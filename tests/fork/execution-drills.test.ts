/**
 * W07 execution drills (charter `roadmap/work/W07-p3-execution.md` §Acceptance "Fork gate
 * extended, never lowered"; treatment §9 items 3–5 and 9): failure, divergence, recovery,
 * and resumption proven ON THE REAL COMPOSITION — the session registry, per-session anvil
 * forks, the tRPC router caller, and the attribution module — not re-enacted with doubles.
 * The behaviours are all unit-proven beside their modules; what only this file can prove
 * is that the machine keeps its honesty when the transactions, receipts, nonces, and
 * storage are real.
 *
 * The state-tampering levers are REALISTIC-CONDITIONS class, never calldata bypasses:
 *
 *  - FAILURE: the approve→wrap pair's allowance is zeroed out from under the plan via
 *    `anvil_setStorageAt` between the approve and its consumer — state changing beneath a
 *    frozen plan is exactly the divergence-class event mainnet can produce — so the wrap
 *    MINES with status 0 (the dispatch path uses a fixed gas limit, no estimation gate).
 *  - DIVERGENCE: the flagship suite's W03 rebase mutation (+1% totalPooledEther via the
 *    packed-accounting storage word) induced BETWEEN the approve and the wrap. The pair
 *    resolves once (D1), so the wrap spends the pre-rebase amount and mints ~1% fewer
 *    weETH than the plan's flows predicted — a real confirmed transaction whose attributed
 *    output breaches the 1e-6 sandbox tolerance. Discriminating by construction: the
 *    flagship's own rebase run (mutation between deposit and approve) completes WITHIN
 *    tolerance, so the two runs together prove the bound separates the cases.
 *  - RECOVERY (treatment §9.9): the persistence and dispatch failures are injected through
 *    the composition's OWN seams — `SandboxContext` accepts any `SessionRegistry` and any
 *    `chainFor`, the same seams this file and the isolation suite already compose — as a
 *    one-shot `appendConfirmed` throw and a one-shot post-dispatch confirmation drop. The
 *    fork, the dispatch, the mined receipt, and the reconciliation reads are all real.
 *
 * Fork topology mirrors `session-isolation.test.ts` (see its header for the experimentally
 * confirmed anvil historical-state wedge): the session forks are children of the SHARED
 * pristine upstream `tests/fork/global-setup.ts` boots, whose head never moves. This file used
 * to spawn its own — the wedge argument requires the upstream to be pristine, not private, and
 * three private ones meant three cold bootstraps against a metered endpoint (R-3a74989b). The
 * port map lives in `tests/fork/anvil.ts`; this suite's session children take 9655–9658.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  concatHex,
  encodeFunctionData,
  keccak256,
  padHex,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { PINNED_BLOCK, readsMeta } from "../helpers/protocol-reads";
import { flagshipGraph } from "../helpers/graphs";
import { encodeShareGraph } from "../../src/lib/share/encode";
import { buildPlan } from "../../src/core/plan";
import { decodeRevert } from "../../src/core/errors";
import { planHashOf } from "../../src/lib/execution/plan-hash";
import { resumePlan, type WireSessionResponse } from "../../src/lib/execution/resume";
import { SANDBOX_OUTPUT_TOLERANCE, toleranceWeiFor } from "../../src/lib/execution/tolerance";
import {
  createSessionRegistry,
  type Session,
  type SessionFork,
  type SessionRegistry,
} from "../../src/server/sandbox/session-registry";
import type { SandboxChain } from "../../src/server/sandbox/execute-step";
import {
  captureSessionSnapshot,
  spawnSessionFork,
  type ForkSessionConfig,
} from "../../src/server/sandbox/fork-session";
import { createSandboxCaller, type SandboxContext } from "../../src/server/trpc/sandbox-router";
import { SESSION_UPSTREAM_URL } from "./anvil";
import { assertSharedUpstreamPristine, hexWord, record } from "./harness";

const PINNED_HASH = readsMeta.pinned_block.hash as Hex;

const config: ForkSessionConfig = {
  upstreamUrl: SESSION_UPSTREAM_URL,
  baseBlock: PINNED_BLOCK,
  expectBlockHash: PINNED_HASH,
  anvilPath: process.env.ANVIL_PATH ?? "anvil",
  portBase: 9655,
  portCount: 4,
  // Loopback topology: `anvil-args.ts` drops the three throttle/retry values for the
  // session children and raises their fork-request timeout instead (PR #20 CI finding);
  // the values still ride the config for the remote (live-mode) topology.
  computeUnitsPerSecond: "100",
  forkRetries: "10",
  forkRetryBackoffMs: "2000",
};

/** W03 mutation contract constants, mirrored from `flagship-plan.test.ts`. */
const STORAGE_SCAN_SLOTS = 256n;
const ALLOWANCE_SCAN_SLOTS = 256n;
const U128 = 1n << 128n;
/** Induced rebase: +1.0000% of totalPooledEther (W03 mutation contract). */
const REBASE_DIVISOR = 100n;
const FLAGSHIP_STEP_COUNT = 13;

const LP_ABI = parseAbi(["function getTotalPooledEther() view returns (uint256)"]);

let rpcId = 0;
async function rpcAt<T>(url: string, method: string, params: readonly unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: (rpcId += 1), method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error !== undefined) {
    throw new Error(`${method} failed: ${body.error.message ?? "rpc error"}`);
  }
  return body.result as T;
}

const blockNumberAt = async (url: string): Promise<bigint> =>
  BigInt(await rpcAt<string>(url, "eth_blockNumber"));

const nonceAt = async (url: string, actor: Address): Promise<bigint> =>
  BigInt(await rpcAt<string>(url, "eth_getTransactionCount", [actor, "latest"]));

const storageAt = async (url: string, address: Address, slot: Hex): Promise<bigint> =>
  BigInt(await rpcAt<string>(url, "eth_getStorageAt", [address, slot, "latest"]));

async function setStorageAt(url: string, address: Address, slot: Hex, word: bigint): Promise<void> {
  await rpcAt(url, "anvil_setStorageAt", [address, slot, hexWord(word)]);
}

async function totalPooledEtherAt(url: string, liquidityPool: Address): Promise<bigint> {
  const data = encodeFunctionData({ abi: LP_ABI, functionName: "getTotalPooledEther" });
  return BigInt(await rpcAt<string>(url, "eth_call", [{ to: liquidityPool, data }, "latest"]));
}

/** The flagship suite's packed-accounting scan (`findPackedAccountingSlot`), against a
 *  session fork: exactly one slot whose low+high halves sum to totalPooledEther. */
async function findPackedAccountingSlotAt(
  url: string,
  liquidityPool: Address,
  totalBefore: bigint,
): Promise<{ slot: bigint; word: bigint }> {
  const matches: Array<{ slot: bigint; word: bigint }> = [];
  for (let slot = 0n; slot < STORAGE_SCAN_SLOTS; slot += 1n) {
    const word = await storageAt(url, liquidityPool, hexWord(slot));
    if (word === 0n) continue;
    const low = word & (U128 - 1n);
    const high = word >> 128n;
    if (low + high === totalBefore) matches.push({ slot, word });
  }
  if (matches.length !== 1) {
    throw new Error(`packed-accounting scan must find exactly one slot; found ${matches.length}`);
  }
  return matches[0]!;
}

/**
 * Locate `allowances[owner][spender]` empirically, the same exactly-one discipline as the
 * packed-accounting scan: for base slots 0..N, compute the solidity double-mapping slot
 * keccak(spender ++ keccak(owner ++ base)) and match the word against the known live
 * allowance. No hand-typed layout claim — the chain itself confirms the slot.
 */
async function findAllowanceSlotAt(
  url: string,
  token: Address,
  owner: Address,
  spender: Address,
  expectedWei: bigint,
): Promise<Hex> {
  if (expectedWei === 0n) throw new Error("allowance-slot scan needs a nonzero live allowance");
  const matches: Hex[] = [];
  for (let base = 0n; base < ALLOWANCE_SCAN_SLOTS; base += 1n) {
    const inner = keccak256(concatHex([padHex(owner, { size: 32 }), toHex(base, { size: 32 })]));
    const slot = keccak256(concatHex([padHex(spender, { size: 32 }), inner]));
    if ((await storageAt(url, token, slot)) === expectedWei) matches.push(slot);
  }
  if (matches.length !== 1) {
    throw new Error(`allowance-slot scan must find exactly one slot; found ${matches.length}`);
  }
  return matches[0]!;
}

/**
 * Replay a mined transaction against the SESSION fork at the parent block of its receipt —
 * same from/to/gas/data/value, pre-state — so the CHAIN yields the revert payload. A local
 * replay rather than a reused one, deliberately: `harness.replayRevert` is bound to the base
 * anvil's URL and the drills tamper with per-session forks, and calling the service's own
 * `revertDataOf` would compare the recorded evidence against the code that recorded it.
 * Throws unless the replay reverts WITH data — a drill that cannot obtain the chain's own
 * bytes has nothing to compare against and must not pass quietly.
 */
async function replayRevertAt(url: string, txHash: Hex, minedBlock: bigint): Promise<Hex> {
  const tx = await rpcAt<Record<string, unknown> | null>(url, "eth_getTransactionByHash", [txHash]);
  if (tx === null) throw new Error(`revert replay: ${txHash} is not in the session fork's history`);
  if (BigInt(tx["blockNumber"] as string) !== minedBlock) {
    throw new Error(`revert replay: ${txHash} is not mined in block ${minedBlock}`);
  }
  const payload: Record<string, string> = {
    from: tx["from"] as string,
    to: tx["to"] as string,
    gas: tx["gas"] as string,
    data: (tx["input"] ?? tx["data"]) as string,
  };
  const value = tx["value"] as string | undefined;
  if (value !== undefined && BigInt(value) > 0n) payload["value"] = value;
  // Raw fetch: the error body IS the datum here, so `rpcAt`'s throw-on-error is wrong.
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: (rpcId += 1),
      method: "eth_call",
      params: [payload, `0x${(minedBlock - 1n).toString(16)}`],
    }),
  });
  const body = (await res.json()) as { error?: { message?: string; data?: unknown } };
  if (body.error === undefined) {
    throw new Error(`revert replay: ${txHash} succeeded at its parent block — no revert bytes`);
  }
  const direct = body.error.data;
  if (typeof direct === "string") return direct as Hex;
  if (typeof direct === "object" && direct !== null) {
    const nested = (direct as { data?: unknown }).data;
    if (typeof nested === "string") return nested as Hex;
  }
  throw new Error(
    `revert replay: no revert data for ${txHash} (${body.error.message ?? "no message"})`,
  );
}

describe("W07 fork gate — execution drills against the real session composition", () => {
  const registry = createSessionRegistry({
    maxSessions: 2,
    // Generous TTL: expiry semantics are unit-proven (session-registry.test); a cold
    // first capture through the throttled upstream must not turn a drill into a TTL test.
    ttlMs: 30 * 60_000,
    maxTxPerSession: 32,
    minExecuteIntervalMs: 0,
  });

  // §9.9 injection seams, one-shot armed. Both wrappers delegate to the REAL registry and
  // the REAL fork chain — the failure is the only fiction, and it is the class of failure
  // (append throw, lost confirmation response) the machine claims to survive.
  let failNextAppend = false;
  let dropNextConfirm = false;

  const store: SessionRegistry = {
    ...registry,
    appendConfirmed(session, entry) {
      if (failNextAppend) {
        failNextAppend = false;
        throw new Error("drill: injected registry-append failure (persistence cell)");
      }
      registry.appendConfirmed(session, entry);
    },
  };

  const chains = new WeakMap<SessionFork, SandboxChain>();
  function realChainOf(session: Session): SandboxChain {
    const chain = chains.get(session.fork);
    if (chain === undefined) throw new Error("session fork has no chain binding");
    return chain;
  }

  const ctx: SandboxContext = {
    store,
    spawnFork: async () => {
      const handle = await spawnSessionFork(config);
      chains.set(handle, handle.chain);
      return handle;
    },
    chainFor: (session) => {
      const real = realChainOf(session);
      return {
        ...real,
        confirmTransaction(txHash) {
          if (dropNextConfirm) {
            dropNextConfirm = false;
            return Promise.reject(
              new Error("drill: injected transport drop — confirmation response lost"),
            );
          }
          return real.confirmTransaction(txHash);
        },
      };
    },
    captureSnapshot: (session) => captureSessionSnapshot(session.fork, session.actor),
  };
  const caller = createSandboxCaller(ctx);

  /** Keys of sessions a failed drill may have left behind; afterAll sweeps them. */
  const openKeys = new Set<string>();

  async function sessionOf(key: string): Promise<Session> {
    const looked = await registry.lookup(key);
    if (!looked.ok) throw new Error(`session lookup refused: ${looked.refusal.kind}`);
    return looked.session;
  }

  async function createSession(): Promise<{ key: string; session: Session }> {
    const created = await caller.create();
    if (!created.ok) throw new Error(`session creation refused: ${created.refusal.kind}`);
    openKeys.add(created.session.sessionKey);
    return { key: created.session.sessionKey, session: await sessionOf(created.session.sessionKey) };
  }

  async function destroySession(key: string): Promise<void> {
    const destroyed = await caller.destroy({ sessionKey: key });
    if (!destroyed.ok) throw new Error(`session destroy refused: ${destroyed.refusal.kind}`);
    openKeys.delete(key);
  }

  /** Server-side plan over the flagship fixture; asserts the 13-step shape and the
   *  deposit→approve→wrap head this file's drills tamper around. */
  async function planFlagship(key: string): Promise<{ planHash: Hex; stepIds: readonly string[] }> {
    const encoded = encodeShareGraph(flagshipGraph());
    if (!encoded.ok) throw new Error("fixture graph refused by the share codec");
    const planned = await caller.plan({ sessionKey: key, document: encoded.token });
    if (!planned.ok) throw new Error(`plan refused: ${JSON.stringify(planned.refusal)}`);
    expect(planned.plan.stepCount).toBe(FLAGSHIP_STEP_COUNT);
    const stepIds = planned.plan.steps.map((step) => step.id);
    expect(stepIds.slice(0, 3)).toEqual(["stake1:deposit", "wrap1:approve", "wrap1:wrap"]);
    return { planHash: planned.plan.planHash as Hex, stepIds };
  }

  type ExecuteResponse = Awaited<ReturnType<typeof caller.executeStep>>;

  async function executeAttributed(
    key: string,
    planHash: Hex,
    stepIndex: number,
  ): Promise<ExecuteResponse> {
    const outcome = await caller.executeStep({ sessionKey: key, planHash, stepIndex });
    if (!outcome.ok) throw new Error(`executeStep refused: ${JSON.stringify(outcome.refusal)}`);
    if (outcome.result.status !== "attributed") {
      throw new Error(`step ${stepIndex} settled as ${outcome.result.status}`);
    }
    return outcome;
  }

  beforeAll(async () => {
    await assertSharedUpstreamPristine("before execution-drills ran");
  });

  afterAll(async () => {
    for (const key of [...openKeys]) {
      await caller.destroy({ sessionKey: key }).catch(() => undefined);
    }
    // The drills tamper with SESSION forks only — that is what a child fork is for. The thing
    // they all fork FROM must be exactly where it started, and the upstream is shared now, so
    // this check names THIS suite rather than leaving global teardown to say "someone did".
    await assertSharedUpstreamPristine("after execution-drills ran");
  });

  it("failure drill: a mid-plan revert lands failed with the executed prefix settled and zero suffix dispatch", async () => {
    const { key, session } = await createSession();
    const { planHash } = await planFlagship(key);
    const snapshot = session.plan?.snapshot;
    if (snapshot === undefined) throw new Error("session has no recorded snapshot");
    const chain = realChainOf(session);
    const url = session.fork.rpcUrl;

    const r0 = await executeAttributed(key, planHash, 0);
    const r1 = await executeAttributed(key, planHash, 1);
    if (!r1.ok || r1.result.status !== "attributed") throw new Error("unreachable");
    const approval = r1.result.approval;
    if (approval === null) throw new Error("approve step recorded no approval facts");
    expect(approval.priorAllowanceWei).toBe("0");
    const approvedWei = BigInt(approval.approvedWei);
    expect(approvedWei > 0n).toBe(true);

    // The tamper: zero the just-set eETH allowance out from under the frozen plan —
    // state moving beneath the plan between steps, the honest failure class. The slot is
    // found empirically and the zeroing is verified through the service's own read.
    const eETH = snapshot.etherfi.eETH;
    const weETH = snapshot.etherfi.weETH;
    expect(await chain.allowance(eETH, session.actor, weETH)).toBe(approvedWei);
    const slot = await findAllowanceSlotAt(url, eETH, session.actor, weETH, approvedWei);
    await setStorageAt(url, eETH, slot, 0n);
    expect(await chain.allowance(eETH, session.actor, weETH)).toBe(0n);
    record(`failure drill: allowance slot ${slot} zeroed (was ${approvedWei})`);

    const nonceBefore = await nonceAt(url, session.actor);
    const headBefore = await blockNumberAt(url);
    expect(nonceBefore).toBe(2n);

    // The wrap dispatches against the tampered state and MINES with status 0.
    const failed = await caller.executeStep({ sessionKey: key, planHash, stepIndex: 2 });
    if (!failed.ok) throw new Error(`wrap dispatch refused: ${JSON.stringify(failed.refusal)}`);
    if (failed.result.status !== "failed") {
      throw new Error(`wrap settled as ${failed.result.status}, expected failed`);
    }
    const failure = failed.result.failure;
    expect(failure.stepIndex).toBe(2);
    expect(failure.stepId).toBe("wrap1:wrap");
    expect(failure.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const minedRevert = await chain.receiptOf(failure.txHash);
    if (minedRevert === null) throw new Error("failed step has no mined receipt on the fork");
    expect(minedRevert.status).toBe(0n);

    // The revert evidence is THE CHAIN'S OWN BYTES, not merely non-null bytes. The mined
    // transaction is replayed here independently of the service — eth_call of the same
    // fields at the parent block of its receipt — and the recorded `raw` must equal that
    // payload exactly. Asserting non-null would have passed on any string the engine
    // invented; this cannot.
    const replayed = await replayRevertAt(url, failure.txHash, minedRevert.blockNumber);
    expect(replayed).toMatch(/^0x[0-9a-fA-F]{8,}$/);
    expect(failure.raw).toBe(replayed);

    // And the decoded reading is a reading OF THOSE BYTES: the pure decoder run over the
    // chain's payload reproduces the recorded evidence field for field, so the two cannot
    // drift apart. The selector claim below is stated as a precondition — this revert is a
    // bare custom error, so the decoded signal IS the payload's leading four bytes.
    const decodedFailure = failure.decoded;
    if (decodedFailure === null) throw new Error("the failure carries no decoded revert reading");
    expect(decodedFailure).toEqual(decodeRevert(replayed));
    expect(decodedFailure.source).toBe("unknown");
    expect(decodedFailure.raw).toBe(replayed.slice(0, 10).toLowerCase());
    expect(replayed.toLowerCase().startsWith(decodedFailure.raw)).toBe(true);
    record(
      `failure drill: wrap reverted on-chain (${failure.txHash}); recorded raw ${failure.raw} ` +
        `equals the independent replay at block ${minedRevert.blockNumber - 1n}; ` +
        `decoded "${decodedFailure.message}" [${decodedFailure.source} ${decodedFailure.raw}]`,
    );

    // The executed prefix stays settled: replays return the recorded results, no new tx.
    expect(await caller.executeStep({ sessionKey: key, planHash, stepIndex: 0 })).toEqual(r0);
    expect(await caller.executeStep({ sessionKey: key, planHash, stepIndex: 1 })).toEqual(r1);

    // Zero suffix dispatch, proven by absence: the failed index and every later index
    // refuse with the recorded evidence; nonce, head, and the registry's tx budget all
    // show exactly the three dispatched transactions (the mined revert spent budget, D6).
    for (const stepIndex of [2, 3, 12]) {
      const refused = await caller.executeStep({ sessionKey: key, planHash, stepIndex });
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error("unreachable");
      expect(refused.refusal).toEqual({ kind: "failed", failure });
    }
    expect(await nonceAt(url, session.actor)).toBe(3n);
    expect(await blockNumberAt(url)).toBe(headBefore + 1n);

    const summary = await caller.session({ sessionKey: key });
    if (!summary.ok) throw new Error("session summary refused");
    expect(summary.session.phase).toEqual({ kind: "failed", failure });
    expect(summary.session.txCount).toBe(3);
    expect(summary.session.executed).toHaveLength(2);
    expect(summary.session.executed.map((step) => step.status)).toEqual([
      "attributed",
      "attributed",
    ]);
    record("failure drill: prefix settled, suffix refused, session pinned failed");

    await destroySession(key);
  });

  it("divergence drill: a rebase between approve and wrap halts with the evidence triple and an idempotent replay", async () => {
    const { key, session } = await createSession();
    const { planHash } = await planFlagship(key);
    const snapshot = session.plan?.snapshot;
    if (snapshot === undefined) throw new Error("session has no recorded snapshot");
    const chain = realChainOf(session);
    const url = session.fork.rpcUrl;

    await executeAttributed(key, planHash, 0);
    const r1 = await executeAttributed(key, planHash, 1);
    if (!r1.ok || r1.result.status !== "attributed") throw new Error("unreachable");
    const approvedWei = BigInt(r1.result.approval?.approvedWei ?? "0");
    expect(approvedWei > 0n).toBe(true);

    // The W03 rebase mutation, placed between the approve and its consumer: the pair
    // already resolved once (D1), so the wrap will spend the pre-rebase figure and its
    // weETH output will fall ~1% short of the plan's prediction.
    const lp = snapshot.etherfi.liquidityPool;
    const totalBefore = await totalPooledEtherAt(url, lp);
    const { slot, word } = await findPackedAccountingSlotAt(url, lp, totalBefore);
    const delta = totalBefore / REBASE_DIVISOR;
    const low = word & (U128 - 1n);
    if (low + delta >= U128) throw new Error("low half would overflow into the high half");
    await setStorageAt(url, lp, hexWord(slot), word + delta);
    expect(await totalPooledEtherAt(url, lp)).toBe(totalBefore + delta);
    record(
      `divergence drill rebase: slot ${slot} word ${word.toString(16)} -> ` +
        `${(word + delta).toString(16)} (delta ${delta})`,
    );

    const halted = await caller.executeStep({ sessionKey: key, planHash, stepIndex: 2 });
    if (!halted.ok) throw new Error(`wrap dispatch refused: ${JSON.stringify(halted.refusal)}`);
    if (halted.result.status !== "halted") {
      throw new Error(`wrap settled as ${halted.result.status}, expected halted`);
    }
    const halt = halted.result.halt;
    if (halt.kind !== "output-divergence") throw new Error(`halt kind ${halt.kind}`);
    expect(halt.stepIndex).toBe(2);
    expect(halt.stepId).toBe("wrap1:wrap");
    expect(halt.mechanism).toBe("transfer-event");
    // The PREDICTED / ATTRIBUTED / TOLERANCE evidence triple, plus the mined receipt:
    // the transaction confirmed AND the attribution diverged — both truths kept.
    const predicted = BigInt(halt.predictedWei);
    if (halt.attributedWei === null) throw new Error("attributed output missing from the halt");
    const attributed = BigInt(halt.attributedWei);
    const tolerance = BigInt(halt.toleranceWei);
    expect(tolerance).toBe(toleranceWeiFor(predicted, SANDBOX_OUTPUT_TOLERANCE));
    expect(attributed < predicted).toBe(true);
    const shortfall = predicted - attributed;
    expect(shortfall > tolerance).toBe(true);
    // Pinned to the induced event: a +1% rebase shorts the wrap by ~predicted/101.
    expect(shortfall > predicted / 200n).toBe(true);
    expect(shortfall < predicted / 50n).toBe(true);
    expect(halted.result.receipt.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const minedOk = await chain.receiptOf(halted.result.receipt.txHash as Hex);
    if (minedOk === null) throw new Error("halted step has no mined receipt on the fork");
    expect(minedOk.status).toBe(1n);
    // Even in the halted run the consumer spent the approval in full (§3.3).
    expect(await chain.allowance(snapshot.etherfi.eETH, session.actor, snapshot.etherfi.weETH)).toBe(0n);
    record(
      `divergence drill: halted — predicted ${halt.predictedWei} attributed ${halt.attributedWei} ` +
        `tolerance ${halt.toleranceWei} tx ${halted.result.receipt.txHash}`,
    );

    // Idempotent replay of the halted index: the recorded result, no new transaction.
    const nonceBefore = await nonceAt(url, session.actor);
    const headBefore = await blockNumberAt(url);
    expect(await caller.executeStep({ sessionKey: key, planHash, stepIndex: 2 })).toEqual(halted);
    expect(await nonceAt(url, session.actor)).toBe(nonceBefore);
    expect(await blockNumberAt(url)).toBe(headBefore);

    // The session pins halted: the suffix refuses with the same evidence, nothing dispatches.
    for (const stepIndex of [3, 12]) {
      const refused = await caller.executeStep({ sessionKey: key, planHash, stepIndex });
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error("unreachable");
      expect(refused.refusal).toEqual({ kind: "halted", halt });
    }
    expect(await nonceAt(url, session.actor)).toBe(3n);

    const summary = await caller.session({ sessionKey: key });
    if (!summary.ok) throw new Error("session summary refused");
    expect(summary.session.phase).toEqual({ kind: "halted", halt });
    expect(summary.session.executed).toHaveLength(3);
    expect(summary.session.executed[2]?.status).toBe("halted");
    record("divergence drill: session pinned halted, replay idempotent, suffix refused");

    await destroySession(key);
  });

  it("recovery drills: persistence-failed and dispatch-unresolved both reconcile from the fork's history without re-sending", async () => {
    const { key, session } = await createSession();
    const { planHash } = await planFlagship(key);
    const url = session.fork.rpcUrl;

    // ————— Cell A (§9.9 / D3): the registry append fails AFTER the deposit confirms —————
    failNextAppend = true;
    const persisted = await caller.executeStep({ sessionKey: key, planHash, stepIndex: 0 });
    expect(failNextAppend).toBe(false);
    if (!persisted.ok) throw new Error(`deposit refused: ${JSON.stringify(persisted.refusal)}`);
    if (persisted.result.status !== "persistence-failed") {
      throw new Error(`deposit settled as ${persisted.result.status}, expected persistence-failed`);
    }
    // Receipt AND measurement both survive the failure (the moment-bound after-read was
    // taken immediately, D3): the receipt is real and mined, the measurement is measured.
    const cellAReceipt = persisted.result.receipt;
    expect(cellAReceipt.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const cellAMeasurement = persisted.result.measurement;
    if (cellAMeasurement.status !== "measured") {
      throw new Error("persistence cell lost its measurement");
    }
    expect(cellAMeasurement.beforeShares).toBe("0");
    expect(BigInt(cellAMeasurement.sharesDelta ?? "0") > 0n).toBe(true);
    expect(await nonceAt(url, session.actor)).toBe(1n);

    // No further executeStep is served before reconciliation.
    const blockedA = await caller.executeStep({ sessionKey: key, planHash, stepIndex: 1 });
    expect(blockedA.ok).toBe(false);
    if (blockedA.ok) throw new Error("unreachable");
    expect(blockedA.refusal).toEqual({ kind: "reconcile-required" });

    // D11: the wire summary carries the recovery payload a client rehydrates from.
    const summaryA = await caller.session({ sessionKey: key });
    if (!summaryA.ok) throw new Error("session summary refused");
    expect(summaryA.session.phase).toEqual({ kind: "reconcile-required", pendingKind: "persistence" });
    expect(summaryA.session.recovery?.kind).toBe("reconcile-persistence");

    // Reconciliation verifies the retained receipt against the fork's own history and
    // settles — never re-sends (nonce and head unchanged across the call).
    const headBeforeReconcileA = await blockNumberAt(url);
    const reconciledA = await caller.reconcile({ sessionKey: key });
    if (!reconciledA.ok) throw new Error(`reconcile refused: ${JSON.stringify(reconciledA.refusal)}`);
    if (reconciledA.result.status !== "attributed") {
      throw new Error(`reconcile settled as ${reconciledA.result.status}`);
    }
    expect(reconciledA.result.stepId).toBe("stake1:deposit");
    expect(reconciledA.result.receipt).toEqual(cellAReceipt);
    expect(reconciledA.result.output?.mechanism).toBe("share-delta");
    expect(await nonceAt(url, session.actor)).toBe(1n);
    expect(await blockNumberAt(url)).toBe(headBeforeReconcileA);
    // The reconciled record is the durable truth: an idempotent replay returns it.
    const replayA = await caller.executeStep({ sessionKey: key, planHash, stepIndex: 0 });
    if (!replayA.ok) throw new Error("replay refused");
    expect(replayA.result).toEqual(reconciledA.result);
    record(
      `recovery cell A: persistence-failed with receipt ${cellAReceipt.txHash} + measured ` +
        `delta ${cellAMeasurement.sharesDelta}; reconciled without a new transaction`,
    );

    // ————— Cell B (§9.9 / D6): the confirmation response drops AFTER the approve dispatches —————
    dropNextConfirm = true;
    const unresolved = await caller.executeStep({ sessionKey: key, planHash, stepIndex: 1 });
    expect(dropNextConfirm).toBe(false);
    if (!unresolved.ok) throw new Error(`approve refused: ${JSON.stringify(unresolved.refusal)}`);
    if (unresolved.result.status !== "dispatch-unresolved") {
      throw new Error(`approve settled as ${unresolved.result.status}, expected dispatch-unresolved`);
    }
    // The intent kept its hash — the transaction really landed; only the response was lost.
    const cellBHash = unresolved.result.txHash;
    if (cellBHash === null) throw new Error("dispatch intent lost its hash");
    expect(await nonceAt(url, session.actor)).toBe(2n);

    const blockedB = await caller.executeStep({ sessionKey: key, planHash, stepIndex: 2 });
    expect(blockedB.ok).toBe(false);
    if (blockedB.ok) throw new Error("unreachable");
    expect(blockedB.refusal).toEqual({ kind: "reconcile-required" });

    const summaryB = await caller.session({ sessionKey: key });
    if (!summaryB.ok) throw new Error("session summary refused");
    expect(summaryB.session.phase).toEqual({ kind: "reconcile-required", pendingKind: "dispatch" });
    const recoveryB = summaryB.session.recovery;
    if (recoveryB?.kind !== "reconcile-dispatch") {
      throw new Error(`recovery payload kind ${recoveryB?.kind ?? "null"}`);
    }
    expect(recoveryB.txHash).toBe(cellBHash);
    expect(recoveryB.preNonce).toBe("1");

    // Discovery, never re-send: the receipt is found by hash in the fork's history and
    // adopted; the nonce does not move.
    const reconciledB = await caller.reconcile({ sessionKey: key });
    if (!reconciledB.ok) throw new Error(`reconcile refused: ${JSON.stringify(reconciledB.refusal)}`);
    if (reconciledB.result.status !== "attributed") {
      throw new Error(`reconcile settled as ${reconciledB.result.status}`);
    }
    expect(reconciledB.result.stepId).toBe("wrap1:approve");
    expect(reconciledB.result.receipt.txHash).toBe(cellBHash);
    expect(await nonceAt(url, session.actor)).toBe(2n);
    record(
      `recovery cell B: dispatch-unresolved with intent hash ${cellBHash}; ` +
        "reconciliation adopted the mined receipt without re-sending",
    );

    // The recovered session executes on: the wrap resolves through BOTH reconciled records
    // (deposit's share delta, approve's once-resolved amount) and spends the approval fully.
    const wrapped = await executeAttributed(key, planHash, 2);
    if (!wrapped.ok || wrapped.result.status !== "attributed") throw new Error("unreachable");
    expect(wrapped.result.consumedApproval?.residualAllowanceWei).toBe("0");
    expect(await nonceAt(url, session.actor)).toBe(3n);
    const summaryEnd = await caller.session({ sessionKey: key });
    if (!summaryEnd.ok) throw new Error("session summary refused");
    expect(summaryEnd.session.phase).toEqual({ kind: "active" });
    expect(summaryEnd.session.txCount).toBe(3);
    record("recovery drills: session fully live after both cells; wrap green with zero residual");

    await destroySession(key);
  });

  it("resumption drill: a fresh client rehydrates the frozen plan from the wire and completes without re-dispatching the prefix", async () => {
    const { key, session } = await createSession();
    const { planHash } = await planFlagship(key);
    const url = session.fork.rpcUrl;

    // The client's FROZEN plan (§2.3): built from an independent capture of the SAME
    // session fork at its verified base — and proven to be THE plan by hash identity
    // against the server's own planHash (§5.3: block-hash-verified identical).
    const clientSnapshot = await captureSessionSnapshot(session.fork, session.actor);
    const clientPlan = buildPlan(flagshipGraph(), clientSnapshot);
    if (!clientPlan.ok) throw new Error(`client plan failed: ${JSON.stringify(clientPlan.errors)}`);
    expect(planHashOf(clientPlan.steps)).toBe(planHash);

    // Client one executes the prefix.
    const prefix = [
      await executeAttributed(key, planHash, 0),
      await executeAttributed(key, planHash, 1),
      await executeAttributed(key, planHash, 2),
    ];
    const nonceAtDrop = await nonceAt(url, session.actor);
    expect(nonceAtDrop).toBe(3n);

    // The client drops. A NEW router caller (fresh transport, no shared machine state)
    // queries server truth; the wire payload is JSON-round-tripped deliberately — the
    // rehydration contract is JSON-safe by explicit mapping, and this proves it.
    const caller2 = createSandboxCaller(ctx);
    const response = JSON.parse(
      JSON.stringify(await caller2.session({ sessionKey: key })),
    ) as WireSessionResponse;
    const resumed = resumePlan({ plan: clientPlan, planHash, response });
    if (!resumed.ok) throw new Error(`resume refused: ${JSON.stringify(resumed.refusal)}`);
    const machine = resumed.machine;

    // The machine rehydrates to exactly the server truth: settled prefix identity by
    // step id AND transaction hash, next index implied by the attributed phase.
    expect(machine.phase).toEqual({ kind: "attributed", stepIndex: 2 });
    expect(machine.planHash).toBe(planHash);
    const machineRecord = machine.record;
    if (machineRecord === null) throw new Error("resumed machine carries no execution record");
    expect(machineRecord.settled).toHaveLength(3);
    machineRecord.settled.forEach((settled, i) => {
      const wire = prefix[i];
      if (wire === undefined || !wire.ok || wire.result.status !== "attributed") {
        throw new Error("unreachable");
      }
      expect(settled.stepIndex).toBe(i);
      expect(settled.stepId).toBe(clientPlan.steps[i]?.id);
      expect(settled.receipt.txHash).toBe(wire.result.receipt.txHash);
      // Adopted, never re-derived: resumePlan is pure (no reads are injected), so the
      // resolved amounts can only have come off the wire record.
      expect(settled.resolvedAmountWei).toBe(
        wire.result.resolvedAmountWei === null ? null : BigInt(wire.result.resolvedAmountWei),
      );
    });
    // Rehydration itself dispatched nothing.
    expect(await nonceAt(url, session.actor)).toBe(nonceAtDrop);

    // Cross-client idempotency: the new caller replays a settled index and receives the
    // recorded result — the server truth survives the client that produced it.
    const replayed = await caller2.executeStep({ sessionKey: key, planHash, stepIndex: 0 });
    expect(replayed).toEqual(prefix[0]);
    expect(await nonceAt(url, session.actor)).toBe(nonceAtDrop);

    // CONTINUE from the machine's next index to completion through the new caller.
    for (let stepIndex = machineRecord.settled.length; stepIndex < FLAGSHIP_STEP_COUNT; stepIndex += 1) {
      const outcome = await caller2.executeStep({ sessionKey: key, planHash, stepIndex });
      if (!outcome.ok) throw new Error(`step ${stepIndex} refused: ${JSON.stringify(outcome.refusal)}`);
      if (outcome.result.status !== "attributed") {
        throw new Error(`step ${stepIndex} settled as ${outcome.result.status}`);
      }
    }

    // Zero re-dispatch of settled steps, proven by counting: 13 steps, 13 transactions,
    // 13 distinct hashes — the prefix's three are among them exactly once.
    expect(await nonceAt(url, session.actor)).toBe(13n);
    const final = await caller2.session({ sessionKey: key });
    if (!final.ok) throw new Error("final summary refused");
    expect(final.session.txCount).toBe(13);
    expect(final.session.executed).toHaveLength(13);
    expect(final.session.executed.every((step) => step.status === "attributed")).toBe(true);
    const hashes = final.session.executed.map((step) =>
      step.status === "attributed" ? step.receipt.txHash : "",
    );
    expect(new Set(hashes).size).toBe(13);

    // Close the loop through the machine: rehydrating from the FINAL wire summary lands
    // the complete phase over the full settled record.
    const finalResponse = JSON.parse(
      JSON.stringify(await caller2.session({ sessionKey: key })),
    ) as WireSessionResponse;
    const completed = resumePlan({ plan: clientPlan, planHash, response: finalResponse });
    if (!completed.ok) throw new Error(`final resume refused: ${JSON.stringify(completed.refusal)}`);
    expect(completed.machine.phase).toEqual({ kind: "complete" });
    if (completed.machine.record === null) throw new Error("completed machine carries no record");
    expect(completed.machine.record.settled).toHaveLength(13);
    record(
      "resumption drill: rehydrated at index 3 from the wire, completed 13/13 with " +
        "13 transactions total — zero prefix re-dispatch",
    );

    await destroySession(key);
  });
});
