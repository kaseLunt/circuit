import { describe, expect, it } from "vitest";
import { getAddress, parseAbi, type Hex } from "viem";
import { configured } from "../../core/provenance";
import type { TransactionStep } from "../../core/plan";
import { receiptMinter, type ConfirmedReceipt } from "../../lib/execution/attribution";
import {
  createSessionRegistry,
  SESSION_KEY_PATTERN,
  type ApprovalFacts,
  type AttributedStepResult,
  type DispatchIntent,
  type SessionFork,
  type RegistryConfig,
  type Session,
  type SessionRegistry,
} from "./session-registry";

const ACTOR = getAddress("0x1111111111111111111111111111111111111111");
const ACTOR_AFTER_RESET = getAddress("0x2222222222222222222222222222222222222222");
const LP = getAddress("0x3333333333333333333333333333333333333333");
const BASE_HASH = `0x${"ab".repeat(32)}` as Hex;

const DEPOSIT_ABI = parseAbi(["function deposit() payable returns (uint256)"]);

function testStep(id = "stake1:deposit"): TransactionStep {
  return {
    id,
    index: 1,
    blockId: "stake1",
    description: "test deposit",
    to: LP,
    abi: DEPOSIT_ABI,
    functionName: "deposit",
    args: [],
    valueSpec: "amount",
    amount: { kind: "literal", amount: configured(10n ** 18n, "TEST_INPUT", "session-registry.test.ts") },
  };
}

let txNonce = 0;
function confirmedReceipt(): ConfirmedReceipt {
  txNonce += 1;
  return receiptMinter("http://127.0.0.1:9999").confirm({
    txHash: `0x${txNonce.toString(16).padStart(64, "0")}` as Hex,
    status: 1n,
    blockNumber: 101n,
    blockHash: `0x${"cd".repeat(32)}` as Hex,
    logs: [],
  });
}

interface FakeFork extends SessionFork {
  destroyed: number;
  resets: number;
  failResets: boolean;
}

function fakeFork(): FakeFork {
  const fork: FakeFork = {
    rpcUrl: "http://127.0.0.1:9999",
    baseBlock: 100n,
    baseBlockHash: BASE_HASH,
    actor: ACTOR,
    destroyed: 0,
    resets: 0,
    failResets: false,
    async reset() {
      fork.resets += 1;
      if (fork.failResets) throw new Error("fork reset failed (injected)");
      return { actor: ACTOR_AFTER_RESET };
    },
    async destroy() {
      fork.destroyed += 1;
    },
  };
  return fork;
}

function config(overrides: Partial<RegistryConfig> & { nowMs?: { value: number } } = {}) {
  // One fake clock drives BOTH tracks by default; the round-5 rollback drills split
  // them deliberately with their own explicit config.
  const clock = overrides.nowMs;
  return {
    maxSessions: overrides.maxSessions !== undefined ? overrides.maxSessions : 4,
    ttlMs: overrides.ttlMs !== undefined ? overrides.ttlMs : 1000,
    maxTxPerSession: overrides.maxTxPerSession !== undefined ? overrides.maxTxPerSession : 8,
    minExecuteIntervalMs:
      overrides.minExecuteIntervalMs !== undefined ? overrides.minExecuteIntervalMs : 0,
    ...(clock !== undefined
      ? { now: () => clock.value, monotonicNow: () => clock.value }
      : {}),
  };
}

function settledResult(stepIndex: number, stepId: string): AttributedStepResult {
  return {
    status: "attributed",
    stepIndex,
    stepId,
    receipt: { txHash: `0x${"00".repeat(32)}` as Hex, blockNumber: 101n, blockHash: BASE_HASH, gasUsed: null },
    resolvedAmountWei: null,
    sharesDelta: null,
    output: null,
    approval: null,
    consumedApproval: null,
    risk: null,
  };
}

const NO_APPROVAL: ApprovalFacts | null = null;

function appendTestEntry(registry: SessionRegistry, session: Session, settle = true): void {
  const step = testStep();
  registry.appendConfirmed(session, {
    stepIndex: session.entries.length,
    stepId: step.id,
    step,
    receipt: confirmedReceipt(),
    resolvedAmount: null,
    approval: NO_APPROVAL,
  });
  if (settle) {
    const index = session.entries.length - 1;
    registry.completeStep(session, index, null, settledResult(index, step.id));
  }
}

function intentFor(session: Session, txHash: Hex | null = null): DispatchIntent {
  const step = testStep();
  return {
    stepIndex: session.entries.length,
    step,
    resolvedAmount: 10n ** 18n,
    approval: NO_APPROVAL,
    beforeShares: 5n,
    preNonce: BigInt(session.entries.length),
    txHash,
  };
}

describe("session creation and keys", () => {
  it("mints distinct 256-bit hex bearer keys", async () => {
    const registry = createSessionRegistry(config());
    const a = await registry.create(async () => fakeFork());
    const b = await registry.create(async () => fakeFork());
    if (!a.ok || !b.ok) throw new Error("creation refused unexpectedly");
    expect(a.session.key).toMatch(SESSION_KEY_PATTERN);
    expect(b.session.key).toMatch(SESSION_KEY_PATTERN);
    expect(a.session.key).not.toBe(b.session.key);
    expect(registry.sessionCount()).toBe(2);
  });

  it("refuses at capacity BEFORE paying for a fork process", async () => {
    const registry = createSessionRegistry(config({ maxSessions: 1 }));
    const first = await registry.create(async () => fakeFork());
    expect(first.ok).toBe(true);
    let spawned = 0;
    const second = await registry.create(async () => {
      spawned += 1;
      return fakeFork();
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.refusal.kind).toBe("at-capacity");
    expect(spawned).toBe(0);
  });

  it("reserves capacity atomically: concurrent creates cannot exceed the cap (finding 3)", async () => {
    const registry = createSessionRegistry(config({ maxSessions: 1 }));
    let spawned = 0;
    const slowSpawn = async (): Promise<SessionFork> => {
      spawned += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return fakeFork();
    };
    const [a, b, c] = await Promise.all([
      registry.create(slowSpawn),
      registry.create(slowSpawn),
      registry.create(slowSpawn),
    ]);
    const succeeded = [a, b, c].filter((r) => r.ok);
    expect(succeeded).toHaveLength(1);
    expect(spawned).toBe(1);
    expect(registry.sessionCount()).toBe(1);
    for (const refused of [a, b, c].filter((r) => !r.ok)) {
      if (refused.ok) throw new Error("unreachable");
      expect(refused.refusal.kind).toBe("at-capacity");
    }
  });

  it("releases the reserved slot when a spawn fails", async () => {
    const registry = createSessionRegistry(config({ maxSessions: 1 }));
    await expect(
      registry.create(async () => {
        throw new Error("spawn failed");
      }),
    ).rejects.toThrow("spawn failed");
    const retry = await registry.create(async () => fakeFork());
    expect(retry.ok).toBe(true);
  });

  it("possession is ownership: only the exact key resolves the session", async () => {
    const registry = createSessionRegistry(config());
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const wrongKey = created.session.key.slice(0, 63) + (created.session.key.endsWith("0") ? "1" : "0");
    const missed = await registry.lookup(wrongKey);
    expect(missed.ok).toBe(false);
    if (missed.ok) throw new Error("unreachable");
    expect(missed.refusal.kind).toBe("unknown-session");
    const hit = await registry.lookup(created.session.key);
    expect(hit.ok).toBe(true);
  });
});

describe("TTL expiry", () => {
  it("expires on the injected clock, destroys the fork, and preserves the executed record (T24)", async () => {
    const nowMs = { value: 0 };
    const registry = createSessionRegistry(config({ ttlMs: 1000, nowMs }));
    const fork = fakeFork();
    const created = await registry.create(async () => fork);
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    appendTestEntry(registry, session);

    nowMs.value = 1001;
    const looked = await registry.lookup(session.key);
    expect(looked.ok).toBe(false);
    if (looked.ok) throw new Error("unreachable");
    if (looked.refusal.kind !== "session-expired") throw new Error(`got ${looked.refusal.kind}`);
    expect(looked.refusal.executedSteps).toBe(1);
    expect(looked.refusal.tombstone.executed).toHaveLength(1);
    expect(looked.refusal.tombstone.recovery).toBeNull();
    expect(fork.destroyed).toBe(1);
    expect(registry.sessionCount()).toBe(0);
  });

  it("never destroys an in-flight session's fork; destruction waits for release (finding 4)", async () => {
    const nowMs = { value: 0 };
    const registry = createSessionRegistry(config({ ttlMs: 1000, nowMs }));
    const fork = fakeFork();
    const created = await registry.create(async () => fork);
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    expect(registry.beginExecution(session).ok).toBe(true);

    nowMs.value = 2000;
    // A concurrent caller sees the expiry, but the fork survives the in-flight op — and what it is
    // told is NOT a tombstone (Codex round-13): the running call can still append to this record,
    // so there is nothing final to hand over yet.
    const during = await registry.lookup(session.key);
    expect(during.ok).toBe(false);
    if (during.ok) throw new Error("unreachable");
    expect(during.refusal.kind).toBe("expiring-in-flight");
    expect(during.refusal).not.toHaveProperty("tombstone");
    expect(fork.destroyed).toBe(0);
    expect(registry.sessionCount()).toBe(1);

    registry.endExecution(session);
    const after = await registry.lookup(session.key);
    expect(after.ok).toBe(false);
    if (after.ok) throw new Error("unreachable");
    expect(after.refusal.kind).toBe("session-expired");
    expect(fork.destroyed).toBe(1);
    expect(registry.sessionCount()).toBe(0);
  });

  it("the record a tombstone carries is final: evidence added in flight lands in it (round-13)", async () => {
    const nowMs = { value: 0 };
    const registry = createSessionRegistry(config({ ttlMs: 1000, nowMs }));
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    expect(registry.beginExecution(session).ok).toBe(true);

    // The TTL passes with the dispatch still outstanding. A caller looking now is told to come
    // back — and this is exactly why: the record it would have been handed is about to change.
    nowMs.value = 2000;
    const during = await registry.lookup(session.key);
    if (during.ok || during.refusal.kind !== "expiring-in-flight") {
      throw new Error(`expected the transient refusal, got ${during.ok ? "ok" : during.refusal.kind}`);
    }

    // The in-flight operation settles its receipt AFTER the boundary, then releases.
    appendTestEntry(registry, session);
    registry.endExecution(session);

    const after = await registry.lookup(session.key);
    if (after.ok || after.refusal.kind !== "session-expired") {
      throw new Error(`expected the tombstone, got ${after.ok ? "ok" : after.refusal.kind}`);
    }
    // The late evidence is in the tombstone. Under the old conflation the first lookup would have
    // handed over a record with zero executed steps, and a client that adopted it would have shown
    // "expired before any step executed" over a step that had in fact landed.
    expect(after.refusal.executedSteps).toBe(1);
    expect(after.refusal.tombstone.executed.length).toBe(1);
  });

  it("tombstones carry pending recovery evidence: attribution-pending cell", async () => {
    const nowMs = { value: 0 };
    const registry = createSessionRegistry(config({ ttlMs: 1000, nowMs }));
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    appendTestEntry(registry, session, false);
    registry.recordMeasurement(session, 0, 42n);
    registry.markAttributionPending(session, 0, 7n);

    nowMs.value = 2000;
    const looked = await registry.lookup(session.key);
    if (looked.ok || looked.refusal.kind !== "session-expired") throw new Error("expected expiry");
    const recovery = looked.refusal.tombstone.recovery;
    if (recovery === null || recovery.kind !== "attribution-pending") {
      throw new Error("expected attribution-pending evidence");
    }
    expect(recovery.stepId).toBe("stake1:deposit");
    expect(recovery.receipt.txHash).toMatch(/^0x/);
    expect(recovery.beforeShares).toBe(7n);
    expect(recovery.sharesDelta).toBe(42n);
  });

  it("tombstones carry pending recovery evidence: persistence and dispatch cells", async () => {
    const nowMs = { value: 0 };
    const registry = createSessionRegistry(config({ ttlMs: 1000, nowMs }));
    const persistence = await registry.create(async () => fakeFork());
    if (!persistence.ok) throw new Error("creation refused");
    const receipt = confirmedReceipt();
    registry.markReconcileRequired(persistence.session, {
      kind: "persistence",
      stepIndex: 0,
      step: testStep(),
      receipt,
      resolvedAmount: 5n,
      approval: NO_APPROVAL,
      measurement: { status: "unavailable", beforeShares: 3n, cause: new Error("post-read failed") },
      cause: new Error("kv down"),
    });
    const dispatch = await registry.create(async () => fakeFork());
    if (!dispatch.ok) throw new Error("creation refused");
    registry.recordDispatchIntent(dispatch.session, intentFor(dispatch.session, `0x${"aa".repeat(32)}`));
    registry.markDispatchUnresolved(dispatch.session, new Error("response lost"));

    nowMs.value = 2000;
    const p = await registry.lookup(persistence.session.key);
    if (p.ok || p.refusal.kind !== "session-expired") throw new Error("expected expiry");
    const pr = p.refusal.tombstone.recovery;
    if (pr === null || pr.kind !== "reconcile-persistence") throw new Error("expected persistence evidence");
    expect(pr.receipt.txHash).toMatch(/^0x/);
    expect(pr.measurement).toMatchObject({ status: "unavailable", beforeShares: 3n });

    const d = await registry.lookup(dispatch.session.key);
    if (d.ok || d.refusal.kind !== "session-expired") throw new Error("expected expiry");
    const dr = d.refusal.tombstone.recovery;
    if (dr === null || dr.kind !== "reconcile-dispatch") throw new Error("expected dispatch evidence");
    expect(dr.txHash).toBe(`0x${"aa".repeat(32)}`);
    expect(dr.beforeShares).toBe(5n);
    expect(dr.preNonce).toBe(0n);
  });

  it("sweeping expired sessions frees capacity for create", async () => {
    const nowMs = { value: 0 };
    const registry = createSessionRegistry(config({ maxSessions: 1, ttlMs: 1000, nowMs }));
    const first = await registry.create(async () => fakeFork());
    expect(first.ok).toBe(true);
    nowMs.value = 2000;
    const second = await registry.create(async () => fakeFork());
    expect(second.ok).toBe(true);
  });

  it("an owner destroy leaves no expiry story — the key is simply unknown afterwards", async () => {
    const registry = createSessionRegistry(config());
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    await registry.destroy(created.session);
    const looked = await registry.lookup(created.session.key);
    expect(looked.ok).toBe(false);
    if (looked.ok) throw new Error("unreachable");
    expect(looked.refusal.kind).toBe("unknown-session");
  });
});

describe("clock-rollback resilience (Codex round-5)", () => {
  it("(a) capacity reclamation: the sweep collects an expired session under a rolled-back wall clock", async () => {
    const wallMs = { value: 1_000_000 };
    const monoMs = { value: 0 };
    const registry = createSessionRegistry({
      maxSessions: 1,
      ttlMs: 1000,
      maxTxPerSession: 8,
      minExecuteIntervalMs: 0,
      now: () => wallMs.value,
      monotonicNow: () => monoMs.value,
    });
    const fork = fakeFork();
    const created = await registry.create(async () => fork);
    if (!created.ok) throw new Error("creation refused");
    // The display stamps come off the wall clock…
    expect(created.session.createdAtMs).toBe(1_000_000);
    expect(created.session.expiresAtMs).toBe(1_001_000);

    // …then the host clock is corrected BACKWARD while real (monotonic) time passes
    // beyond the TTL. Wall-clock enforcement would hold the expiry comparison false
    // forever and pin all the anvil slots; the monotonic track sweeps on schedule.
    wallMs.value = 0;
    monoMs.value = 2000;
    const looked = await registry.lookup(created.session.key);
    expect(looked.ok).toBe(false);
    if (looked.ok) throw new Error("unreachable");
    expect(looked.refusal.kind).toBe("session-expired");
    expect(fork.destroyed).toBe(1);
    expect(registry.sessionCount()).toBe(0);
    // The freed slot is genuinely reusable — capacity was reclaimed, not leaked.
    const next = await registry.create(async () => fakeFork());
    expect(next.ok).toBe(true);
  });

  it("(b) dispatch retry timing: rate-limit windows are not inflated by rollback", async () => {
    const wallMs = { value: 1_000_000 };
    const monoMs = { value: 0 };
    const registry = createSessionRegistry({
      maxSessions: 4,
      ttlMs: 60_000,
      maxTxPerSession: 8,
      minExecuteIntervalMs: 250,
      now: () => wallMs.value,
      monotonicNow: () => monoMs.value,
    });
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    expect(registry.beginExecution(session).ok).toBe(true);
    registry.endExecution(session);

    // The wall clock jumps back an hour. Wall-clock arithmetic would make the elapsed
    // time negative and refuse with a rollback-inflated retryAfterMs; the monotonic
    // track keeps the window exactly 250ms wide.
    wallMs.value = 1_000_000 - 3_600_000;
    monoMs.value = 100;
    const tooSoon = registry.beginExecution(session);
    expect(tooSoon.ok).toBe(false);
    if (tooSoon.ok) throw new Error("unreachable");
    expect(tooSoon.refusal).toEqual({ kind: "rate-limited", retryAfterMs: 150 });

    monoMs.value = 251;
    expect(registry.beginExecution(session).ok).toBe(true);
    registry.endExecution(session);
  });

  it("(c) retryAfterMs crosses the wire as an integer even off a fractional monotonic clock", async () => {
    const monoMs = { value: 0 };
    const registry = createSessionRegistry({
      maxSessions: 4,
      ttlMs: 60_000,
      maxTxPerSession: 8,
      minExecuteIntervalMs: 250,
      now: () => 1_000_000,
      monotonicNow: () => monoMs.value,
    });
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    expect(registry.beginExecution(created.session).ok).toBe(true);
    registry.endExecution(created.session);

    // performance.now() is fractional, and the wire types retryAfterMs as a
    // non-negative INTEGER — the client's strict parser refuses anything else. Found
    // by the §3 steps 5-7 e2e gate: 6.697200000053272 stopped a run as malformed-wire.
    monoMs.value = 243.3028;
    const tooSoon = registry.beginExecution(created.session);
    expect(tooSoon.ok).toBe(false);
    if (tooSoon.ok) throw new Error("unreachable");
    if (tooSoon.refusal.kind !== "rate-limited") throw new Error("expected rate-limited");
    expect(Number.isInteger(tooSoon.refusal.retryAfterMs)).toBe(true);
    // Ceil, never round: the stated wait is never understated. 250 − 243.3028 → 7.
    expect(tooSoon.refusal.retryAfterMs).toBe(7);
  });
});

describe("execution gates", () => {
  it("holds a per-session mutex: concurrent begin is refused, never queued", async () => {
    const registry = createSessionRegistry(config());
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    expect(registry.beginExecution(created.session).ok).toBe(true);
    const second = registry.beginExecution(created.session);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.refusal.kind).toBe("session-busy");
    registry.endExecution(created.session);
    expect(registry.beginExecution(created.session).ok).toBe(true);
  });

  it("rate-limits dispatches below the configured floor", async () => {
    const nowMs = { value: 0 };
    const registry = createSessionRegistry(config({ minExecuteIntervalMs: 250, nowMs }));
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    expect(registry.beginExecution(created.session).ok).toBe(true);
    registry.endExecution(created.session);
    nowMs.value = 100;
    const tooSoon = registry.beginExecution(created.session);
    expect(tooSoon.ok).toBe(false);
    if (tooSoon.ok) throw new Error("unreachable");
    expect(tooSoon.refusal).toEqual({ kind: "rate-limited", retryAfterMs: 150 });
    nowMs.value = 251;
    expect(registry.beginExecution(created.session).ok).toBe(true);
  });

  it("caps per-session transactions, but exclusive operations are never budget-gated", async () => {
    const registry = createSessionRegistry(config({ maxTxPerSession: 2 }));
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    registry.noteTransaction(created.session);
    registry.noteTransaction(created.session);
    const over = registry.beginExecution(created.session);
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error("unreachable");
    expect(over.refusal.kind).toBe("tx-cap");
    // beginExclusive ignores the budget: reconciliation must stay reachable at the cap (D3).
    expect(registry.beginExclusive(created.session).ok).toBe(true);
    registry.endExecution(created.session);
  });
});

describe("dispatch intents (finding 2)", () => {
  it("records, annotates, and clears an intent through the happy path", async () => {
    const registry = createSessionRegistry(config());
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    registry.recordDispatchIntent(session, intentFor(session));
    expect(session.pendingDispatch).not.toBeNull();
    registry.noteDispatchHash(session, `0x${"bb".repeat(32)}`);
    expect(session.pendingDispatch?.txHash).toBe(`0x${"bb".repeat(32)}`);
    registry.clearDispatchIntent(session);
    expect(session.pendingDispatch).toBeNull();
  });

  it("refuses a second concurrent intent and out-of-sequence intents", async () => {
    const registry = createSessionRegistry(config());
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    registry.recordDispatchIntent(session, intentFor(session));
    expect(() => registry.recordDispatchIntent(session, intentFor(session))).toThrow(/already pending/);
    registry.clearDispatchIntent(session);
    expect(() =>
      registry.recordDispatchIntent(session, { ...intentFor(session), stepIndex: 3 }),
    ).toThrow(/out of sequence/);
  });

  it("converts an unresolved dispatch into the reconcile-required pending", async () => {
    const registry = createSessionRegistry(config());
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    registry.recordDispatchIntent(session, intentFor(session));
    const intent = registry.markDispatchUnresolved(session, new Error("lost"));
    expect(session.pendingDispatch).toBeNull();
    if (session.phase.kind !== "reconcile-required") throw new Error("expected reconcile-required");
    if (session.phase.pending.kind !== "dispatch") throw new Error("expected dispatch pending");
    expect(session.phase.pending.intent).toBe(intent);
  });

  it("adopts a discovered receipt or vacates a dispatch that provably never landed", async () => {
    const registry = createSessionRegistry(config());
    const adopted = await registry.create(async () => fakeFork());
    if (!adopted.ok) throw new Error("creation refused");
    registry.recordDispatchIntent(adopted.session, intentFor(adopted.session));
    registry.markDispatchUnresolved(adopted.session, new Error("lost"));
    const receipt = confirmedReceipt();
    const entry = registry.adoptDispatchedStep(adopted.session, receipt, 42n);
    expect(entry.receipt).toBe(receipt);
    expect(entry.sharesDelta).toBe(42n);
    expect(adopted.session.phase).toEqual({ kind: "active" });
    expect(adopted.session.entries).toHaveLength(1);

    const vacated = await registry.create(async () => fakeFork());
    if (!vacated.ok) throw new Error("creation refused");
    registry.recordDispatchIntent(vacated.session, intentFor(vacated.session));
    registry.markDispatchUnresolved(vacated.session, new Error("lost"));
    registry.vacateDispatch(vacated.session);
    expect(vacated.session.phase).toEqual({ kind: "active" });
    expect(vacated.session.entries).toHaveLength(0);

    expect(() => registry.vacateDispatch(vacated.session)).toThrow(/without a dispatch-pending/);
    expect(() => registry.adoptDispatchedStep(vacated.session, receipt, null)).toThrow(
      /without a dispatch-pending/,
    );
  });
});

describe("record discipline", () => {
  it("refuses out-of-sequence appends", async () => {
    const registry = createSessionRegistry(config());
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const step = testStep();
    expect(() =>
      registry.appendConfirmed(created.session, {
        stepIndex: 3,
        stepId: step.id,
        step,
        receipt: confirmedReceipt(),
        resolvedAmount: null,
        approval: NO_APPROVAL,
      }),
    ).toThrow(/out of sequence/);
  });

  it("refuses recording a plan over executed steps or across a generation change", async () => {
    const registry = createSessionRegistry(config());
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    const recorded = {
      plan: { ok: true as const, steps: [testStep()], targetEModeCategoryId: null, flows: [] },
      snapshot: {} as never,
      planHash: `0x${"00".repeat(32)}` as Hex,
      predictedOutputs: new Map<string, bigint>(),
      risk: new Map<string, never>(),
    };
    const staleGeneration = session.generation;
    session.generation += 1;
    expect(() => registry.recordPlan(session, recorded, staleGeneration)).toThrow(/generation/);
    registry.recordPlan(session, recorded, session.generation);
    appendTestEntry(registry, session, false);
    expect(() => registry.recordPlan(session, recorded, session.generation)).toThrow(/reset first/);
  });

  it("walks a step through pending attribution to settlement", async () => {
    const registry = createSessionRegistry(config());
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    appendTestEntry(registry, session, false);
    registry.markAttributionPending(session, 0, 42n);
    expect(session.phase).toEqual({ kind: "attribution-pending", stepIndex: 0 });
    expect(session.entries[0]!.beforeShares).toBe(42n);

    registry.recordMeasurement(session, 0, 7n);
    expect(session.entries[0]!.sharesDelta).toBe(7n);

    registry.completeStep(session, 0, 7n, settledResult(0, "stake1:deposit"));
    expect(session.phase).toEqual({ kind: "active" });
    expect(session.entries[0]!.beforeShares).toBeNull();
    expect(session.entries[0]!.settled).not.toBeNull();
    expect(registry.summaryOf(session).executed).toHaveLength(1);
  });

  it("reconciliation restores the exact pending record and reactivates the session", async () => {
    const registry = createSessionRegistry(config());
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    const step = testStep();
    const receipt = confirmedReceipt();
    expect(() => registry.applyReconciliation(session, null)).toThrow(/persistence-pending/);

    registry.markReconcileRequired(session, {
      kind: "persistence",
      stepIndex: 0,
      step,
      receipt,
      resolvedAmount: 5n,
      approval: { spender: LP, priorAllowanceWei: 0n, approvedWei: 5n },
      measurement: { status: "measured", beforeShares: 1n, sharesDelta: 3n },
      cause: new Error("kv down"),
    });
    expect(session.phase.kind).toBe("reconcile-required");
    const summary = registry.summaryOf(session);
    expect(summary.recovery?.kind).toBe("reconcile-persistence");

    const entry = registry.applyReconciliation(session, 3n);
    expect(session.phase).toEqual({ kind: "active" });
    expect(entry.receipt).toBe(receipt);
    expect(entry.resolvedAmount).toBe(5n);
    expect(entry.approval).toEqual({ spender: LP, priorAllowanceWei: 0n, approvedWei: 5n });
    expect(entry.sharesDelta).toBe(3n);
    expect(session.entries).toHaveLength(1);
  });

  it("halts and failures pin the session phase with their evidence", async () => {
    const registry = createSessionRegistry(config());
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const receiptView = {
      txHash: `0x${"00".repeat(32)}` as Hex,
      blockNumber: 101n,
      blockHash: BASE_HASH,
      gasUsed: null,
    };
    registry.markHalted(created.session, {
      kind: "output-divergence",
      stepIndex: 0,
      stepId: "stake1:deposit",
      mechanism: "share-delta",
      predictedWei: 100n,
      attributedWei: 90n,
      toleranceWei: 2n,
      detail: null,
      receipt: receiptView,
    });
    expect(created.session.phase.kind).toBe("halted");
    registry.markFailed(created.session, {
      stepIndex: 0,
      stepId: "stake1:deposit",
      txHash: receiptView.txHash,
      decoded: null,
      raw: "0xdeadbeef",
    });
    expect(created.session.phase.kind).toBe("failed");
  });
});

describe("reset", () => {
  it("clears the run, re-mints the actor, bumps the generation, and keeps the key", async () => {
    const registry = createSessionRegistry(config());
    const fork = fakeFork();
    const created = await registry.create(async () => fork);
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    appendTestEntry(registry, session, false);
    registry.noteTransaction(session);
    registry.markFailed(session, {
      stepIndex: 0,
      stepId: "stake1:deposit",
      txHash: `0x${"00".repeat(32)}` as Hex,
      decoded: null,
      raw: null,
    });

    const key = session.key;
    const generationBefore = session.generation;
    const outcome = await registry.reset(session);
    expect(outcome.ok).toBe(true);
    expect(fork.resets).toBe(1);
    expect(session.key).toBe(key);
    expect(session.actor).toBe(ACTOR_AFTER_RESET);
    expect(session.generation).toBe(generationBefore + 1);
    expect(session.phase).toEqual({ kind: "active" });
    expect(session.plan).toBeNull();
    expect(session.txCount).toBe(0);
    expect(session.entries).toHaveLength(0);
    const looked = await registry.lookup(key);
    expect(looked.ok).toBe(true);
  });

  it("a failed reset invalidates the session and preserves its evidence (finding 6)", async () => {
    const registry = createSessionRegistry(config());
    const fork = fakeFork();
    fork.failResets = true;
    const created = await registry.create(async () => fork);
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    appendTestEntry(registry, session);

    const outcome = await registry.reset(session);
    expect(outcome.ok).toBe(false);
    expect(registry.sessionCount()).toBe(0);
    // The key answers with the tombstone — the record predates the failed reset.
    const looked = await registry.lookup(session.key);
    expect(looked.ok).toBe(false);
    if (looked.ok) throw new Error("unreachable");
    if (looked.refusal.kind !== "session-expired") throw new Error(`got ${looked.refusal.kind}`);
    expect(looked.refusal.tombstone.executed).toHaveLength(1);
  });
});

describe("summary", () => {
  it("exposes the rehydration read: identity, phase, plan hash, executed results, recovery", async () => {
    const registry = createSessionRegistry(config());
    const created = await registry.create(async () => fakeFork());
    if (!created.ok) throw new Error("creation refused");
    const session = created.session;
    const summary = registry.summaryOf(session);
    expect(summary.baseBlock).toBe(100n);
    expect(summary.baseBlockHash).toBe(BASE_HASH);
    expect(summary.actor).toBe(ACTOR);
    expect(summary.phase).toEqual({ kind: "active" });
    expect(summary.planHash).toBeNull();
    expect(summary.planStepCount).toBeNull();
    expect(summary.executed).toHaveLength(0);
    expect(summary.recovery).toBeNull();
  });
});
