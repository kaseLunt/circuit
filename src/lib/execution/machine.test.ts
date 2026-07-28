import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { buildPlan, type BlockFlow, type PlanSuccess, type TransactionStep } from "../../core/plan";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import { receiptMinter, type ConfirmedReceipt } from "./attribution";
import { SANDBOX_OUTPUT_TOLERANCE, toleranceWeiFor } from "./tolerance";
import {
  attributionCellOf,
  createExecutionMachine,
  reduce,
  stepRequirementsOf,
  type ExecutionMachine,
  type ReduceResult,
} from "./machine";
import {
  clearResolvedIntent,
  createRecord,
  enrichFailure,
  nextStepIndexOf,
  noteReplacement,
  noteSubmission,
  openDispatchIntent,
  pinDiscoveredHash,
  recordFailure,
  recordHalt,
  runClosed,
  settleStep,
  type ExecutionRecord,
  type RecordOutcome,
} from "./record";
import type {
  DispatchFacts,
  ExecutionEvent,
  FailureRecordFact,
  HaltFact,
  HaltedStepFact,
  ReceiptRef,
  RecordRefusal,
  SandboxStepResult,
  SettledStepFact,
  TransitionRefusal,
} from "./types";

const WAD = 10n ** 18n;
const PREDICTED = 10n * WAD;
const ACTOR = "0x00000000000000000000000000000000000000aa" as Address;
const SPENDER = "0x00000000000000000000000000000000000000bb" as Address;
const PLAN_HASH = `0x${"ab".repeat(32)}` as Hex;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const NULL_FACTS: DispatchFacts = {
  nonce: null,
  resolvedAmountWei: null,
  approval: null,
  beforeShares: null,
};

const executeEv = (facts: Partial<DispatchFacts> = {}): ExecutionEvent => ({
  type: "execute",
  facts: { ...NULL_FACTS, ...facts },
});
const advanceEv = (facts: Partial<DispatchFacts> = {}): ExecutionEvent => ({
  type: "advance",
  facts: { ...NULL_FACTS, ...facts },
});

const configured = (value: bigint) => ({
  kind: "configured" as const,
  value,
  name: "test-figure",
  definedAt: "machine.test.ts",
});

function step(id: string, index: number, blockId: string): TransactionStep {
  return {
    id,
    index,
    blockId,
    description: `step ${id}`,
    to: ACTOR,
    abi: [],
    functionName: "deposit",
    args: [],
    valueSpec: "none",
    amount: { kind: "none" },
  };
}

function flow(blockId: string, outputWei: bigint | null): BlockFlow {
  return {
    blockId,
    type: "stake",
    inputAsset: "ETH",
    inputWei: null,
    outputAsset: "eETH",
    outputWei: outputWei === null ? null : configured(outputWei),
    reserve: null,
  };
}

const plan: PlanSuccess = {
  ok: true,
  steps: [step("s0", 0, "b0"), step("s1", 1, "b1")],
  targetEModeCategoryId: null,
  flows: [flow("b0", PREDICTED), flow("b1", PREDICTED)],
};
const singleStepPlan: PlanSuccess = {
  ok: true,
  steps: [step("s0", 0, "b0")],
  targetEModeCategoryId: null,
  flows: [flow("b0", PREDICTED)],
};
const noPredictionPlan: PlanSuccess = {
  ok: true,
  steps: [step("s0", 0, "b0"), step("s1", 1, "b1")],
  targetEModeCategoryId: null,
  flows: [flow("b0", null)],
};
const emptyPlan: PlanSuccess = { ok: true, steps: [], targetEModeCategoryId: null, flows: [] };

// The REAL canonical fixture: buildPlan over the flagship graph and the recorded snapshot —
// approves, setUserEMode and supplies included, exactly as the server executes them.
const canonicalPlan: PlanSuccess = (() => {
  const result = buildPlan(flagshipGraph(), fixtureSnapshot());
  if (!result.ok) throw new Error("canonical flagship plan failed to build");
  return result;
})();

function canonicalStep(stepIndex: number): TransactionStep {
  const found = canonicalPlan.steps[stepIndex];
  if (found === undefined) throw new Error(`no canonical step ${stepIndex}`);
  return found;
}

function canonicalPredicted(stepIndex: number): bigint {
  const found = canonicalPlan.flows.find((f) => f.blockId === canonicalStep(stepIndex).blockId);
  if (found === undefined || found.outputWei === null) {
    throw new Error(`no predicted output for canonical step ${stepIndex}`);
  }
  return found.outputWei.value;
}

const minter = receiptMinter("test-rpc");
const minted = (txHash: Hex): ConfirmedReceipt =>
  minter.confirm({ status: 1n, txHash, blockNumber: 123n, blockHash: hash(0xb10c), logs: [] });

const receiptRef = (txHash: Hex): ReceiptRef => ({
  txHash,
  blockNumber: 123n,
  blockHash: hash(0xb10c),
  gasUsed: null,
});

function ok(result: ReduceResult): ExecutionMachine {
  expect(result.refusal).toBeNull();
  return result.machine;
}

function refused(result: ReduceResult, machine: ExecutionMachine): TransitionRefusal {
  expect(result.machine).toBe(machine);
  if (result.refusal === null) throw new Error("expected a refusal");
  return result.refusal;
}

function recordOf(machine: ExecutionMachine): ExecutionRecord {
  if (machine.record === null) throw new Error("expected a record");
  return machine.record;
}

function recOk(outcome: RecordOutcome): ExecutionRecord {
  if (!outcome.ok) throw new Error(`unexpected record refusal: ${outcome.refusal.kind}`);
  return outcome.record;
}

function recRefused(outcome: RecordOutcome): RecordRefusal {
  if (outcome.ok) throw new Error("expected a record refusal");
  return outcome.refusal;
}

function readyMachine(mode: "sandbox" | "live" = "sandbox", planArg: PlanSuccess = plan): ExecutionMachine {
  const created = createExecutionMachine(
    mode === "live" ? { mode, tolerance: SANDBOX_OUTPUT_TOLERANCE } : { mode },
  );
  const simulating = ok(reduce(created, { type: "simulate" }));
  return ok(
    reduce(simulating, {
      type: "plan-ready",
      plan: planArg,
      planHash: PLAN_HASH,
      address: mode === "live" ? ACTOR : null,
    }),
  );
}

const pendingSandbox = (): ExecutionMachine => ok(reduce(readyMachine(), executeEv()));
const awaiting = (): ExecutionMachine => ok(reduce(readyMachine("live"), executeEv({ nonce: 7n })));
const pendingLive = (): ExecutionMachine => ok(reduce(awaiting(), { type: "signed", txHash: hash(1) }));
const attributingLive = (): ExecutionMachine =>
  ok(reduce(pendingLive(), { type: "tx-confirmed", receipt: minted(hash(1)) }));

const measured = (attributedWei: bigint): ExecutionEvent => ({
  type: "attribution-measured",
  mechanism: "share-delta",
  attributedWei,
  sharesDelta: 5n,
});

/** Settle the already-confirmed canonical step `k` per its classified requirements. */
function settleCanonicalStep(machine: ExecutionMachine, k: number): ExecutionMachine {
  const requirements = stepRequirementsOf(canonicalPlan, canonicalStep(k));
  let next = machine;
  if (requirements.consumesApprovalFrom !== null) {
    next = ok(
      reduce(next, {
        type: "residual-allowance-checked",
        spender: requirements.consumesApprovalFrom as Address,
        residualAllowanceWei: 0n,
      }),
    );
  }
  if (requirements.output !== null) {
    next = ok(
      reduce(next, {
        type: "attribution-measured",
        mechanism: requirements.output,
        attributedWei: canonicalPredicted(k),
        sharesDelta: requirements.output === "share-delta" ? 5n : null,
      }),
    );
  } else {
    next = ok(reduce(next, { type: "non-producer-settled" }));
  }
  return next;
}

/** Walk the LIVE canonical machine to `attributing(until)`, settling every earlier step. */
function canonicalLiveAt(until: number): ExecutionMachine {
  let machine = readyMachine("live", canonicalPlan);
  for (let k = 0; k <= until; k += 1) {
    machine = ok(reduce(machine, k === 0 ? executeEv() : advanceEv()));
    machine = ok(reduce(machine, { type: "signed", txHash: hash(0x1000 + k) }));
    machine = ok(reduce(machine, { type: "tx-confirmed", receipt: minted(hash(0x1000 + k)) }));
    if (k === until) return machine;
    machine = settleCanonicalStep(machine, k);
  }
  throw new Error("unreachable");
}

function canonicalSandboxResult(
  k: number,
  overrides: Partial<Extract<SandboxStepResult, { status: "attributed" }>> = {},
): SandboxStepResult {
  const target = canonicalStep(k);
  const requirements = stepRequirementsOf(canonicalPlan, target);
  return {
    status: "attributed",
    stepIndex: k,
    stepId: target.id,
    receipt: receiptRef(hash(0x2000 + k)),
    resolvedAmountWei: 1n,
    sharesDelta: null,
    output: null,
    approval: null,
    consumedApproval:
      requirements.consumesApprovalFrom === null
        ? null
        : { spender: requirements.consumesApprovalFrom as Address, residualAllowanceWei: 0n },
    risk: null,
    ...overrides,
  };
}

function attributedResult(stepIndex: number, stepId: string): SandboxStepResult {
  return {
    status: "attributed",
    stepIndex,
    stepId,
    receipt: receiptRef(hash(0x51)),
    resolvedAmountWei: PREDICTED,
    sharesDelta: 5n,
    output: {
      mechanism: "share-delta",
      predictedWei: PREDICTED,
      attributedWei: PREDICTED,
      toleranceWei: toleranceWeiFor(PREDICTED, SANDBOX_OUTPUT_TOLERANCE),
    },
    approval: { spender: SPENDER, priorAllowanceWei: 0n, approvedWei: PREDICTED },
    consumedApproval: null,
    risk: { expected: { status: "healthy", hfWad: 2n * WAD }, chainHfWad: 2n * WAD },
  };
}

function divergenceHalt(stepIndex: number, stepId: string): HaltFact {
  return {
    kind: "output-divergence",
    stepIndex,
    stepId,
    mechanism: "share-delta",
    predictedWei: PREDICTED,
    attributedWei: 2n * PREDICTED,
    toleranceWei: toleranceWeiFor(PREDICTED, SANDBOX_OUTPUT_TOLERANCE),
    detail: null,
    receipt: receiptRef(hash(0x77)),
  };
}

const settledFact = (stepIndex: number, stepId: string): SettledStepFact => ({
  stepIndex,
  stepId,
  receipt: receiptRef(hash(0x51)),
  resolvedAmountWei: PREDICTED,
  sharesDelta: null,
  output: null,
  approval: null,
  consumedApproval: null,
  risk: null,
});

const haltedFact = (stepIndex: number, stepId: string): HaltedStepFact => ({
  stepIndex,
  stepId,
  receipt: receiptRef(hash(0x77)),
  resolvedAmountWei: null,
  sharesDelta: null,
  halt: divergenceHalt(stepIndex, stepId),
});

const failureFact = (stepIndex: number, stepId: string): FailureRecordFact => ({
  stepIndex,
  stepId,
  cause: "reverted",
  txHash: hash(0xf),
  decoded: null,
  raw: null,
});

const EVENT_CATALOG: readonly ExecutionEvent[] = [
  { type: "simulate" },
  { type: "plan-ready", plan, planHash: PLAN_HASH, address: null },
  { type: "plan-refused" },
  { type: "document-mutated" },
  executeEv(),
  advanceEv(),
  { type: "signed", txHash: hash(1) },
  { type: "user-rejected" },
  { type: "request-failed" },
  { type: "tx-confirmed", receipt: minted(hash(0xcc)) },
  { type: "tx-reverted", txHash: hash(1) },
  { type: "tx-timeout" },
  { type: "keep-waiting" },
  { type: "give-up" },
  { type: "tx-replaced", classification: "repriced", replacedHash: hash(1), replacementHash: hash(2) },
  { type: "tx-replaced", classification: "superseded", replacedHash: hash(1), replacementHash: hash(2) },
  measured(PREDICTED),
  { type: "attribution-unavailable", beforeShares: 1n },
  { type: "persistence-failed", measurement: { status: "measured", beforeShares: 1n, sharesDelta: 2n } },
  { type: "residual-allowance-checked", spender: SPENDER, residualAllowanceWei: 0n },
  { type: "non-producer-settled" },
  { type: "step-result", result: attributedResult(0, "s0") },
  { type: "step-refused", refusal: { kind: "session-busy" } },
  { type: "reconcile-result", result: attributedResult(0, "s0") },
  { type: "failure-enriched", decoded: null, raw: null },
  { type: "wallet-changed" },
  { type: "session-lost", executedSteps: 1 },
];

describe("record transitions", () => {
  const intent0 = { stepIndex: 0, stepId: "s0", txHash: null, ...NULL_FACTS };

  it("createRecord starts open and empty", () => {
    const record = createRecord(PLAN_HASH);
    expect(record.settled).toEqual([]);
    expect(record.intent).toBeNull();
    expect(nextStepIndexOf(record)).toBe(0);
    expect(runClosed(record)).toBe(false);
  });

  it("openDispatchIntent enforces sequence, single intent, and run closure", () => {
    const record = createRecord(PLAN_HASH);
    const opened = recOk(openDispatchIntent(record, intent0));
    expect(opened.intent).toEqual(intent0);
    expect(recRefused(openDispatchIntent(opened, { ...intent0, stepIndex: 1 }))).toEqual({
      kind: "intent-open",
      stepIndex: 0,
    });
    expect(recRefused(openDispatchIntent(record, { ...intent0, stepIndex: 1 }))).toEqual({
      kind: "out-of-sequence",
      expectedIndex: 0,
      receivedIndex: 1,
    });
    const closed = recOk(recordFailure(record, failureFact(0, "s0")));
    expect(recRefused(openDispatchIntent(closed, intent0))).toEqual({ kind: "run-closed" });
  });

  it("the intent persists the full dispatch facts (D6, finding 1)", () => {
    const facts = {
      nonce: 7n,
      resolvedAmountWei: 5n * WAD,
      approval: { spender: SPENDER, priorAllowanceWei: 0n, approvedWei: 5n * WAD },
      beforeShares: 3n,
    };
    const record = recOk(openDispatchIntent(createRecord(PLAN_HASH), { ...intent0, ...facts }));
    expect(record.intent).toEqual({ stepIndex: 0, stepId: "s0", txHash: null, ...facts });
  });

  it("noteSubmission fills exactly one null hash on the matching intent", () => {
    const record = createRecord(PLAN_HASH);
    expect(recRefused(noteSubmission(record, 0, hash(1)))).toEqual({ kind: "no-intent" });
    const opened = recOk(openDispatchIntent(record, intent0));
    expect(recRefused(noteSubmission(opened, 1, hash(1)))).toEqual({
      kind: "intent-mismatch",
      intentIndex: 0,
      receivedIndex: 1,
    });
    const submitted = recOk(noteSubmission(opened, 0, hash(1)));
    expect(submitted.intent?.txHash).toBe(hash(1));
    expect(recRefused(noteSubmission(submitted, 0, hash(2)))).toEqual({
      kind: "submission-exists",
      txHash: hash(1),
    });
  });

  it("noteReplacement swaps only an existing hash", () => {
    const record = createRecord(PLAN_HASH);
    expect(recRefused(noteReplacement(record, 0, hash(2)))).toEqual({ kind: "no-intent" });
    const opened = recOk(openDispatchIntent(record, intent0));
    expect(recRefused(noteReplacement(opened, 1, hash(2)))).toEqual({
      kind: "intent-mismatch",
      intentIndex: 0,
      receivedIndex: 1,
    });
    expect(recRefused(noteReplacement(opened, 0, hash(2)))).toEqual({ kind: "no-submission" });
    const submitted = recOk(noteSubmission(opened, 0, hash(1)));
    expect(recOk(noteReplacement(submitted, 0, hash(2))).intent?.txHash).toBe(hash(2));
  });

  it("clearResolvedIntent is total and touches only the matching intent", () => {
    const record = createRecord(PLAN_HASH);
    expect(clearResolvedIntent(record, 0)).toBe(record);
    const opened = recOk(openDispatchIntent(record, intent0));
    expect(clearResolvedIntent(opened, 1)).toBe(opened);
    expect(clearResolvedIntent(opened, 0).intent).toBeNull();
  });

  it("pinDiscoveredHash pins once and never overwrites the dispatch's own hash", () => {
    const record = createRecord(PLAN_HASH);
    expect(pinDiscoveredHash(record, 0, hash(9))).toBe(record);
    const opened = recOk(openDispatchIntent(record, intent0));
    expect(pinDiscoveredHash(opened, 1, hash(9))).toBe(opened);
    const pinned = pinDiscoveredHash(opened, 0, hash(9));
    expect(pinned.intent?.txHash).toBe(hash(9));
    expect(pinDiscoveredHash(pinned, 0, hash(8))).toBe(pinned);
  });

  it("settleStep appends in strict sequence and consumes the matching intent", () => {
    const record = recOk(openDispatchIntent(createRecord(PLAN_HASH), intent0));
    const settled = recOk(settleStep(record, settledFact(0, "s0")));
    expect(settled.settled).toHaveLength(1);
    expect(settled.intent).toBeNull();
    expect(nextStepIndexOf(settled)).toBe(1);
    expect(recRefused(settleStep(settled, settledFact(0, "s0")))).toEqual({
      kind: "out-of-sequence",
      expectedIndex: 1,
      receivedIndex: 0,
    });
    const mismatched = recOk(openDispatchIntent(settled, { ...intent0, stepIndex: 1, stepId: "s1" }));
    expect(recRefused(settleStep({ ...mismatched, settled: [] }, settledFact(0, "s0")))).toEqual({
      kind: "intent-mismatch",
      intentIndex: 1,
      receivedIndex: 0,
    });
    const closed = recOk(recordHalt(settled, haltedFact(1, "s1")));
    expect(recRefused(settleStep(closed, settledFact(1, "s1")))).toEqual({ kind: "run-closed" });
  });

  it("recordHalt closes the run with the divergence pair, in sequence", () => {
    const record = createRecord(PLAN_HASH);
    expect(recRefused(recordHalt(record, haltedFact(1, "s1")))).toEqual({
      kind: "out-of-sequence",
      expectedIndex: 0,
      receivedIndex: 1,
    });
    const withIntent = recOk(openDispatchIntent(record, intent0));
    expect(recRefused(recordHalt({ ...withIntent, intent: { ...intent0, stepIndex: 1 } }, haltedFact(0, "s0")))).toEqual(
      { kind: "intent-mismatch", intentIndex: 1, receivedIndex: 0 },
    );
    const halted = recOk(recordHalt(withIntent, haltedFact(0, "s0")));
    expect(halted.halted?.halt.kind).toBe("output-divergence");
    expect(halted.intent).toBeNull();
    expect(runClosed(halted)).toBe(true);
    expect(recRefused(recordHalt(halted, haltedFact(0, "s0")))).toEqual({ kind: "run-closed" });
  });

  it("recordFailure is durable with nulls and never edits the intent (D7/D6)", () => {
    const record = recOk(openDispatchIntent(createRecord(PLAN_HASH), intent0));
    expect(recRefused(recordFailure(record, failureFact(1, "s1")))).toEqual({
      kind: "out-of-sequence",
      expectedIndex: 0,
      receivedIndex: 1,
    });
    const failed = recOk(recordFailure(record, failureFact(0, "s0")));
    expect(failed.failure?.decoded).toBeNull();
    expect(failed.failure?.raw).toBeNull();
    expect(failed.intent).toEqual(intent0);
    expect(recRefused(recordFailure(failed, failureFact(0, "s0")))).toEqual({ kind: "run-closed" });
  });

  it("enrichFailure fills nulls only, and only for reverted causes", () => {
    const decoded = { message: "HF too low", raw: "0x1234", source: "custom-error" as const };
    expect(recRefused(enrichFailure(createRecord(PLAN_HASH), { decoded, raw: "0x1234" }))).toEqual({
      kind: "no-failure",
    });
    const gaveUp = recOk(
      recordFailure(createRecord(PLAN_HASH), { ...failureFact(0, "s0"), cause: "timeout-gave-up" }),
    );
    expect(recRefused(enrichFailure(gaveUp, { decoded, raw: "0x1234" }))).toEqual({
      kind: "enrichment-illegal-cause",
      cause: "timeout-gave-up",
    });
    const failed = recOk(recordFailure(createRecord(PLAN_HASH), failureFact(0, "s0")));
    const noop = recOk(enrichFailure(failed, { decoded: null, raw: null }));
    expect(noop.failure).toEqual(failed.failure);
    const partial = recOk(enrichFailure(failed, { decoded, raw: null }));
    expect(partial.failure?.decoded).toEqual(decoded);
    expect(partial.failure?.raw).toBeNull();
    const full = recOk(enrichFailure(partial, { decoded: null, raw: "0x1234" }));
    expect(full.failure?.raw).toBe("0x1234");
    expect(recRefused(enrichFailure(full, { decoded, raw: null }))).toEqual({
      kind: "enrichment-overwrite",
      field: "decoded",
    });
    expect(recRefused(enrichFailure(full, { decoded: null, raw: "0x9" }))).toEqual({
      kind: "enrichment-overwrite",
      field: "raw",
    });
  });
});

describe("stepRequirementsOf — the canonical 13-step plan (finding 2)", () => {
  it("classifies every canonical step: producers by mechanism, consumers by spender", () => {
    const classified = canonicalPlan.steps.map((target) => {
      const requirements = stepRequirementsOf(canonicalPlan, target);
      return [target.id, requirements.output, requirements.consumesApprovalFrom] as const;
    });
    // Consumers' spenders are pinned independently of the classifier's derivation: the
    // wrap spends its approval at the weETH contract and the supply at the Pool — both
    // are the consuming step's own `to` address.
    const spenderOf = (index: number): Hex => getAddress(canonicalStep(index).to);
    expect(classified).toEqual([
      ["stake1:deposit", "share-delta", null],
      ["wrap1:approve", null, null],
      ["wrap1:wrap", "transfer-event", spenderOf(2)],
      ["supply1:set-emode", null, null],
      ["supply1:approve", null, null],
      ["supply1:supply", null, spenderOf(5)],
      ["borrow:borrow", "transfer-event", null],
      ["unwrap:withdraw", "withdraw-argument", null],
      ["stake2:deposit", "share-delta", null],
      ["wrap2:approve", null, null],
      ["wrap2:wrap", "transfer-event", spenderOf(10)],
      ["supply2:approve", null, null],
      ["supply2:supply", null, spenderOf(12)],
    ]);
  });

  it("an approve step with a malformed spender argument fails loud", () => {
    const approve: TransactionStep = { ...step("bad:approve", 0, "b0"), functionName: "approve" };
    const consumer: TransactionStep = {
      ...step("bad:consume", 1, "b0"),
      functionName: "supply",
      amount: approve.amount,
    };
    const crafted: PlanSuccess = { ...plan, steps: [approve, consumer] };
    expect(() => stepRequirementsOf(crafted, consumer)).toThrow(/no spender argument/);
  });
});

describe("createExecutionMachine", () => {
  it("defaults the sandbox to the named sandbox tolerance", () => {
    const machine = createExecutionMachine({ mode: "sandbox" });
    expect(machine.tolerance).toBe(SANDBOX_OUTPUT_TOLERANCE);
    expect(machine.phase).toEqual({ kind: "idle" });
    expect(machine.record).toBeNull();
  });

  it("refuses a live machine without a named tolerance", () => {
    expect(() => createExecutionMachine({ mode: "live" })).toThrow(/named tolerance/);
  });

  it("accepts a live machine with an explicit tolerance", () => {
    const machine = createExecutionMachine({ mode: "live", tolerance: SANDBOX_OUTPUT_TOLERANCE });
    expect(machine.mode).toBe("live");
  });
});

describe("plan lifecycle", () => {
  it("simulate → plan-ready pins the plan, hash, address and a fresh record", () => {
    const machine = readyMachine("live");
    expect(machine.phase).toEqual({ kind: "ready" });
    expect(machine.plan).toBe(plan);
    expect(machine.planHash).toBe(PLAN_HASH);
    expect(machine.address).toBe(ACTOR);
    expect(recordOf(machine)).toEqual(createRecord(PLAN_HASH));
  });

  it("plan-refused returns to idle", () => {
    const created = createExecutionMachine({ mode: "sandbox" });
    const simulating = ok(reduce(created, { type: "simulate" }));
    expect(ok(reduce(simulating, { type: "plan-refused" })).phase).toEqual({ kind: "idle" });
  });

  it("document-mutated drops the plan and record from ready", () => {
    const idle = ok(reduce(readyMachine(), { type: "document-mutated" }));
    expect(idle.phase).toEqual({ kind: "idle" });
    expect(idle.plan).toBeNull();
    expect(idle.planHash).toBeNull();
    expect(idle.record).toBeNull();
  });

  it("document-mutated is refused mid-execution (T26: the document is frozen)", () => {
    const machine = pendingSandbox();
    expect(refused(reduce(machine, { type: "document-mutated" }), machine).kind).toBe("illegal-transition");
  });
});

describe("dispatch (D6: intent with full facts, before send)", () => {
  it("execute in sandbox opens the intent and enters pending with no hash", () => {
    const machine = pendingSandbox();
    expect(machine.phase).toEqual({ kind: "pending", stepIndex: 0, txHash: null });
    expect(recordOf(machine).intent).toEqual({ stepIndex: 0, stepId: "s0", txHash: null, ...NULL_FACTS });
  });

  it("execute in live pins nonce, resolved amount, approval facts and beforeShares (finding 1)", () => {
    const facts = {
      nonce: 7n,
      resolvedAmountWei: PREDICTED,
      approval: { spender: SPENDER, priorAllowanceWei: 0n, approvedWei: PREDICTED },
      beforeShares: 3n,
    };
    const machine = ok(reduce(readyMachine("live"), executeEv(facts)));
    expect(machine.phase).toEqual({ kind: "awaiting-signature", stepIndex: 0 });
    expect(recordOf(machine).intent).toEqual({ stepIndex: 0, stepId: "s0", txHash: null, ...facts });
  });

  it("the intent's facts survive request loss and wallet change (finding 1)", () => {
    const facts = { nonce: 7n, resolvedAmountWei: PREDICTED, approval: null, beforeShares: 3n };
    const dispatched = ok(reduce(readyMachine("live"), executeEv(facts)));
    const unresolved = ok(reduce(dispatched, { type: "request-failed" }));
    expect(recordOf(unresolved).intent).toEqual({ stepIndex: 0, stepId: "s0", txHash: null, ...facts });
    const halted = ok(reduce(unresolved, { type: "wallet-changed" }));
    expect(recordOf(halted).intent).toEqual({ stepIndex: 0, stepId: "s0", txHash: null, ...facts });
  });

  it("execute refuses an empty plan", () => {
    const machine = readyMachine("sandbox", emptyPlan);
    expect(refused(reduce(machine, executeEv()), machine).kind).toBe("empty-plan");
  });

  it("execute is refused anywhere but ready", () => {
    const machine = pendingSandbox();
    expect(refused(reduce(machine, executeEv()), machine).kind).toBe("illegal-transition");
  });

  it("A10: advance is legal only from attributed(k) and dispatch-vacated(k)", () => {
    for (const machine of [readyMachine(), pendingSandbox(), attributingLive()]) {
      expect(refused(reduce(machine, advanceEv()), machine).kind).toBe("illegal-transition");
    }
  });

  it("advance from attributed(k) dispatches k+1", () => {
    const attributed = ok(reduce(pendingSandbox(), { type: "step-result", result: attributedResult(0, "s0") }));
    expect(attributed.phase).toEqual({ kind: "attributed", stepIndex: 0 });
    const next = ok(reduce(attributed, advanceEv()));
    expect(next.phase).toEqual({ kind: "pending", stepIndex: 1, txHash: null });
    expect(recordOf(next).intent).toEqual({ stepIndex: 1, stepId: "s1", txHash: null, ...NULL_FACTS });
  });

  it("advance surfaces record refusals atomically", () => {
    const closedRecord = recOk(recordFailure(createRecord(PLAN_HASH), failureFact(0, "s0")));
    const machine: ExecutionMachine = {
      ...readyMachine(),
      record: closedRecord,
      phase: { kind: "attributed", stepIndex: 0 },
    };
    const refusal = refused(reduce(machine, advanceEv()), machine);
    expect(refusal).toEqual({ kind: "record-refused", refusal: { kind: "run-closed" } });
  });
});

describe("live signing beat", () => {
  it("signed pins the hash on the intent and enters pending", () => {
    const machine = pendingLive();
    expect(machine.phase).toEqual({ kind: "pending", stepIndex: 0, txHash: hash(1) });
    expect(recordOf(machine).intent?.txHash).toBe(hash(1));
  });

  it("user-rejected is a classified decision: failure recorded, intent resolved, no hash", () => {
    const machine = ok(reduce(awaiting(), { type: "user-rejected" }));
    expect(machine.phase).toEqual({ kind: "failed-at", stepIndex: 0, cause: "user-rejected" });
    const record = recordOf(machine);
    expect(record.failure).toEqual({
      stepIndex: 0,
      stepId: "s0",
      cause: "user-rejected",
      txHash: null,
      decoded: null,
      raw: null,
    });
    expect(record.intent).toBeNull();
  });

  it("request-failed is never nothing-happened: dispatch-unresolved with the intent retained (D6)", () => {
    const machine = ok(reduce(awaiting(), { type: "request-failed" }));
    expect(machine.phase).toEqual({ kind: "dispatch-unresolved", stepIndex: 0, txHash: null });
    expect(recordOf(machine).intent?.nonce).toBe(7n);
  });
});

describe("confirmation (A15: receipt-bearing facts only)", () => {
  it("a minted receipt matching the intent hash enters attributing", () => {
    const machine = attributingLive();
    expect(machine.phase).toEqual({
      kind: "attributing",
      stepIndex: 0,
      receipt: { txHash: hash(1), blockNumber: 123n, blockHash: hash(0xb10c), gasUsed: null },
      consumedApproval: null,
    });
  });

  it("carries gasUsed off the receipt when the mint preserved one", () => {
    const withGas = minter.confirm({
      status: 1n,
      txHash: hash(1),
      blockNumber: 123n,
      blockHash: hash(0xb10c),
      logs: [],
      gasUsed: 21000n,
    });
    const machine = ok(reduce(pendingLive(), { type: "tx-confirmed", receipt: withGas }));
    expect(machine.phase.kind === "attributing" && machine.phase.receipt.gasUsed).toBe(21000n);
  });

  it("refuses a spread copy of a minted receipt (unminted identity)", () => {
    const machine = pendingLive();
    const forged = { ...minted(hash(1)) };
    expect(refused(reduce(machine, { type: "tx-confirmed", receipt: forged }), machine).kind).toBe(
      "unminted-receipt",
    );
  });

  it("refuses a receipt for a different transaction than the intent's", () => {
    const machine = pendingLive();
    const refusal = refused(reduce(machine, { type: "tx-confirmed", receipt: minted(hash(2)) }), machine);
    expect(refusal).toEqual({ kind: "receipt-mismatch", expected: hash(1), received: hash(2) });
  });

  it("refuses any receipt when no intent is open (corrupted cache)", () => {
    const base = pendingLive();
    const machine: ExecutionMachine = { ...base, record: createRecord(PLAN_HASH) };
    const refusal = refused(reduce(machine, { type: "tx-confirmed", receipt: minted(hash(1)) }), machine);
    expect(refusal).toEqual({ kind: "receipt-mismatch", expected: null, received: hash(1) });
  });

  it("a late confirmation lands from timeout (T32a: it may still land)", () => {
    const timedOut = ok(reduce(pendingLive(), { type: "tx-timeout" }));
    const machine = ok(reduce(timedOut, { type: "tx-confirmed", receipt: minted(hash(1)) }));
    expect(machine.phase.kind).toBe("attributing");
  });
});

describe("revert and timeout", () => {
  it("tx-reverted records the failure durably first (D7) and resolves the intent", () => {
    const machine = ok(reduce(pendingLive(), { type: "tx-reverted", txHash: hash(1) }));
    expect(machine.phase).toEqual({ kind: "failed-at", stepIndex: 0, cause: "reverted" });
    const record = recordOf(machine);
    expect(record.failure).toEqual({
      stepIndex: 0,
      stepId: "s0",
      cause: "reverted",
      txHash: hash(1),
      decoded: null,
      raw: null,
    });
    expect(record.intent).toBeNull();
  });

  it("tx-reverted refuses a hash the intent never dispatched", () => {
    const machine = pendingLive();
    const refusal = refused(reduce(machine, { type: "tx-reverted", txHash: hash(9) }), machine);
    expect(refusal).toEqual({ kind: "receipt-mismatch", expected: hash(1), received: hash(9) });
  });

  it("tx-reverted over a bare record refuses with no expectation to cite", () => {
    const base = pendingLive();
    const machine: ExecutionMachine = { ...base, record: createRecord(PLAN_HASH) };
    const refusal = refused(reduce(machine, { type: "tx-reverted", txHash: hash(1) }), machine);
    expect(refusal).toEqual({ kind: "receipt-mismatch", expected: null, received: hash(1) });
  });

  it("tx-timeout requires a watched hash", () => {
    const sandbox = pendingSandbox();
    expect(refused(reduce(sandbox, { type: "tx-timeout" }), sandbox).kind).toBe("illegal-transition");
    const timedOut = ok(reduce(pendingLive(), { type: "tx-timeout" }));
    expect(timedOut.phase).toEqual({ kind: "timeout", stepIndex: 0, txHash: hash(1) });
  });

  it("keep-waiting returns to pending on the same hash", () => {
    const timedOut = ok(reduce(pendingLive(), { type: "tx-timeout" }));
    expect(ok(reduce(timedOut, { type: "keep-waiting" })).phase).toEqual({
      kind: "pending",
      stepIndex: 0,
      txHash: hash(1),
    });
  });

  it("give-up records timeout-gave-up and RETAINS the intent — the tx may still land", () => {
    const timedOut = ok(reduce(pendingLive(), { type: "tx-timeout" }));
    const machine = ok(reduce(timedOut, { type: "give-up" }));
    expect(machine.phase).toEqual({ kind: "failed-at", stepIndex: 0, cause: "timeout-gave-up" });
    const record = recordOf(machine);
    expect(record.failure?.cause).toBe("timeout-gave-up");
    expect(record.failure?.txHash).toBe(hash(1));
    expect(record.intent?.txHash).toBe(hash(1));
  });

  it("a timeout give-up can never take a decoded-revert enrichment (T32a)", () => {
    const timedOut = ok(reduce(pendingLive(), { type: "tx-timeout" }));
    const machine = ok(reduce(timedOut, { type: "give-up" }));
    const refusal = refused(
      reduce(machine, {
        type: "failure-enriched",
        decoded: { message: "x", raw: "0x12", source: "custom-error" },
        raw: "0x12",
      }),
      machine,
    );
    expect(refusal).toEqual({
      kind: "record-refused",
      refusal: { kind: "enrichment-illegal-cause", cause: "timeout-gave-up" },
    });
  });
});

describe("replacements carry both hashes (finding 3)", () => {
  const repriced = (replacedHash: Hex, replacementHash: Hex): ExecutionEvent => ({
    type: "tx-replaced",
    classification: "repriced",
    replacedHash,
    replacementHash,
  });
  const superseded = (replacedHash: Hex, replacementHash: Hex): ExecutionEvent => ({
    type: "tx-replaced",
    classification: "superseded",
    replacedHash,
    replacementHash,
  });

  it("a repriced replacement applies only against the watched hash", () => {
    const machine = ok(reduce(pendingLive(), repriced(hash(1), hash(2))));
    expect(machine.phase).toEqual({ kind: "pending", stepIndex: 0, txHash: hash(2) });
    expect(recordOf(machine).intent?.txHash).toBe(hash(2));
  });

  it("a duplicate of the applied replacement is an idempotent no-op", () => {
    const machine = ok(reduce(pendingLive(), repriced(hash(1), hash(2))));
    const duplicate = reduce(machine, repriced(hash(1), hash(2)));
    expect(duplicate.machine).toBe(machine);
    expect(duplicate.refusal).toBeNull();
  });

  it("a stale A→B after A→B→C refuses unchanged — the watch never regresses", () => {
    const afterB = ok(reduce(pendingLive(), repriced(hash(1), hash(2))));
    const afterC = ok(reduce(afterB, repriced(hash(2), hash(3))));
    expect(afterC.phase).toEqual({ kind: "pending", stepIndex: 0, txHash: hash(3) });
    const stale = refused(reduce(afterC, repriced(hash(1), hash(2))), afterC);
    expect(stale).toEqual({
      kind: "stale-replacement",
      currentTxHash: hash(3),
      replacedHash: hash(1),
      replacementHash: hash(2),
    });
    expect(recordOf(afterC).intent?.txHash).toBe(hash(3));
  });

  it("a superseding replacement is final and records the SUPERSEDING hash as evidence", () => {
    const machine = ok(reduce(pendingLive(), superseded(hash(1), hash(2))));
    expect(machine.phase).toEqual({ kind: "failed-at", stepIndex: 0, cause: "cancelled" });
    expect(recordOf(machine).failure?.txHash).toBe(hash(2));
    expect(recordOf(machine).intent).toBeNull();
  });

  it("a superseding replacement citing an unwatched hash refuses", () => {
    const machine = pendingLive();
    expect(refused(reduce(machine, superseded(hash(9), hash(2))), machine).kind).toBe("stale-replacement");
  });

  it("a replacement with nothing submitted refuses with no current hash", () => {
    const machine = pendingSandbox();
    const refusal = refused(reduce(machine, repriced(hash(1), hash(2))), machine);
    expect(refusal).toEqual({
      kind: "stale-replacement",
      currentTxHash: null,
      replacedHash: hash(1),
      replacementHash: hash(2),
    });
  });

  it("a replacement over a bare record refuses the same way (crafted cache)", () => {
    const base = pendingLive();
    const machine: ExecutionMachine = { ...base, record: createRecord(PLAN_HASH) };
    const refusal = refused(reduce(machine, repriced(hash(1), hash(2))), machine);
    expect(refusal.kind).toBe("stale-replacement");
  });

  it("replacements classify from timeout as well", () => {
    const timedOut = ok(reduce(pendingLive(), { type: "tx-timeout" }));
    const machine = ok(reduce(timedOut, superseded(hash(1), hash(2))));
    expect(machine.phase).toEqual({ kind: "failed-at", stepIndex: 0, cause: "cancelled" });
  });
});

describe("attribution and tolerance (§6.2 via tolerance.ts)", () => {
  const bound = toleranceWeiFor(PREDICTED, SANDBOX_OUTPUT_TOLERANCE);

  it("within tolerance settles the step with the §6.2 pair and the intent's dispatch facts", () => {
    const facts = { nonce: 7n, resolvedAmountWei: PREDICTED, approval: null, beforeShares: 3n };
    const dispatched = ok(reduce(readyMachine("live"), executeEv(facts)));
    const signed = ok(reduce(dispatched, { type: "signed", txHash: hash(1) }));
    const attributing = ok(reduce(signed, { type: "tx-confirmed", receipt: minted(hash(1)) }));
    const machine = ok(reduce(attributing, measured(PREDICTED + bound)));
    expect(machine.phase).toEqual({ kind: "attributed", stepIndex: 0 });
    const entry = recordOf(machine).settled[0];
    expect(entry?.resolvedAmountWei).toBe(PREDICTED);
    expect(entry?.output).toEqual({
      mechanism: "share-delta",
      predictedWei: PREDICTED,
      attributedWei: PREDICTED + bound,
      toleranceWei: bound,
    });
    expect(entry?.sharesDelta).toBe(5n);
    expect(recordOf(machine).intent).toBeNull();
  });

  it("settles with null dispatch evidence when no intent survives (crafted cache)", () => {
    const base = pendingSandbox();
    const machine: ExecutionMachine = {
      ...base,
      record: createRecord(PLAN_HASH),
      phase: { kind: "attributing", stepIndex: 0, receipt: receiptRef(hash(1)), consumedApproval: null },
    };
    const settled = ok(reduce(machine, measured(PREDICTED)));
    expect(recordOf(settled).settled[0]?.resolvedAmountWei).toBeNull();
  });

  it("one wei beyond the bound halts — the gate discriminates (A12)", () => {
    const machine = ok(reduce(attributingLive(), measured(PREDICTED + bound + 1n)));
    expect(machine.phase.kind).toBe("halted-divergent");
    const halted = recordOf(machine).halted;
    expect(halted?.halt).toEqual({
      kind: "output-divergence",
      stepIndex: 0,
      stepId: "s0",
      mechanism: "share-delta",
      predictedWei: PREDICTED,
      attributedWei: PREDICTED + bound + 1n,
      toleranceWei: bound,
      detail: null,
      receipt: { txHash: hash(1), blockNumber: 123n, blockHash: hash(0xb10c), gasUsed: null },
    });
    expect(halted?.resolvedAmountWei).toBeNull();
  });

  it("the last step's attribution completes the run", () => {
    const base = readyMachine("live", singleStepPlan);
    const signed = ok(reduce(ok(reduce(base, executeEv())), { type: "signed", txHash: hash(1) }));
    const attributing = ok(reduce(signed, { type: "tx-confirmed", receipt: minted(hash(1)) }));
    expect(ok(reduce(attributing, measured(PREDICTED))).phase).toEqual({ kind: "complete" });
  });

  it("a divergence halt preserves the intent's resolved calldata amount (finding 2)", () => {
    const facts = { nonce: 7n, resolvedAmountWei: 42n, approval: null, beforeShares: null };
    const dispatched = ok(reduce(readyMachine("live"), executeEv(facts)));
    const signed = ok(reduce(dispatched, { type: "signed", txHash: hash(1) }));
    const attributing = ok(reduce(signed, { type: "tx-confirmed", receipt: minted(hash(1)) }));
    const machine = ok(reduce(attributing, measured(2n * PREDICTED)));
    expect(machine.phase.kind).toBe("halted-divergent");
    expect(recordOf(machine).halted?.resolvedAmountWei).toBe(42n);
    expect(recordOf(machine).intent).toBeNull();
  });

  it("refuses to compare against a missing prediction — never a default (SPEC §5)", () => {
    const base = readyMachine("live", noPredictionPlan);
    const nullOutput: ExecutionMachine = {
      ...base,
      record: recOk(
        openDispatchIntent(recordOf(base), { stepIndex: 0, stepId: "s0", txHash: hash(1), ...NULL_FACTS }),
      ),
      phase: { kind: "attributing", stepIndex: 0, receipt: receiptRef(hash(1)), consumedApproval: null },
    };
    expect(refused(reduce(nullOutput, measured(PREDICTED)), nullOutput)).toEqual({
      kind: "no-prediction",
      stepId: "s0",
    });
    const missingFlow: ExecutionMachine = {
      ...base,
      phase: { kind: "attributing", stepIndex: 1, receipt: receiptRef(hash(1)), consumedApproval: null },
    };
    expect(refused(reduce(missingFlow, measured(PREDICTED)), missingFlow)).toEqual({
      kind: "no-prediction",
      stepId: "s1",
    });
  });

  it("re-enters the comparison from attribution-unavailable (D3 recovery)", () => {
    const unavailable = ok(reduce(attributingLive(), { type: "attribution-unavailable", beforeShares: 3n }));
    expect(unavailable.phase).toEqual({
      kind: "attribution-unavailable",
      stepIndex: 0,
      receipt: { txHash: hash(1), blockNumber: 123n, blockHash: hash(0xb10c), gasUsed: null },
      beforeShares: 3n,
      consumedApproval: null,
    });
    const machine = ok(reduce(unavailable, measured(PREDICTED)));
    expect(machine.phase).toEqual({ kind: "attributed", stepIndex: 0 });
  });

  it("attribution-measured is illegal outside the attributing family", () => {
    const machine = pendingSandbox();
    expect(refused(reduce(machine, measured(PREDICTED)), machine).kind).toBe("illegal-transition");
  });
});

describe("settlement requirements on the canonical plan (finding 2)", () => {
  it("walks all 13 canonical steps live: measured producers, settled non-producers, checked consumers", () => {
    let machine = readyMachine("live", canonicalPlan);
    for (let k = 0; k < canonicalPlan.steps.length; k += 1) {
      machine = ok(reduce(machine, k === 0 ? executeEv() : advanceEv()));
      machine = ok(reduce(machine, { type: "signed", txHash: hash(0x1000 + k) }));
      machine = ok(reduce(machine, { type: "tx-confirmed", receipt: minted(hash(0x1000 + k)) }));
      machine = settleCanonicalStep(machine, k);
    }
    expect(machine.phase).toEqual({ kind: "complete" });
    const settled = recordOf(machine).settled;
    expect(settled.map((entry) => entry.stepId)).toEqual(canonicalPlan.steps.map((s) => s.id));
    for (const entry of settled) {
      const requirements = stepRequirementsOf(canonicalPlan, canonicalStep(entry.stepIndex));
      expect(entry.output === null ? null : entry.output.mechanism).toBe(requirements.output);
      if (requirements.consumesApprovalFrom !== null) {
        expect(entry.consumedApproval).toEqual({
          spender: requirements.consumesApprovalFrom,
          residualAllowanceWei: 0n,
        });
      }
    }
  });

  it("an approval cannot be settled by measuring another step's output", () => {
    const machine = canonicalLiveAt(1); // wrap1:approve confirmed
    const refusal = refused(
      reduce(machine, { type: "attribution-measured", mechanism: "share-delta", attributedWei: 1n, sharesDelta: null }),
      machine,
    );
    expect(refusal).toEqual({
      kind: "mechanism-mismatch",
      stepId: "wrap1:approve",
      expected: null,
      received: "share-delta",
    });
  });

  it("a producer demands its exact mechanism", () => {
    const machine = canonicalLiveAt(0); // stake1:deposit confirmed
    const refusal = refused(
      reduce(machine, {
        type: "attribution-measured",
        mechanism: "transfer-event",
        attributedWei: 1n,
        sharesDelta: null,
      }),
      machine,
    );
    expect(refusal).toEqual({
      kind: "mechanism-mismatch",
      stepId: "stake1:deposit",
      expected: "share-delta",
      received: "transfer-event",
    });
  });

  it("a producer cannot take the no-output settlement path", () => {
    const machine = canonicalLiveAt(0);
    expect(refused(reduce(machine, { type: "non-producer-settled" }), machine)).toEqual({
      kind: "output-required",
      stepId: "stake1:deposit",
      mechanism: "share-delta",
    });
  });

  it("§3.3 is mandatory: a consuming producer cannot settle before its residual verdict", () => {
    const machine = canonicalLiveAt(2); // wrap1:wrap confirmed, residual unchecked
    const refusal = refused(
      reduce(machine, {
        type: "attribution-measured",
        mechanism: "transfer-event",
        attributedWei: canonicalPredicted(2),
        sharesDelta: null,
      }),
      machine,
    );
    expect(refusal.kind).toBe("residual-check-required");
  });

  it("§3.3 is mandatory: a consuming non-producer cannot settle before its residual verdict", () => {
    let machine = canonicalLiveAt(5); // supply1:supply confirmed, residual unchecked
    const refusal = refused(reduce(machine, { type: "non-producer-settled" }), machine);
    expect(refusal.kind).toBe("residual-check-required");
    machine = ok(
      reduce(machine, {
        type: "residual-allowance-checked",
        spender: canonicalStep(5).to,
        residualAllowanceWei: 0n,
      }),
    );
    machine = ok(reduce(machine, { type: "non-producer-settled" }));
    expect(machine.phase).toEqual({ kind: "attributed", stepIndex: 5 });
  });

  it("a residual check against a non-consuming step is refused", () => {
    const machine = canonicalLiveAt(0);
    expect(
      refused(
        reduce(machine, { type: "residual-allowance-checked", spender: SPENDER, residualAllowanceWei: 0n }),
        machine,
      ),
    ).toEqual({ kind: "no-approval-to-check", stepId: "stake1:deposit" });
  });

  it("a residual check against the wrong spender is refused", () => {
    const machine = canonicalLiveAt(2);
    const refusal = refused(
      reduce(machine, { type: "residual-allowance-checked", spender: ACTOR, residualAllowanceWei: 0n }),
      machine,
    );
    expect(refusal).toEqual({
      kind: "spender-mismatch",
      stepId: "wrap1:wrap",
      expected: getAddress(canonicalStep(2).to),
      received: getAddress(ACTOR),
    });
  });

  it("a second residual check for the same step is refused", () => {
    const checked = ok(
      reduce(canonicalLiveAt(2), {
        type: "residual-allowance-checked",
        spender: canonicalStep(2).to,
        residualAllowanceWei: 0n,
      }),
    );
    expect(
      refused(
        reduce(checked, {
          type: "residual-allowance-checked",
          spender: canonicalStep(2).to,
          residualAllowanceWei: 0n,
        }),
        checked,
      ).kind,
    ).toBe("illegal-transition");
  });

  it("a nonzero residual halts through the T18 data-error identity", () => {
    const machine = ok(
      reduce(canonicalLiveAt(2), {
        type: "residual-allowance-checked",
        spender: canonicalStep(2).to,
        residualAllowanceWei: 17n,
      }),
    );
    expect(machine.phase.kind).toBe("halted-divergent");
    expect(recordOf(machine).halted?.halt).toEqual({
      kind: "residual-allowance",
      stepIndex: 2,
      stepId: "wrap1:wrap",
      spender: canonicalStep(2).to,
      residualAllowanceWei: 17n,
      receipt: { txHash: hash(0x1002), blockNumber: 123n, blockHash: hash(0xb10c), gasUsed: null },
    });
  });

  it("a residual halt preserves the intent's resolved calldata amount (finding 2)", () => {
    let machine = canonicalLiveAt(1);
    machine = settleCanonicalStep(machine, 1);
    machine = ok(reduce(machine, advanceEv({ resolvedAmountWei: 42n })));
    machine = ok(reduce(machine, { type: "signed", txHash: hash(0x1002) }));
    machine = ok(reduce(machine, { type: "tx-confirmed", receipt: minted(hash(0x1002)) }));
    machine = ok(
      reduce(machine, {
        type: "residual-allowance-checked",
        spender: canonicalStep(2).to,
        residualAllowanceWei: 17n,
      }),
    );
    expect(machine.phase.kind).toBe("halted-divergent");
    expect(recordOf(machine).halted?.resolvedAmountWei).toBe(42n);
    expect(recordOf(machine).intent).toBeNull();
  });

  it("a divergence halt on the canonical consumer preserves the intent's resolved amount (finding 2)", () => {
    let machine = canonicalLiveAt(1);
    machine = settleCanonicalStep(machine, 1);
    machine = ok(reduce(machine, advanceEv({ resolvedAmountWei: 42n })));
    machine = ok(reduce(machine, { type: "signed", txHash: hash(0x1002) }));
    machine = ok(reduce(machine, { type: "tx-confirmed", receipt: minted(hash(0x1002)) }));
    machine = ok(
      reduce(machine, {
        type: "residual-allowance-checked",
        spender: canonicalStep(2).to,
        residualAllowanceWei: 0n,
      }),
    );
    machine = ok(
      reduce(machine, {
        type: "attribution-measured",
        mechanism: "transfer-event",
        attributedWei: 2n * canonicalPredicted(2),
        sharesDelta: null,
      }),
    );
    expect(machine.phase.kind).toBe("halted-divergent");
    expect(recordOf(machine).halted?.resolvedAmountWei).toBe(42n);
    expect(recordOf(machine).intent).toBeNull();
  });

  it("a residual verdict survives a failed measurement and settles from re-entry (D3)", () => {
    let machine = ok(
      reduce(canonicalLiveAt(2), {
        type: "residual-allowance-checked",
        spender: canonicalStep(2).to,
        residualAllowanceWei: 0n,
      }),
    );
    machine = ok(reduce(machine, { type: "attribution-unavailable", beforeShares: 3n }));
    expect(machine.phase.kind === "attribution-unavailable" && machine.phase.consumedApproval).toEqual({
      spender: canonicalStep(2).to,
      residualAllowanceWei: 0n,
    });
    machine = ok(
      reduce(machine, {
        type: "attribution-measured",
        mechanism: "transfer-event",
        attributedWei: canonicalPredicted(2),
        sharesDelta: null,
      }),
    );
    expect(machine.phase).toEqual({ kind: "attributed", stepIndex: 2 });
    expect(recordOf(machine).settled[2]?.consumedApproval).toEqual({
      spender: canonicalStep(2).to,
      residualAllowanceWei: 0n,
    });
  });

  it("a residual check can land while attribution is unavailable (D3 re-entry)", () => {
    let machine = ok(reduce(canonicalLiveAt(2), { type: "attribution-unavailable", beforeShares: 3n }));
    machine = ok(
      reduce(machine, {
        type: "residual-allowance-checked",
        spender: canonicalStep(2).to,
        residualAllowanceWei: 0n,
      }),
    );
    expect(machine.phase.kind).toBe("attribution-unavailable");
    machine = ok(
      reduce(machine, {
        type: "attribution-measured",
        mechanism: "transfer-event",
        attributedWei: canonicalPredicted(2),
        sharesDelta: null,
      }),
    );
    expect(machine.phase).toEqual({ kind: "attributed", stepIndex: 2 });
  });

  it("an approve settles through the explicit non-producer path with its dispatch facts", () => {
    const approval = { spender: SPENDER, priorAllowanceWei: 0n, approvedWei: PREDICTED };
    let machine = canonicalLiveAt(0);
    machine = settleCanonicalStep(machine, 0);
    machine = ok(reduce(machine, advanceEv({ resolvedAmountWei: 5n, approval })));
    machine = ok(reduce(machine, { type: "signed", txHash: hash(0x1001) }));
    machine = ok(reduce(machine, { type: "tx-confirmed", receipt: minted(hash(0x1001)) }));
    machine = ok(reduce(machine, { type: "non-producer-settled" }));
    expect(machine.phase).toEqual({ kind: "attributed", stepIndex: 1 });
    const entry = recordOf(machine).settled[1];
    expect(entry?.stepId).toBe("wrap1:approve");
    expect(entry?.resolvedAmountWei).toBe(5n);
    expect(entry?.approval).toEqual(approval);
    expect(entry?.output).toBeNull();
  });

  it("adopting a server result for a consumer without its residual verdict refuses (§3.3)", () => {
    let machine = readyMachine("sandbox", canonicalPlan);
    for (let k = 0; k < 5; k += 1) {
      machine = ok(reduce(machine, k === 0 ? executeEv() : advanceEv()));
      machine = ok(reduce(machine, { type: "step-result", result: canonicalSandboxResult(k) }));
    }
    machine = ok(reduce(machine, advanceEv()));
    const refusal = refused(
      reduce(machine, {
        type: "step-result",
        result: canonicalSandboxResult(5, { consumedApproval: null }),
      }),
      machine,
    );
    expect(refusal.kind).toBe("residual-check-required");
    const adopted = ok(reduce(machine, { type: "step-result", result: canonicalSandboxResult(5) }));
    expect(adopted.phase).toEqual({ kind: "attributed", stepIndex: 5 });
  });

  it("non-producer-settled is illegal outside attributing", () => {
    const machine = pendingSandbox();
    expect(refused(reduce(machine, { type: "non-producer-settled" }), machine).kind).toBe(
      "illegal-transition",
    );
  });
});

describe("D3 cells", () => {
  it("persistence-failed carries its measurement and distinguishes both unpersisted cells", () => {
    const measuredCell = ok(
      reduce(attributingLive(), {
        type: "persistence-failed",
        measurement: { status: "measured", beforeShares: 3n, sharesDelta: 2n },
      }),
    );
    expect(attributionCellOf(measuredCell.phase)).toBe("unpersisted-measured");
    const unmeasuredCell = ok(
      reduce(attributingLive(), {
        type: "persistence-failed",
        measurement: { status: "unavailable", beforeShares: 3n, cause: "read refused" },
      }),
    );
    expect(attributionCellOf(unmeasuredCell.phase)).toBe("unpersisted-unmeasured");
  });

  it("names all four persistence × measurement cells", () => {
    const attributed = ok(reduce(attributingLive(), measured(PREDICTED)));
    expect(attributionCellOf(attributed.phase)).toBe("persisted-measured");
    const unavailable = ok(reduce(attributingLive(), { type: "attribution-unavailable", beforeShares: 3n }));
    expect(attributionCellOf(unavailable.phase)).toBe("persisted-unmeasured");
    expect(attributionCellOf({ kind: "ready" })).toBeNull();
  });

  it("D3: no dispatch out of a persistence failure before reconciliation", () => {
    const persistence = ok(
      reduce(attributingLive(), {
        type: "persistence-failed",
        measurement: { status: "measured", beforeShares: 3n, sharesDelta: 2n },
      }),
    );
    expect(refused(reduce(persistence, advanceEv()), persistence)).toEqual({
      kind: "reconcile-required",
      phase: "persistence-failed",
    });
    const unavailable = ok(reduce(attributingLive(), { type: "attribution-unavailable", beforeShares: 3n }));
    expect(refused(reduce(unavailable, advanceEv()), unavailable).kind).toBe("reconcile-required");
    const unresolved = ok(reduce(awaiting(), { type: "request-failed" }));
    expect(refused(reduce(unresolved, advanceEv()), unresolved).kind).toBe("reconcile-required");
  });

  it("the cell events are illegal outside attributing", () => {
    const machine = pendingSandbox();
    expect(
      refused(reduce(machine, { type: "attribution-unavailable", beforeShares: null }), machine).kind,
    ).toBe("illegal-transition");
    expect(
      refused(
        reduce(machine, {
          type: "persistence-failed",
          measurement: { status: "measured", beforeShares: null, sharesDelta: null },
        }),
        machine,
      ).kind,
    ).toBe("illegal-transition");
  });
});

describe("sandbox step results", () => {
  it("an attributed result settles the adopted server facts verbatim", () => {
    const machine = ok(reduce(pendingSandbox(), { type: "step-result", result: attributedResult(0, "s0") }));
    expect(machine.phase).toEqual({ kind: "attributed", stepIndex: 0 });
    const entry = recordOf(machine).settled[0];
    expect(entry?.approval).toEqual({ spender: SPENDER, priorAllowanceWei: 0n, approvedWei: PREDICTED });
    expect(entry?.risk?.chainHfWad).toBe(2n * WAD);
    expect(recordOf(machine).intent).toBeNull();
  });

  it("the last attributed result completes the run", () => {
    const base = readyMachine("sandbox", singleStepPlan);
    const pending = ok(reduce(base, executeEv()));
    expect(ok(reduce(pending, { type: "step-result", result: attributedResult(0, "s0") })).phase).toEqual({
      kind: "complete",
    });
  });

  it("a halted result adopts the server's halt evidence", () => {
    const result: SandboxStepResult = { status: "halted", ...haltedFact(0, "s0") };
    const machine = ok(reduce(pendingSandbox(), { type: "step-result", result }));
    expect(machine.phase.kind).toBe("halted-divergent");
    expect(recordOf(machine).halted?.halt.kind).toBe("output-divergence");
  });

  it("a failed result records the server's enriched failure and resolves the intent", () => {
    const decoded = { message: "HF too low", raw: "0x1234", source: "custom-error" as const };
    const result: SandboxStepResult = {
      status: "failed",
      failure: { stepIndex: 0, stepId: "s0", txHash: hash(0xf), decoded, raw: "0x1234" },
    };
    const machine = ok(reduce(pendingSandbox(), { type: "step-result", result }));
    expect(machine.phase).toEqual({ kind: "failed-at", stepIndex: 0, cause: "reverted" });
    expect(recordOf(machine).failure?.decoded).toEqual(decoded);
    expect(recordOf(machine).intent).toBeNull();
  });

  it("a failed result over a bare record still lands durably (crafted cache)", () => {
    const base = pendingSandbox();
    const machine: ExecutionMachine = { ...base, record: createRecord(PLAN_HASH) };
    const result: SandboxStepResult = {
      status: "failed",
      failure: { stepIndex: 0, stepId: "s0", txHash: hash(0xf), decoded: null, raw: null },
    };
    const landed = ok(reduce(machine, { type: "step-result", result }));
    expect(landed.phase.kind).toBe("failed-at");
  });

  it("the recovery arms carry their D11 payloads into the matching phases", () => {
    const unavailable: SandboxStepResult = {
      status: "attribution-unavailable",
      stepIndex: 0,
      stepId: "s0",
      receipt: receiptRef(hash(0x51)),
      beforeShares: 3n,
    };
    expect(ok(reduce(pendingSandbox(), { type: "step-result", result: unavailable })).phase).toEqual({
      kind: "attribution-unavailable",
      stepIndex: 0,
      receipt: receiptRef(hash(0x51)),
      beforeShares: 3n,
      consumedApproval: null,
    });
    const persistence: SandboxStepResult = {
      status: "persistence-failed",
      stepIndex: 0,
      stepId: "s0",
      receipt: receiptRef(hash(0x51)),
      measurement: { status: "measured", beforeShares: 3n, sharesDelta: 2n },
    };
    expect(ok(reduce(pendingSandbox(), { type: "step-result", result: persistence })).phase.kind).toBe(
      "persistence-failed",
    );
  });

  it("dispatch-unresolved pins a discovered hash on the hashless intent (D6)", () => {
    const result: SandboxStepResult = {
      status: "dispatch-unresolved",
      stepIndex: 0,
      stepId: "s0",
      txHash: hash(5),
    };
    const machine = ok(reduce(pendingSandbox(), { type: "step-result", result }));
    expect(machine.phase).toEqual({ kind: "dispatch-unresolved", stepIndex: 0, txHash: hash(5) });
    expect(recordOf(machine).intent?.txHash).toBe(hash(5));
  });

  it("dispatch-unresolved without a hash leaves the intent as dispatched", () => {
    const result: SandboxStepResult = {
      status: "dispatch-unresolved",
      stepIndex: 0,
      stepId: "s0",
      txHash: null,
    };
    const machine = ok(reduce(pendingSandbox(), { type: "step-result", result }));
    expect(recordOf(machine).intent?.txHash).toBeNull();
  });

  it("D4: a result citing a different step identity is refused, never guessed", () => {
    const machine = pendingSandbox();
    const wrongId = refused(
      reduce(machine, { type: "step-result", result: attributedResult(0, "sX") }),
      machine,
    );
    expect(wrongId).toEqual({
      kind: "step-identity-mismatch",
      expectedIndex: 0,
      expectedId: "s0",
      receivedIndex: 0,
      receivedId: "sX",
    });
    const wrongIndex = refused(
      reduce(machine, { type: "step-result", result: attributedResult(1, "s1") }),
      machine,
    );
    expect(wrongIndex.kind).toBe("step-identity-mismatch");
  });

  it("step-result is sandbox-only and pending-only", () => {
    const live = pendingLive();
    expect(
      refused(reduce(live, { type: "step-result", result: attributedResult(0, "s0") }), live).kind,
    ).toBe("illegal-transition");
    const ready = readyMachine();
    expect(
      refused(reduce(ready, { type: "step-result", result: attributedResult(0, "s0") }), ready).kind,
    ).toBe("illegal-transition");
  });
});

describe("sandbox step refusals", () => {
  it("session-expired lands the T24 abandoned state", () => {
    const machine = ok(
      reduce(pendingSandbox(), { type: "step-refused", refusal: { kind: "session-expired", executedSteps: 1 } }),
    );
    expect(machine.phase).toEqual({ kind: "abandoned", executedSteps: 1, recovery: null });
  });

  it("a server halt for the same step is adopted", () => {
    const machine = ok(
      reduce(pendingSandbox(), { type: "step-refused", refusal: { kind: "halted", halt: divergenceHalt(0, "s0") } }),
    );
    expect(machine.phase.kind).toBe("halted-divergent");
    expect(recordOf(machine).halted?.resolvedAmountWei).toBeNull();
  });

  it("a server halt for a different step demands resync", () => {
    const machine = pendingSandbox();
    expect(
      refused(
        reduce(machine, { type: "step-refused", refusal: { kind: "halted", halt: divergenceHalt(1, "s1") } }),
        machine,
      ).kind,
    ).toBe("resync-required");
  });

  it("a server failure for the same step is adopted; a different step demands resync", () => {
    const failure = { stepIndex: 0, stepId: "s0", txHash: hash(0xf), decoded: null, raw: null };
    const machine = ok(reduce(pendingSandbox(), { type: "step-refused", refusal: { kind: "failed", failure } }));
    expect(machine.phase).toEqual({ kind: "failed-at", stepIndex: 0, cause: "reverted" });
    const fresh = pendingSandbox();
    expect(
      refused(
        reduce(fresh, {
          type: "step-refused",
          refusal: { kind: "failed", failure: { ...failure, stepIndex: 1, stepId: "s1" } },
        }),
        fresh,
      ).kind,
    ).toBe("resync-required");
  });

  it("reconcile-required from the server demands rehydration", () => {
    const machine = pendingSandbox();
    expect(
      refused(reduce(machine, { type: "step-refused", refusal: { kind: "reconcile-required" } }), machine).kind,
    ).toBe("resync-required");
  });

  it("transient refusals surface as transport refusals with the run state untouched", () => {
    const machine = pendingSandbox();
    const refusal = refused(
      reduce(machine, { type: "step-refused", refusal: { kind: "rate-limited", retryAfterMs: 500 } }),
      machine,
    );
    expect(refusal).toEqual({ kind: "transport-refusal", refusal: { kind: "rate-limited", retryAfterMs: 500 } });
  });

  it("step-refused is sandbox-only and pending-only", () => {
    const live = pendingLive();
    expect(
      refused(reduce(live, { type: "step-refused", refusal: { kind: "session-busy" } }), live).kind,
    ).toBe("illegal-transition");
  });
});

describe("reconciliation (never re-send)", () => {
  const persistenceMachine = (): ExecutionMachine =>
    ok(
      reduce(pendingSandbox(), {
        type: "step-result",
        result: {
          status: "persistence-failed",
          stepIndex: 0,
          stepId: "s0",
          receipt: receiptRef(hash(0x51)),
          measurement: { status: "measured", beforeShares: 3n, sharesDelta: 2n },
        },
      }),
    );

  it("a reconcile result settles the pending step from persistence-failed", () => {
    const machine = ok(
      reduce(persistenceMachine(), { type: "reconcile-result", result: attributedResult(0, "s0") }),
    );
    expect(machine.phase).toEqual({ kind: "attributed", stepIndex: 0 });
  });

  it("discovery proving a vacated dispatch re-legalizes exactly that step", () => {
    const unresolved = ok(
      reduce(pendingSandbox(), {
        type: "step-result",
        result: { status: "dispatch-unresolved", stepIndex: 0, stepId: "s0", txHash: null },
      }),
    );
    const vacated = ok(
      reduce(unresolved, {
        type: "reconcile-result",
        result: { status: "dispatch-vacated", stepIndex: 0, stepId: "s0" },
      }),
    );
    expect(vacated.phase).toEqual({ kind: "dispatch-vacated", stepIndex: 0 });
    expect(recordOf(vacated).intent).toBeNull();
    const redispatched = ok(reduce(vacated, advanceEv()));
    expect(redispatched.phase).toEqual({ kind: "pending", stepIndex: 0, txHash: null });
    expect(recordOf(redispatched).intent?.stepIndex).toBe(0);
  });

  it("reconcile-result is legal from a resumed attributing state", () => {
    const base = pendingSandbox();
    const attributing: ExecutionMachine = {
      ...base,
      phase: { kind: "attributing", stepIndex: 0, receipt: receiptRef(hash(0x51)), consumedApproval: null },
    };
    const machine = ok(reduce(attributing, { type: "reconcile-result", result: attributedResult(0, "s0") }));
    expect(machine.phase).toEqual({ kind: "attributed", stepIndex: 0 });
  });

  it("reconcile-result is refused outside the recovery family and outside sandbox", () => {
    const machine = pendingSandbox();
    expect(
      refused(reduce(machine, { type: "reconcile-result", result: attributedResult(0, "s0") }), machine).kind,
    ).toBe("illegal-transition");
    const live = attributingLive();
    expect(
      refused(reduce(live, { type: "reconcile-result", result: attributedResult(0, "s0") }), live).kind,
    ).toBe("illegal-transition");
  });
});

describe("failure enrichment (D7)", () => {
  it("fills the durable entry's nulls after the fact and refuses overwrites", () => {
    const failed = ok(reduce(pendingLive(), { type: "tx-reverted", txHash: hash(1) }));
    const decoded = { message: "HF too low", raw: "0x1234", source: "custom-error" as const };
    const enriched = ok(reduce(failed, { type: "failure-enriched", decoded, raw: "0x1234" }));
    expect(enriched.phase).toEqual(failed.phase);
    expect(recordOf(enriched).failure?.decoded).toEqual(decoded);
    const refusal = refused(reduce(enriched, { type: "failure-enriched", decoded, raw: null }), enriched);
    expect(refusal).toEqual({ kind: "record-refused", refusal: { kind: "enrichment-overwrite", field: "decoded" } });
  });

  it("is illegal outside failed-at", () => {
    const machine = readyMachine();
    expect(refused(reduce(machine, { type: "failure-enriched", decoded: null, raw: null }), machine).kind).toBe(
      "illegal-transition",
    );
  });
});

describe("wallet-changed and session-lost", () => {
  it("halts a live run when the signer changes (A2)", () => {
    for (const machine of [readyMachine("live"), awaiting(), pendingLive(), attributingLive()]) {
      expect(ok(reduce(machine, { type: "wallet-changed" })).phase).toEqual({ kind: "halted-wallet-changed" });
    }
  });

  it("wallet-changed is meaningless in sandbox and before ready", () => {
    const sandbox = pendingSandbox();
    expect(refused(reduce(sandbox, { type: "wallet-changed" }), sandbox).kind).toBe("illegal-transition");
    const idle = createExecutionMachine({ mode: "live", tolerance: SANDBOX_OUTPUT_TOLERANCE });
    expect(refused(reduce(idle, { type: "wallet-changed" }), idle).kind).toBe("illegal-transition");
  });

  it("session-lost abandons a sandbox run mid-flight (T24)", () => {
    const machine = ok(reduce(pendingSandbox(), { type: "session-lost", executedSteps: 0 }));
    expect(machine.phase).toEqual({ kind: "abandoned", executedSteps: 0, recovery: null });
  });

  it("session-lost is refused in live mode and from idle", () => {
    const live = pendingLive();
    expect(refused(reduce(live, { type: "session-lost", executedSteps: 0 }), live).kind).toBe(
      "illegal-transition",
    );
    const idle = createExecutionMachine({ mode: "sandbox" });
    expect(refused(reduce(idle, { type: "session-lost", executedSteps: 0 }), idle).kind).toBe(
      "illegal-transition",
    );
  });
});

describe("A12: halted and terminal states pin against the full event catalog", () => {
  const bound = toleranceWeiFor(PREDICTED, SANDBOX_OUTPUT_TOLERANCE);
  const haltedDivergent = () => ok(reduce(attributingLive(), measured(PREDICTED + bound + 1n)));
  const walletChanged = () => ok(reduce(readyMachine("live"), { type: "wallet-changed" }));
  const abandoned = () => ok(reduce(pendingSandbox(), { type: "session-lost", executedSteps: 0 }));
  const complete = () => {
    const pending = ok(reduce(readyMachine("sandbox", singleStepPlan), executeEv()));
    return ok(reduce(pending, { type: "step-result", result: attributedResult(0, "s0") }));
  };

  for (const [name, build] of [
    ["halted-divergent", haltedDivergent],
    ["halted-wallet-changed", walletChanged],
    ["abandoned", abandoned],
    ["complete", complete],
  ] as const) {
    it(`${name} refuses every event`, () => {
      const machine = build();
      for (const event of EVENT_CATALOG) {
        const refusal = refused(reduce(machine, event), machine);
        expect(refusal.kind).toBe("halt-pinned");
      }
    });
  }
});

describe("illegal-event sweep at ready (states, not absorption)", () => {
  it("every inapplicable event at ready is a surfaced illegal transition", () => {
    const machine = readyMachine();
    const legalAtSandboxReady = new Set(["execute", "document-mutated", "session-lost"]);
    for (const event of EVENT_CATALOG) {
      if (legalAtSandboxReady.has(event.type)) continue;
      expect(refused(reduce(machine, event), machine).kind).toBe("illegal-transition");
    }
  });
});

describe("machine invariants fail loud", () => {
  it("a run phase without a plan or record throws", () => {
    const corrupted: ExecutionMachine = {
      ...createExecutionMachine({ mode: "sandbox" }),
      phase: { kind: "pending", stepIndex: 0, txHash: null },
    };
    expect(() => reduce(corrupted, { type: "step-result", result: attributedResult(0, "s0") })).toThrow(
      /invariant/,
    );
  });

  it("a step index outside the plan throws", () => {
    const base = pendingSandbox();
    const corrupted: ExecutionMachine = {
      ...base,
      phase: { kind: "attributing", stepIndex: 9, receipt: receiptRef(hash(1)), consumedApproval: null },
    };
    expect(() => reduce(corrupted, measured(PREDICTED))).toThrow(/no step at index 9/);
  });
});

describe("full sandbox run", () => {
  it("walks execute → step-result → advance → step-result → complete", () => {
    let machine = readyMachine();
    machine = ok(reduce(machine, executeEv()));
    machine = ok(reduce(machine, { type: "step-result", result: attributedResult(0, "s0") }));
    expect(machine.phase).toEqual({ kind: "attributed", stepIndex: 0 });
    machine = ok(reduce(machine, advanceEv()));
    machine = ok(reduce(machine, { type: "step-result", result: attributedResult(1, "s1") }));
    expect(machine.phase).toEqual({ kind: "complete" });
    expect(recordOf(machine).settled).toHaveLength(2);
  });
});
