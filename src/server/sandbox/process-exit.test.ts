import { describe, expect, it } from "vitest";
import { createPortLeaseRegistry } from "./port-lease";
import { hasExitRecord, trackProcessExit, type ProcessLike } from "./process-exit";

class FakeProcess implements ProcessLike {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly killCalls: Array<NodeJS.Signals | number | undefined> = [];
  private listeners: Array<() => void> = [];

  once(_event: "exit", listener: () => void): unknown {
    this.listeners.push(listener);
    return this;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    return true;
  }

  emitExit(exitCode: number | null, signalCode: string | null): void {
    this.exitCode = exitCode;
    this.signalCode = signalCode;
    for (const listener of this.listeners.splice(0)) listener();
  }
}

describe("hasExitRecord", () => {
  it("reads BOTH of Node's exit records — signal death has exitCode null", () => {
    expect(hasExitRecord({ exitCode: null, signalCode: null })).toBe(false);
    expect(hasExitRecord({ exitCode: 0, signalCode: null })).toBe(true);
    expect(hasExitRecord({ exitCode: 1, signalCode: null })).toBe(true);
    expect(hasExitRecord({ exitCode: null, signalCode: "SIGTERM" })).toBe(true);
    expect(hasExitRecord({ exitCode: null, signalCode: "SIGKILL" })).toBe(true);
  });
});

describe("trackProcessExit", () => {
  it("treats a signal-terminated child as already exited (the round-3 bug)", async () => {
    const child = new FakeProcess();
    child.signalCode = "SIGTERM"; // killed before the tracker existed; exitCode stays null
    const tracker = trackProcessExit(child);
    expect(tracker.exited()).toBe(true);
    await tracker.destroy(10_000); // resolves immediately — no wait on a fired one-shot
    expect(child.killCalls).toHaveLength(0);
  });

  it("memoizes destruction: every destroy call returns the SAME promise, one kill", async () => {
    const child = new FakeProcess();
    const tracker = trackProcessExit(child);
    const first = tracker.destroy(10_000);
    const second = tracker.destroy(10_000);
    expect(second).toBe(first);
    expect(child.killCalls).toEqual([undefined]); // one SIGTERM, no double-kill
    child.emitExit(0, null);
    await first;
    // A destroy AFTER completion still returns the settled original.
    const third = tracker.destroy(10_000);
    expect(third).toBe(first);
    await third;
    expect(child.killCalls).toEqual([undefined]);
  });

  it("a second destroy after signal-based death resolves instead of waiting forever", async () => {
    const child = new FakeProcess();
    const tracker = trackProcessExit(child);
    const destruction = tracker.destroy(10_000);
    // The child dies by signal (e.g. external SIGKILL) — exitCode stays null.
    child.emitExit(null, "SIGKILL");
    await destruction;
    await tracker.destroy(10_000); // must resolve; the one-shot already fired
    expect(tracker.exited()).toBe(true);
  });

  it("escalates to SIGKILL after the grace period and still waits for the OBSERVED exit", async () => {
    const child = new FakeProcess();
    const tracker = trackProcessExit(child);
    let settled = false;
    const destruction = tracker.destroy(10).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(child.killCalls).toEqual([undefined, "SIGKILL"]);
    expect(settled).toBe(false); // SIGKILL requested is not exit observed
    child.emitExit(null, "SIGKILL");
    await destruction;
    expect(settled).toBe(true);
  });

  it("resolves immediately for a child that never spawned (no pid, no exit event ever)", async () => {
    const child = new FakeProcess();
    child.pid = undefined;
    const tracker = trackProcessExit(child);
    await tracker.destroy(10_000);
    expect(child.killCalls).toHaveLength(0);
  });

  it("waitForExit resolves on the observed exit and immediately thereafter", async () => {
    const child = new FakeProcess();
    const tracker = trackProcessExit(child);
    let observed = false;
    const wait = tracker.waitForExit().then(() => {
      observed = true;
    });
    expect(observed).toBe(false);
    child.emitExit(0, null);
    await wait;
    await tracker.waitForExit();
    expect(tracker.exited()).toBe(true);
  });

  it("counts an exit record that appeared without the event as observed (belt)", () => {
    const child = new FakeProcess();
    const tracker = trackProcessExit(child);
    // Simulate the record being written through a path the listener did not see.
    child.exitCode = 0;
    expect(tracker.exited()).toBe(true);
  });
});

describe("destruction and port leases compose (the concurrent destroy/create drill)", () => {
  it("holds the port through a pending destruction; releases only on observed exit", async () => {
    const registry = createPortLeaseRegistry(9700, 2);
    const child = new FakeProcess();
    const tracker = trackProcessExit(child);
    const lease = registry.acquire();

    // The fork-session wiring: release ties to the settled destruction promise.
    const destruction = tracker.destroy(10_000).finally(() => lease.release());

    // Destroy is in progress (exit not yet observed): a concurrent create gets a
    // DIFFERENT port — never the dying anvil's socket.
    const concurrent = registry.acquire();
    expect(concurrent.port).not.toBe(lease.port);
    expect(registry.isLeased(lease.port)).toBe(true);

    child.emitExit(null, "SIGTERM");
    await destruction;
    expect(registry.isLeased(lease.port)).toBe(false);
    const reused = registry.acquire();
    expect(reused.port).toBe(lease.port);
  });
});
