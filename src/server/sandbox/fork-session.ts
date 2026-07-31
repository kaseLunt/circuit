/**
 * Per-session fork lifecycle — one anvil child process per session, the self-hosted
 * provider the P0 spike proved (`spikes/sandbox-proof/proof.mjs`) shaped into the
 * treatment §5.1 contract:
 *
 *  - forks are pinned to the RECORDED base block and verified by block hash on create
 *    and after every reset (`expectBlockHash` pattern; mismatch destroys the fork and
 *    refuses — it never serves, A7);
 *  - the session actor is a per-session random address, verified code-free at boot for
 *    the EIP-7702 reason the fork suite recorded (`tests/fork/flagship-plan.test.ts`,
 *    the wallet-selection comment), funded and impersonated on the fork — a second
 *    isolation wall on top of the per-process fork;
 *  - anvil binds to 127.0.0.1 only, and the upstream archive RPC arrives through
 *    server-only env (`SANDBOX_FORK_URL`) — never `NEXT_PUBLIC_*` (A6, lint-gated);
 *  - resets retry with linear backoff because a re-fork is idempotent — the SAME
 *    request again, never a second transaction (the harness's `rpcWithRetry` lesson);
 *    `--retries`/`--fork-retry-backoff` harden anvil's own fork backend the same way
 *    `tests/fork/global-setup.ts` does (R-3a74989b posture).
 *
 * This module is deliberately NOT unit-coverage-enrolled: it is process and socket I/O
 * end to end, and its behaviour is proven where it is honest to prove it — on the fork
 * (`tests/fork/session-isolation.test.ts`). Everything decision-shaped lives in
 * `session-registry.ts` / `execute-step.ts`, which are.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createPublicClient, getAddress, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { captureChainSnapshot } from "../chain/snapshot";
import { PINNED_BLOCK, readsMeta } from "../../lib/recorded-reads/reads-log";
import type { ChainSnapshot } from "../../core/plan";
import { createSessionRegistry, type SessionFork } from "./session-registry";
import {
  SandboxTxRevertedError,
  type SandboxChain,
  type SandboxRawReceipt,
  type SandboxService,
} from "./execute-step";
import {
  DeadlineExceededError,
  SANDBOX_CONFIRM_BUDGET_MS,
  SANDBOX_READ_TIMEOUT_MS,
  SANDBOX_RPC_REQUEST_TIMEOUT_MS,
  operationBudget,
  pollUntilReady,
  requestWindow,
  withDeadline,
} from "./deadlines";
import { createPortLeaseRegistry, type PortLeaseRegistry } from "./port-lease";
import { trackProcessExit } from "./process-exit";
import { sessionAnvilArgs } from "./anvil-args";

export interface ForkSessionConfig {
  /** Upstream RPC the session anvil forks from. Server-only env; archive-capable in prod. */
  readonly upstreamUrl: string;
  readonly baseBlock: bigint;
  readonly expectBlockHash: Hex;
  readonly anvilPath: string;
  /** Loopback ports handed to session anvils, [portBase, portBase + portCount). */
  readonly portBase: number;
  readonly portCount: number;
  readonly computeUnitsPerSecond: string;
  readonly forkRetries: string;
  readonly forkRetryBackoffMs: string;
}

const READY_TIMEOUT_MS = 120_000;
const READY_PROBE_INTERVAL_MS = 500;
const RECEIPT_POLL_INTERVAL_MS = 50;
/** Snapshot capture is hundreds of multicalled reads against a possibly cold upstream
 *  cache — it gets a larger bound than ordinary session reads (deadlines.ts). */
const CAPTURE_READ_TIMEOUT_MS = 120_000;
/** Reset retries: idempotent, linear backoff — the limiter's window is seconds (harness.ts). */
const RESET_ATTEMPTS = 5;
const RESET_BACKOFF_MS = 2_000;
/**
 * Explicit limit instead of node-side estimation (harness.ts lesson): Aave txs cost more
 * inside the mined block than at the estimation state — interest-accrual SSTOREs turn from
 * no-ops into value changes as the timestamp advances — so estimated limits can OutOfGas
 * at the tail of validateHFAndLtv.
 */
const SESSION_STEP_GAS_LIMIT = 2_000_000n;
/**
 * Session actor funding — the figure the fork gate itself funds its wallets with. Plans
 * are bounded by the graph's MAX_INPUT_ETH; the rest is gas headroom on a fork where ETH
 * is free anyway. Never a money-math input: the plan's input amount is the document's.
 */
const ACTOR_FUNDING_WEI = 100_000n * 10n ** 18n;

const KILL_GRACE_MS = 10_000;

const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;

const READ_ABI = {
  eeth: parseAbi(["function shares(address) view returns (uint256)"]),
  lp: parseAbi(["function amountForShare(uint256) view returns (uint256)"]),
  erc20: parseAbi(["function allowance(address,address) view returns (uint256)"]),
  pool: parseAbi([
    "function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  ]),
};

export class ForkIdentityMismatchError extends Error {
  constructor(baseBlock: bigint, expected: Hex, got: string | null) {
    super(
      `fork identity mismatch at block ${baseBlock}: got ${got !== null ? got : "null"}, expected ${expected} — refusing to serve`,
    );
  }
}

/** The env-derived config for production composition. Throws rather than defaulting the
 *  one value that cannot be defaulted — there is no fallback fork upstream. */
export function forkSessionConfigFromEnv(): ForkSessionConfig {
  const upstreamUrl = process.env.SANDBOX_FORK_URL;
  if (upstreamUrl === undefined || upstreamUrl === "") {
    throw new Error(
      "SANDBOX_FORK_URL is required (server-only env, never NEXT_PUBLIC_*): the sandbox " +
        `session service forks from it at the pinned base block ${PINNED_BLOCK}`,
    );
  }
  const hash: unknown = readsMeta.pinned_block.hash;
  if (typeof hash !== "string" || !HEX_HASH.test(hash)) {
    throw new Error("reads log meta.pinned_block.hash is missing or malformed");
  }
  return {
    upstreamUrl,
    baseBlock: PINNED_BLOCK,
    expectBlockHash: hash as Hex,
    anvilPath: process.env.SANDBOX_ANVIL_PATH ?? process.env.ANVIL_PATH ?? "anvil",
    portBase: Number(process.env.SANDBOX_PORT_BASE ?? "9545"),
    portCount: Number(process.env.SANDBOX_PORT_COUNT ?? "16"),
    // anvil assumes a paid tier's compute budget and bursts past free endpoints, which
    // answer 429; self-throttling trades wall-clock for determinism (global-setup.ts).
    computeUnitsPerSecond: process.env.SANDBOX_ANVIL_CUPS ?? "100",
    forkRetries: process.env.SANDBOX_ANVIL_FORK_RETRIES ?? "10",
    forkRetryBackoffMs: process.env.SANDBOX_ANVIL_FORK_RETRY_BACKOFF_MS ?? "2000",
  };
}

/** Port LEASES, not a set (Codex round-2 finding 3): a port is released only after the
 *  old child's exit is observed, so a concurrent create can never race a dying anvil
 *  for its socket. The decision structure lives covered in `port-lease.ts`. */
const portRegistries = new Map<string, PortLeaseRegistry>();

function portRegistryFor(config: ForkSessionConfig): PortLeaseRegistry {
  const key = `${config.portBase}:${config.portCount}`;
  let registry = portRegistries.get(key);
  if (registry === undefined) {
    registry = createPortLeaseRegistry(config.portBase, config.portCount);
    portRegistries.set(key, registry);
  }
  return registry;
}

const hexQuantity = (v: bigint): Hex => `0x${v.toString(16)}` as Hex;

let rpcId = 0;

/**
 * Every fork-RPC round trip runs under a per-request deadline (Codex round-2 finding 1):
 * the AbortSignal tears the socket down and the await REJECTS at the deadline, so no
 * polling loop, retry ladder, or reconciliation read can stall the session mutex on a
 * hung upstream. The policy (bounds, budgets) lives covered in `deadlines.ts`.
 */
export async function rpcCall<T>(
  url: string,
  method: string,
  params: readonly unknown[] = [],
  timeoutMs: number = SANDBOX_RPC_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return withDeadline(`${method} against ${url}`, timeoutMs, async (signal) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: (rpcId += 1), method, params }),
      signal,
    });
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error !== undefined) {
      throw new Error(`${method} failed: ${body.error.message !== undefined ? body.error.message : "rpc error"}`);
    }
    return body.result as T;
  });
}

async function verifyForkIdentity(url: string, baseBlock: bigint, expected: Hex): Promise<void> {
  const block = await rpcCall<{ hash?: string } | null>(url, "eth_getBlockByNumber", [
    hexQuantity(baseBlock),
    false,
  ]);
  const got = block !== null && typeof block.hash === "string" ? block.hash : null;
  if (got === null || got.toLowerCase() !== expected.toLowerCase()) {
    throw new ForkIdentityMismatchError(baseBlock, expected, got);
  }
}

/**
 * Mint a per-session actor: a fresh random address (code-free with overwhelming
 * probability, and CHECKED — expected is not observed), funded and impersonated.
 * Random-per-session is both display honesty and an isolation wall: no two sessions
 * share an actor, so a leaked address ties to exactly one fork.
 */
async function mintSessionActor(url: string): Promise<Address> {
  const actor = getAddress(`0x${randomBytes(20).toString("hex")}`);
  const code = await rpcCall<string>(url, "eth_getCode", [actor, "latest"]);
  if (code !== "0x") {
    // The fork suite's recorded reason: code-bearing accounts (EIP-7702 delegations)
    // OOG the 2300-gas stipend of WETH9.withdraw's ETH send.
    throw new Error(`minted session actor ${actor} unexpectedly has code — refusing the session`);
  }
  await rpcCall(url, "anvil_setBalance", [actor, hexQuantity(ACTOR_FUNDING_WEI)]);
  await rpcCall(url, "anvil_impersonateAccount", [actor]);
  return actor;
}

async function resetWithRetry(url: string, config: ForkSessionConfig): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RESET_ATTEMPTS; attempt += 1) {
    try {
      await rpcCall(url, "anvil_reset", [
        { forking: { jsonRpcUrl: config.upstreamUrl, blockNumber: Number(config.baseBlock) } },
      ]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === RESET_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, RESET_BACKOFF_MS * attempt));
    }
  }
  throw new Error(
    `anvil_reset failed after ${RESET_ATTEMPTS} attempts — the upstream endpoint is ` +
      `rate-limiting the re-fork. Last error: ${String(lastError)}`,
  );
}

function rawReceiptOf(txHash: Hex, r: Record<string, unknown>): SandboxRawReceipt {
  return {
    txHash,
    status: BigInt(r["status"] as string),
    blockNumber: BigInt(r["blockNumber"] as string),
    blockHash: r["blockHash"] as Hex,
    logs: r["logs"] as SandboxRawReceipt["logs"],
    gasUsed: BigInt(r["gasUsed"] as string),
  };
}

function chainFor(url: string, client: PublicClient, baseBlock: bigint): SandboxChain {
  return {
    async dispatchTransaction(tx) {
      const payload: Record<string, string> = {
        from: tx.from,
        to: tx.to,
        data: tx.data,
        gas: hexQuantity(SESSION_STEP_GAS_LIMIT),
      };
      if (tx.value > 0n) payload["value"] = hexQuantity(tx.value);
      return rpcCall<Hex>(url, "eth_sendTransaction", [payload]);
    },

    async confirmTransaction(txHash) {
      // Bounded twice over (finding 1): each poll under the per-request deadline, the
      // whole loop under an operation budget. Past the budget the await REJECTS — the
      // dispatch intent already persists, so the execute path classifies the failure
      // as dispatch-unresolved and recovery resumes by discovery.
      const budget = operationBudget(SANDBOX_CONFIRM_BUDGET_MS);
      for (;;) {
        if (budget.exceeded()) {
          throw new DeadlineExceededError(
            `receipt confirmation for ${txHash}`,
            SANDBOX_CONFIRM_BUDGET_MS,
          );
        }
        const r = await rpcCall<Record<string, unknown> | null>(
          url,
          "eth_getTransactionReceipt",
          [txHash],
          requestWindow(budget, SANDBOX_RPC_REQUEST_TIMEOUT_MS),
        );
        if (r !== null) {
          const receipt = rawReceiptOf(txHash, r);
          if (receipt.status !== 1n) throw new SandboxTxRevertedError(txHash);
          return receipt;
        }
        await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_INTERVAL_MS));
      }
    },

    async actorNonce(actor) {
      return BigInt(await rpcCall<string>(url, "eth_getTransactionCount", [actor, "latest"]));
    },

    async transactionByNonce(actor, nonce) {
      // The session fork's history is tiny — the pinned base plus one block per
      // executed step — so a linear walk of the blocks this fork itself mined (never
      // below the base: those are upstream history) is bounded and exact. Discovery
      // only; never dispatch (finding 2).
      const latest = BigInt(await rpcCall<string>(url, "eth_blockNumber"));
      const actorLower = actor.toLowerCase();
      for (let n = latest; n > baseBlock; n -= 1n) {
        const block = await rpcCall<{ transactions?: readonly Record<string, unknown>[] } | null>(
          url,
          "eth_getBlockByNumber",
          [hexQuantity(n), true],
        );
        if (block === null || block.transactions === undefined) continue;
        for (const tx of block.transactions) {
          const from = tx["from"];
          const txNonce = tx["nonce"];
          if (
            typeof from === "string" &&
            from.toLowerCase() === actorLower &&
            typeof txNonce === "string" &&
            BigInt(txNonce) === nonce
          ) {
            return tx["hash"] as Hex;
          }
        }
      }
      return null;
    },

    async revertDataOf(txHash) {
      // Replay the mined tx faithfully — original gas limit, parent-block state — to
      // surface the revert data (the harness `replayRevert` pattern).
      const tx = await rpcCall<Record<string, unknown> | null>(url, "eth_getTransactionByHash", [
        txHash,
      ]);
      if (tx === null) return `tx ${txHash} not found`;
      const parent = BigInt(tx["blockNumber"] as string) - 1n;
      const payload: Record<string, string> = {
        from: tx["from"] as string,
        to: tx["to"] as string,
        gas: tx["gas"] as string,
        data: (tx["input"] !== undefined ? tx["input"] : tx["data"]) as string,
      };
      const value = tx["value"] as string | undefined;
      if (value !== undefined && BigInt(value) > 0n) payload["value"] = value;
      // Raw fetch (the error body IS the datum), bounded like every other round trip.
      const body = await withDeadline(
        `revert replay for ${txHash}`,
        SANDBOX_RPC_REQUEST_TIMEOUT_MS,
        async (signal) => {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: (rpcId += 1),
              method: "eth_call",
              params: [payload, hexQuantity(parent)],
            }),
            signal,
          });
          return (await res.json()) as { error?: { message?: string; data?: unknown } };
        },
      );
      if (body.error === undefined) return null;
      const d = body.error.data;
      if (typeof d === "string") return d;
      if (typeof d === "object" && d !== null) {
        const nested = (d as { data?: unknown }).data;
        if (typeof nested === "string") return nested;
      }
      return body.error.message !== undefined ? body.error.message : "unknown revert";
    },

    async receiptOf(txHash) {
      const r = await rpcCall<Record<string, unknown> | null>(url, "eth_getTransactionReceipt", [
        txHash,
      ]);
      if (r === null) return null;
      return rawReceiptOf(txHash, r);
    },

    sharesOf(eeth, actor) {
      return client.readContract({
        address: eeth,
        abi: READ_ABI.eeth,
        functionName: "shares",
        args: [actor],
      });
    },

    amountForShare(liquidityPool, shares) {
      return client.readContract({
        address: liquidityPool,
        abi: READ_ABI.lp,
        functionName: "amountForShare",
        args: [shares],
      });
    },

    allowance(token, owner, spender) {
      return client.readContract({
        address: token,
        abi: READ_ABI.erc20,
        functionName: "allowance",
        args: [owner, spender],
      });
    },

    async healthFactorOf(pool, actor) {
      const account = await client.readContract({
        address: pool,
        abi: READ_ABI.pool,
        functionName: "getUserAccountData",
        args: [actor],
      });
      return account[5];
    },
  };
}

export interface SessionForkHandle extends SessionFork {
  readonly chain: SandboxChain;
}

export async function spawnSessionFork(config: ForkSessionConfig): Promise<SessionForkHandle> {
  const lease = portRegistryFor(config).acquire();
  const port = lease.port;
  const url = `http://127.0.0.1:${port}`;
  // Flag construction is a covered TOPOLOGY DECISION (`anvil-args.ts`, PR #20 CI
  // finding): a localhost upstream gets no self-throttle and a raised fork-request
  // timeout; a remote upstream keeps the R-3a74989b posture. `anvil_reset` re-forks
  // in-process and inherits these spawn-time flags, so this is the ONLY site.
  const child: ChildProcess = spawn(
    config.anvilPath,
    sessionAnvilArgs({
      upstreamUrl: config.upstreamUrl,
      baseBlock: config.baseBlock,
      port,
      computeUnitsPerSecond: config.computeUnitsPerSecond,
      forkRetries: config.forkRetries,
      forkRetryBackoffMs: config.forkRetryBackoffMs,
    }),
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // The exit listener is installed HERE, at spawn time (Codex round-3 finding 1), so a
  // destroy that begins after the one-shot event has fired can never wait on it; the
  // tracker also reads Node's signal-death record (`signalCode` with `exitCode` null).
  const exitTracker = trackProcessExit(child);
  let stderrTail = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });
  let failure: Error | null = null;
  child.on("error", (e) => {
    failure = new Error(`failed to spawn anvil ('${config.anvilPath}'): ${e.message}`);
  });
  child.on("exit", (code) => {
    if (failure === null) {
      failure = new Error(`session anvil exited (code ${code}): ${stderrTail}`);
    }
  });

  async function destroyProcess(): Promise<void> {
    // Memoized destruction over the observed exit (round-2 finding 3, round-3
    // finding 1): every call shares one promise, resolution waits for the exit EVENT
    // (including after SIGKILL), signal deaths count as exited, and the port lease is
    // released only once that observation lands. Decision logic lives covered in
    // `process-exit.ts`; this function only binds it to the lease.
    try {
      await exitTracker.destroy(KILL_GRACE_MS);
    } finally {
      lease.release();
    }
  }

  try {
    // Readiness under the covered monotonic poll (Codex round-4 finding): the previous
    // inline Date.now() deadline was the last wall-clock bound in this file, and a
    // backward host-clock correction could hold it open with the pending spawn, port
    // lease, and capacity slot all occupied.
    await pollUntilReady({
      what: `anvil readiness for ${url}`,
      budgetMs: READY_TIMEOUT_MS,
      intervalMs: READY_PROBE_INTERVAL_MS,
      requestTimeoutMs: SANDBOX_RPC_REQUEST_TIMEOUT_MS,
      probe: (windowMs) => rpcCall(url, "eth_blockNumber", [], windowMs),
      fatal: () => failure,
      onTimeout: () =>
        new Error(`session anvil readiness timeout after ${READY_TIMEOUT_MS}ms: ${stderrTail}`),
    });

    await verifyForkIdentity(url, config.baseBlock, config.expectBlockHash);
    const bootActor = await mintSessionActor(url);
    const client = createPublicClient({
      chain: mainnet,
      transport: http(url, { timeout: SANDBOX_READ_TIMEOUT_MS }),
    }) as unknown as PublicClient;

    return {
      rpcUrl: url,
      baseBlock: config.baseBlock,
      baseBlockHash: config.expectBlockHash,
      actor: bootActor,
      chain: chainFor(url, client, config.baseBlock),
      async reset() {
        // Transactional (Codex finding 6): once anvil_reset has begun, a failure at ANY
        // later stage — identity verification, actor minting — leaves the fork in a
        // state nothing has verified, so the child is destroyed on the way out and the
        // caller (the registry) invalidates the session. A fork that cannot prove its
        // identity never serves (A7).
        try {
          await resetWithRetry(url, config);
          await verifyForkIdentity(url, config.baseBlock, config.expectBlockHash);
          const actor = await mintSessionActor(url);
          return { actor };
        } catch (cause) {
          await destroyProcess();
          throw cause;
        }
      },
      destroy: destroyProcess,
    };
  } catch (cause) {
    // A fork that cannot prove its identity (or boot) never serves — destroy, then refuse.
    await destroyProcess();
    throw cause;
  }
}

let envService: SandboxService | null = null;

/**
 * Production composition: env-configured fork spawning behind a process-wide registry.
 * Lazy and memoized, so importing this module never demands env or spawns anything —
 * only the transport that mounts the router will.
 */
export function sandboxServiceFromEnv(): SandboxService {
  if (envService !== null) return envService;
  const config = forkSessionConfigFromEnv();
  const store = createSessionRegistry();
  const chains = new WeakMap<SessionFork, SandboxChain>();
  envService = {
    store,
    spawnFork: async () => {
      const handle = await spawnSessionFork(config);
      chains.set(handle, handle.chain);
      return handle;
    },
    chainFor: (session) => {
      const chain = chains.get(session.fork);
      if (chain === undefined) throw new Error("session fork has no chain binding");
      return chain;
    },
    captureSnapshot: (session) => captureSessionSnapshot(session.fork, session.actor),
  };
  return envService;
}

/** The §5.3 invariant: calldata executed in a session derives from a snapshot captured
 *  FROM that session's fork, block-hash-verified, with the session actor. */
export async function captureSessionSnapshot(
  fork: SessionFork,
  actor: Address,
): Promise<ChainSnapshot> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(fork.rpcUrl, { timeout: CAPTURE_READ_TIMEOUT_MS }),
  }) as unknown as PublicClient;
  return captureChainSnapshot(client, {
    user: actor,
    blockNumber: fork.baseBlock,
    expectBlockHash: fork.baseBlockHash,
  });
}
