/**
 * Spawns anvil forked at the pinned fixture block, verifies fork identity by
 * block hash, and tears the process down when the suite ends (W03 wiring
 * contract). FORK_RPC_URL must be archive-capable — the pinned block has aged
 * out of public nodes' recent-state windows; there is no fallback endpoint.
 *
 * TWO anvils are booted here, and the second one is the R-3a74989b consolidation: the base
 * fork the flagship suite MINES on, and ONE pristine never-mined upstream that every
 * session-shaped suite forks its children from. `tests/fork/anvil.ts` carries the port map and
 * the reason one pristine upstream is as safe as three. Four cold bootstraps against the
 * metered endpoint per run became two, which is the whole point: the CI flake was three
 * concurrent-ish cold forks hitting a free tier's burst ceiling, and no amount of suite-side
 * retry reaches a boot that already 429'd.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PINNED_BLOCK, readsMeta } from "../helpers/protocol-reads";
import { sessionAnvilArgs } from "../../src/server/sandbox/anvil-args";
import { trackProcessExit, type ProcessExitTracker } from "../../src/server/sandbox/process-exit";
import { SANDBOX_RPC_REQUEST_TIMEOUT_MS, pollUntilReady } from "../../src/server/sandbox/deadlines";
import { rpcCall } from "../../src/server/sandbox/fork-session";
import { ANVIL_URL, SESSION_UPSTREAM_URL } from "./anvil";

const READY_TIMEOUT_MS = 120_000;
const UPSTREAM_READY_PROBE_INTERVAL_MS = 500;


/**
 * THE PRISTINE INVARIANT, stated in one place so both ends of the run say the same sentence.
 *
 * A moved head re-arms the anvil historical-state wedge, and the wedge presents as silent
 * total unresponsiveness rather than as an error — so the run has to fail on the CAUSE while
 * the cause is still legible. Checked at boot (before any suite can use it) and again at
 * teardown (after every suite has), which is what turns "nothing mines on this" from a
 * convention into a checked claim.
 */
async function assertPristine(url: string, when: string): Promise<void> {
  const head = BigInt(
    await rpcCall<string>(url, "eth_blockNumber", [], SANDBOX_RPC_REQUEST_TIMEOUT_MS),
  );
  if (head !== PINNED_BLOCK) {
    throw new Error(
      `the shared pristine session upstream at ${url} has head ${head}, not the pin ` +
        `${PINNED_BLOCK}, ${when} — something mined on it. Nothing may mine or mutate this ` +
        "anvil: a moved head re-arms the historical-state wedge that dedicated pristine " +
        "upstreams exist to avoid, and the wedge is silent (see tests/fork/anvil.ts). A suite " +
        "that needs to mine takes its own fork, as the flagship suite does.",
    );
  }
}

interface SharedUpstream {
  readonly teardown: () => Promise<void>;
}

/**
 * Boot the ONE pristine upstream the session-shaped suites share.
 *
 * Lifted verbatim from the three per-suite bootstraps it replaces — same `sessionAnvilArgs`
 * remote posture (it faces the real provider), same readiness discipline, same identity check
 * — so the consolidation moves proven code rather than reimplementing it.
 */
async function startSharedSessionUpstream(
  forkUrl: string,
  anvilBin: string,
): Promise<SharedUpstream> {
  const port = new URL(SESSION_UPSTREAM_URL).port;
  const upstream: ChildProcess = spawn(
    anvilBin,
    sessionAnvilArgs({
      upstreamUrl: forkUrl,
      baseBlock: PINNED_BLOCK,
      port: Number(port),
      computeUnitsPerSecond: process.env.ANVIL_CUPS ?? "100",
      forkRetries: process.env.ANVIL_FORK_RETRIES ?? "10",
      forkRetryBackoffMs: process.env.ANVIL_FORK_RETRY_BACKOFF_MS ?? "2000",
    }),
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const tracker: ProcessExitTracker = trackProcessExit(upstream);
  const logStream = createWriteStream(join(tmpdir(), "circuit-session-upstream.log"), {
    flags: "w",
  });
  let stderrTail = "";
  let tearingDown = false;
  upstream.stdout?.on("data", (d: Buffer) => {
    logStream.write(d);
  });
  upstream.stderr?.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
    logStream.write(d);
  });
  let failure: Error | null = null;
  upstream.on("error", (e) => {
    failure = new Error(`failed to spawn the shared session upstream anvil: ${e.message}`);
  });
  upstream.on("exit", (code) => {
    if (failure === null && !tearingDown) {
      failure = new Error(`the shared session upstream anvil exited (code ${code}): ${stderrTail}`);
    }
  });

  /**
   * OWNERSHIP STARTS AT THE SPAWN, not at the successful return.
   *
   * Every check below can throw with the anvil ALIVE — a readiness timeout, a boot-pristine
   * violation, an identity mismatch, a 429 that kills the child mid-probe. vitest does not call
   * the teardown of a `globalSetup` that threw, and there is no handle to call it with anyway,
   * so anything left running here survives the run and holds :9639 against the NEXT one — which
   * then finds a stale anvil answering its readiness probe while its own spawn fails silently.
   * That is a contaminated run reported as a mysterious failure, which is precisely the class of
   * defect this consolidation exists to remove. So the whole initialization is bracketed and the
   * process is collected on every path out that is not success.
   */
  const retire = async (): Promise<void> => {
    tearingDown = true;
    await tracker.destroy(10_000).catch(() => undefined);
    logStream.end();
  };

  let initialized = false;
  try {
    await pollUntilReady({
      what: `shared session upstream readiness at ${SESSION_UPSTREAM_URL}`,
      budgetMs: READY_TIMEOUT_MS,
      intervalMs: UPSTREAM_READY_PROBE_INTERVAL_MS,
      requestTimeoutMs: SANDBOX_RPC_REQUEST_TIMEOUT_MS,
      probe: (windowMs) => rpcCall<string>(SESSION_UPSTREAM_URL, "eth_blockNumber", [], windowMs),
      fatal: () => failure,
      onTimeout: () =>
        new Error(
          `the shared session upstream was not ready after ${READY_TIMEOUT_MS}ms: ${stderrTail}`,
        ),
    });

    await assertPristine(SESSION_UPSTREAM_URL, "at boot");
    const pinned = await rpcCall<{ hash?: string } | null>(
      SESSION_UPSTREAM_URL,
      "eth_getBlockByNumber",
      [`0x${PINNED_BLOCK.toString(16)}`, false],
      SANDBOX_RPC_REQUEST_TIMEOUT_MS,
    );
    if (pinned === null || pinned.hash !== readsMeta.pinned_block.hash) {
      throw new Error(
        `shared session upstream identity mismatch at ${PINNED_BLOCK}: ` +
          `${pinned?.hash ?? "null"} != ${readsMeta.pinned_block.hash}`,
      );
    }
    initialized = true;
  } finally {
    if (!initialized) await retire();
  }

  process.stdout.write(
    `shared pristine session upstream ready at ${SESSION_UPSTREAM_URL}, pinned to ${PINNED_BLOCK}\n`,
  );

  return {
    teardown: async () => {
      // The pristine claim is checked BEFORE the process dies — after `destroy` there is
      // nothing left to ask. A violation fails the run; the process still gets collected.
      try {
        await assertPristine(SESSION_UPSTREAM_URL, "at teardown");
      } finally {
        await retire();
      }
    },
  };
}

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
    // The external base anvil is the FLAGSHIP's fork; the session-shaped suites still need
    // their shared pristine upstream, and it is not the external one. It is booted here when
    // an endpoint is available — this mode exists for forensics on an already-forked base, and
    // a flagship-only run under it must not be made to require a provider it never calls. A
    // session suite entered without it says so in its own words (see each suite's beforeAll).
    const externalForkUrl = process.env.FORK_RPC_URL;
    if (externalForkUrl === undefined || externalForkUrl === "") return async () => {};
    const external = await startSharedSessionUpstream(
      externalForkUrl,
      process.env.ANVIL_PATH ?? "anvil",
    );
    return external.teardown;
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

  // The second and last cold fork of the run. Booted AFTER the base anvil's identity check so
  // a wrong-history endpoint fails on one bootstrap rather than on two. If IT fails — a 429 at
  // boot is the realistic case — the base anvil is collected on the way out: vitest never calls
  // the teardown for a globalSetup that threw, so the cleanup has to be here.
  let shared: SharedUpstream;
  try {
    shared = await startSharedSessionUpstream(forkUrl, anvilBin);
  } catch (error) {
    child.kill();
    throw error;
  }

  return async () => {
    /**
     * Forensics escape hatch: ANVIL_KEEP=1 leaves the FLAGSHIP fork running after a failed run
     * so the reverted tx can be traced with `cast run`.
     *
     * The shared session upstream is retired anyway, and the asymmetry is the point. What
     * ANVIL_KEEP preserves is MINED state — the flagship's fork carries the transactions the
     * run executed, and that history is the artifact; it cannot be reconstructed by re-forking.
     * The shared upstream is pristine by design: it holds nothing any run put there, so there
     * is nothing to inspect, and re-forking the pin reproduces it byte for byte at any time.
     * Keeping it would trade zero forensic value for a stale process holding :9639 against the
     * next run — the exact contamination the ownership bracket above exists to prevent.
     */
    if (process.env.ANVIL_KEEP === "1") {
      try {
        await shared.teardown();
      } finally {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      return;
    }
    // The pristine claim first: it is a statement about what the RUN did, and it has to be
    // made while the upstream is still answering. It THROWS on a violation, and the base anvil
    // still has to be collected — a teardown that leaks a process on its way to reporting a
    // failure hands the next run a port conflict on top of the real problem.
    try {
      await shared.teardown();
    } finally {
      child.kill();
    }
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
