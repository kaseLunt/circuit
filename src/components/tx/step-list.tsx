"use client";

/**
 * StepList (T6–T11): one row per `TransactionStep`, in plan order, at the system's one
 * row height. All rows exist from the moment the plan builds (T11 — rows never enter
 * one by one); only their slots resolve. Confirmed steps never fold into a summary
 * count (T8 — the executed prefix IS the record); the list auto-scrolls the active row
 * into view with INSTANT scroll, never smooth.
 *
 * The glyph column is the machine's single visual narrator (T7). Chroma discipline:
 * `text-primary` on exactly the active spinner, `text-success` on exactly the confirmed
 * `Check`, `text-destructive` on exactly the failed step; a declined signature is `Ban`
 * muted (a decision, not a failure), a divergence is `EqualNot` foreground (a stop, not
 * an error), and the unexecuted suffix drops whole rows to muted with "not sent" prose
 * (T20 — never a dash, never a zero, never a skeleton: nothing is loading).
 *
 * The failed and halted steps carry their card IN the row's detail zone: the point of
 * decision is the point of action, spatially anchored to the fact that forced it (T25).
 */
import { useEffect, useRef } from "react";
import { Ban, Check, Circle, Clock, Copy, EqualNot, Loader, X } from "lucide-react";
import { formatAddress, formatHealthFactor, formatToken, formatUnits } from "../../core/format";
import type { PlanSuccess, TransactionStep } from "../../core/plan";
import type { ExecutionMachine } from "../../lib/execution/machine";
import type { OutputTolerance } from "../../lib/execution/tolerance";
import type { ExecutionPhase, SettledStepFact } from "../../lib/execution/types";
import {
  attributedProvenance,
  chainHfProvenance,
  predictedOutputProvenance,
  resolvedAmountProvenance,
} from "../../lib/tx/provenance";
import { cn } from "../../lib/utils";
import { SourcedValue, slotClassName, type SlotRamp } from "../shared/sourced-value";
import { Button } from "../ui/button";
import { FailureCard } from "./failure-card";
import { HaltCard } from "./halt-card";
import {
  approveConsumerOf,
  approveSpenderAddressOf,
  plannedAmountOf,
  stepRowStatusOf,
  type StepRowStatus,
} from "./step-status";

const ROW_RAMP: SlotRamp = { resolved: "text-sm", size: "text-sm" };
const PAIR_RAMP: SlotRamp = {
  resolved: "font-mono text-xs tabular-nums text-foreground",
  size: "text-xs",
};
const AMOUNT_CHARS = 12;

export interface RecoveryAction {
  readonly label: string;
  readonly onAct: () => void;
  readonly gateReason?: string | null;
}

export interface StepListProps {
  /** The frozen plan — the machine's own reference once armed (T33). */
  readonly plan: PlanSuccess;
  readonly machine: ExecutionMachine;
  /** True while the driver's reconcile call is in flight — the spinner's licence. */
  readonly reconciling: boolean;
  readonly recover: RecoveryAction;
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function glyphOf(status: StepRowStatus, reconciling: boolean): React.ReactElement {
  const base = "h-3.5 w-3.5 shrink-0";
  switch (status.kind) {
    case "active":
    case "attributing":
      return <Loader aria-hidden="true" className={cn(base, "step-spinner text-primary")} />;
    case "recovery":
      return reconciling ? (
        <Loader aria-hidden="true" className={cn(base, "step-spinner text-primary")} />
      ) : (
        <Loader aria-hidden="true" className={cn(base, "text-muted-foreground")} />
      );
    case "settled":
      return <Check aria-hidden="true" className={cn(base, "text-success")} />;
    case "halted":
      return <EqualNot aria-hidden="true" className={cn(base, "text-foreground")} />;
    case "failed":
      if (status.failure.cause === "user-rejected") {
        return <Ban aria-hidden="true" className={cn(base, "text-muted-foreground")} />;
      }
      if (status.failure.cause === "timeout-gave-up") {
        return <Clock aria-hidden="true" className={cn(base, "text-muted-foreground")} />;
      }
      return <X aria-hidden="true" className={cn(base, "text-destructive")} />;
    case "timeout":
      return <Clock aria-hidden="true" className={cn(base, "text-muted-foreground")} />;
    case "interrupted":
      return <Loader aria-hidden="true" className={cn(base, "text-muted-foreground")} />;
    case "queued":
    case "awaiting-signature":
    case "vacated":
    case "not-sent":
      return <Circle aria-hidden="true" className={cn(base, "text-muted-foreground")} />;
  }
}

function AmountSlot({
  plan,
  step,
  status,
}: {
  readonly plan: PlanSuccess;
  readonly step: TransactionStep;
  readonly status: StepRowStatus;
}) {
  const label = `Step ${step.index} amount`;
  switch (status.kind) {
    case "settled": {
      const settled = status.settled;
      if (settled.output !== null) {
        return (
          <SourcedValue
            value={attributedProvenance(
              settled.output.attributedWei,
              settled.output.mechanism,
              settled.receipt,
            )}
            pending={false}
            label={`Step ${step.index} attributed output`}
            chars={AMOUNT_CHARS}
            format={(value) => formatToken(value, 4)}
            unavailableReason="unavailable"
            className={slotClassName(true, false, ROW_RAMP)}
          />
        );
      }
      if (settled.resolvedAmountWei !== null) {
        return (
          <SourcedValue
            value={resolvedAmountProvenance(settled.resolvedAmountWei, settled.receipt)}
            pending={false}
            label={`Step ${step.index} resolved amount`}
            chars={AMOUNT_CHARS}
            format={(value) => formatToken(value, 4)}
            unavailableReason="unavailable"
            className={slotClassName(true, false, ROW_RAMP)}
          />
        );
      }
      return null;
    }
    case "active":
    case "attributing":
    case "recovery":
    case "timeout":
      return (
        <SourcedValue
          value={null}
          pending
          label={label}
          chars={AMOUNT_CHARS}
          format={(value: bigint) => formatToken(value, 4)}
          unavailableReason="unavailable"
          className={slotClassName(false, true, ROW_RAMP)}
        />
      );
    case "not-sent":
    case "vacated":
      return <span className="text-xs text-muted-foreground">not sent</span>;
    case "interrupted":
      return <span className="text-xs text-muted-foreground">held server-side</span>;
    case "failed":
      return status.failure.cause === "user-rejected" ? (
        <span className="text-xs text-muted-foreground">not sent</span>
      ) : null;
    case "halted":
      return status.halted.resolvedAmountWei === null ? null : (
        <SourcedValue
          value={resolvedAmountProvenance(status.halted.resolvedAmountWei, status.halted.receipt)}
          pending={false}
          label={`Step ${step.index} resolved amount`}
          chars={AMOUNT_CHARS}
          format={(value) => formatToken(value, 4)}
          unavailableReason="unavailable"
          className={slotClassName(true, false, ROW_RAMP)}
        />
      );
    case "queued":
    case "awaiting-signature": {
      const planned = plannedAmountOf(plan, step);
      if (planned.kind === "figure") {
        return (
          <SourcedValue
            value={planned.amount}
            pending={false}
            label={label}
            chars={AMOUNT_CHARS}
            format={(value) => formatToken(value, 4)}
            unavailableReason="unavailable"
            className={slotClassName(true, false, ROW_RAMP)}
          />
        );
      }
      if (planned.kind === "bound") {
        return (
          <span className="text-xs text-muted-foreground">{`bound to step ${planned.producerStepNumber}`}</span>
        );
      }
      return null;
    }
  }
}

function HashLine({ txHash }: { readonly txHash: string }) {
  return (
    <span className="flex items-center gap-1">
      {/* Truncating a HASH is legal — an identifier, not a quantity (T9) — and copy
          always yields the full hash. */}
      <span className="font-mono text-xs text-muted-foreground">{formatAddress(txHash, 4)}</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Copy transaction hash"
        onClick={() => copyText(txHash)}
      >
        <Copy aria-hidden="true" />
      </Button>
    </span>
  );
}

/** T15: one sentence, composed entirely from the step objects, no safety verdicts. The
 *  "nothing remains" clause is legal ONLY because the §3.3 zero-after-consume check is
 *  enforced (machine + server); if that check is ever cut, cut this clause with it. */
function approvalExplainerOf(plan: PlanSuccess, approve: TransactionStep): string | null {
  const spender = approveSpenderAddressOf(approve);
  const consumer = approveConsumerOf(plan, approve);
  if (spender === null || consumer === null) return null;
  const spec = approve.amount;
  const amount =
    spec.kind === "step-output"
      ? (() => {
          const producer = plan.steps.find((step) => step.id === spec.producerStepId);
          return producer === undefined
            ? "the attributed output of its producer step"
            : `the attributed output of step ${producer.index}`;
        })()
      : "the resolved amount";
  return `Allows ${formatAddress(spender, 4)} — the target of step ${consumer.index} — to move exactly ${amount}. Step ${consumer.index} spends it in full; nothing remains.`;
}

function SettledDetail({
  plan,
  step,
  position,
  settled,
}: {
  readonly plan: PlanSuccess;
  readonly step: TransactionStep;
  /** Array position — machine/wire step index; `step.index` is the 1-based display number. */
  readonly position: number;
  readonly settled: SettledStepFact;
}) {
  const explainer = approvalExplainerOf(plan, step);
  const predicted =
    settled.output === null
      ? null
      : predictedOutputProvenance(plan, position, settled.output.predictedWei);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <HashLine txHash={settled.receipt.txHash} />
        {settled.receipt.gasUsed === null ? null : (
          <span className="font-mono text-xs text-muted-foreground">
            {`gas used ${formatUnits(settled.receipt.gasUsed, 0, 0)}`}
          </span>
        )}
      </div>
      {settled.output === null ? null : (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>
            <span className="block text-label uppercase tracking-wider text-muted-foreground">
              Predicted
            </span>
            <SourcedValue
              value={predicted}
              pending={false}
              label={`Step ${step.index} predicted output`}
              chars={AMOUNT_CHARS}
              format={(value) => formatToken(value, 6)}
              unavailableReason="does not match the plan's flows"
              className={slotClassName(predicted !== null, false, PAIR_RAMP)}
            />
          </span>
          <span>
            <span className="block text-label uppercase tracking-wider text-muted-foreground">
              Attributed
            </span>
            <SourcedValue
              value={attributedProvenance(
                settled.output.attributedWei,
                settled.output.mechanism,
                settled.receipt,
              )}
              pending={false}
              label={`Step ${step.index} attributed output`}
              chars={AMOUNT_CHARS}
              format={(value) => formatToken(value, 6)}
              unavailableReason="unavailable"
              className={slotClassName(true, false, PAIR_RAMP)}
            />
          </span>
        </div>
      )}
      {settled.risk === null ? null : (
        <p className="text-xs text-muted-foreground">
          {"HF after this step: "}
          <SourcedValue
            value={chainHfProvenance(settled.risk.chainHfWad, settled.receipt)}
            pending={false}
            label={`Health factor after step ${step.index}`}
            chars={5}
            format={formatHealthFactor}
            unavailableReason="unavailable"
            inline
            className={slotClassName(true, false, PAIR_RAMP)}
          />
        </p>
      )}
      {explainer === null ? null : <p className="text-xs text-muted-foreground">{explainer}</p>}
    </div>
  );
}

function statusDetail(
  plan: PlanSuccess,
  step: TransactionStep,
  position: number,
  status: StepRowStatus,
  phase: ExecutionPhase,
  tolerance: OutputTolerance,
  recover: RecoveryAction,
): React.ReactElement | null {
  switch (status.kind) {
    case "settled":
      return <SettledDetail plan={plan} step={step} position={position} settled={status.settled} />;
    case "active":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {status.txHash === null ? null : <HashLine txHash={status.txHash} />}
          <span className="text-xs text-muted-foreground">transaction pending</span>
        </div>
      );
    case "attributing":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <HashLine txHash={status.receipt.txHash} />
          <span className="text-xs text-muted-foreground">
            transaction confirmed — attributing output
          </span>
        </div>
      );
    case "timeout":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <HashLine txHash={status.txHash} />
          <span className="text-xs text-muted-foreground">
            not confirmed within the expected time — it may still land
          </span>
        </div>
      );
    case "recovery": {
      const line =
        phase.kind === "attribution-unavailable"
          ? "transaction confirmed · its measured output could not be read — reconciling re-reads it"
          : phase.kind === "persistence-failed"
            ? "transaction confirmed · the record did not persist — reconciling verifies the retained receipt"
            : phase.kind === "dispatch-unresolved"
              ? "dispatch outcome unknown — discovery walks the receipt, the nonce pin, and history; nothing is re-sent"
              : "outcome recorded on the session fork — evidence rehydrates on reload";
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {status.txHash === null ? null : <HashLine txHash={status.txHash} />}
          <span className="text-xs text-muted-foreground">{line}</span>
        </div>
      );
    }
    case "vacated":
      return (
        <p className="text-xs text-muted-foreground">
          discovery proved this transaction never landed — sending it again is legal;
          nothing happened
        </p>
      );
    case "interrupted": {
      const recovery = status.recovery;
      const line =
        recovery.kind === "attribution-pending"
          ? "transaction confirmed · attribution never completed before the session expired"
          : recovery.kind === "reconcile-persistence"
            ? "transaction confirmed · its record never persisted before the session expired"
            : "dispatch outcome undiscovered when the session expired";
      const txHash =
        recovery.kind === "reconcile-dispatch" ? recovery.txHash : recovery.receipt.txHash;
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {txHash === null ? null : <HashLine txHash={txHash} />}
          <span className="text-xs text-muted-foreground">{line}</span>
        </div>
      );
    }
    case "failed":
      return <FailureCard failure={status.failure} recover={recover} />;
    case "halted":
      return (
        <HaltCard halt={status.halted.halt} plan={plan} tolerance={tolerance} recover={recover} />
      );
    case "queued":
    case "awaiting-signature":
    case "not-sent":
      return null;
  }
}

export function StepList({ plan, machine, reconciling, recover }: StepListProps) {
  const phase = machine.phase;
  const activeIndex =
    "stepIndex" in phase && phase.kind !== "attributed" ? phase.stepIndex : null;
  const activeRowRef = useRef<HTMLLIElement>(null);

  // INSTANT scroll (T8): a progress list that glides is performing.
  useEffect(() => {
    if (activeIndex === null) return;
    const row = activeRowRef.current;
    if (row !== null && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ behavior: "auto", block: "nearest" });
    }
  }, [activeIndex]);

  return (
    <ol aria-label="Execution steps" className="space-y-0">
      {plan.steps.map((step, position) => {
        const status = stepRowStatusOf(machine, position);
        const muted = status.kind === "not-sent";
        const detail = statusDetail(plan, step, position, status, phase, machine.tolerance, recover);
        return (
          <li
            key={step.id}
            ref={position === activeIndex ? activeRowRef : undefined}
            className="rounded-sm"
          >
            <div className={cn("flex h-9 items-center gap-2 px-3")}>
              {glyphOf(status, reconciling)}
              <span className="w-[2ch] shrink-0 text-right font-mono text-xs text-muted-foreground">
                {step.index}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  muted ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {step.description}
              </span>
              <span className="flex shrink-0 items-center justify-end text-sm tabular-nums">
                <AmountSlot plan={plan} step={step} status={status} />
              </span>
            </div>
            {detail === null ? null : (
              // Opacity-only appearance; the height change lands instantly — no expand
              // tween (T9: layout motion on a panel is banned).
              <div className="transition-fast px-3 pb-2 pl-9">{detail}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
