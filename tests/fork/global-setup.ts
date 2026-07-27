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

const RESET_ATTEMPTS = 5;
const RESET_BACKOFF_MS = 2_000;

async function resetWithRetry(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RESET_ATTEMPTS; attempt += 1) {
    try {
      await rpc("anvil_reset", [{ forking: { blockNumber: Number(PINNED_BLOCK) } }]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === RESET_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, RESET_BACKOFF_MS * attempt));
    }
  }
  throw new Error(
    `anvil_reset failed after ${RESET_ATTEMPTS} attempts — the upstream endpoint is rate-limiting ` +
      `the re-fork; raise ANVIL_CUPS or use a paid endpoint. Last error: ${String(lastError)}`,
  );
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // ANVIL_EXTERNAL=1: attach to an already-running fork (kept alive across
  // runs for forensics/iteration) instead of spawning one. Identity is still
  // verified below in that mode.
  if (process.env.ANVIL_EXTERNAL === "1") {
    // Re-fork at the pin so every run starts from clean fixture state while
    // anvil's on-disk upstream cache stays warm.
    // Retried: the re-fork makes anvil re-fetch upstream state in one burst, which a
    // free-tier endpoint answers with a rate-limit error. A reset is idempotent, so a
    // second attempt is the same request rather than a different one.
    await resetWithRetry();
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
  // R-3a74989b retirement option 1. CUPS smooths STEADY-STATE load, but the flake is burst
  // shaped: anvil's lazy upstream storage fetches collide inside a single multicall and the
  // 429 surfaces as `failed to get storage … Max retries exceeded` mid-suite. These two flags
  // harden the layer the retry actually has to happen in — inside anvil's fork backend, which
  // no suite-side wrapper can reach (rpcWithRetry only covers anvil_reset, harness.ts).
  // Verified against anvil 1.7.1: the flags are `--retries` (rate-limit retry count, default
  // 5) and `--fork-retry-backoff` (initial backoff in MILLISECONDS); `--fork-request-retries`
  // does not exist in this version and is rejected at argument parsing.
  // Values match the suite-side posture (harness.ts: 5 attempts, 2s) with a doubled retry
  // budget, trading wall-clock for determinism exactly as the CUPS setting above does.
  const forkRetries = process.env.ANVIL_FORK_RETRIES ?? "10";
  const forkRetryBackoffMs = process.env.ANVIL_FORK_RETRY_BACKOFF_MS ?? "2000";
  const child = spawn(
    anvilBin,
    [
      "--fork-url",
      forkUrl,
      "--fork-block-number",
      PINNED_BLOCK.toString(),
      "--compute-units-per-second",
      cups,
      "--retries",
      forkRetries,
      "--fork-retry-backoff",
      forkRetryBackoffMs,
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
