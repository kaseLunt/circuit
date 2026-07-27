import { describe, expect, it, vi } from "vitest";
import {
  DeadlineExceededError,
  operationBudget,
  pollUntilReady,
  requestWindow,
  withDeadline,
} from "./deadlines";

const stall = (): Promise<never> => new Promise<never>(() => {});

describe("withDeadline", () => {
  it("resolves a prompt call untouched", async () => {
    const value = await withDeadline("prompt", 1000, async () => 42);
    expect(value).toBe(42);
  });

  it("rejects a stalled call at the deadline, even when the signal is ignored", async () => {
    // This is THE guarantee (Codex round-2 finding 1): the await FAILS, bounded,
    // whatever the transport does — a stalled socket cannot hold a mutex forever.
    await expect(withDeadline("stalled", 15, () => stall())).rejects.toThrow(DeadlineExceededError);
  });

  it("carries what/afterMs on the deadline error for classification and display", async () => {
    try {
      await withDeadline("eth_getTransactionReceipt against x", 10, () => stall());
      throw new Error("should have rejected");
    } catch (error) {
      if (!(error instanceof DeadlineExceededError)) throw new Error("wrong error type");
      expect(error.what).toBe("eth_getTransactionReceipt against x");
      expect(error.afterMs).toBe(10);
      expect(error.message).toMatch(/10ms deadline/);
    }
  });

  it("aborts the signal at the deadline so the transport can tear the socket down", async () => {
    let observed: AbortSignal | null = null;
    await expect(
      withDeadline("signal", 10, (signal) => {
        observed = signal;
        return stall();
      }),
    ).rejects.toThrow(DeadlineExceededError);
    expect(observed).not.toBeNull();
    expect((observed as unknown as AbortSignal).aborted).toBe(true);
  });

  it("normalizes an abort-caused transport rejection to the deadline error", async () => {
    await expect(
      withDeadline("abort-normalized", 10, async (signal) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        // Simulate fetch surfacing the abort as its own error type.
        if (signal.aborted) throw new Error("The operation was aborted");
        return 1;
      }),
    ).rejects.toThrow(DeadlineExceededError);
  });

  it("passes a call's OWN failure through untouched when the deadline has not fired", async () => {
    await expect(
      withDeadline("own-failure", 1000, async () => {
        throw new Error("rpc said no");
      }),
    ).rejects.toThrow("rpc said no");
  });
});

describe("operationBudget", () => {
  it("defaults to a MONOTONIC clock: a backward wall-clock jump cannot extend the budget", async () => {
    // Freeze Date.now at zero — a maximal backward correction. Node's timers and
    // performance.now are untouched by it, so if the default budget consulted the wall
    // clock it would never exhaust; the monotonic default exhausts on schedule
    // (Codex round-3 finding 2).
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const budget = operationBudget(10);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(budget.exceeded()).toBe(true);
      expect(budget.remainingMs()).toBe(0);
    } finally {
      wallClock.mockRestore();
    }
  });

  it("draws down on the injected clock and reports exhaustion exactly", () => {
    const nowMs = { value: 0 };
    const budget = operationBudget(100, () => nowMs.value);
    expect(budget.exceeded()).toBe(false);
    expect(budget.remainingMs()).toBe(100);
    nowMs.value = 60;
    expect(budget.remainingMs()).toBe(40);
    expect(budget.exceeded()).toBe(false);
    nowMs.value = 100;
    expect(budget.remainingMs()).toBe(0);
    expect(budget.exceeded()).toBe(true);
    nowMs.value = 500;
    expect(budget.remainingMs()).toBe(0);
  });
});

describe("requestWindow", () => {
  it("clips the request ceiling to the remaining budget, floored at 1ms", () => {
    const nowMs = { value: 0 };
    const budget = operationBudget(100, () => nowMs.value);
    expect(requestWindow(budget, 20)).toBe(20);
    nowMs.value = 95;
    expect(requestWindow(budget, 20)).toBe(5);
    nowMs.value = 200;
    // An exhausted budget still yields a positive window so the caller fails FAST
    // instead of hanging on a zero-timeout that never fires.
    expect(requestWindow(budget, 20)).toBe(1);
  });
});

describe("pollUntilReady", () => {
  const instantSleep = async () => {};

  it("returns the first successful probe's value", async () => {
    const value = await pollUntilReady({
      what: "ready",
      budgetMs: 1000,
      intervalMs: 1,
      requestTimeoutMs: 20,
      probe: async () => "up",
      sleep: instantSleep,
    });
    expect(value).toBe("up");
  });

  it("retries failed probes on the interval until one succeeds, clipping each window", async () => {
    const nowMs = { value: 0 };
    const sleeps: number[] = [];
    const windows: number[] = [];
    let attempts = 0;
    const value = await pollUntilReady({
      what: "ready",
      budgetMs: 100,
      intervalMs: 7,
      requestTimeoutMs: 20,
      probe: async (windowMs) => {
        windows.push(windowMs);
        attempts += 1;
        nowMs.value += 30;
        if (attempts < 3) throw new Error("not yet");
        return attempts;
      },
      now: () => nowMs.value,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(value).toBe(3);
    expect(sleeps).toEqual([7, 7]);
    // Windows shrink with the budget: full ceiling, then clipped to what remains.
    expect(windows).toEqual([20, 20, 20].map((w, i) => Math.max(1, Math.min(w, 100 - i * 30))));
  });

  it("aborts immediately on a fatal condition — a dead child never becomes ready", async () => {
    const died = new Error("anvil exited (code 1)");
    await expect(
      pollUntilReady({
        what: "ready",
        budgetMs: 1000,
        intervalMs: 1,
        requestTimeoutMs: 20,
        probe: async () => {
          throw new Error("unreachable probe");
        },
        fatal: () => died,
        sleep: instantSleep,
      }),
    ).rejects.toThrow("anvil exited (code 1)");
  });

  it("throws the caller's timeout error (diagnostics attached) at budget exhaustion", async () => {
    const nowMs = { value: 0 };
    await expect(
      pollUntilReady({
        what: "ready",
        budgetMs: 50,
        intervalMs: 1,
        requestTimeoutMs: 20,
        probe: async () => {
          nowMs.value += 30;
          throw new Error("not yet");
        },
        onTimeout: () => new Error("readiness timeout: anvil stderr tail here"),
        now: () => nowMs.value,
        sleep: instantSleep,
      }),
    ).rejects.toThrow("readiness timeout: anvil stderr tail here");
  });

  it("defaults to DeadlineExceededError when no timeout factory is given", async () => {
    const nowMs = { value: 0 };
    await expect(
      pollUntilReady({
        what: "anvil readiness",
        budgetMs: 10,
        intervalMs: 1,
        requestTimeoutMs: 20,
        probe: async () => {
          nowMs.value += 30;
          throw new Error("not yet");
        },
        now: () => nowMs.value,
        sleep: instantSleep,
      }),
    ).rejects.toThrow(DeadlineExceededError);
  });

  it("holds its bound against a backward wall-clock jump (the round-4 readiness drill)", async () => {
    // Same technique as the confirm-budget proof: freeze Date.now at zero — a maximal
    // backward correction. The poll runs on the DEFAULT monotonic clock with real
    // timers, so a 15ms budget with an always-failing probe must exhaust on schedule;
    // a wall-clock-bound loop would spin here forever.
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      await expect(
        pollUntilReady({
          what: "anvil readiness under clock rollback",
          budgetMs: 15,
          intervalMs: 5,
          requestTimeoutMs: 20,
          probe: async () => {
            throw new Error("never ready");
          },
        }),
      ).rejects.toThrow(DeadlineExceededError);
    } finally {
      wallClock.mockRestore();
    }
  });
});
