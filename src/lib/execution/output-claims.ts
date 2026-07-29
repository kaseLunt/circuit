/**
 * The money-claim validator (Codex verification round, thread 019fa749): every wire
 * figure that CLAIMS to be a prediction, a tolerance bound, or a within/beyond verdict
 * is recomputed from facts the machine can vouch for — the plan's own flows wrapper,
 * `toleranceWeiFor`, `withinOutputTolerance` — and any disagreement is a typed refusal,
 * never an adoption.
 *
 * Pure, and deliberately in `src/lib/execution/`: BOTH adoption seams consume it — the
 * driver's live execute/reconcile path (before any machine event) and `resumePlan`'s
 * record adoption (session summaries AND tombstones) — so no recovery path can adopt a
 * result the live path refused. One validator, every gate.
 */
import type { PlanSuccess } from "../../core/plan";
import { toleranceWeiFor, withinOutputTolerance, type OutputTolerance } from "./tolerance";
import type { HaltFact, SandboxStepResult } from "./types";

export interface OutputClaim {
  readonly stepIndex: number;
  readonly predictedWei: bigint;
  readonly attributedWei: bigint | null;
  readonly toleranceWei: bigint;
  readonly arrivedAs: "attributed" | "halted";
}

/**
 * Recompute-and-compare for one claim. Checked in order: the predicted figure IS the
 * flows wrapper's; the tolerance IS the recomputed bound; the within/beyond
 * classification agrees with the numbers (an attribution-refused halt carries no
 * attributed figure and skips only the classification arm).
 */
export function outputClaimMismatch(
  plan: PlanSuccess,
  tolerance: OutputTolerance,
  claim: OutputClaim,
): string | null {
  const step = plan.steps[claim.stepIndex];
  if (step === undefined) {
    return `predicted output cites step ${claim.stepIndex}, which the plan does not have`;
  }
  const flow = plan.flows.find((candidate) => candidate.blockId === step.blockId);
  if (flow === undefined || flow.outputWei === null) {
    return `step ${claim.stepIndex} carries a predicted output the plan's flows do not`;
  }
  const predicted = flow.outputWei.value;
  if (predicted !== claim.predictedWei) {
    return `step ${claim.stepIndex} predicted output disagrees with the plan's flows wrapper`;
  }
  if (claim.toleranceWei !== toleranceWeiFor(predicted, tolerance)) {
    return `step ${claim.stepIndex} tolerance disagrees with the machine's recomputed bound`;
  }
  if (claim.attributedWei !== null) {
    const within = withinOutputTolerance(predicted, claim.attributedWei, tolerance);
    if (claim.arrivedAs === "attributed" && !within) {
      return `step ${claim.stepIndex} attributed output lies outside the machine's bound but arrived as attributed`;
    }
    if (claim.arrivedAs === "halted" && within) {
      return `step ${claim.stepIndex} attributed output lies within the machine's bound but arrived as a halt`;
    }
  }
  return null;
}

/** A halt fact's claims — only the output-divergence kind carries any. */
export function haltClaimMismatch(
  plan: PlanSuccess,
  tolerance: OutputTolerance,
  halt: HaltFact,
): string | null {
  if (halt.kind !== "output-divergence") return null;
  return outputClaimMismatch(plan, tolerance, {
    stepIndex: halt.stepIndex,
    predictedWei: halt.predictedWei,
    attributedWei: halt.attributedWei,
    toleranceWei: halt.toleranceWei,
    arrivedAs: "halted",
  });
}

/**
 * A step result's claims. Null plan short-circuits (the machine refuses such events on
 * its own); results without output claims (approvals, failures, dispatch outcomes)
 * carry nothing to verify.
 */
export function stepResultClaimMismatch(
  plan: PlanSuccess | null,
  tolerance: OutputTolerance,
  result: SandboxStepResult,
): string | null {
  if (plan === null) return null;
  if (result.status === "attributed" && result.output !== null) {
    return outputClaimMismatch(plan, tolerance, {
      stepIndex: result.stepIndex,
      predictedWei: result.output.predictedWei,
      attributedWei: result.output.attributedWei,
      toleranceWei: result.output.toleranceWei,
      arrivedAs: "attributed",
    });
  }
  if (result.status === "halted") {
    return haltClaimMismatch(plan, tolerance, result.halt);
  }
  return null;
}
