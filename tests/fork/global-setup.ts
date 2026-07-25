/**
 * Spawns anvil forked at the pinned fixture block, verifies fork identity by
 * block hash, and tears the process down when the suite ends (W03 wiring
 * contract). FORK_RPC_URL must be archive-capable — the pinned block has aged
 * out of public nodes' recent-state windows; there is no fallback endpoint.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PINNED_BLOCK, readsMeta } from "../helpers/protocol-reads";
import { ANVIL_URL } from "./anvil";

const READY_TIMEOUT_MS = 120_000;

async function rpc(method: string, params: readonly unknown[] = []): Promise<unknown> {
  const res = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error !== undefined) {
    throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
  }
  return body.result;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // ANVIL_EXTERNAL=1: attach to an already-running fork (kept alive across
  // runs for forensics/iteration) instead of spawning one. Identity is still
  // verified below in that mode.
  if (process.env.ANVIL_EXTERNAL === "1") {
    // Re-fork at the pin so every run starts from clean fixture state while
    // anvil's on-disk upstream cache stays warm.
    await rpc("anvil_reset", [{ forking: { blockNumber: Number(PINNED_BLOCK) } }]);
    const pinned = (await rpc("eth_getBlockByNumber", [
      `0x${PINNED_BLOCK.toString(16)}`,
      false,
    ])) as { hash?: string } | null;
    if (pinned === null || pinned.hash !== readsMeta.pinned_block.hash) {
      throw new Error(
        `external anvil fork identity mismatch at ${PINNED_BLOCK}: ${pinned?.hash ?? "null"}`,
      );
    }
    return async () => {};
  }
  const forkUrl = process.env.FORK_RPC_URL;
  if (forkUrl === undefined || forkUrl === "") {
    throw new Error(
      "FORK_RPC_URL is required and must be archive-capable — block " +
        `${PINNED_BLOCK} has aged out of public nodes' recent-state windows (W03).`,
    );
  }
  const anvilBin = process.env.ANVIL_PATH ?? "anvil";
  const port = new URL(ANVIL_URL).port;
  // anvil assumes 330 compute units/second (Alchemy's paid tier) and bursts past a free-tier
  // provider, which answers HTTP 429. Because anvil retries and then gives up, that surfaces as
  // "Max retries exceeded" mid-suite and vitest reports every test SKIPPED — an environment
  // failure wearing the costume of a total suite failure. Self-throttling trades wall-clock for
  // determinism. Override with ANVIL_CUPS when pointing at an endpoint with a higher budget.
  const cups = process.env.ANVIL_CUPS ?? "100";
  const child = spawn(
    anvilBin,
    [
      "--fork-url",
      forkUrl,
      "--fork-block-number",
      PINNED_BLOCK.toString(),
      "--compute-units-per-second",
      cups,
      "--host",
      "127.0.0.1",
      "--port",
      port,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  // Full anvil output goes to a tmp log (outside the repo) for revert forensics.
  const logPath = join(tmpdir(), "circuit-anvil.log");
  const logStream = createWriteStream(logPath, { flags: "w" });
  let stderrTail = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
    logStream.write(d);
  });
  child.stdout?.on("data", (d: Buffer) => {
    logStream.write(d);
  });
  let failure: Error | null = null;
  child.on("error", (e) => {
    failure = new Error(`failed to spawn anvil ('${anvilBin}'): ${e.message}`);
  });
  child.on("exit", (code) => {
    if (failure === null) {
      failure = new Error(`anvil exited before the suite finished (code ${code}): ${stderrTail}`);
    }
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (!ready) {
    if (failure !== null) throw failure;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`anvil readiness timeout after ${READY_TIMEOUT_MS}ms: ${stderrTail}`);
    }
    try {
      await rpc("eth_blockNumber");
      ready = true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Fork identity: the pinned block must carry the recorded hash, or every
  // downstream assertion would be measured against the wrong history.
  const pinned = (await rpc("eth_getBlockByNumber", [
    `0x${PINNED_BLOCK.toString(16)}`,
    false,
  ])) as { hash?: string } | null;
  const expectedHash = readsMeta.pinned_block.hash;
  if (pinned === null || pinned.hash !== expectedHash) {
    child.kill();
    throw new Error(
      `fork identity mismatch at block ${PINNED_BLOCK}: got ${pinned?.hash ?? "null"}, expected ${expectedHash}`,
    );
  }

  return async () => {
    // Forensics escape hatch: ANVIL_KEEP=1 leaves the fork running after a
    // failed run so the reverted tx can be traced with `cast run`.
    if (process.env.ANVIL_KEEP === "1") {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      return;
    }
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const force = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 10_000);
      child.on("exit", () => {
        clearTimeout(force);
        resolve();
      });
    });
  };
}
