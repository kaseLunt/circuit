/**
 * W07 session-service fork gate (treatment §5.1/§9.7): the P0 two-session proof re-run as
 * a standing check against the REAL service composition — registry, per-session anvil
 * forks, the tRPC router, and the attribution-module execute path — not a re-enactment
 * with test doubles.
 *
 * The per-session anvils fork from the SHARED PRISTINE upstream `tests/fork/global-setup.ts`
 * boots, pinned to `PINNED_BLOCK` from the real `FORK_RPC_URL` — NOT from the suite's shared
 * base anvil. WHY (experimentally confirmed 2026-07-27): an anvil serving concurrent
 * historical-tag state reads to forked children DEADLOCKS PERMANENTLY when its head has
 * moved past the tag — the flagship suite mines the shared base +3 blocks before this
 * file runs, and a 30-request burst at the pinned tag against a mined base wedged every
 * probe instantly (even eth_blockNumber), while the identical burst against a pristine
 * base answered healthy at ~60ms. Forking from an upstream whose head NEVER moves makes the
 * wedge condition unreachable by construction.
 *
 * This file used to spawn that upstream ITSELF, and so did the two sibling session suites —
 * three cold bootstraps against a metered endpoint per run, which is what R-3a74989b's CI
 * flake was made of. The wedge argument is about the upstream being PRISTINE, never about it
 * being private: a never-mined anvil stays at the pin forever, so one serves all three exactly
 * as safely. `beforeAll`/`afterAll` here bracket the shared upstream's head with the pin, so a
 * suite that ever mines on it is named rather than merely detected.
 *
 * Proven here, in order: fork-identity refusal (A7), two isolated sessions (A5),
 * server-built plan + step execution with attribution through the real module,
 * cross-session invisibility, wire idempotency without a second transaction (A4),
 * strict sequencing, bearer-key ownership, and the reset drill (fresh fork at the
 * verified base, record cleared, actor re-minted).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { PINNED_BLOCK, readsMeta } from "../helpers/protocol-reads";
import { flagshipGraph } from "../helpers/graphs";
import { encodeShareGraph } from "../../src/lib/share/encode";
import {
  SANDBOX_OUTPUT_TOLERANCE,
  withinOutputTolerance,
} from "../../src/lib/execution/tolerance";
import {
  createSessionRegistry,
  type Session,
  type SessionFork,
} from "../../src/server/sandbox/session-registry";
import type { SandboxChain } from "../../src/server/sandbox/execute-step";
import {
  ForkIdentityMismatchError,
  captureSessionSnapshot,
  spawnSessionFork,
  type ForkSessionConfig,
} from "../../src/server/sandbox/fork-session";
import { createSandboxCaller, type SandboxContext } from "../../src/server/trpc/sandbox-router";
import { SESSION_UPSTREAM_URL } from "./anvil";
import { assertSharedUpstreamPristine, record } from "./harness";

const PINNED_HASH = readsMeta.pinned_block.hash as Hex;

const config: ForkSessionConfig = {
  upstreamUrl: SESSION_UPSTREAM_URL,
  baseBlock: PINNED_BLOCK,
  expectBlockHash: PINNED_HASH,
  anvilPath: process.env.ANVIL_PATH ?? "anvil",
  portBase: 9645,
  portCount: 4,
  // The session anvils' upstream is the LOCAL dedicated anvil above, so the topology
  // decision in `anvil-args.ts` (PR #20 CI finding) drops the three throttle/retry
  // values below for the children and raises their fork-request timeout instead —
  // self-throttling loopback traffic starved the fresh actor's cold-miss storage sweep
  // past anvil's default 45s fork timeout. The values still ride the config for the
  // remote (live-mode) topology, where they are the R-3a74989b posture.
  computeUnitsPerSecond: "100",
  forkRetries: "10",
  forkRetryBackoffMs: "2000",
};

let sessionRpcId = 0;
async function rpcAt<T>(url: string, method: string, params: readonly unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: (sessionRpcId += 1), method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error !== undefined) {
    throw new Error(`${method} failed: ${body.error.message ?? "rpc error"}`);
  }
  return body.result as T;
}

const blockNumberAt = async (url: string): Promise<bigint> =>
  BigInt(await rpcAt<string>(url, "eth_blockNumber"));

describe("W07 fork gate — sandbox sessions are isolated, verified, and idempotent", () => {
  const registry = createSessionRegistry({
    maxSessions: 2,
    ttlMs: 10 * 60_000,
    maxTxPerSession: 32,
    minExecuteIntervalMs: 0,
  });
  const chains = new WeakMap<SessionFork, SandboxChain>();
  const ctx: SandboxContext = {
    store: registry,
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
  const caller = createSandboxCaller(ctx);

  let keyA = "";
  let keyB = "";
  let planHash = "";
  let sessionA: Session;
  let sessionB: Session;

  async function sessionOf(key: string): Promise<Session> {
    const looked = await registry.lookup(key);
    if (!looked.ok) throw new Error(`session lookup refused: ${looked.refusal.kind}`);
    return looked.session;
  }

  beforeAll(async () => {
    await assertSharedUpstreamPristine("before session-isolation ran");

    const [a, b] = [await caller.create(), await caller.create()];
    if (!a.ok || !b.ok) throw new Error("session creation refused");
    keyA = a.session.sessionKey;
    keyB = b.session.sessionKey;
    sessionA = await sessionOf(keyA);
    sessionB = await sessionOf(keyB);
    record(`session A fork ${sessionA.fork.rpcUrl} actor ${sessionA.actor}`);
    record(`session B fork ${sessionB.fork.rpcUrl} actor ${sessionB.actor}`);
  });

  afterAll(async () => {
    await caller.destroy({ sessionKey: keyA }).catch(() => undefined);
    await caller.destroy({ sessionKey: keyB }).catch(() => undefined);
    // The upstream is SHARED and outlives this suite, so the pristine claim is re-checked
    // here rather than only at global teardown: it localises the violation to the suite that
    // caused it instead of to whichever one happened to run last.
    await assertSharedUpstreamPristine("after session-isolation ran");
  });

  it("refuses a fork whose base-block hash cannot be verified (A7)", async () => {
    const tampered: ForkSessionConfig = {
      ...config,
      expectBlockHash: `0x${"11".repeat(32)}` as Hex,
    };
    await expect(spawnSessionFork(tampered)).rejects.toThrow(ForkIdentityMismatchError);
  });

  it("boots both sessions at the verified pinned base with distinct actors and keys", async () => {
    expect(keyA).toMatch(/^[0-9a-f]{64}$/);
    expect(keyB).toMatch(/^[0-9a-f]{64}$/);
    expect(keyA).not.toBe(keyB);
    expect(sessionA.fork.baseBlockHash).toBe(PINNED_HASH);
    expect(sessionB.fork.baseBlockHash).toBe(PINNED_HASH);
    expect(sessionA.actor).not.toBe(sessionB.actor);
    expect(sessionA.fork.rpcUrl).not.toBe(sessionB.fork.rpcUrl);
    expect(await blockNumberAt(sessionA.fork.rpcUrl)).toBe(PINNED_BLOCK);
    expect(await blockNumberAt(sessionB.fork.rpcUrl)).toBe(PINNED_BLOCK);
  });

  it("refuses a third session at the configured capacity, before spawning anything", async () => {
    const third = await caller.create();
    expect(third.ok).toBe(false);
    if (third.ok) throw new Error("unreachable");
    expect(third.refusal).toEqual({ kind: "at-capacity" });
  });

  it("plans server-side from the session fork's own snapshot and executes step 1 through the attribution module", async () => {
    const encoded = encodeShareGraph(flagshipGraph());
    if (!encoded.ok) throw new Error("fixture graph refused by the share codec");
    const planned = await caller.plan({ sessionKey: keyA, document: encoded.token });
    if (!planned.ok) throw new Error(`plan refused: ${JSON.stringify(planned.refusal)}`);
    expect(planned.plan.stepCount).toBe(13);
    planHash = planned.plan.planHash;
    record(`session A planHash ${planHash}`);

    const outcome = await caller.executeStep({ sessionKey: keyA, planHash, stepIndex: 0 });
    if (!outcome.ok) throw new Error(`executeStep refused: ${JSON.stringify(outcome.refusal)}`);
    if (outcome.result.status !== "attributed") {
      throw new Error(`step 0 settled as ${outcome.result.status}`);
    }
    expect(outcome.result.stepId).toBe("stake1:deposit");
    expect(BigInt(outcome.result.sharesDelta ?? "0") > 0n).toBe(true);
    const output = outcome.result.output;
    if (output === null) throw new Error("deposit should carry an attributed output");
    expect(output.mechanism).toBe("share-delta");
    expect(
      withinOutputTolerance(
        BigInt(output.predictedWei),
        BigInt(output.attributedWei),
        SANDBOX_OUTPUT_TOLERANCE,
      ),
    ).toBe(true);
    record(
      `step 1 attributed: predicted ${output.predictedWei} attributed ${output.attributedWei} ` +
        `tolerance ${output.toleranceWei} tx ${outcome.result.receipt.txHash}`,
    );
    expect(await blockNumberAt(sessionA.fork.rpcUrl)).toBeGreaterThan(PINNED_BLOCK);
  });

  it("keeps session B blind to everything session A did (the isolation contract)", async () => {
    const snapshotA = sessionA.plan?.snapshot;
    if (snapshotA === undefined) throw new Error("session A has no recorded snapshot");
    const chainB = ctx.chainFor(sessionB);
    // A's actor left no trace on B's fork: no eETH shares, no balance, no nonce.
    expect(await chainB.sharesOf(snapshotA.etherfi.eETH, sessionA.actor)).toBe(0n);
    expect(BigInt(await rpcAt<string>(sessionB.fork.rpcUrl, "eth_getBalance", [sessionA.actor, "latest"]))).toBe(0n);
    expect(
      BigInt(await rpcAt<string>(sessionB.fork.rpcUrl, "eth_getTransactionCount", [sessionA.actor, "latest"])),
    ).toBe(0n);
    // B's fork never moved off the pinned base.
    expect(await blockNumberAt(sessionB.fork.rpcUrl)).toBe(PINNED_BLOCK);
    record("isolation: session B observed none of session A's state");
  });

  it("replays a duplicate executeStep without a second transaction (A4)", async () => {
    const before = await blockNumberAt(sessionA.fork.rpcUrl);
    const nonceBefore = BigInt(
      await rpcAt<string>(sessionA.fork.rpcUrl, "eth_getTransactionCount", [sessionA.actor, "latest"]),
    );
    const first = await caller.executeStep({ sessionKey: keyA, planHash, stepIndex: 0 });
    const replay = await caller.executeStep({ sessionKey: keyA, planHash, stepIndex: 0 });
    expect(replay).toEqual(first);
    expect(await blockNumberAt(sessionA.fork.rpcUrl)).toBe(before);
    expect(
      BigInt(await rpcAt<string>(sessionA.fork.rpcUrl, "eth_getTransactionCount", [sessionA.actor, "latest"])),
    ).toBe(nonceBefore);
    record("idempotency: duplicate executeStep produced zero new transactions");
  });

  it("refuses out-of-order dispatch with the expected index", async () => {
    const outcome = await caller.executeStep({ sessionKey: keyA, planHash, stepIndex: 5 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal).toEqual({ kind: "out-of-order", expectedIndex: 1 });
  });

  it("bearer-key possession is ownership: a forged key resolves nothing", async () => {
    const forged = keyA.slice(0, 63) + (keyA.endsWith("0") ? "1" : "0");
    const looked = await caller.session({ sessionKey: forged });
    expect(looked.ok).toBe(false);
    if (looked.ok) throw new Error("unreachable");
    expect(looked.refusal).toEqual({ kind: "unknown-session" });
  });

  it("resets to a fresh, hash-verified fork with a re-minted actor and a cleared record", async () => {
    const actorBefore = sessionA.actor;
    const reset = await caller.reset({ sessionKey: keyA });
    if (!reset.ok) throw new Error("reset refused");
    expect(reset.session.phase).toEqual({ kind: "active" });
    expect(reset.session.planHash).toBeNull();
    expect(reset.session.executed).toHaveLength(0);
    sessionA = await sessionOf(keyA);
    expect(sessionA.actor).not.toBe(actorBefore);
    expect(await blockNumberAt(sessionA.fork.rpcUrl)).toBe(PINNED_BLOCK);

    // The strongest identity proof available: planning again re-captures from the reset
    // fork with expectBlockHash — it would refuse if the reset had landed anywhere else.
    const encoded = encodeShareGraph(flagshipGraph());
    if (!encoded.ok) throw new Error("fixture graph refused by the share codec");
    const planned = await caller.plan({ sessionKey: keyA, document: encoded.token });
    expect(planned.ok).toBe(true);
    record("reset drill: fresh fork verified at the pinned base; session re-planned clean");
  });

  it("destroy releases the session and its key", async () => {
    const destroyed = await caller.destroy({ sessionKey: keyB });
    expect(destroyed.ok).toBe(true);
    const looked = await caller.session({ sessionKey: keyB });
    expect(looked.ok).toBe(false);
    if (looked.ok) throw new Error("unreachable");
    expect(looked.refusal).toEqual({ kind: "unknown-session" });
  });
});
