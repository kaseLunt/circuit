/**
 * Pure derivation: one `StepRowStatus` per plan step, read off the machine (T33 — a
 * discriminated union mirroring the machine, never an `isLoading`/`isSuccess` pair; a
 * boolean pair can express states the machine forbids).
 *
 * The settled arm carries the RECORD ENTRY, not a flag: the confirmed check renders only
 * off a receipt-bearing record object (T5/A15 — the prop shape has no place for an
 * optimistic boolean). The suffix arm exists because T20's trichotomy is three visual
 * registers — executed prefix, the stopped step, unexecuted suffix — and the suffix must
 * be derivable, never guessed from "not settled yet".
 */
import type { PlanSuccess, TransactionStep } from "../../core/plan";
import type { ExecutionMachine } from "../../lib/execution/machine";
import type { ExecutionPhase } from "../../lib/execution/types";
import type {
  FailureRecordFact,
  HaltedStepFact,
  ReceiptRef,
  RecoveryFact,
  SettledStepFact,
} from "../../lib/execution/types";
import type { Provenanced } from "../../core/provenance";

export type StepRowStatus =
  | { readonly kind: "queued" }
  | { readonly kind: "awaiting-signature" }
  | { readonly kind: "active"; readonly txHash: `0x${string}` | null }
  | { readonly kind: "timeout"; readonly txHash: `0x${string}` }
  | { readonly kind: "attributing"; readonly receipt: ReceiptRef }
  | { readonly kind: "settled"; readonly settled: SettledStepFact }
  | { readonly kind: "halted"; readonly halted: HaltedStepFact }
  | { readonly kind: "failed"; readonly failure: FailureRecordFact }
  | {
      /** Rev 3.1 both-truths states: the tx confirmed AND something else is unresolved. */
      readonly kind: "recovery";
      readonly receipt: ReceiptRef | null;
      readonly txHash: `0x${string}` | null;
    }
  | { readonly kind: "vacated" }
  | { readonly kind: "interrupted"; readonly recovery: RecoveryFact }
  | { readonly kind: "not-sent" };

/** Phase kinds after which every unexecuted step renders in T20's suffix register. */
const STOPPED: ReadonlySet<ExecutionPhase["kind"]> = new Set([
  "failed-at",
  "halted-divergent",
  "halted-wallet-changed",
  "abandoned",
]);

export function stepRowStatusOf(machine: ExecutionMachine, stepIndex: number): StepRowStatus {
  const record = machine.record;
  if (record !== null) {
    const settled = record.settled[stepIndex];
    if (settled !== undefined) return { kind: "settled", settled };
    if (record.halted !== null && record.halted.stepIndex === stepIndex) {
      return { kind: "halted", halted: record.halted };
    }
    if (record.failure !== null && record.failure.stepIndex === stepIndex) {
      return { kind: "failed", failure: record.failure };
    }
  }
  const phase = machine.phase;
  if ("stepIndex" in phase && phase.stepIndex === stepIndex) {
    switch (phase.kind) {
      case "awaiting-signature":
        return { kind: "awaiting-signature" };
      case "pending":
        return { kind: "active", txHash: phase.txHash };
      case "timeout":
        return { kind: "timeout", txHash: phase.txHash };
      case "attributing":
        return { kind: "attributing", receipt: phase.receipt };
      case "attribution-unavailable":
      case "persistence-failed":
        return { kind: "recovery", receipt: phase.receipt, txHash: phase.receipt.txHash };
      case "dispatch-unresolved":
        return { kind: "recovery", receipt: null, txHash: phase.txHash };
      case "dispatch-vacated":
        return { kind: "vacated" };
      default:
        break;
    }
  }
  if (phase.kind === "abandoned") {
    if (phase.recovery !== null && phase.recovery.stepIndex === stepIndex) {
      return { kind: "interrupted", recovery: phase.recovery };
    }
    // A step the tombstone counts as executed but the client record has no entry for:
    // its evidence is server-side (D8 tombstone) and rehydrates on reload. Neither
    // "queued" (claims not-sent) nor "settled" (needs the receipt, T5) is honest here.
    if (stepIndex < phase.executedSteps) {
      return { kind: "recovery", receipt: null, txHash: null };
    }
    return { kind: "not-sent" };
  }
  if (STOPPED.has(phase.kind)) return { kind: "not-sent" };
  return { kind: "queued" };
}

/**
 * The canvas's executing frame (T26/T1, P2 site five): during `executing(k)` — the
 * in-flight substates of §2.1 — the active step's BLOCK carries `border-primary` on the
 * canvas; at every other phase the frame is absent. Mapped here from the machine's own
 * phase through the frozen plan, so the canvas and the column can never disagree about
 * which block is executing.
 */
/**
 * Phases in which the DOCUMENT is frozen (treatment §2.4, rendered per T26).
 *
 * Every phase from the first dispatch until the run settles: the plan under execution is the
 * frozen one, and a mid-run edit would make the canvas describe a strategy that is not the
 * one moving money. On a terminal state the lock lifts — editing is how the user starts over,
 * and editing invalidates continue-from-k by definition.
 *
 * T26 rules what the lock LOOKS like, and it is not a veil: reads stay live at full
 * legibility (pan, zoom, provenance tooltips, disclosures — mid-execution is precisely when
 * inspection matters most). Only WRITES refuse, and they refuse through the typed-rejection
 * strip the block family already owns.
 */
const RUN_LOCKED: ReadonlySet<ExecutionPhase["kind"]> = new Set([
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

/** The one sentence every refused write states while a run holds the document (T26). */
export const RUN_LOCK_REASON = "Execution in progress — the strategy is locked.";

export function runLocksDocument(machine: ExecutionMachine): boolean {
  return RUN_LOCKED.has(machine.phase.kind);
}

export function executingBlockIdOf(machine: ExecutionMachine): string | null {
  const phase = machine.phase;
  if (machine.plan === null) return null;
  if (
    phase.kind === "awaiting-signature" ||
    phase.kind === "pending" ||
    phase.kind === "timeout" ||
    phase.kind === "attributing"
  ) {
    return machine.plan.steps[phase.stepIndex]?.blockId ?? null;
  }
  return null;
}

/**
 * What the amount slot of an UNSETTLED row may honestly show (T13's spec-or-resolved
 * rule): the spec's own provenanced figure where the plan carries one, the "bound to
 * step {j}" statement where the amount is a future attribution, and nothing at all for
 * steps that carry no amount — a step with no amount has no value to be unavailable.
 */
export type PlannedAmount =
  | { readonly kind: "figure"; readonly amount: Provenanced<bigint> }
  | {
      readonly kind: "bound";
      /** The producer's 1-based step number (`TransactionStep.index` is display-numbered). */
      readonly producerStepNumber: number;
    }
  | { readonly kind: "none" };

export function plannedAmountOf(plan: PlanSuccess, step: TransactionStep): PlannedAmount {
  const spec = step.amount;
  switch (spec.kind) {
    case "literal":
    case "derived":
      return { kind: "figure", amount: spec.amount };
    case "step-output": {
      const producer = plan.steps.find((candidate) => candidate.id === spec.producerStepId);
      return producer === undefined
        ? { kind: "none" }
        : { kind: "bound", producerStepNumber: producer.index };
    }
    case "none":
      return { kind: "none" };
  }
}

/**
 * The approve pair, read the way the machine reads it (D1/D4): the consumer is the step
 * sharing the approve's amount-spec OBJECT — reference identity, never field equality.
 */
export function approveConsumerOf(
  plan: PlanSuccess,
  approve: TransactionStep,
): TransactionStep | null {
  if (approve.functionName !== "approve") return null;
  for (const candidate of plan.steps) {
    if (candidate !== approve && candidate.amount === approve.amount) return candidate;
  }
  return null;
}

/** The approve's spender, from its own first argument — the only place it exists. */
export function approveSpenderAddressOf(approve: TransactionStep): string | null {
  const arg = approve.args[0];
  if (arg !== undefined && arg.kind === "value" && typeof arg.value === "string") {
    return arg.value;
  }
  return null;
}
