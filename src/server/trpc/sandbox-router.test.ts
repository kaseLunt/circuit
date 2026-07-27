/**
 * Router-level proofs with a fake fork backend: the A3 property (no schema field for
 * client calldata, strict objects refuse unknown keys), the designed-refusal payloads,
 * and the JSON-safety of every wire view (a stray bigint makes JSON.stringify throw,
 * so serializing the whole response IS the assertion). The deep wire run drives the
 * REAL flagship plan through deposit → approve → wrap → set-emode → approve → supply,
 * so every result facet — output pair, approval facts, consumed approval, HF reading —
 * crosses the wire once.
 */
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { HF_NO_DEBT } from "../../core/health-factor";
import { encodeShareGraph } from "../../lib/share/encode";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import {
  scriptedChain,
  transferLog,
  type ChainScript,
} from "../../../tests/helpers/sandbox-chain";
import { sandboxSnapshot, SANDBOX_USER } from "../../lib/recorded-reads/sandbox-snapshot";
import {
  createSessionRegistry,
  type SessionFork,
  type SessionRegistry,
} from "../sandbox/session-registry";
import type { SandboxChain } from "../sandbox/execute-step";
import { createSandboxCaller, type SandboxContext } from "./sandbox-router";

const BASE_HASH = `0x${"ab".repeat(32)}` as Hex;
const WAD = 10n ** 18n;

const shareToken = (() => {
  const encoded = encodeShareGraph(flagshipGraph());
  if (!encoded.ok) throw new Error("fixture graph refused by the share codec");
  return encoded.token;
})();

function forkWith(actor: Address): SessionFork {
  return {
    rpcUrl: "http://127.0.0.1:9999",
    baseBlock: 100n,
    baseBlockHash: BASE_HASH,
    actor,
    async reset() {
      return { actor };
    },
    async destroy() {},
  };
}

function testContext(
  chain: SandboxChain,
  options: { maxSessions?: number } = {},
): { ctx: SandboxContext; caller: ReturnType<typeof createSandboxCaller>; store: SessionRegistry } {
  const store = createSessionRegistry({
    maxSessions: options.maxSessions !== undefined ? options.maxSessions : 4,
    ttlMs: 60_000,
    maxTxPerSession: 32,
    minExecuteIntervalMs: 0,
  });
  const ctx: SandboxContext = {
    store,
    spawnFork: async () => forkWith(SANDBOX_USER),
    chainFor: () => chain,
    captureSnapshot: async () => sandboxSnapshot(),
  };
  return { ctx, caller: createSandboxCaller(ctx), store };
}

const idleChain = (): SandboxChain => scriptedChain({});

/** Create + plan the real flagship document, then swap in a per-test chain script. */
async function plannedFixture(script: (predicted: {
  deposit: bigint;
  wrap: bigint;
  wrapTo: Address;
}) => ChainScript, failAppend = false) {
  const fixture = testContext(idleChain());
  const created = await fixture.caller.create();
  if (!created.ok) throw new Error("create refused");
  const planned = await fixture.caller.plan({
    sessionKey: created.session.sessionKey,
    document: shareToken,
  });
  if (!planned.ok) throw new Error("plan refused");
  const looked = await fixture.store.lookup(created.session.sessionKey);
  if (!looked.ok) throw new Error("session vanished");
  const recorded = looked.session.plan!;
  const predicted = {
    deposit: recorded.predictedOutputs.get("stake1:deposit")!,
    wrap: recorded.predictedOutputs.get("wrap1:wrap")!,
    wrapTo: recorded.plan.steps[2]!.to,
  };
  const chain = scriptedChain(script(predicted));
  const store = failAppend
    ? {
        ...fixture.store,
        appendConfirmed: () => {
          throw new Error("registry append failed (injected)");
        },
      }
    : fixture.store;
  const ctx: SandboxContext = { ...fixture.ctx, store, chainFor: () => chain };
  return {
    caller: createSandboxCaller(ctx),
    healthyCaller: createSandboxCaller({ ...fixture.ctx, chainFor: () => chain }),
    store: fixture.store,
    chain,
    sessionKey: created.session.sessionKey,
    planHash: planned.plan.planHash,
    predicted,
  };
}

describe("create/session lifecycle over the wire", () => {
  it("creates a session and returns a JSON-safe identity view", async () => {
    const { caller } = testContext(idleChain());
    const created = await caller.create();
    if (!created.ok) throw new Error("create refused");
    expect(created.session.sessionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(created.session.baseBlock).toBe("100");
    expect(created.session.baseBlockHash).toBe(BASE_HASH);
    expect(created.session.actor).toBe(SANDBOX_USER);
    expect(() => JSON.stringify(created)).not.toThrow();
  });

  it("refuses at capacity with the designed state", async () => {
    const { caller } = testContext(idleChain(), { maxSessions: 1 });
    expect((await caller.create()).ok).toBe(true);
    const second = await caller.create();
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.refusal).toEqual({ kind: "at-capacity" });
  });

  it("answers an unknown (but well-shaped) key with unknown-session", async () => {
    const { caller } = testContext(idleChain());
    const looked = await caller.session({ sessionKey: "0".repeat(64) });
    expect(looked.ok).toBe(false);
    if (looked.ok) throw new Error("unreachable");
    expect(looked.refusal).toEqual({ kind: "unknown-session" });
  });
});

describe("plan over the wire", () => {
  it("plans the flagship document and returns the recorded hash and a JSON-safe view", async () => {
    const { caller } = testContext(idleChain());
    const created = await caller.create();
    if (!created.ok) throw new Error("create refused");
    const planned = await caller.plan({ sessionKey: created.session.sessionKey, document: shareToken });
    if (!planned.ok) throw new Error(`plan refused: ${JSON.stringify(planned)}`);
    expect(planned.plan.stepCount).toBe(13);
    expect(planned.plan.planHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(planned.plan.steps).toHaveLength(13);
    const literal = planned.plan.steps[0]!.amount;
    if (literal.kind !== "literal") throw new Error("step 1 should carry the input literal");
    expect(literal.wei).toBe((10n * WAD).toString());
    for (const flow of planned.plan.flows) {
      if (flow.outputWei !== null) expect(typeof flow.outputWei).toBe("string");
    }
    expect(() => JSON.stringify(planned)).not.toThrow();
  });

  it("refuses an undecodable document with the codec's own failure", async () => {
    const { caller } = testContext(idleChain());
    const created = await caller.create();
    if (!created.ok) throw new Error("create refused");
    const planned = await caller.plan({ sessionKey: created.session.sessionKey, document: "%%%" });
    expect(planned.ok).toBe(false);
    if (planned.ok) throw new Error("unreachable");
    expect(planned.refusal.kind).toBe("document-refused");
  });
});

describe("the deep wire run: deposit through supply", () => {
  it("carries output, approval, consumed-approval, and HF facets across the wire, JSON-safe", async () => {
    const { caller, sessionKey, planHash, predicted } = await plannedFixture((p) => ({
      shares: [0n, 500n],
      amountForShare: () => p.deposit,
      allowances: [0n, 0n, 0n, 0n],
      healthFactors: [HF_NO_DEBT],
      sends: [{}, {}, { logs: [transferLog(p.wrapTo, p.wrapTo, SANDBOX_USER, p.wrap)] }, {}, {}, {}],
    }));

    const results = [];
    for (let stepIndex = 0; stepIndex < 6; stepIndex += 1) {
      const outcome = await caller.executeStep({ sessionKey, planHash, stepIndex });
      if (!outcome.ok) throw new Error(`step ${stepIndex} refused: ${JSON.stringify(outcome)}`);
      if (outcome.result.status !== "attributed") {
        throw new Error(`step ${stepIndex} settled as ${outcome.result.status}`);
      }
      expect(() => JSON.stringify(outcome)).not.toThrow();
      results.push(outcome.result);
    }

    expect(results[0]!.output).toEqual({
      mechanism: "share-delta",
      predictedWei: predicted.deposit.toString(),
      attributedWei: predicted.deposit.toString(),
      toleranceWei: (predicted.deposit / 10n ** 6n).toString(),
    });
    expect(results[0]!.receipt.gasUsed).toBe("21000");
    expect(results[1]!.approval).toEqual({
      spender: predicted.wrapTo,
      priorAllowanceWei: "0",
      approvedWei: predicted.deposit.toString(),
    });
    expect(results[2]!.consumedApproval).toEqual({
      spender: predicted.wrapTo,
      residualAllowanceWei: "0",
    });
    expect(results[2]!.output?.mechanism).toBe("transfer-event");
    // supply1:supply carries the §5.4 cross-check reading: no debt yet, sentinel exact.
    expect(results[5]!.risk).toEqual({
      expected: { status: "no-debt" },
      chainHfWad: HF_NO_DEBT.toString(),
    });

    const summary = await caller.session({ sessionKey });
    if (!summary.ok) throw new Error("session query refused");
    expect(summary.session.executed).toHaveLength(6);
    expect(() => JSON.stringify(summary)).not.toThrow();
  });

  it("replays idempotently over the wire with an identical view", async () => {
    const { caller, chain, sessionKey, planHash } = await plannedFixture((p) => ({
      shares: [0n, 500n],
      amountForShare: () => p.deposit,
      sends: [{}],
    }));
    const first = await caller.executeStep({ sessionKey, planHash, stepIndex: 0 });
    const replay = await caller.executeStep({ sessionKey, planHash, stepIndex: 0 });
    expect(replay).toEqual(first);
    expect(chain.dispatches).toHaveLength(1);
    expect(chain.landed).toHaveLength(1);
  });

  it("surfaces sequencing refusals as designed states", async () => {
    const { caller, sessionKey, planHash } = await plannedFixture(() => ({}));
    const outcome = await caller.executeStep({ sessionKey, planHash, stepIndex: 7 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal).toEqual({ kind: "out-of-order", expectedIndex: 0 });
  });

  it("reconcile on a healthy session is the designed nothing-to-reconcile state", async () => {
    const { caller, sessionKey } = await plannedFixture(() => ({}));
    const outcome = await caller.reconcile({ sessionKey });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal).toEqual({ kind: "nothing-to-reconcile" });
  });
});

describe("failure states arrive as renderable views", () => {
  it("renders a revert as the failed view, pins the session, and reports it on re-dispatch", async () => {
    const { caller, sessionKey, planHash } = await plannedFixture(() => ({
      shares: [0n],
      sends: [{ revert: true }],
      revertData: "0xdeadbeef",
    }));
    const outcome = await caller.executeStep({ sessionKey, planHash, stepIndex: 0 });
    if (!outcome.ok) throw new Error("revert should be a result");
    if (outcome.result.status !== "failed") throw new Error(`got ${outcome.result.status}`);
    expect(outcome.result.failure.raw).toBe("0xdeadbeef");
    expect(() => JSON.stringify(outcome)).not.toThrow();

    const looked = await caller.session({ sessionKey });
    if (!looked.ok) throw new Error("session query refused");
    expect(looked.session.phase.kind).toBe("failed");
    expect(() => JSON.stringify(looked)).not.toThrow();

    const next = await caller.executeStep({ sessionKey, planHash, stepIndex: 1 });
    expect(next.ok).toBe(false);
    if (next.ok) throw new Error("unreachable");
    expect(next.refusal.kind).toBe("failed");
    expect(() => JSON.stringify(next)).not.toThrow();
  });

  it("renders output divergence as the halted view with the string evidence pair", async () => {
    const { caller, sessionKey, planHash, predicted } = await plannedFixture(() => ({
      shares: [0n, 500n],
      amountForShare: () => 0n,
      sends: [{}],
    }));
    const outcome = await caller.executeStep({ sessionKey, planHash, stepIndex: 0 });
    if (!outcome.ok) throw new Error("divergence should be a result");
    if (outcome.result.status !== "halted") throw new Error(`got ${outcome.result.status}`);
    if (outcome.result.halt.kind !== "output-divergence") throw new Error("wrong halt kind");
    expect(outcome.result.halt.predictedWei).toBe(predicted.deposit.toString());
    expect(outcome.result.halt.attributedWei).toBe("0");
    expect(() => JSON.stringify(outcome)).not.toThrow();

    const summary = await caller.session({ sessionKey });
    if (!summary.ok) throw new Error("session query refused");
    expect(summary.session.phase.kind).toBe("halted");
    expect(() => JSON.stringify(summary)).not.toThrow();

    const next = await caller.executeStep({ sessionKey, planHash, stepIndex: 1 });
    expect(next.ok).toBe(false);
    if (next.ok) throw new Error("unreachable");
    expect(next.refusal.kind).toBe("halted");
    expect(() => JSON.stringify(next)).not.toThrow();
  });

  it("renders a residual allowance as the halted data-error view", async () => {
    const { caller, sessionKey, planHash } = await plannedFixture((p) => ({
      shares: [0n, 500n],
      amountForShare: () => p.deposit,
      allowances: [0n, 5n],
      sends: [{}, {}, { logs: [transferLog(p.wrapTo, p.wrapTo, SANDBOX_USER, p.wrap)] }],
    }));
    for (let stepIndex = 0; stepIndex < 2; stepIndex += 1) {
      const ok = await caller.executeStep({ sessionKey, planHash, stepIndex });
      expect(ok.ok).toBe(true);
    }
    const outcome = await caller.executeStep({ sessionKey, planHash, stepIndex: 2 });
    if (!outcome.ok) throw new Error("should be a result");
    if (outcome.result.status !== "halted") throw new Error(`got ${outcome.result.status}`);
    if (outcome.result.halt.kind !== "residual-allowance") throw new Error("wrong halt kind");
    expect(outcome.result.halt.residualAllowanceWei).toBe("5");
    expect(() => JSON.stringify(outcome)).not.toThrow();
  });

  it("renders an HF disagreement as the halted data-error view", async () => {
    const { caller, sessionKey, planHash } = await plannedFixture((p) => ({
      shares: [0n, 500n],
      amountForShare: () => p.deposit,
      allowances: [0n, 0n, 0n, 0n],
      healthFactors: [HF_NO_DEBT - 1n],
      sends: [{}, {}, { logs: [transferLog(p.wrapTo, p.wrapTo, SANDBOX_USER, p.wrap)] }, {}, {}, {}],
    }));
    for (let stepIndex = 0; stepIndex < 5; stepIndex += 1) {
      const ok = await caller.executeStep({ sessionKey, planHash, stepIndex });
      expect(ok.ok).toBe(true);
    }
    const outcome = await caller.executeStep({ sessionKey, planHash, stepIndex: 5 });
    if (!outcome.ok) throw new Error("should be a result");
    if (outcome.result.status !== "halted") throw new Error(`got ${outcome.result.status}`);
    if (outcome.result.halt.kind !== "hf-disagreement") throw new Error("wrong halt kind");
    expect(outcome.result.halt.expected).toEqual({ status: "no-debt" });
    expect(outcome.result.halt.chainHfWad).toBe((HF_NO_DEBT - 1n).toString());
    expect(() => JSON.stringify(outcome)).not.toThrow();
  });

  it("renders attribution-unavailable with its recovery view, and completes on re-entry (finding 5)", async () => {
    const { caller, store, predicted, sessionKey, planHash } = await plannedFixture(() => ({
      shares: [0n, "throw"],
      sends: [{}],
    }));
    const pending = await caller.executeStep({ sessionKey, planHash, stepIndex: 0 });
    if (!pending.ok) throw new Error("should be a result");
    if (pending.result.status !== "attribution-unavailable") {
      throw new Error(`got ${pending.result.status}`);
    }
    expect(pending.result.beforeShares).toBe("0");
    expect(() => JSON.stringify(pending)).not.toThrow();

    // The session query carries everything a reload needs to rehydrate the state:
    // step identity, the confirmed receipt, and the retained beforeShares.
    const summary = await caller.session({ sessionKey });
    if (!summary.ok) throw new Error("session query refused");
    expect(summary.session.phase).toEqual({ kind: "attribution-pending", stepIndex: 0 });
    const recovery = summary.session.recovery;
    if (recovery === null || recovery.kind !== "attribution-pending") {
      throw new Error("expected attribution-pending recovery view");
    }
    expect(recovery.stepId).toBe("stake1:deposit");
    expect(recovery.receipt.txHash).toBe(pending.result.receipt.txHash);
    expect(recovery.beforeShares).toBe("0");
    expect(() => JSON.stringify(summary)).not.toThrow();

    const retryChain = scriptedChain({
      shares: [500n],
      amountForShare: () => predicted.deposit,
    });
    const retryCaller = createSandboxCaller({
      store,
      spawnFork: async () => forkWith(SANDBOX_USER),
      chainFor: () => retryChain,
      captureSnapshot: async () => sandboxSnapshot(),
    });
    const resumed = await retryCaller.executeStep({ sessionKey, planHash, stepIndex: 0 });
    if (!resumed.ok) throw new Error("re-entry refused");
    expect(resumed.result.status).toBe("attributed");
  });

  it("renders persistence-failed with its measurement and recovery view, then reconciles over the wire", async () => {
    const { caller, healthyCaller, store, chain, sessionKey, planHash } = await plannedFixture(
      (p) => ({
        shares: [0n, "throw", 700n],
        amountForShare: () => p.deposit,
        sends: [{}],
      }),
      true,
    );
    const outcome = await caller.executeStep({ sessionKey, planHash, stepIndex: 0 });
    if (!outcome.ok) throw new Error("should be a result");
    if (outcome.result.status !== "persistence-failed") throw new Error(`got ${outcome.result.status}`);
    expect(outcome.result.measurement).toEqual({
      status: "unavailable",
      beforeShares: "0",
      cause: expect.stringContaining("sharesOf failure") as string,
    });
    expect(() => JSON.stringify(outcome)).not.toThrow();

    // The rehydration read carries the receipt-backed pending facts (finding 5).
    const summary = await healthyCaller.session({ sessionKey });
    if (!summary.ok) throw new Error("session query refused");
    expect(summary.session.phase).toEqual({
      kind: "reconcile-required",
      pendingKind: "persistence",
    });
    const recovery = summary.session.recovery;
    if (recovery === null || recovery.kind !== "reconcile-persistence") {
      throw new Error("expected reconcile-persistence recovery view");
    }
    expect(recovery.stepId).toBe("stake1:deposit");
    expect(recovery.receipt.txHash).toBe(outcome.result.receipt.txHash);
    expect(recovery.measurement).toMatchObject({ status: "unavailable", beforeShares: "0" });
    expect(() => JSON.stringify(summary)).not.toThrow();

    // A fork that does not corroborate the retained receipt refuses to reconcile
    // (a fresh scripted chain has an empty ledger, standing in for a fork that lost it).
    const blankCaller = createSandboxCaller({
      store,
      spawnFork: async () => forkWith(SANDBOX_USER),
      chainFor: () => scriptedChain({}),
      captureSnapshot: async () => sandboxSnapshot(),
    });
    const mismatch = await blankCaller.reconcile({ sessionKey });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error("unreachable");
    expect(mismatch.refusal.kind).toBe("reconcile-mismatch");

    // The real fork corroborates: reconciliation restores the record without re-sending.
    const reconciled = await healthyCaller.reconcile({ sessionKey });
    if (!reconciled.ok) throw new Error("reconcile refused");
    expect(reconciled.result.status).toBe("attributed");
    expect(chain.dispatches).toHaveLength(1);
    expect(() => JSON.stringify(reconciled)).not.toThrow();
  });

  it("renders dispatch-unresolved with its recovery view, vacates, and re-arms (finding 2/5)", async () => {
    const { caller, sessionKey, planHash } = await plannedFixture(() => ({
      shares: [0n],
      sends: [{ dispatchError: "socket hung up" }],
    }));
    const outcome = await caller.executeStep({ sessionKey, planHash, stepIndex: 0 });
    if (!outcome.ok) throw new Error("should be a result");
    if (outcome.result.status !== "dispatch-unresolved") throw new Error(`got ${outcome.result.status}`);
    expect(outcome.result.txHash).toBeNull();
    expect(() => JSON.stringify(outcome)).not.toThrow();

    const summary = await caller.session({ sessionKey });
    if (!summary.ok) throw new Error("session query refused");
    expect(summary.session.phase).toEqual({ kind: "reconcile-required", pendingKind: "dispatch" });
    const recovery = summary.session.recovery;
    if (recovery === null || recovery.kind !== "reconcile-dispatch") {
      throw new Error("expected reconcile-dispatch recovery view");
    }
    expect(recovery.stepId).toBe("stake1:deposit");
    expect(recovery.txHash).toBeNull();
    expect(recovery.preNonce).toBe("0");
    expect(() => JSON.stringify(summary)).not.toThrow();

    const vacated = await caller.reconcile({ sessionKey });
    if (!vacated.ok) throw new Error("reconcile refused");
    expect(vacated.result.status).toBe("dispatch-vacated");
    const after = await caller.session({ sessionKey });
    if (!after.ok) throw new Error("session query refused");
    expect(after.session.phase).toEqual({ kind: "active" });
  });

  it("surfaces a failed transactional reset as the designed reset-failed state (finding 6)", async () => {
    const store = createSessionRegistry({
      maxSessions: 4,
      ttlMs: 60_000,
      maxTxPerSession: 32,
      minExecuteIntervalMs: 0,
    });
    const failingResetFork: SessionFork = {
      rpcUrl: "http://127.0.0.1:9999",
      baseBlock: 100n,
      baseBlockHash: BASE_HASH,
      actor: SANDBOX_USER,
      async reset() {
        throw new Error("anvil_reset landed nowhere verifiable");
      },
      async destroy() {},
    };
    const ctx: SandboxContext = {
      store,
      spawnFork: async () => failingResetFork,
      chainFor: () => idleChain(),
      captureSnapshot: async () => sandboxSnapshot(),
    };
    const caller = createSandboxCaller(ctx);
    const created = await caller.create();
    if (!created.ok) throw new Error("create refused");
    const reset = await caller.reset({ sessionKey: created.session.sessionKey });
    expect(reset.ok).toBe(false);
    if (reset.ok) throw new Error("unreachable");
    expect(reset.refusal).toEqual({ kind: "reset-failed" });
    // The invalidated session's key now answers with its tombstone.
    const looked = await caller.session({ sessionKey: created.session.sessionKey });
    expect(looked.ok).toBe(false);
    if (looked.ok) throw new Error("unreachable");
    expect(looked.refusal.kind).toBe("session-expired");
  });
});

describe("A3: the schemas have no field calldata could ride in", () => {
  it("rejects unknown keys outright — to/data/amount cannot be smuggled", async () => {
    const { caller } = testContext(idleChain());
    const created = await caller.create();
    if (!created.ok) throw new Error("create refused");
    const sessionKey = created.session.sessionKey;
    const planHash = `0x${"11".repeat(32)}`;
    await expect(
      caller.executeStep({
        sessionKey,
        planHash,
        stepIndex: 0,
        to: "0x000000000000000000000000000000000000dEaD",
      } as never),
    ).rejects.toThrow();
    await expect(
      caller.executeStep({ sessionKey, planHash, stepIndex: 0, data: "0xdeadbeef" } as never),
    ).rejects.toThrow();
    await expect(
      caller.executeStep({ sessionKey, planHash, stepIndex: 0, amount: "1000" } as never),
    ).rejects.toThrow();
    await expect(
      caller.plan({ sessionKey, document: shareToken, calldata: "0x00" } as never),
    ).rejects.toThrow();
  });

  it("rejects malformed session keys and plan hashes at the schema", async () => {
    const { caller } = testContext(idleChain());
    await expect(caller.session({ sessionKey: "not-a-key" })).rejects.toThrow();
    await expect(
      caller.executeStep({ sessionKey: "0".repeat(64), planHash: "not-a-hash", stepIndex: 0 }),
    ).rejects.toThrow();
    await expect(
      caller.executeStep({
        sessionKey: "0".repeat(64),
        planHash: `0x${"11".repeat(32)}`,
        stepIndex: -1,
      }),
    ).rejects.toThrow();
  });
});

describe("reset and destroy over the wire", () => {
  it("reset clears the run and re-arms planning; destroy forgets the key", async () => {
    const { caller } = testContext(idleChain());
    const created = await caller.create();
    if (!created.ok) throw new Error("create refused");
    const key = created.session.sessionKey;
    const planned = await caller.plan({ sessionKey: key, document: shareToken });
    expect(planned.ok).toBe(true);

    const reset = await caller.reset({ sessionKey: key });
    if (!reset.ok) throw new Error("reset refused");
    expect(reset.session.phase).toEqual({ kind: "active" });
    expect(reset.session.planHash).toBeNull();
    expect(reset.session.executed).toHaveLength(0);

    const destroyed = await caller.destroy({ sessionKey: key });
    expect(destroyed.ok).toBe(true);
    const looked = await caller.session({ sessionKey: key });
    expect(looked.ok).toBe(false);
    if (looked.ok) throw new Error("unreachable");
    expect(looked.refusal).toEqual({ kind: "unknown-session" });
  });
});
