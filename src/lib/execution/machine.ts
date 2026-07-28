/**
 * The pure execution state machine (P3 treatment §2.1/§2.2). Plan in, step-by-step
 * progression out; every state it can occupy is a state the tx grammar renders
 * (`ExecutionPhase`, types.ts) and every transition is a named event.
 *
 * Purity contract: no I/O, no provider, no React — the boundary lint enforces it. Effects
 * are the DRIVER's: wallet requests, receipt watches, share reads, and sandbox tRPC calls
 * happen outside and re-enter as events. The machine owns the DECISIONS: sequencing (A10 —
 * step k+1 is reachable only through `attributed(k)`), the §6.2 tolerance comparison
 * through the landed `tolerance.ts` (never a second bound), the §3.3 zero-after-consume
 * verdict, halt pinning (A12/T19 — the halted family and the run's terminal states accept
 * no event), D3's reconcile-before-dispatch gate, and D6/D7 at the wallet seam via
 * `record.ts` (intent before send; failure durable before enrichment).
 *
 * `reduce` is total: an event a phase does not accept returns the machine UNCHANGED with a
 * typed refusal — surfaced, never silently absorbed. The only throws are machine-invariant
 * violations (a run phase without a plan/record), which mean the caller corrupted the
 * machine outside `reduce` — failing loud is the honest treatment.
 */
import { getAddress, type Address, type Hex } from "viem";
import type { PlanSuccess, TransactionStep } from "../../core/plan";
import {
  confirmationOf,
  isConfirmedReceipt,
  producesShareDelta,
  type ConfirmedReceipt,
} from "./attribution";
import { SANDBOX_OUTPUT_TOLERANCE, toleranceWeiFor, withinOutputTolerance, type OutputTolerance } from "./tolerance";
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
  settleStep,
  type ExecutionRecord,
  type RecordOutcome,
} from "./record";
import type {
  ApprovalFact,
  AttributionCell,
  ConsumedApprovalFact,
  DispatchFacts,
  ExecutionEvent,
  ExecutionMode,
  ExecutionPhase,
  HaltedStepFact,
  OutputMechanism,
  ReceiptRef,
  SandboxStepResult,
  SettledStepFact,
  StepRequirements,
  TransitionRefusal,
} from "./types";

export interface ExecutionMachine {
  readonly mode: ExecutionMode;
  readonly tolerance: OutputTolerance;
  readonly plan: PlanSuccess | null;
  readonly planHash: Hex | null;
  /** Pinned at `ready` (treatment §1.2); null in sandbox. */
  readonly address: Address | null;
  readonly record: ExecutionRecord | null;
  readonly phase: ExecutionPhase;
}

export interface ReduceResult {
  readonly machine: ExecutionMachine;
  readonly refusal: TransitionRefusal | null;
}

export interface CreateMachineOptions {
  readonly mode: ExecutionMode;
  readonly tolerance?: OutputTolerance;
}

/** A12/T19: these states pin — no event moves them; recovery is a NEW machine via resume. */
const PINNED: ReadonlySet<ExecutionPhase["kind"]> = new Set([
  "complete",
  "abandoned",
  "halted-divergent",
  "halted-wallet-changed",
]);

/** D3: dispatch is gated behind reconciliation in every unresolved-outcome state. */
const RECONCILE_GATED: ReadonlySet<ExecutionPhase["kind"]> = new Set([
  "attribution-unavailable",
  "persistence-failed",
  "dispatch-unresolved",
]);

const WALLET_HALTABLE: ReadonlySet<ExecutionPhase["kind"]> = new Set([
  "ready",
  "awaiting-signature",
  "pending",
  "timeout",
  "attributing",
  "attributed",
  "attribution-unavailable",
  "persistence-failed",
  "dispatch-unresolved",
  "dispatch-vacated",
]);

const SESSION_LOSABLE: ReadonlySet<ExecutionPhase["kind"]> = new Set([
  "simulating",
  "ready",
  "pending",
  "attributing",
  "attributed",
  "attribution-unavailable",
  "persistence-failed",
  "dispatch-unresolved",
  "dispatch-vacated",
]);

export function createExecutionMachine(options: CreateMachineOptions): ExecutionMachine {
  const fallback = options.mode === "sandbox" ? SANDBOX_OUTPUT_TOLERANCE : null;
  const tolerance = options.tolerance ?? fallback;
  if (tolerance === null) {
    // Live bounds differ from sandbox bounds for stated reasons (rebases land between
    // steps) and must be added to tolerance.ts, named, with their own justification —
    // reusing the sandbox bound silently would be a numeric fallback wearing a default.
    throw new Error("a live execution machine requires a named tolerance from tolerance.ts");
  }
  return {
    mode: options.mode,
    tolerance,
    plan: null,
    planHash: null,
    address: null,
    record: null,
    phase: { kind: "idle" },
  };
}

/**
 * The shared pure step-requirements classifier: what a step demands before it settles.
 *
 * ONE implementation policy per arm: the share-delta arm IS the attribution module's
 * `producesShareDelta`; the remaining mechanism arms mirror the server's function-name
 * classification (`producerMechanismOf`, `src/server/sandbox/execute-step.ts` — the import
 * direction is illegal under the purity boundary, and the canonical-plan test pins all 13
 * classifications so drift between the two homes fails a test, not a user). The consumer
 * arm reads the SAME relation the server's `approvePairOf` reads: an approve step sharing
 * the consumer's amount-spec OBJECT — reference identity per doctrine D1/D4, never field
 * equality — with the spender taken from the approve's own first argument.
 */
export function stepRequirementsOf(plan: PlanSuccess, step: TransactionStep): StepRequirements {
  return {
    output: outputMechanismOf(step),
    consumesApprovalFrom: consumedSpenderOf(plan, step),
  };
}

function outputMechanismOf(step: TransactionStep): OutputMechanism | null {
  if (producesShareDelta(step)) return "share-delta";
  switch (step.functionName) {
    case "wrap":
    case "borrow":
      return "transfer-event";
    case "withdraw":
      return "withdraw-argument";
    default:
      return null;
  }
}

function consumedSpenderOf(plan: PlanSuccess, step: TransactionStep): Hex | null {
  if (step.functionName === "approve") return null;
  for (const approve of plan.steps) {
    if (approve.functionName === "approve" && approve.amount === step.amount) {
      return approveSpenderOf(approve);
    }
  }
  return null;
}

function approveSpenderOf(approve: TransactionStep): Hex {
  const arg = approve.args[0];
  if (arg !== undefined && arg.kind === "value" && typeof arg.value === "string") {
    return getAddress(arg.value);
  }
  throw new Error(`approve step ${approve.id} has no spender argument`);
}

/** The four D3 persistence × measurement cells, readable off any per-step outcome state. */
export function attributionCellOf(phase: ExecutionPhase): AttributionCell | null {
  if (phase.kind === "attributed") return "persisted-measured";
  if (phase.kind === "attribution-unavailable") return "persisted-unmeasured";
  if (phase.kind === "persistence-failed") {
    return phase.measurement.status === "measured" ? "unpersisted-measured" : "unpersisted-unmeasured";
  }
  return null;
}

interface RunFacts {
  readonly plan: PlanSuccess;
  readonly planHash: Hex;
  readonly record: ExecutionRecord;
}

function runFactsOf(machine: ExecutionMachine): RunFacts {
  if (machine.plan === null || machine.planHash === null || machine.record === null) {
    throw new Error("machine invariant violated: a run phase requires a plan and a record");
  }
  return { plan: machine.plan, planHash: machine.planHash, record: machine.record };
}

function stepAt(plan: PlanSuccess, stepIndex: number): TransactionStep {
  const step = plan.steps[stepIndex];
  if (step === undefined) {
    throw new Error(`machine invariant violated: no step at index ${stepIndex}`);
  }
  return step;
}

const refuseWith = (machine: ExecutionMachine, refusal: TransitionRefusal): ReduceResult => ({
  machine,
  refusal,
});

const illegal = (machine: ExecutionMachine, event: ExecutionEvent): ReduceResult =>
  refuseWith(machine, { kind: "illegal-transition", phase: machine.phase.kind, event: event.type });

/** Land a record transition and a phase together, or refuse the whole event atomically. */
function landed(
  machine: ExecutionMachine,
  outcome: RecordOutcome,
  phase: ExecutionPhase,
): ReduceResult {
  if (!outcome.ok) return refuseWith(machine, { kind: "record-refused", refusal: outcome.refusal });
  return { machine: { ...machine, record: outcome.record, phase }, refusal: null };
}

/** The prediction is the flows wrapper the canvas rendered — the same object, by reference. */
function predictedOutputWeiOf(plan: PlanSuccess, step: TransactionStep): bigint | null {
  const flow = plan.flows.find((candidate) => candidate.blockId === step.blockId);
  if (flow === undefined || flow.outputWei === null) return null;
  return flow.outputWei.value;
}

function dispatchNext(
  machine: ExecutionMachine,
  run: RunFacts,
  facts: DispatchFacts,
): ReduceResult {
  const stepIndex = nextStepIndexOf(run.record);
  const step = stepAt(run.plan, stepIndex);
  const opened = openDispatchIntent(run.record, {
    stepIndex,
    stepId: step.id,
    txHash: null,
    nonce: facts.nonce,
    resolvedAmountWei: facts.resolvedAmountWei,
    approval: facts.approval,
    beforeShares: facts.beforeShares,
  });
  const phase: ExecutionPhase =
    machine.mode === "live"
      ? { kind: "awaiting-signature", stepIndex }
      : { kind: "pending", stepIndex, txHash: null };
  return landed(machine, opened, phase);
}

/** The intent's moment-bound dispatch evidence for a step, where the record still holds it. */
function dispatchEvidenceOf(
  record: ExecutionRecord,
  stepIndex: number,
): { readonly resolvedAmountWei: bigint | null; readonly approval: ApprovalFact | null } {
  const intent = record.intent;
  if (intent === null || intent.stepIndex !== stepIndex) {
    return { resolvedAmountWei: null, approval: null };
  }
  return { resolvedAmountWei: intent.resolvedAmountWei, approval: intent.approval };
}

function settledPhaseFor(plan: PlanSuccess, stepIndex: number): ExecutionPhase {
  return stepIndex === plan.steps.length - 1 ? { kind: "complete" } : { kind: "attributed", stepIndex };
}

/**
 * Adopt one server step outcome (execute or reconcile). Identity is checked by `step.id`
 * against the frozen plan (D4 — never structural), and every arm lands its record
 * consequence in the same reduction.
 */
function applyStepResult(
  machine: ExecutionMachine,
  run: RunFacts,
  expectedIndex: number,
  result: SandboxStepResult,
): ReduceResult {
  const identity =
    result.status === "failed"
      ? { stepIndex: result.failure.stepIndex, stepId: result.failure.stepId }
      : { stepIndex: result.stepIndex, stepId: result.stepId };
  const expectedStep = stepAt(run.plan, expectedIndex);
  if (identity.stepIndex !== expectedIndex || identity.stepId !== expectedStep.id) {
    return refuseWith(machine, {
      kind: "step-identity-mismatch",
      expectedIndex,
      expectedId: expectedStep.id,
      receivedIndex: identity.stepIndex,
      receivedId: identity.stepId,
    });
  }
  switch (result.status) {
    case "attributed": {
      // §3.3 holds on adoption too: a consuming step settled by the server must carry its
      // zero-residual verdict; its absence means the two sides disagree about the plan.
      const requirements = stepRequirementsOf(run.plan, expectedStep);
      if (requirements.consumesApprovalFrom !== null && result.consumedApproval === null) {
        return refuseWith(machine, {
          kind: "residual-check-required",
          stepId: expectedStep.id,
          spender: requirements.consumesApprovalFrom,
        });
      }
      const entry: SettledStepFact = {
        stepIndex: result.stepIndex,
        stepId: result.stepId,
        receipt: result.receipt,
        resolvedAmountWei: result.resolvedAmountWei,
        sharesDelta: result.sharesDelta,
        output: result.output,
        approval: result.approval,
        consumedApproval: result.consumedApproval,
        risk: result.risk,
      };
      return landed(machine, settleStep(run.record, entry), settledPhaseFor(run.plan, result.stepIndex));
    }
    case "halted": {
      const halted: HaltedStepFact = {
        stepIndex: result.stepIndex,
        stepId: result.stepId,
        receipt: result.receipt,
        resolvedAmountWei: result.resolvedAmountWei,
        sharesDelta: result.sharesDelta,
        halt: result.halt,
      };
      return landed(machine, recordHalt(run.record, halted), {
        kind: "halted-divergent",
        stepIndex: result.stepIndex,
        halt: result.halt,
      });
    }
    case "failed": {
      const record = clearResolvedIntent(run.record, expectedIndex);
      return landed(
        machine,
        recordFailure(record, {
          stepIndex: result.failure.stepIndex,
          stepId: result.failure.stepId,
          cause: "reverted",
          txHash: result.failure.txHash,
          decoded: result.failure.decoded,
          raw: result.failure.raw,
        }),
        { kind: "failed-at", stepIndex: expectedIndex, cause: "reverted" },
      );
    }
    case "attribution-unavailable":
      return {
        machine: {
          ...machine,
          phase: {
            kind: "attribution-unavailable",
            stepIndex: result.stepIndex,
            receipt: result.receipt,
            beforeShares: result.beforeShares,
            consumedApproval: null,
          },
        },
        refusal: null,
      };
    case "persistence-failed":
      return {
        machine: {
          ...machine,
          phase: {
            kind: "persistence-failed",
            stepIndex: result.stepIndex,
            receipt: result.receipt,
            measurement: result.measurement,
          },
        },
        refusal: null,
      };
    case "dispatch-unresolved": {
      const record =
        result.txHash === null
          ? run.record
          : pinDiscoveredHash(run.record, expectedIndex, result.txHash);
      return {
        machine: {
          ...machine,
          record,
          phase: { kind: "dispatch-unresolved", stepIndex: result.stepIndex, txHash: result.txHash },
        },
        refusal: null,
      };
    }
    case "dispatch-vacated": {
      const record = clearResolvedIntent(run.record, expectedIndex);
      return {
        machine: { ...machine, record, phase: { kind: "dispatch-vacated", stepIndex: result.stepIndex } },
        refusal: null,
      };
    }
  }
}

export function reduce(machine: ExecutionMachine, event: ExecutionEvent): ReduceResult {
  const phase = machine.phase;
  if (PINNED.has(phase.kind)) {
    return refuseWith(machine, { kind: "halt-pinned", phase: phase.kind, event: event.type });
  }
  switch (event.type) {
    case "simulate": {
      if (phase.kind !== "idle") return illegal(machine, event);
      return { machine: { ...machine, phase: { kind: "simulating" } }, refusal: null };
    }
    case "plan-ready": {
      if (phase.kind !== "simulating") return illegal(machine, event);
      return {
        machine: {
          ...machine,
          plan: event.plan,
          planHash: event.planHash,
          address: event.address,
          record: createRecord(event.planHash),
          phase: { kind: "ready" },
        },
        refusal: null,
      };
    }
    case "plan-refused": {
      if (phase.kind !== "simulating") return illegal(machine, event);
      return { machine: { ...machine, phase: { kind: "idle" } }, refusal: null };
    }
    case "document-mutated": {
      if (phase.kind !== "ready") return illegal(machine, event);
      return {
        machine: {
          ...machine,
          plan: null,
          planHash: null,
          address: null,
          record: null,
          phase: { kind: "idle" },
        },
        refusal: null,
      };
    }
    case "execute": {
      if (phase.kind !== "ready") return illegal(machine, event);
      const run = runFactsOf(machine);
      if (run.plan.steps.length === 0) return refuseWith(machine, { kind: "empty-plan" });
      return dispatchNext(machine, run, event.facts);
    }
    case "advance": {
      if (RECONCILE_GATED.has(phase.kind)) {
        return refuseWith(machine, { kind: "reconcile-required", phase: phase.kind });
      }
      if (phase.kind !== "attributed" && phase.kind !== "dispatch-vacated") {
        return illegal(machine, event);
      }
      return dispatchNext(machine, runFactsOf(machine), event.facts);
    }
    case "signed": {
      if (phase.kind !== "awaiting-signature") return illegal(machine, event);
      const run = runFactsOf(machine);
      return landed(machine, noteSubmission(run.record, phase.stepIndex, event.txHash), {
        kind: "pending",
        stepIndex: phase.stepIndex,
        txHash: event.txHash,
      });
    }
    case "user-rejected": {
      // The wallet's own classified refusal (EIP-1193 4001): provably nothing was sent, so
      // the intent resolves — the one pre-send failure D6 does not send to reconciliation.
      if (phase.kind !== "awaiting-signature") return illegal(machine, event);
      const run = runFactsOf(machine);
      const step = stepAt(run.plan, phase.stepIndex);
      return landed(
        machine,
        recordFailure(clearResolvedIntent(run.record, phase.stepIndex), {
          stepIndex: phase.stepIndex,
          stepId: step.id,
          cause: "user-rejected",
          txHash: null,
          decoded: null,
          raw: null,
        }),
        { kind: "failed-at", stepIndex: phase.stepIndex, cause: "user-rejected" },
      );
    }
    case "request-failed": {
      // D6: a request that throws after `eth_sendTransaction` may have sent — the intent
      // stays open and the outcome is discovered against the chain, never assumed away.
      if (phase.kind !== "awaiting-signature") return illegal(machine, event);
      return {
        machine: {
          ...machine,
          phase: { kind: "dispatch-unresolved", stepIndex: phase.stepIndex, txHash: null },
        },
        refusal: null,
      };
    }
    case "tx-confirmed": {
      if (phase.kind !== "pending" && phase.kind !== "timeout") return illegal(machine, event);
      if (!isConfirmedReceipt(event.receipt)) return refuseWith(machine, { kind: "unminted-receipt" });
      const run = runFactsOf(machine);
      const mark = confirmationOf(event.receipt);
      const intent = run.record.intent;
      if (intent === null || intent.txHash !== mark.txHash) {
        return refuseWith(machine, {
          kind: "receipt-mismatch",
          expected: intent === null ? null : intent.txHash,
          received: mark.txHash,
        });
      }
      const gasRaw: unknown = (event.receipt as ConfirmedReceipt & { readonly gasUsed?: unknown }).gasUsed;
      const receipt: ReceiptRef = {
        txHash: mark.txHash,
        blockNumber: mark.blockNumber,
        blockHash: mark.blockHash,
        gasUsed: typeof gasRaw === "bigint" ? gasRaw : null,
      };
      return {
        machine: {
          ...machine,
          phase: { kind: "attributing", stepIndex: phase.stepIndex, receipt, consumedApproval: null },
        },
        refusal: null,
      };
    }
    case "tx-reverted": {
      if (phase.kind !== "pending" && phase.kind !== "timeout") return illegal(machine, event);
      const run = runFactsOf(machine);
      const intent = run.record.intent;
      if (intent === null || intent.txHash === null || intent.txHash !== event.txHash) {
        return refuseWith(machine, {
          kind: "receipt-mismatch",
          expected: intent === null ? null : intent.txHash,
          received: event.txHash,
        });
      }
      const step = stepAt(run.plan, phase.stepIndex);
      // The outcome is KNOWN (mined revert): the intent resolves, and the failure entry is
      // durable NOW with null decoded/raw — enrichment arrives later or not at all (D7).
      return landed(
        machine,
        recordFailure(clearResolvedIntent(run.record, phase.stepIndex), {
          stepIndex: phase.stepIndex,
          stepId: step.id,
          cause: "reverted",
          txHash: event.txHash,
          decoded: null,
          raw: null,
        }),
        { kind: "failed-at", stepIndex: phase.stepIndex, cause: "reverted" },
      );
    }
    case "tx-timeout": {
      if (phase.kind !== "pending" || phase.txHash === null) return illegal(machine, event);
      return {
        machine: { ...machine, phase: { kind: "timeout", stepIndex: phase.stepIndex, txHash: phase.txHash } },
        refusal: null,
      };
    }
    case "keep-waiting": {
      if (phase.kind !== "timeout") return illegal(machine, event);
      return {
        machine: { ...machine, phase: { kind: "pending", stepIndex: phase.stepIndex, txHash: phase.txHash } },
        refusal: null,
      };
    }
    case "give-up": {
      if (phase.kind !== "timeout") return illegal(machine, event);
      const run = runFactsOf(machine);
      const step = stepAt(run.plan, phase.stepIndex);
      // The chain has not spoken (T32a): the intent STAYS — the unwatched transaction may
      // still land, and the recovery re-simulation is what discovers whether it did.
      return landed(
        machine,
        recordFailure(run.record, {
          stepIndex: phase.stepIndex,
          stepId: step.id,
          cause: "timeout-gave-up",
          txHash: phase.txHash,
          decoded: null,
          raw: null,
        }),
        { kind: "failed-at", stepIndex: phase.stepIndex, cause: "timeout-gave-up" },
      );
    }
    case "tx-replaced": {
      if (phase.kind !== "pending" && phase.kind !== "timeout") return illegal(machine, event);
      const run = runFactsOf(machine);
      const intent = run.record.intent;
      const current =
        intent !== null && intent.stepIndex === phase.stepIndex ? intent.txHash : null;
      // A replacement is applied only against the transaction it actually replaced: a
      // delayed A→B arriving after A→B→C must not regress the watch to a stale hash, and
      // a duplicate of the applied event is a no-op, not an error.
      if (event.replacementHash === current) return { machine, refusal: null };
      if (current === null || event.replacedHash !== current) {
        return refuseWith(machine, {
          kind: "stale-replacement",
          currentTxHash: current,
          replacedHash: event.replacedHash,
          replacementHash: event.replacementHash,
        });
      }
      if (event.classification === "repriced") {
        return landed(machine, noteReplacement(run.record, phase.stepIndex, event.replacementHash), {
          kind: "pending",
          stepIndex: phase.stepIndex,
          txHash: event.replacementHash,
        });
      }
      const step = stepAt(run.plan, phase.stepIndex);
      // Classification preceded finality (T32a): the nonce is spent by the superseding
      // transaction, so the original can never land. The superseding hash is the failure
      // evidence — it is the transaction that actually exists on chain.
      return landed(
        machine,
        recordFailure(clearResolvedIntent(run.record, phase.stepIndex), {
          stepIndex: phase.stepIndex,
          stepId: step.id,
          cause: "cancelled",
          txHash: event.replacementHash,
          decoded: null,
          raw: null,
        }),
        { kind: "failed-at", stepIndex: phase.stepIndex, cause: "cancelled" },
      );
    }
    case "attribution-measured": {
      if (phase.kind !== "attributing" && phase.kind !== "attribution-unavailable") {
        return illegal(machine, event);
      }
      const run = runFactsOf(machine);
      const step = stepAt(run.plan, phase.stepIndex);
      const requirements = stepRequirementsOf(run.plan, step);
      if (requirements.output === null || requirements.output !== event.mechanism) {
        return refuseWith(machine, {
          kind: "mechanism-mismatch",
          stepId: step.id,
          expected: requirements.output,
          received: event.mechanism,
        });
      }
      // §3.3 is mandatory, not optional: a consuming producer cannot settle before its
      // zero-residual verdict exists.
      if (requirements.consumesApprovalFrom !== null && phase.consumedApproval === null) {
        return refuseWith(machine, {
          kind: "residual-check-required",
          stepId: step.id,
          spender: requirements.consumesApprovalFrom,
        });
      }
      const predictedWei = predictedOutputWeiOf(run.plan, step);
      if (predictedWei === null) return refuseWith(machine, { kind: "no-prediction", stepId: step.id });
      const toleranceWei = toleranceWeiFor(predictedWei, machine.tolerance);
      // Read the intent's moment-bound facts BEFORE either outcome: recordHalt clears the
      // intent, and the resolved calldata amount has no other historical copy.
      const evidence = dispatchEvidenceOf(run.record, phase.stepIndex);
      if (withinOutputTolerance(predictedWei, event.attributedWei, machine.tolerance)) {
        const entry: SettledStepFact = {
          stepIndex: phase.stepIndex,
          stepId: step.id,
          receipt: phase.receipt,
          resolvedAmountWei: evidence.resolvedAmountWei,
          sharesDelta: event.sharesDelta,
          output: {
            mechanism: event.mechanism,
            predictedWei,
            attributedWei: event.attributedWei,
            toleranceWei,
          },
          approval: evidence.approval,
          consumedApproval: phase.consumedApproval,
          risk: null,
        };
        return landed(machine, settleStep(run.record, entry), settledPhaseFor(run.plan, phase.stepIndex));
      }
      const halt = {
        kind: "output-divergence" as const,
        stepIndex: phase.stepIndex,
        stepId: step.id,
        mechanism: event.mechanism,
        predictedWei,
        attributedWei: event.attributedWei,
        toleranceWei,
        detail: null,
        receipt: phase.receipt,
      };
      return landed(
        machine,
        recordHalt(run.record, {
          stepIndex: phase.stepIndex,
          stepId: step.id,
          receipt: phase.receipt,
          resolvedAmountWei: evidence.resolvedAmountWei,
          sharesDelta: event.sharesDelta,
          halt,
        }),
        { kind: "halted-divergent", stepIndex: phase.stepIndex, halt },
      );
    }
    case "attribution-unavailable": {
      if (phase.kind !== "attributing") return illegal(machine, event);
      return {
        machine: {
          ...machine,
          phase: {
            kind: "attribution-unavailable",
            stepIndex: phase.stepIndex,
            receipt: phase.receipt,
            beforeShares: event.beforeShares,
            consumedApproval: phase.consumedApproval,
          },
        },
        refusal: null,
      };
    }
    case "non-producer-settled": {
      if (phase.kind !== "attributing") return illegal(machine, event);
      const run = runFactsOf(machine);
      const step = stepAt(run.plan, phase.stepIndex);
      const requirements = stepRequirementsOf(run.plan, step);
      if (requirements.output !== null) {
        return refuseWith(machine, {
          kind: "output-required",
          stepId: step.id,
          mechanism: requirements.output,
        });
      }
      if (requirements.consumesApprovalFrom !== null && phase.consumedApproval === null) {
        return refuseWith(machine, {
          kind: "residual-check-required",
          stepId: step.id,
          spender: requirements.consumesApprovalFrom,
        });
      }
      const evidence = dispatchEvidenceOf(run.record, phase.stepIndex);
      const entry: SettledStepFact = {
        stepIndex: phase.stepIndex,
        stepId: step.id,
        receipt: phase.receipt,
        resolvedAmountWei: evidence.resolvedAmountWei,
        sharesDelta: null,
        output: null,
        approval: evidence.approval,
        consumedApproval: phase.consumedApproval,
        risk: null,
      };
      return landed(machine, settleStep(run.record, entry), settledPhaseFor(run.plan, phase.stepIndex));
    }
    case "persistence-failed": {
      if (phase.kind !== "attributing") return illegal(machine, event);
      return {
        machine: {
          ...machine,
          phase: {
            kind: "persistence-failed",
            stepIndex: phase.stepIndex,
            receipt: phase.receipt,
            measurement: event.measurement,
          },
        },
        refusal: null,
      };
    }
    case "residual-allowance-checked": {
      // §3.3 zero-after-consume, verified after the consuming transaction is mined and
      // BEFORE the step may settle — mandatory for every consuming step, meaningless for
      // any other, and always against the pair's own spender.
      if (phase.kind !== "attributing" && phase.kind !== "attribution-unavailable") {
        return illegal(machine, event);
      }
      const run = runFactsOf(machine);
      const step = stepAt(run.plan, phase.stepIndex);
      const requirements = stepRequirementsOf(run.plan, step);
      if (requirements.consumesApprovalFrom === null) {
        return refuseWith(machine, { kind: "no-approval-to-check", stepId: step.id });
      }
      if (phase.consumedApproval !== null) return illegal(machine, event);
      const spender = getAddress(event.spender);
      if (spender !== requirements.consumesApprovalFrom) {
        return refuseWith(machine, {
          kind: "spender-mismatch",
          stepId: step.id,
          expected: requirements.consumesApprovalFrom,
          received: spender,
        });
      }
      const consumed: ConsumedApprovalFact = {
        spender: event.spender,
        residualAllowanceWei: event.residualAllowanceWei,
      };
      if (event.residualAllowanceWei === 0n) {
        return {
          machine: { ...machine, phase: { ...phase, consumedApproval: consumed } },
          refusal: null,
        };
      }
      const halt = {
        kind: "residual-allowance" as const,
        stepIndex: phase.stepIndex,
        stepId: step.id,
        spender: event.spender,
        residualAllowanceWei: event.residualAllowanceWei,
        receipt: phase.receipt,
      };
      // recordHalt clears the intent, so its moment-bound resolved amount is persisted on
      // the halted entry — the halt must not be the record's only incomplete row.
      const evidence = dispatchEvidenceOf(run.record, phase.stepIndex);
      return landed(
        machine,
        recordHalt(run.record, {
          stepIndex: phase.stepIndex,
          stepId: step.id,
          receipt: phase.receipt,
          resolvedAmountWei: evidence.resolvedAmountWei,
          sharesDelta: null,
          halt,
        }),
        { kind: "halted-divergent", stepIndex: phase.stepIndex, halt },
      );
    }
    case "step-result": {
      if (machine.mode !== "sandbox" || phase.kind !== "pending") return illegal(machine, event);
      return applyStepResult(machine, runFactsOf(machine), phase.stepIndex, event.result);
    }
    case "reconcile-result": {
      if (
        machine.mode !== "sandbox" ||
        (phase.kind !== "attributing" &&
          phase.kind !== "attribution-unavailable" &&
          phase.kind !== "persistence-failed" &&
          phase.kind !== "dispatch-unresolved")
      ) {
        return illegal(machine, event);
      }
      return applyStepResult(machine, runFactsOf(machine), phase.stepIndex, event.result);
    }
    case "step-refused": {
      if (machine.mode !== "sandbox" || phase.kind !== "pending") return illegal(machine, event);
      const refusal = event.refusal;
      if (refusal.kind === "session-expired") {
        // The refusal carries only the count; the tombstone's full evidence (settled
        // prefix + pending recovery) rehydrates through resumePlan on the next load.
        return {
          machine: {
            ...machine,
            phase: { kind: "abandoned", executedSteps: refusal.executedSteps, recovery: null },
          },
          refusal: null,
        };
      }
      const run = runFactsOf(machine);
      const step = stepAt(run.plan, phase.stepIndex);
      if (refusal.kind === "halted") {
        if (refusal.halt.stepIndex !== phase.stepIndex || refusal.halt.stepId !== step.id) {
          return refuseWith(machine, {
            kind: "resync-required",
            reason: "server halt cites a different step — rehydrate via resumePlan",
          });
        }
        return landed(
          machine,
          recordHalt(run.record, {
            stepIndex: refusal.halt.stepIndex,
            stepId: refusal.halt.stepId,
            receipt: refusal.halt.receipt,
            resolvedAmountWei: null,
            sharesDelta: null,
            halt: refusal.halt,
          }),
          { kind: "halted-divergent", stepIndex: refusal.halt.stepIndex, halt: refusal.halt },
        );
      }
      if (refusal.kind === "failed") {
        if (refusal.failure.stepIndex !== phase.stepIndex || refusal.failure.stepId !== step.id) {
          return refuseWith(machine, {
            kind: "resync-required",
            reason: "server failure cites a different step — rehydrate via resumePlan",
          });
        }
        return landed(
          machine,
          recordFailure(clearResolvedIntent(run.record, phase.stepIndex), {
            stepIndex: refusal.failure.stepIndex,
            stepId: refusal.failure.stepId,
            cause: "reverted",
            txHash: refusal.failure.txHash,
            decoded: refusal.failure.decoded,
            raw: refusal.failure.raw,
          }),
          { kind: "failed-at", stepIndex: phase.stepIndex, cause: "reverted" },
        );
      }
      if (refusal.kind === "reconcile-required") {
        return refuseWith(machine, {
          kind: "resync-required",
          reason: "server requires reconciliation — rehydrate via resumePlan",
        });
      }
      return refuseWith(machine, { kind: "transport-refusal", refusal });
    }
    case "failure-enriched": {
      if (phase.kind !== "failed-at") return illegal(machine, event);
      const run = runFactsOf(machine);
      return landed(machine, enrichFailure(run.record, { decoded: event.decoded, raw: event.raw }), phase);
    }
    case "wallet-changed": {
      if (machine.mode !== "live" || !WALLET_HALTABLE.has(phase.kind)) return illegal(machine, event);
      return { machine: { ...machine, phase: { kind: "halted-wallet-changed" } }, refusal: null };
    }
    case "session-lost": {
      if (machine.mode !== "sandbox" || !SESSION_LOSABLE.has(phase.kind)) return illegal(machine, event);
      return {
        machine: {
          ...machine,
          phase: { kind: "abandoned", executedSteps: event.executedSteps, recovery: null },
        },
        refusal: null,
      };
    }
  }
}
