/**
 * Provenance for wire-arrived execution facts — the "trail transport" duty the sandbox
 * router names and deliberately leaves to this surface (`sandbox-router.ts` planView
 * note; treatment D11).
 *
 * The client cannot mint `Observed` — `observationMinter` lives behind the server/chain
 * boundary and the forged-literal lint ban keeps the shape unforgeable, and that ban is
 * load-bearing: this module did not perform the read. What it holds is the fact that the
 * ATTRIBUTION MODULE's tested math measured the figure on the session fork, plus the
 * receipt that pins where. So the wrapper is `Derived`: the expression names the SPEC
 * §5.5 mechanism (T10 — the mechanism is the tooltip's first line) and the note cites
 * transaction and block, which is exactly the evidence the treatment requires the
 * attributed figure to carry (mechanism + tx + block, T17).
 *
 * Tolerance figures are `Configured`: named constants with a definition site, which is
 * their literal provenance kind.
 */
import { configured, derived, type Derived, type Provenanced } from "../../core/provenance";
import type { PlanSuccess } from "../../core/plan";
import type { OutputMechanism, ReceiptRef } from "../execution/types";
import { toleranceWeiFor, type OutputTolerance } from "../execution/tolerance";

/** T10's tooltip-first-line vocabulary, verbatim. */
export function mechanismLabel(mechanism: OutputMechanism): string {
  switch (mechanism) {
    case "share-delta":
      return "share delta";
    case "transfer-event":
      return "Transfer event";
    case "withdraw-argument":
      return "withdraw argument";
  }
}

const receiptCitation = (receipt: ReceiptRef): string =>
  `measured at execution: tx ${receipt.txHash} @ block ${receipt.blockNumber}`;

/** The attributed output of an executed step, carrying its mechanism + tx + block. */
export function attributedProvenance(
  attributedWei: bigint,
  mechanism: OutputMechanism,
  receipt: ReceiptRef,
): Derived<bigint> {
  return derived(attributedWei, mechanismLabel(mechanism), [], receiptCitation(receipt));
}

/** A resolved calldata amount off the executed record (approve/supply argument values). */
export function resolvedAmountProvenance(
  resolvedAmountWei: bigint,
  receipt: ReceiptRef,
): Derived<bigint> {
  return derived(
    resolvedAmountWei,
    "resolved calldata amount",
    [],
    receiptCitation(receipt),
  );
}

/** A chain-read health factor that crossed the wire beside its receipt (§5.4 cross-check). */
export function chainHfProvenance(chainHfWad: bigint, receipt: ReceiptRef): Derived<bigint> {
  return derived(
    chainHfWad,
    "Pool.getUserAccountData(actor).healthFactor",
    [],
    `read after execution: tx ${receipt.txHash} @ block ${receipt.blockNumber}`,
  );
}

const TOLERANCE_DEFINED_AT = "src/lib/execution/tolerance.ts";

/**
 * The per-step tolerance bound, RECOMPUTED from the prediction wrapper and the
 * machine's own named constants — the trail derives exactly what it claims (Codex
 * hard-gate finding 2: labelling a wire figure with a formula it was never run through
 * lets the trail lie). The driver separately refuses any wire result whose shipped
 * tolerance disagrees with this recomputation, so the figure on screen and the figure
 * the halt verdict used are provably the same number.
 */
export function toleranceProvenance(
  predicted: Provenanced<bigint>,
  tolerance: OutputTolerance,
): Derived<bigint> {
  const bounds = toleranceConstantsProvenance(tolerance);
  return derived(
    toleranceWeiFor(predicted.value, tolerance),
    "max(absWei, predicted / relPow)",
    [predicted, bounds.absWei, bounds.relPow],
    "bounds derived from fork receipts, not invented — see the tolerance module's header",
  );
}

/** The tolerance constants themselves, for the pre-execute review's bounds line. */
export function toleranceConstantsProvenance(tolerance: OutputTolerance): {
  readonly absWei: Provenanced<bigint>;
  readonly relPow: Provenanced<bigint>;
} {
  return {
    absWei: configured(tolerance.absWei, "SANDBOX_OUTPUT_TOLERANCE.absWei", TOLERANCE_DEFINED_AT),
    relPow: configured(tolerance.relPow, "SANDBOX_OUTPUT_TOLERANCE.relPow", TOLERANCE_DEFINED_AT),
  };
}

/**
 * The PREDICTED figure for a step's output: the plan's own flows wrapper — the same
 * object the canvas rendered (§6.2's one-source rule) — and NOTHING else. A wire
 * prediction the local plan cannot vouch for returns null: the slot renders an explicit
 * unavailable state, and the driver surfaces the disagreement as a wire fault
 * (`wirePredictionMismatch`) — never a minted fallback figure that LOOKS like the
 * canvas's prediction but is not it.
 */
export function predictedOutputProvenance(
  plan: PlanSuccess,
  stepIndex: number,
  predictedWei: bigint,
): Provenanced<bigint> | null {
  const step = plan.steps[stepIndex];
  if (step === undefined) return null;
  const flow = plan.flows.find((candidate) => candidate.blockId === step.blockId);
  if (flow === undefined || flow.outputWei === null || flow.outputWei.value !== predictedWei) {
    return null;
  }
  return flow.outputWei;
}

/**
 * A predicted health factor from the frozen plan's own risk walk (`riskLedger` — the
 * one prediction home, treatment §0). Shared by the pre-execute review's per-step risk
 * lines (T13) and the halt card's PREDICTED column (T18).
 */
export function predictedHfProvenance(hfWad: bigint): Derived<bigint> {
  return derived(
    hfWad,
    "riskLedger checkpoint hfWad",
    [],
    "predicted by the frozen plan's risk walk",
  );
}

/**
 * The T17 divergence delta as a DERIVED quantity over its two source wrappers — the
 * derivation trail keeps both parents, so the tooltip shows exactly which prediction
 * and which measurement the sign came from. Never computed inline in a component.
 */
export function divergenceDeltaProvenance(
  predicted: Provenanced<bigint>,
  attributed: Provenanced<bigint>,
): Derived<bigint> {
  return derived(
    attributed.value - predicted.value,
    "attributed − predicted",
    [attributed, predicted],
  );
}

/** A residual allowance that should have been zero (§3.3), cited to its read. */
export function residualAllowanceProvenance(
  residualAllowanceWei: bigint,
  receipt: ReceiptRef,
): Derived<bigint> {
  return derived(
    residualAllowanceWei,
    "allowance(actor, spender) after the consuming step",
    [],
    `read after execution: tx ${receipt.txHash} @ block ${receipt.blockNumber}`,
  );
}
