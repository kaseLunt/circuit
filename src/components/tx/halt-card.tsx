"use client";

/**
 * The achromatic maximum-contrast stop (T16–T19) — THE data-error identity, defined
 * once and shared by all three halt kinds (T18: output divergence, the §5.4 HF
 * cross-check disagreement, the §3.3 residual-allowance finding).
 *
 * No hue anywhere on this card: every color in the system would misclaim what happened
 * (destructive ⇒ on-chain failure, warning ⇒ continue-with-awareness, success ⇒ fine,
 * primary ⇒ activity — all false). The color channel stays silent and the CONTRAST
 * channel carries the stop: `border-foreground`, the product's only one, with the
 * `EqualNot` glyph stating the mathematical fact itself — measured ≠ predicted.
 *
 * Every figure here is a wrapped quantity through SourcedValue: the prediction is the
 * plan's OWN flows wrapper or an explicit unavailable state (never a re-minted figure —
 * a wire prediction the plan cannot vouch for is the driver's wire fault, not this
 * card's number); the attribution cites mechanism + tx + block; the tolerance derives
 * from the machine's own named constants; and the delta is a DERIVED quantity over its
 * two source wrappers — no arithmetic happens in this component. Both transport truths
 * stay on the card (T17): the transaction confirmed AND the reading diverged — neither
 * erases the other. The card cannot be dismissed while the state holds (T19): it has no
 * close affordance.
 */
import { Check, EqualNot } from "lucide-react";
import { formatHealthFactor, formatToken, formatUnits } from "../../core/format";
import type { Provenanced } from "../../core/provenance";
import type { PlanSuccess } from "../../core/plan";
import type { HaltFact, RiskExpectationFact } from "../../lib/execution/types";
import type { OutputTolerance } from "../../lib/execution/tolerance";
import {
  attributedProvenance,
  chainHfProvenance,
  divergenceDeltaProvenance,
  predictedHfProvenance,
  predictedOutputProvenance,
  residualAllowanceProvenance,
  toleranceProvenance,
} from "../../lib/tx/provenance";
import { SourcedValue, slotClassName, type SlotRamp } from "../shared/sourced-value";
import { TransactionButton } from "./transaction-button";

const EVIDENCE_RAMP: SlotRamp = {
  resolved: "font-mono text-sm tabular-nums text-foreground",
  size: "text-sm",
};

const AMOUNT_CHARS = 14;

export interface HaltCardProps {
  readonly halt: HaltFact;
  readonly plan: PlanSuccess;
  /** The machine's own tolerance facts — the named constants, never re-typed (Codex 3a). */
  readonly tolerance: OutputTolerance;
  readonly recover: {
    readonly label: string;
    readonly onAct: () => void;
    readonly gateReason?: string | null;
  };
}

function expectedHfOf(expected: RiskExpectationFact): Provenanced<bigint> | null {
  return expected.status === "healthy" ? predictedHfProvenance(expected.hfWad) : null;
}

function EvidenceSlot({
  label,
  value,
  format,
  chars,
  unavailableReason,
}: {
  readonly label: string;
  readonly value: Provenanced<bigint> | null;
  readonly format: (value: bigint) => string;
  readonly chars: number;
  readonly unavailableReason: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-label uppercase tracking-wider text-muted-foreground">{label}</p>
      <SourcedValue
        value={value}
        pending={false}
        label={label}
        chars={chars}
        format={format}
        unavailableReason={unavailableReason}
        className={slotClassName(value !== null, false, EVIDENCE_RAMP)}
      />
    </div>
  );
}

function labelOf(halt: HaltFact): string {
  const k = halt.stepIndex + 1;
  switch (halt.kind) {
    case "output-divergence":
      return `HALTED — step ${k} output diverged`;
    case "hf-disagreement":
      return `HALTED — step ${k} health-factor readings disagree`;
    case "residual-allowance":
      return `HALTED — step ${k} left a residual allowance`;
  }
}

function proseOf(halt: HaltFact): string {
  switch (halt.kind) {
    case "output-divergence":
      return "The transaction confirmed, but its measured output differs from the prediction beyond tolerance. Nothing further was sent.";
    case "hf-disagreement":
      return "The transaction confirmed, but the chain's health-factor reading differs from the prediction. Nothing further was sent.";
    case "residual-allowance":
      return "The consuming transaction confirmed, but its allowance did not return to zero. Nothing further was sent.";
  }
}

function divergedFactOf(halt: HaltFact): string {
  switch (halt.kind) {
    case "output-divergence":
      return "attribution diverged";
    case "hf-disagreement":
      return "health-factor readings disagree";
    case "residual-allowance":
      return "residual allowance is not zero";
  }
}

export function HaltCard({ halt, plan, tolerance, recover }: HaltCardProps) {
  const predicted =
    halt.kind === "output-divergence"
      ? predictedOutputProvenance(plan, halt.stepIndex, halt.predictedWei)
      : null;
  const attributed =
    halt.kind === "output-divergence" && halt.attributedWei !== null
      ? attributedProvenance(halt.attributedWei, halt.mechanism, halt.receipt)
      : null;
  const delta =
    predicted !== null && attributed !== null
      ? divergenceDeltaProvenance(predicted, attributed)
      : null;
  return (
    <div className="rounded-lg border border-foreground bg-card p-4">
      <div className="flex items-center gap-2">
        <EqualNot aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-foreground" />
        <p className="text-label uppercase tracking-wider text-foreground">{labelOf(halt)}</p>
      </div>

      {halt.kind === "output-divergence" ? (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <EvidenceSlot
            label="Predicted"
            value={predicted}
            format={(value) => formatToken(value, 6)}
            chars={AMOUNT_CHARS}
            unavailableReason="prediction unavailable — does not match the plan's flows"
          />
          <EvidenceSlot
            label="Attributed"
            value={attributed}
            format={(value) => formatToken(value, 6)}
            chars={AMOUNT_CHARS}
            unavailableReason={
              halt.detail === null ? "attribution refused" : `attribution refused — ${halt.detail}`
            }
          />
          <EvidenceSlot
            label="Tolerance"
            value={predicted === null ? null : toleranceProvenance(predicted, tolerance)}
            format={(value) => `± ${formatToken(value, 6)}`}
            chars={AMOUNT_CHARS}
            unavailableReason="tolerance unavailable — the prediction could not be verified"
          />
          <EvidenceSlot
            label="Delta"
            value={delta}
            format={(value) => formatUnits(value, 18, 6)}
            chars={AMOUNT_CHARS}
            unavailableReason="delta unavailable — one side is missing"
          />
        </div>
      ) : halt.kind === "hf-disagreement" ? (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <EvidenceSlot
            label="Predicted"
            value={expectedHfOf(halt.expected)}
            format={formatHealthFactor}
            chars={5}
            unavailableReason={
              halt.expected.status === "no-debt"
                ? "no debt expected"
                : halt.expected.status === "unknown"
                  ? `prediction unavailable — ${halt.expected.reason}`
                  : "prediction unavailable"
            }
          />
          <EvidenceSlot
            label="Chain"
            value={chainHfProvenance(halt.chainHfWad, halt.receipt)}
            format={formatHealthFactor}
            chars={5}
            unavailableReason="chain reading unavailable"
          />
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <div>
            <p className="text-label uppercase tracking-wider text-muted-foreground">Spender</p>
            <p className="break-all font-mono text-xs text-foreground">{halt.spender}</p>
          </div>
          <EvidenceSlot
            label="Residual allowance"
            value={residualAllowanceProvenance(halt.residualAllowanceWei, halt.receipt)}
            format={(value) => formatToken(value, 6)}
            chars={AMOUNT_CHARS}
            unavailableReason="residual unavailable"
          />
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">{proseOf(halt)}</p>

      {/* Both transport truths, two labeled glyph-lines — neither erases the other (T17).
          The Check here is text-foreground: this state renders NO chroma at all, and the
          success glyph's two sanctioned sites (T4) are elsewhere. */}
      <div className="mt-2 space-y-1">
        <p className="flex items-center gap-2 text-xs text-foreground">
          <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-foreground" />
          transaction confirmed
        </p>
        <p className="flex items-center gap-2 text-xs text-foreground">
          <EqualNot aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-foreground" />
          {divergedFactOf(halt)}
        </p>
      </div>

      <div className="mt-3">
        <TransactionButton
          onClick={recover.onAct}
          gateReason={recover.gateReason ?? null}
          size="sm"
        >
          {recover.label}
        </TransactionButton>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Sandbox recovery resets the session fork and re-simulates from the pinned base
        block; the halted record above stays as it stands until then.
      </p>
    </div>
  );
}
