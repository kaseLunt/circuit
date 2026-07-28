import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { BlockFlow, PlanSuccess, TransactionStep } from "../../core/plan";
import { reduce, type ExecutionMachine } from "./machine";
import {
  refusalFactOf,
  resumePlan,
  stepResultFactOf,
  type ResumeOutcome,
  type ResumeRefusal,
  type WireFailure,
  type WireHalt,
  type WireMeasurement,
  type WireReceipt,
  type WireRecovery,
  type WireRefusal,
  type WireSessionResponse,
  type WireSessionSummary,
  type WireStepResult,
} from "./resume";

const WAD = 10n ** 18n;
const PREDICTED = 10n * WAD;
const ACTOR = "0x00000000000000000000000000000000000000aa" as Address;
const SPENDER = "0x00000000000000000000000000000000000000bb";
const PLAN_HASH = `0x${"ab".repeat(32)}` as Hex;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const configured = (value: bigint) => ({
  kind: "configured" as const,
  value,
  name: "test-figure",
  definedAt: "resume.test.ts",
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

function flow(blockId: string): BlockFlow {
  return {
    blockId,
    type: "stake",
    inputAsset: "ETH",
    inputWei: null,
    outputAsset: "eETH",
    outputWei: configured(PREDICTED),
    reserve: null,
  };
}

const plan: PlanSuccess = {
  ok: true,
  steps: [step("s0", 0, "b0"), step("s1", 1, "b1")],
  targetEModeCategoryId: null,
  flows: [flow("b0"), flow("b1")],
};

const wireReceipt = (txHash: Hex) => ({
  txHash,
  blockNumber: "123",
  blockHash: hash(0xb10c),
  gasUsed: null as string | null,
});

type WireAttributed = Extract<WireStepResult, { status: "attributed" }>;
type WireHaltedStep = Extract<WireStepResult, { status: "halted" }>;

function wireAttributed(stepIndex: number, stepId: string): WireAttributed {
  return {
    status: "attributed",
    stepIndex,
    stepId,
    receipt: wireReceipt(hash(0x51 + stepIndex)),
    resolvedAmountWei: PREDICTED.toString(),
    sharesDelta: "-5",
    output: {
      mechanism: "share-delta",
      predictedWei: PREDICTED.toString(),
      attributedWei: PREDICTED.toString(),
      toleranceWei: "1",
    },
    approval: { spender: SPENDER, priorAllowanceWei: "0", approvedWei: PREDICTED.toString() },
    consumedApproval: { spender: SPENDER, residualAllowanceWei: "0" },
    risk: { expected: { status: "healthy", hfWad: (2n * WAD).toString() }, chainHfWad: (2n * WAD).toString() },
  };
}

function wireAttributedBare(stepIndex: number, stepId: string): WireAttributed {
  return {
    status: "attributed",
    stepIndex,
    stepId,
    receipt: wireReceipt(hash(0x51 + stepIndex)),
    resolvedAmountWei: null,
    sharesDelta: null,
    output: null,
    approval: null,
    consumedApproval: null,
    risk: null,
  };
}

function wireDivergence(
  stepIndex: number,
  stepId: string,
): Extract<WireHalt, { kind: "output-divergence" }> {
  return {
    kind: "output-divergence",
    stepIndex,
    stepId,
    mechanism: "share-delta",
    predictedWei: PREDICTED.toString(),
    attributedWei: (2n * PREDICTED).toString(),
    toleranceWei: "1",
    detail: null,
    receipt: wireReceipt(hash(0x77)),
  };
}

function wireHalted(stepIndex: number, stepId: string): WireHaltedStep {
  return {
    status: "halted",
    stepIndex,
    stepId,
    receipt: wireReceipt(hash(0x77)),
    resolvedAmountWei: null,
    sharesDelta: null,
    halt: wireDivergence(stepIndex, stepId),
  };
}

function summary(overrides: Partial<WireSessionSummary>): WireSessionSummary {
  return {
    baseBlock: "100",
    baseBlockHash: hash(0xba5e),
    actor: ACTOR,
    createdAtMs: 1,
    expiresAtMs: 2,
    phase: { kind: "active" },
    planHash: PLAN_HASH,
    planStepCount: 2,
    txCount: 0,
    executed: [],
    recovery: null,
    ...overrides,
  };
}

const respond = (session: WireSessionSummary): WireSessionResponse => ({ ok: true, session });

function resumed(outcome: ResumeOutcome): ExecutionMachine {
  if (!outcome.ok) throw new Error(`unexpected resume refusal: ${outcome.refusal.kind}`);
  return outcome.machine;
}

function resumeRefused(outcome: ResumeOutcome): ResumeRefusal {
  if (outcome.ok) throw new Error("expected a resume refusal");
  return outcome.refusal;
}

const resumeWith = (response: WireSessionResponse): ResumeOutcome =>
  resumePlan({ plan, planHash: PLAN_HASH, response });

describe("resumePlan — active sessions", () => {
  it("an empty active session resumes to ready over the FROZEN plan reference", () => {
    const machine = resumed(resumeWith(respond(summary({}))));
    expect(machine.phase).toEqual({ kind: "ready" });
    expect(machine.plan).toBe(plan);
    expect(machine.planHash).toBe(PLAN_HASH);
    expect(machine.mode).toBe("sandbox");
    expect(machine.record?.settled).toEqual([]);
  });

  it("a mid-plan session resumes to attributed(k) and continues from k+1, never re-sending", () => {
    const machine = resumed(resumeWith(respond(summary({ executed: [wireAttributed(0, "s0")], txCount: 1 }))));
    expect(machine.phase).toEqual({ kind: "attributed", stepIndex: 0 });
    const entry = machine.record?.settled[0];
    expect(entry?.resolvedAmountWei).toBe(PREDICTED);
    expect(entry?.sharesDelta).toBe(-5n);
    expect(entry?.consumedApproval).toEqual({ spender: SPENDER, residualAllowanceWei: 0n });
    const advanced = reduce(machine, { type: "advance", facts: { nonce: null, resolvedAmountWei: null, approval: null, beforeShares: null } });
    expect(advanced.refusal).toBeNull();
    expect(advanced.machine.phase).toEqual({ kind: "pending", stepIndex: 1, txHash: null });
    expect(advanced.machine.record?.intent?.stepId).toBe("s1");
  });

  it("a fully executed session resumes to complete", () => {
    const machine = resumed(
      resumeWith(respond(summary({ executed: [wireAttributedBare(0, "s0"), wireAttributedBare(1, "s1")] }))),
    );
    expect(machine.phase).toEqual({ kind: "complete" });
    expect(machine.record?.settled).toHaveLength(2);
  });

  it("an active phase over a halted executed record is malformed", () => {
    const outcome = resumeWith(respond(summary({ executed: [wireHalted(0, "s0")] })));
    expect(resumeRefused(outcome)).toEqual({
      kind: "malformed-summary",
      detail: "active phase over a halted record",
    });
  });
});

describe("resumePlan — identity and shape gates", () => {
  it("refuses a different plan hash (plan freezing, §2.4)", () => {
    const outcome = resumeWith(respond(summary({ planHash: `0x${"cd".repeat(32)}` })));
    expect(resumeRefused(outcome).kind).toBe("plan-hash-mismatch");
    const noPlan = resumeWith(respond(summary({ planHash: null })));
    expect(resumeRefused(noPlan)).toEqual({
      kind: "plan-hash-mismatch",
      expected: PLAN_HASH,
      received: null,
    });
  });

  it("refuses a step-count mismatch", () => {
    expect(resumeRefused(resumeWith(respond(summary({ planStepCount: 3 }))))).toEqual({
      kind: "plan-shape-mismatch",
      planSteps: 2,
      sessionSteps: 3,
    });
  });

  it("D4/§2.3.1: record-to-step matching is by identity — a foreign stepId refuses", () => {
    const outcome = resumeWith(respond(summary({ executed: [wireAttributed(0, "sX")] })));
    expect(resumeRefused(outcome)).toEqual({
      kind: "step-identity-mismatch",
      expectedIndex: 0,
      expectedId: "s0",
      receivedIndex: 0,
      receivedId: "sX",
    });
    const shifted = resumeWith(respond(summary({ executed: [wireAttributed(1, "s1")] })));
    expect(resumeRefused(shifted).kind).toBe("step-identity-mismatch");
  });

  it("refuses a non-settled status inside the executed prefix", () => {
    const stray: WireStepResult = { status: "dispatch-vacated", stepIndex: 0, stepId: "s0" };
    expect(resumeRefused(resumeWith(respond(summary({ executed: [stray] })))).kind).toBe("malformed-summary");
  });

  it("refuses a halted entry that is not the last executed entry", () => {
    const outcome = resumeWith(
      respond(summary({ executed: [wireHalted(0, "s0"), wireAttributed(1, "s1")] })),
    );
    expect(resumeRefused(outcome)).toEqual({
      kind: "malformed-summary",
      detail: "halted step is not the last executed entry",
    });
  });

  it("refuses malformed wei and malformed hex — never a defaulted number (SPEC §5)", () => {
    const badWei: WireStepResult = { ...wireAttributedBare(0, "s0"), resolvedAmountWei: "12x" };
    expect(resumeRefused(resumeWith(respond(summary({ executed: [badWei] })))).kind).toBe("malformed-wire");
    const badHash: WireStepResult = {
      ...wireAttributedBare(0, "s0"),
      receipt: { ...wireReceipt(hash(0x51)), txHash: "0x1234" },
    };
    expect(resumeRefused(resumeWith(respond(summary({ executed: [badHash] })))).kind).toBe("malformed-wire");
    const negativeBefore: WireSessionResponse = respond(
      summary({
        phase: { kind: "reconcile-required", pendingKind: "persistence" },
        recovery: {
          kind: "reconcile-persistence",
          stepIndex: 0,
          stepId: "s0",
          receipt: wireReceipt(hash(0x51)),
          resolvedAmountWei: null,
          measurement: { status: "unavailable", beforeShares: "-3", cause: "read refused" },
        },
      }),
    );
    expect(resumeRefused(resumeWith(negativeBefore)).kind).toBe("malformed-wire");
  });
});

describe("resumePlan — halted and failed sessions", () => {
  it("a halted session resumes pinned on the divergence evidence", () => {
    const machine = resumed(
      resumeWith(
        respond(
          summary({ executed: [wireHalted(0, "s0")], phase: { kind: "halted", halt: wireDivergence(0, "s0") } }),
        ),
      ),
    );
    expect(machine.phase.kind).toBe("halted-divergent");
    expect(machine.record?.halted?.halt.kind).toBe("output-divergence");
    const pinnedResult = reduce(machine, { type: "advance", facts: { nonce: null, resolvedAmountWei: null, approval: null, beforeShares: null } });
    expect(pinnedResult.refusal?.kind).toBe("halt-pinned");
  });

  it("a halted phase without the executed halted entry rebuilds the halt from evidence", () => {
    const machine = resumed(
      resumeWith(respond(summary({ phase: { kind: "halted", halt: wireDivergence(0, "s0") } }))),
    );
    expect(machine.phase.kind).toBe("halted-divergent");
    expect(machine.record?.halted?.stepIndex).toBe(0);
  });

  it("a halt citing a different step than the executed record is malformed", () => {
    const outcome = resumeWith(
      respond(
        summary({ executed: [wireHalted(0, "s0")], phase: { kind: "halted", halt: wireDivergence(1, "s1") } }),
      ),
    );
    expect(resumeRefused(outcome).kind).toBe("malformed-summary");
  });

  it("a failed session resumes to failed-at with the server's durable failure", () => {
    const decoded = { message: "HF too low", raw: "0x1234", source: "custom-error" as const };
    const machine = resumed(
      resumeWith(
        respond(
          summary({
            phase: {
              kind: "failed",
              failure: { stepIndex: 0, stepId: "s0", txHash: hash(0xf), decoded, raw: "0x1234" },
            },
          }),
        ),
      ),
    );
    expect(machine.phase).toEqual({ kind: "failed-at", stepIndex: 0, cause: "reverted" });
    expect(machine.record?.failure?.decoded).toEqual(decoded);
  });

  it("a failure over a halted record surfaces the record refusal atomically", () => {
    const outcome = resumeWith(
      respond(
        summary({
          executed: [wireHalted(0, "s0")],
          phase: {
            kind: "failed",
            failure: { stepIndex: 0, stepId: "s0", txHash: hash(0xf), decoded: null, raw: null },
          },
        }),
      ),
    );
    expect(resumeRefused(outcome)).toEqual({ kind: "record-refused", refusal: { kind: "run-closed" } });
  });
});

describe("resumePlan — recovery states (D11 payloads, never re-send)", () => {
  const attributionPending: WireRecovery = {
    kind: "attribution-pending",
    stepIndex: 0,
    stepId: "s0",
    receipt: wireReceipt(hash(0x51)),
    resolvedAmountWei: null,
    beforeShares: "3",
    sharesDelta: null,
  };

  it("attribution-pending resumes to attributing with the receipt re-pinned as the intent", () => {
    const machine = resumed(
      resumeWith(
        respond(summary({ phase: { kind: "attribution-pending", stepIndex: 0 }, recovery: attributionPending })),
      ),
    );
    expect(machine.phase).toEqual({
      kind: "attributing",
      stepIndex: 0,
      receipt: { txHash: hash(0x51), blockNumber: 123n, blockHash: hash(0xb10c), gasUsed: null },
      consumedApproval: null,
    });
    expect(machine.record?.intent).toEqual({
      stepIndex: 0,
      stepId: "s0",
      txHash: hash(0x51),
      nonce: null,
      resolvedAmountWei: null,
      approval: null,
      beforeShares: 3n,
    });
    const reconciled = reduce(machine, {
      type: "reconcile-result",
      result: {
        status: "attributed",
        stepIndex: 0,
        stepId: "s0",
        receipt: { txHash: hash(0x51), blockNumber: 123n, blockHash: hash(0xb10c), gasUsed: null },
        resolvedAmountWei: PREDICTED,
        sharesDelta: 5n,
        output: null,
        approval: null,
        consumedApproval: null,
        risk: null,
      },
    });
    expect(reconciled.refusal).toBeNull();
    expect(reconciled.machine.phase).toEqual({ kind: "attributed", stepIndex: 0 });
  });

  it("attribution-pending without its recovery payload refuses", () => {
    const outcome = resumeWith(respond(summary({ phase: { kind: "attribution-pending", stepIndex: 0 } })));
    expect(resumeRefused(outcome)).toEqual({ kind: "missing-recovery", phase: "attribution-pending" });
  });

  it("attribution-pending with the wrong recovery kind refuses", () => {
    const outcome = resumeWith(
      respond(
        summary({
          phase: { kind: "attribution-pending", stepIndex: 0 },
          recovery: {
            kind: "reconcile-dispatch",
            stepIndex: 0,
            stepId: "s0",
            txHash: null,
            beforeShares: null,
            preNonce: "7",
          },
        }),
      ),
    );
    expect(resumeRefused(outcome)).toEqual({
      kind: "recovery-kind-mismatch",
      phase: "attribution-pending",
      recovery: "reconcile-dispatch",
    });
  });

  it("a recovery payload citing a step out of identity refuses (D4)", () => {
    const outcome = resumeWith(
      respond(
        summary({
          phase: { kind: "attribution-pending", stepIndex: 1 },
          recovery: { ...attributionPending, stepIndex: 1, stepId: "s1" },
        }),
      ),
    );
    expect(resumeRefused(outcome).kind).toBe("step-identity-mismatch");
  });

  it("reconcile-persistence resumes to persistence-failed with the measurement cell intact (D3)", () => {
    const machine = resumed(
      resumeWith(
        respond(
          summary({
            phase: { kind: "reconcile-required", pendingKind: "persistence" },
            recovery: {
              kind: "reconcile-persistence",
              stepIndex: 0,
              stepId: "s0",
              receipt: wireReceipt(hash(0x51)),
              resolvedAmountWei: null,
              measurement: { status: "measured", beforeShares: "3", sharesDelta: "-2" },
            },
          }),
        ),
      ),
    );
    expect(machine.phase).toEqual({
      kind: "persistence-failed",
      stepIndex: 0,
      receipt: { txHash: hash(0x51), blockNumber: 123n, blockHash: hash(0xb10c), gasUsed: null },
      measurement: { status: "measured", beforeShares: 3n, sharesDelta: -2n },
    });
    const advanced = reduce(machine, { type: "advance", facts: { nonce: null, resolvedAmountWei: null, approval: null, beforeShares: null } });
    expect(advanced.refusal?.kind).toBe("reconcile-required");
  });

  it("reconcile-dispatch resumes to dispatch-unresolved with the D6 pins as the intent", () => {
    const machine = resumed(
      resumeWith(
        respond(
          summary({
            phase: { kind: "reconcile-required", pendingKind: "dispatch" },
            recovery: {
              kind: "reconcile-dispatch",
              stepIndex: 0,
              stepId: "s0",
              txHash: hash(0x99),
              beforeShares: null,
              preNonce: "7",
            },
          }),
        ),
      ),
    );
    expect(machine.phase).toEqual({ kind: "dispatch-unresolved", stepIndex: 0, txHash: hash(0x99) });
    expect(machine.record?.intent).toEqual({
      stepIndex: 0,
      stepId: "s0",
      txHash: hash(0x99),
      nonce: 7n,
      resolvedAmountWei: null,
      approval: null,
      beforeShares: null,
    });
    const advanced = reduce(machine, { type: "advance", facts: { nonce: null, resolvedAmountWei: null, approval: null, beforeShares: null } });
    expect(advanced.refusal?.kind).toBe("reconcile-required");
  });

  it("a hashless reconcile-dispatch keeps the null hash honest", () => {
    const machine = resumed(
      resumeWith(
        respond(
          summary({
            phase: { kind: "reconcile-required", pendingKind: "dispatch" },
            recovery: {
              kind: "reconcile-dispatch",
              stepIndex: 0,
              stepId: "s0",
              txHash: null,
              beforeShares: "3",
              preNonce: "7",
            },
          }),
        ),
      ),
    );
    expect(machine.phase).toEqual({ kind: "dispatch-unresolved", stepIndex: 0, txHash: null });
    expect(machine.record?.intent?.txHash).toBeNull();
  });

  it("reconcile-required without recovery, or with the wrong kind, refuses", () => {
    const missing = resumeWith(
      respond(summary({ phase: { kind: "reconcile-required", pendingKind: "dispatch" } })),
    );
    expect(resumeRefused(missing)).toEqual({ kind: "missing-recovery", phase: "reconcile-required" });
    const mismatched = resumeWith(
      respond(
        summary({
          phase: { kind: "reconcile-required", pendingKind: "dispatch" },
          recovery: attributionPending,
        }),
      ),
    );
    expect(resumeRefused(mismatched)).toEqual({
      kind: "recovery-kind-mismatch",
      phase: "reconcile-required",
      recovery: "attribution-pending",
    });
  });
});

describe("resumePlan — expired and refused sessions", () => {
  it("session-expired resumes to abandoned over the tombstone's settled prefix (T24/D8)", () => {
    const response: WireSessionResponse = {
      ok: false,
      refusal: {
        kind: "session-expired",
        executedSteps: 1,
        tombstone: { executedSteps: 1, executed: [wireAttributed(0, "s0")], recovery: null },
      },
    };
    const machine = resumed(resumeWith(response));
    expect(machine.phase).toEqual({ kind: "abandoned", executedSteps: 1, recovery: null });
    expect(machine.record?.settled).toHaveLength(1);
    const pinnedResult = reduce(machine, {
      type: "advance",
      facts: { nonce: null, resolvedAmountWei: null, approval: null, beforeShares: null },
    });
    expect(pinnedResult.refusal?.kind).toBe("halt-pinned");
  });

  it("a tombstone with a foreign step identity refuses (D4 holds beyond expiry)", () => {
    const response: WireSessionResponse = {
      ok: false,
      refusal: {
        kind: "session-expired",
        executedSteps: 1,
        tombstone: { executedSteps: 1, executed: [wireAttributed(0, "sX")], recovery: null },
      },
    };
    expect(resumeRefused(resumeWith(response)).kind).toBe("step-identity-mismatch");
  });

  it("any other refusal is unresumable — a fresh session is the story", () => {
    const response: WireSessionResponse = { ok: false, refusal: { kind: "unknown-session" } };
    expect(resumeRefused(resumeWith(response))).toEqual({
      kind: "unresumable-refusal",
      refusal: "unknown-session",
    });
  });
});

describe("resumePlan — tombstone recovery evidence (finding 4)", () => {
  const expiredWith = (
    recovery: WireRecovery | null,
    executed: readonly WireStepResult[] = [wireAttributed(0, "s0")],
    counts: { readonly refusalSteps?: number; readonly tombstoneSteps?: number } = {},
  ): WireSessionResponse => ({
    ok: false,
    refusal: {
      kind: "session-expired",
      executedSteps: counts.refusalSteps ?? executed.length,
      tombstone: {
        executedSteps: counts.tombstoneSteps ?? executed.length,
        executed,
        recovery,
      },
    },
  });

  it("expiry during attribution preserves the pending receipt and beforeShares read-only", () => {
    const machine = resumed(
      resumeWith(
        expiredWith({
          kind: "attribution-pending",
          stepIndex: 1,
          stepId: "s1",
          receipt: wireReceipt(hash(0x52)),
          resolvedAmountWei: "7",
          beforeShares: "3",
          sharesDelta: null,
        }),
      ),
    );
    expect(machine.phase).toEqual({
      kind: "abandoned",
      executedSteps: 1,
      recovery: {
        kind: "attribution-pending",
        stepIndex: 1,
        stepId: "s1",
        receipt: { txHash: hash(0x52), blockNumber: 123n, blockHash: hash(0xb10c), gasUsed: null },
        resolvedAmountWei: 7n,
        beforeShares: 3n,
        sharesDelta: null,
      },
    });
    expect(machine.record?.settled).toHaveLength(1);
  });

  it("expiry during persistence reconciliation preserves the measurement cell", () => {
    const machine = resumed(
      resumeWith(
        expiredWith({
          kind: "reconcile-persistence",
          stepIndex: 1,
          stepId: "s1",
          receipt: wireReceipt(hash(0x52)),
          resolvedAmountWei: null,
          measurement: { status: "unavailable", beforeShares: "3", cause: "read refused" },
        }),
      ),
    );
    expect(machine.phase.kind === "abandoned" && machine.phase.recovery).toEqual({
      kind: "reconcile-persistence",
      stepIndex: 1,
      stepId: "s1",
      receipt: { txHash: hash(0x52), blockNumber: 123n, blockHash: hash(0xb10c), gasUsed: null },
      resolvedAmountWei: null,
      measurement: { status: "unavailable", beforeShares: 3n, cause: "read refused" },
    });
  });

  it("expiry during dispatch reconciliation preserves the D6 pins", () => {
    const machine = resumed(
      resumeWith(
        expiredWith({
          kind: "reconcile-dispatch",
          stepIndex: 1,
          stepId: "s1",
          txHash: hash(0x99),
          beforeShares: "3",
          preNonce: "7",
        }),
      ),
    );
    expect(machine.phase.kind === "abandoned" && machine.phase.recovery).toEqual({
      kind: "reconcile-dispatch",
      stepIndex: 1,
      stepId: "s1",
      txHash: hash(0x99),
      beforeShares: 3n,
      preNonce: 7n,
    });
  });

  it("a tombstone recovery citing a foreign identity refuses (D4)", () => {
    const outcome = resumeWith(
      expiredWith({
        kind: "reconcile-dispatch",
        stepIndex: 1,
        stepId: "sX",
        txHash: null,
        beforeShares: null,
        preNonce: "7",
      }),
    );
    expect(resumeRefused(outcome).kind).toBe("step-identity-mismatch");
  });

  it("a tombstone whose counts disagree with its executed record is malformed", () => {
    expect(resumeRefused(resumeWith(expiredWith(null, [wireAttributed(0, "s0")], { refusalSteps: 2 })))).toEqual({
      kind: "malformed-summary",
      detail: "tombstone step count disagrees with its executed record",
    });
    expect(
      resumeRefused(resumeWith(expiredWith(null, [wireAttributed(0, "s0")], { tombstoneSteps: 0 }))).kind,
    ).toBe("malformed-summary");
  });
});

describe("null and omitted wire payloads refuse typed, never crash (round-2 finding 1)", () => {
  const expectMalformed = <T,>(outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: ResumeRefusal }): void => {
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.refusal.kind).toBe("malformed-wire");
  };

  it("null and undefined top-level payloads refuse through both adapters", () => {
    for (const garbage of [null, undefined]) {
      expectMalformed(stepResultFactOf(garbage as unknown as WireStepResult));
      expectMalformed(refusalFactOf(garbage as unknown as WireRefusal));
    }
  });

  it("null/omitted nested result payloads refuse: receipt, output, approval, risk", () => {
    expectMalformed(
      stepResultFactOf({ ...wireAttributedBare(0, "s0"), receipt: null as unknown as WireReceipt }),
    );
    expectMalformed(
      stepResultFactOf({ ...wireAttributedBare(0, "s0"), receipt: undefined as unknown as WireReceipt }),
    );
    expectMalformed(
      stepResultFactOf({ ...wireAttributedBare(0, "s0"), output: undefined as unknown as null }),
    );
    expectMalformed(stepResultFactOf({ ...wireAttributedBare(0, "s0"), approval: 5 as unknown as null }));
    expectMalformed(stepResultFactOf({ ...wireAttributedBare(0, "s0"), risk: undefined as unknown as null }));
    expectMalformed(
      stepResultFactOf({
        ...wireAttributedBare(0, "s0"),
        risk: { expected: null as unknown as { status: "no-debt" }, chainHfWad: "5" },
      }),
    );
  });

  it("null/omitted measurement, halt, and failure payloads refuse", () => {
    expectMalformed(
      stepResultFactOf({
        status: "persistence-failed",
        stepIndex: 0,
        stepId: "s0",
        receipt: wireReceipt(hash(0x51)),
        measurement: null as unknown as WireMeasurement,
      }),
    );
    expectMalformed(stepResultFactOf({ ...wireHalted(0, "s0"), halt: undefined as unknown as WireHalt }));
    expectMalformed(stepResultFactOf({ status: "failed", failure: null as unknown as WireFailure }));
    expectMalformed(refusalFactOf({ kind: "halted", halt: null as unknown as WireHalt }));
    expectMalformed(refusalFactOf({ kind: "failed", failure: undefined as unknown as WireFailure }));
    expectMalformed(refusalFactOf({ kind: "failed", failure: null as unknown as WireFailure }));
  });

  it("null/omitted session payloads refuse through resumePlan", () => {
    expect(resumeRefused(resumeWith(null as unknown as WireSessionResponse)).kind).toBe("malformed-wire");
    expect(
      resumeRefused(resumeWith({ ok: true, session: null } as unknown as WireSessionResponse)).kind,
    ).toBe("malformed-wire");
    expect(
      resumeRefused(
        resumeWith(respond({ ...summary({}), phase: undefined as unknown as WireSessionSummary["phase"] })),
      ).kind,
    ).toBe("malformed-wire");
    expect(
      resumeRefused(
        resumeWith(respond({ ...summary({}), executed: undefined as unknown as readonly WireStepResult[] })),
      ).kind,
    ).toBe("malformed-wire");
    expect(
      resumeRefused(
        resumeWith(
          respond(
            summary({
              phase: { kind: "attribution-pending", stepIndex: 0 },
              recovery: undefined as unknown as null,
            }),
          ),
        ),
      ).kind,
    ).toBe("malformed-wire");
  });

  it("null/omitted tombstone payloads refuse through resumePlan", () => {
    const expired = (tombstone: unknown): WireSessionResponse =>
      ({
        ok: false,
        refusal: { kind: "session-expired", executedSteps: 0, tombstone },
      }) as unknown as WireSessionResponse;
    expect(resumeRefused(resumeWith(expired(null))).kind).toBe("malformed-wire");
    expect(
      resumeRefused(resumeWith(expired({ executedSteps: 0, executed: undefined, recovery: null }))).kind,
    ).toBe("malformed-wire");
    expect(
      resumeRefused(resumeWith(expired({ executedSteps: 0, executed: [], recovery: undefined }))).kind,
    ).toBe("malformed-wire");
    expect(
      resumeRefused(
        resumeWith({ ok: false, refusal: null } as unknown as WireSessionResponse),
      ).kind,
    ).toBe("malformed-wire");
  });

  it("pendingKind is validated and must agree with the recovery payload", () => {
    const dispatchRecovery: WireRecovery = {
      kind: "reconcile-dispatch",
      stepIndex: 0,
      stepId: "s0",
      txHash: null,
      beforeShares: null,
      preNonce: "7",
    };
    const unknownPending = resumeWith(
      respond(
        summary({
          phase: { kind: "reconcile-required", pendingKind: "quantum" },
          recovery: dispatchRecovery,
        }),
      ),
    );
    expect(resumeRefused(unknownPending).kind).toBe("malformed-wire");
    const disagreeing = resumeWith(
      respond(
        summary({
          phase: { kind: "reconcile-required", pendingKind: "persistence" },
          recovery: dispatchRecovery,
        }),
      ),
    );
    expect(resumeRefused(disagreeing)).toEqual({
      kind: "recovery-kind-mismatch",
      phase: "reconcile-required(persistence)",
      recovery: "reconcile-dispatch",
    });
  });
});

describe("version skew refuses typed, never defaults (finding 5)", () => {
  it("an unknown measurement cell is malformed-wire — never mis-filed as unavailable", () => {
    const skewed = stepResultFactOf({
      status: "persistence-failed",
      stepIndex: 0,
      stepId: "s0",
      receipt: wireReceipt(hash(0x51)),
      measurement: { status: "quantum", beforeShares: "3" } as unknown as WireMeasurement,
    });
    expect(!skewed.ok && skewed.refusal.kind).toBe("malformed-wire");
    expect(!skewed.ok && skewed.refusal.kind === "malformed-wire" && skewed.refusal.detail).toMatch(
      /measurement\.status/,
    );
  });

  it("an unknown result status is malformed-wire", () => {
    const skewed = stepResultFactOf({ status: "quantum-settled" } as unknown as WireStepResult);
    expect(!skewed.ok && skewed.refusal.kind).toBe("malformed-wire");
  });

  it("an unknown halt kind is malformed-wire", () => {
    const skewed = stepResultFactOf({
      ...wireHalted(0, "s0"),
      halt: { kind: "vibes-divergence" } as unknown as WireHalt,
    });
    expect(!skewed.ok && skewed.refusal.kind).toBe("malformed-wire");
  });

  it("an unknown risk-expectation status is malformed-wire", () => {
    const skewed = stepResultFactOf({
      ...wireAttributedBare(0, "s0"),
      risk: {
        expected: { status: "vibes" } as unknown as { status: "no-debt" },
        chainHfWad: "5",
      },
    });
    expect(!skewed.ok && skewed.refusal.kind).toBe("malformed-wire");
  });

  it("an unknown session phase kind is malformed-wire through resumePlan", () => {
    const outcome = resumeWith(
      respond(summary({ phase: { kind: "hyper-active" } as unknown as WireSessionSummary["phase"] })),
    );
    expect(resumeRefused(outcome).kind).toBe("malformed-wire");
  });

  it("an unknown recovery kind is malformed-wire through resumePlan", () => {
    const outcome = resumeWith(
      respond(
        summary({
          phase: { kind: "attribution-pending", stepIndex: 0 },
          recovery: { kind: "telepathic" } as unknown as WireRecovery,
        }),
      ),
    );
    expect(resumeRefused(outcome).kind).toBe("malformed-wire");
  });

  it("an unknown refusal kind is malformed-wire through the adapter", () => {
    const skewed = refusalFactOf({ kind: "cosmic-ray" } as unknown as WireRefusal);
    expect(!skewed.ok && skewed.refusal.kind).toBe("malformed-wire");
  });

  it("an unknown decode source is malformed-wire", () => {
    const skewed = stepResultFactOf({
      status: "failed",
      failure: {
        stepIndex: 0,
        stepId: "s0",
        txHash: hash(0xf),
        decoded: { message: "x", raw: "0x12", source: "oracle" } as unknown as null,
        raw: null,
      },
    });
    expect(!skewed.ok && skewed.refusal.kind).toBe("malformed-wire");
  });

  it("a non-object where a discriminated object belongs is malformed-wire", () => {
    const gone = stepResultFactOf({
      status: "persistence-failed",
      stepIndex: 0,
      stepId: "s0",
      receipt: wireReceipt(hash(0x51)),
      measurement: "gone" as unknown as WireMeasurement,
    });
    expect(!gone.ok && gone.refusal.kind).toBe("malformed-wire");
    const stringDecoded = stepResultFactOf({
      status: "failed",
      failure: {
        stepIndex: 0,
        stepId: "s0",
        txHash: hash(0xf),
        decoded: "boom" as unknown as null,
        raw: null,
      },
    });
    expect(!stringDecoded.ok && stringDecoded.refusal.kind).toBe("malformed-wire");
  });

  it("garbage primitives are malformed-wire: stringly indexes and non-string causes", () => {
    const stringIndex = stepResultFactOf({
      ...wireAttributedBare(0, "s0"),
      stepIndex: "0" as unknown as number,
    });
    expect(!stringIndex.ok && stringIndex.refusal.kind).toBe("malformed-wire");
    const numericCause = stepResultFactOf({
      status: "persistence-failed",
      stepIndex: 0,
      stepId: "s0",
      receipt: wireReceipt(hash(0x51)),
      measurement: { status: "unavailable", beforeShares: "3", cause: 42 as unknown as string },
    });
    expect(!numericCause.ok && numericCause.refusal.kind).toBe("malformed-wire");
  });
});

describe("resumePlan — edges", () => {
  it("threads an explicit tolerance into the resumed machine", () => {
    const tolerance = { absWei: 5n, relPow: 10n ** 4n };
    const outcome = resumePlan({ plan, planHash: PLAN_HASH, response: respond(summary({})), tolerance });
    expect(resumed(outcome).tolerance).toBe(tolerance);
  });

  it("a sparse executed array is malformed, never skipped", () => {
    const sparse = new Array<WireStepResult>(1);
    const outcome = resumeWith(respond(summary({ executed: sparse, planStepCount: 2 })));
    expect(resumeRefused(outcome)).toEqual({ kind: "malformed-summary", detail: "executed[0] missing" });
  });

  it("refuses a malformed spender address and a malformed signed delta", () => {
    const badSpender = resumeWith(
      respond(
        summary({
          executed: [
            { ...wireAttributed(0, "s0"), approval: { spender: "0x12", priorAllowanceWei: "0", approvedWei: "1" } },
          ],
        }),
      ),
    );
    expect(resumeRefused(badSpender).kind).toBe("malformed-wire");
    const badDelta = resumeWith(
      respond(summary({ executed: [{ ...wireAttributed(0, "s0"), sharesDelta: "x" }] })),
    );
    expect(resumeRefused(badDelta).kind).toBe("malformed-wire");
  });

  it("an executed entry citing a step outside the plan reports no expected id", () => {
    const outcome = resumeWith(respond(summary({ executed: [wireAttributed(5, "s5")] })));
    expect(resumeRefused(outcome)).toEqual({
      kind: "step-identity-mismatch",
      expectedIndex: 0,
      expectedId: null,
      receivedIndex: 5,
      receivedId: "s5",
    });
  });

  it("a failed phase and a reconcile recovery both pass the identity gate (D4)", () => {
    const failedMismatch = resumeWith(
      respond(
        summary({
          phase: {
            kind: "failed",
            failure: { stepIndex: 0, stepId: "sX", txHash: hash(0xf), decoded: null, raw: null },
          },
        }),
      ),
    );
    expect(resumeRefused(failedMismatch).kind).toBe("step-identity-mismatch");
    const dispatchMismatch = resumeWith(
      respond(
        summary({
          phase: { kind: "reconcile-required", pendingKind: "dispatch" },
          recovery: {
            kind: "reconcile-dispatch",
            stepIndex: 0,
            stepId: "sX",
            txHash: null,
            beforeShares: null,
            preNonce: "7",
          },
        }),
      ),
    );
    expect(resumeRefused(dispatchMismatch).kind).toBe("step-identity-mismatch");
  });

  it("a halt rebuilt from evidence still passes through the identity gate (D4)", () => {
    const wrongId = resumeWith(respond(summary({ phase: { kind: "halted", halt: wireDivergence(0, "sX") } })));
    expect(resumeRefused(wrongId).kind).toBe("step-identity-mismatch");
    const offPlan = resumeWith(respond(summary({ phase: { kind: "halted", halt: wireDivergence(5, "s5") } })));
    expect(resumeRefused(offPlan)).toEqual({
      kind: "step-identity-mismatch",
      expectedIndex: 0,
      expectedId: null,
      receivedIndex: 5,
      receivedId: "s5",
    });
  });

  it("rethrows failures that are neither wire-shape nor record refusals", () => {
    const evil = {
      ok: true,
      session: Object.defineProperty({ ...summary({}) }, "executed", {
        get(): readonly WireStepResult[] {
          throw new Error("boom");
        },
      }),
    } as WireSessionResponse;
    expect(() => resumePlan({ plan, planHash: PLAN_HASH, response: evil })).toThrow("boom");
  });
});

describe("wire adapters", () => {
  it("stepResultFactOf parses every arm with exact bigints", () => {
    const attributed = stepResultFactOf(wireAttributed(0, "s0"));
    if (!attributed.ok) throw new Error("expected ok");
    expect(attributed.value.status === "attributed" && attributed.value.output?.predictedWei).toBe(PREDICTED);
    const halted = stepResultFactOf(wireHalted(0, "s0"));
    expect(halted.ok && halted.value.status === "halted" && halted.value.halt.kind).toBe("output-divergence");
    const failed = stepResultFactOf({
      status: "failed",
      failure: { stepIndex: 0, stepId: "s0", txHash: hash(0xf), decoded: null, raw: null },
    });
    expect(failed.ok && failed.value.status === "failed" && failed.value.failure.txHash).toBe(hash(0xf));
    const unavailable = stepResultFactOf({
      status: "attribution-unavailable",
      stepIndex: 0,
      stepId: "s0",
      receipt: wireReceipt(hash(0x51)),
      beforeShares: "3",
    });
    expect(unavailable.ok && unavailable.value.status === "attribution-unavailable" && unavailable.value.beforeShares).toBe(3n);
    const persistence = stepResultFactOf({
      status: "persistence-failed",
      stepIndex: 0,
      stepId: "s0",
      receipt: wireReceipt(hash(0x51)),
      measurement: { status: "unavailable", beforeShares: "3", cause: "read refused" },
    });
    expect(
      persistence.ok && persistence.value.status === "persistence-failed" && persistence.value.measurement.status,
    ).toBe("unavailable");
    const unresolved = stepResultFactOf({
      status: "dispatch-unresolved",
      stepIndex: 0,
      stepId: "s0",
      txHash: null,
    });
    expect(unresolved.ok && unresolved.value.status === "dispatch-unresolved" && unresolved.value.txHash).toBeNull();
    const vacated = stepResultFactOf({ status: "dispatch-vacated", stepIndex: 0, stepId: "s0" });
    expect(vacated.ok && vacated.value.status).toBe("dispatch-vacated");
  });

  it("parses receipt gasUsed and every risk-expectation arm", () => {
    const withGas = stepResultFactOf({
      ...wireAttributedBare(0, "s0"),
      receipt: { ...wireReceipt(hash(0x51)), gasUsed: "21000" },
      risk: { expected: { status: "no-debt" }, chainHfWad: "5" },
    });
    if (!withGas.ok || withGas.value.status !== "attributed") throw new Error("expected attributed");
    expect(withGas.value.receipt.gasUsed).toBe(21000n);
    expect(withGas.value.risk?.expected).toEqual({ status: "no-debt" });
    const unknown = stepResultFactOf({
      ...wireAttributedBare(0, "s0"),
      risk: { expected: { status: "unknown", reason: "no oracle" }, chainHfWad: "5" },
    });
    expect(
      unknown.ok &&
        unknown.value.status === "attributed" &&
        unknown.value.risk?.expected,
    ).toEqual({ status: "unknown", reason: "no oracle" });
  });

  it("parses the hf-disagreement and residual-allowance halt arms", () => {
    const hf = stepResultFactOf({
      ...wireHalted(0, "s0"),
      halt: {
        kind: "hf-disagreement",
        stepIndex: 0,
        stepId: "s0",
        expected: { status: "healthy", hfWad: (2n * WAD).toString() },
        chainHfWad: WAD.toString(),
        receipt: wireReceipt(hash(0x77)),
      },
    });
    expect(hf.ok && hf.value.status === "halted" && hf.value.halt.kind).toBe("hf-disagreement");
    const residual = stepResultFactOf({
      ...wireHalted(0, "s0"),
      halt: {
        kind: "residual-allowance",
        stepIndex: 0,
        stepId: "s0",
        spender: SPENDER,
        residualAllowanceWei: "17",
        receipt: wireReceipt(hash(0x77)),
      },
    });
    expect(residual.ok && residual.value.status === "halted" && residual.value.halt.kind).toBe(
      "residual-allowance",
    );
  });

  it("refuses an unknown mechanism and a malformed dispatch hash", () => {
    const badMechanism = stepResultFactOf({
      ...wireAttributedBare(0, "s0"),
      output: { mechanism: "balance-sweep", predictedWei: "1", attributedWei: "1", toleranceWei: "1" },
    });
    expect(!badMechanism.ok && badMechanism.refusal.kind).toBe("malformed-wire");
    const badHash = stepResultFactOf({
      status: "dispatch-unresolved",
      stepIndex: 0,
      stepId: "s0",
      txHash: "0xnope",
    });
    expect(!badHash.ok && badHash.refusal.kind).toBe("malformed-wire");
  });

  it("the adapters rethrow failures that are not wire-shape refusals", () => {
    const evil = Object.defineProperty({}, "status", {
      get(): never {
        throw new Error("boom");
      },
    }) as WireStepResult;
    expect(() => stepResultFactOf(evil)).toThrow("boom");
  });

  it("refusalFactOf keeps the machine-relevant facts and drops tombstone weight", () => {
    const expired = refusalFactOf({
      kind: "session-expired",
      executedSteps: 2,
      tombstone: { executedSteps: 2, executed: [], recovery: null },
    });
    expect(expired.ok && expired.value).toEqual({ kind: "session-expired", executedSteps: 2 });
    const halted = refusalFactOf({ kind: "halted", halt: wireDivergence(0, "s0") });
    expect(
      halted.ok &&
        halted.value.kind === "halted" &&
        halted.value.halt.kind === "output-divergence" &&
        halted.value.halt.predictedWei,
    ).toBe(PREDICTED);
    const failed = refusalFactOf({
      kind: "failed",
      failure: { stepIndex: 0, stepId: "s0", txHash: hash(0xf), decoded: null, raw: null },
    });
    expect(failed.ok && failed.value.kind).toBe("failed");
    const passthrough = refusalFactOf({ kind: "rate-limited", retryAfterMs: 500 });
    expect(passthrough.ok && passthrough.value).toEqual({ kind: "rate-limited", retryAfterMs: 500 });
    const outOfOrder = refusalFactOf({ kind: "out-of-order", expectedIndex: 3 });
    expect(outOfOrder.ok && outOfOrder.value).toEqual({ kind: "out-of-order", expectedIndex: 3 });
    const mismatch = refusalFactOf({ kind: "reconcile-mismatch", detail: "nonce advanced" });
    expect(mismatch.ok && mismatch.value).toEqual({ kind: "reconcile-mismatch", detail: "nonce advanced" });
    const bare = refusalFactOf({ kind: "session-busy" });
    expect(bare.ok && bare.value).toEqual({ kind: "session-busy" });
    const unknownSession = refusalFactOf({ kind: "unknown-session" });
    expect(unknownSession.ok && unknownSession.value).toEqual({ kind: "unknown-session" });
    const malformed = refusalFactOf({ kind: "halted", halt: { ...wireDivergence(0, "s0"), predictedWei: "x" } });
    expect(!malformed.ok && malformed.refusal.kind).toBe("malformed-wire");
  });
});
