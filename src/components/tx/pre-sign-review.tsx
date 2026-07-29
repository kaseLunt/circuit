"use client";

/**
 * The pre-execute review — sandbox's pre-sign surface (T12–T13 adapted: SPEC §6 skips
 * `awaiting-signature` in sandbox, so the review happens ONCE, before the run commits).
 * In-column, above the step list, never a modal; the card appears via opacity only.
 *
 * Two zones per step, both always rendered, no accordion (T13), every fact read from
 * the SAME `PlanSuccess` reference the machine executes (T33 — no describing strings):
 *  1. Consequence — the step's own sentence from the plan, the block's flow row
 *     (`inputAsset/inputWei → outputAsset/outputWei`) through the P2 SourcedValue
 *     machinery unchanged, and for risk-changing steps the ledger checkpoint's
 *     "After this step: HF x.xx" — warning band takes `text-warning`, the only chroma
 *     this card may ever show.
 *  2. Call — the calldata's own facts in mono: the target's FULL address, the function
 *     name, the args from `step.args` with the amount slot spec-or-resolved honestly
 *     ("bound to the attributed output of step {j}" until resolved).
 *
 * Above the steps: the run-level facts — step count, input, the simulation's block +
 * age (T29 — no TTL countdown; the age recomposes per machine transition, it never
 * ticks), the named attribution bounds, and the session TTL as prose. The Execute
 * button is the screen's ONE terminal commit (T3a, primary variant).
 */
import { formatDuration, formatHealthFactor, formatToken, formatUnits } from "../../core/format";
import { riskState, type HealthFactor } from "../../core/health-factor";
import type { PlanSuccess, TransactionStep } from "../../core/plan";
import type { RiskCheckpoint } from "../../core/risk";
import type { OutputTolerance } from "../../lib/execution/tolerance";
import type { SessionFacts } from "../../lib/tx/driver";
import { predictedHfProvenance, toleranceConstantsProvenance } from "../../lib/tx/provenance";
import { SourcedValue, slotClassName, type SlotRamp } from "../shared/sourced-value";
import { plannedAmountOf } from "./step-status";
import { TransactionButton } from "./transaction-button";

const ROW_RAMP: SlotRamp = { resolved: "text-sm", size: "text-sm" };
const CONTEXT_RAMP: SlotRamp = {
  resolved: "text-xs text-muted-foreground",
  size: "text-xs",
};
/** T13: the warning band is the only chroma this card may ever show. */
const WARN_RAMP: SlotRamp = { resolved: "text-xs text-warning", size: "text-xs" };

export interface PreSignReviewProps {
  /** The frozen plan the machine holds — the same reference, never a describing string (T33). */
  readonly plan: PlanSuccess;
  /** The plan-build actor (`snapshot.user.address`) — names the actor slot in signatures. */
  readonly planActor: string;
  readonly tolerance: OutputTolerance;
  /** The frozen plan's own risk walk, pinned at arm alongside the plan (§0: one prediction home). */
  readonly checkpoints: readonly RiskCheckpoint[] | null;
  readonly session: SessionFacts | null;
  /** The block the simulation is pinned to, and when the plan was built (display-only). */
  readonly simulatedAtBlock: bigint;
  readonly plannedAtMs: number | null;
  readonly nowMs: number;
  readonly onExecute: () => void;
  readonly executeGateReason: string | null;
}

/**
 * Value args are identifiers and codes (addresses, enums); the money quantity renders
 * on its own line through SourcedValue, never inline in the signature. The plan-build
 * actor gets the same slot grammar as `amount` (taste verdict finding 1): the sandbox
 * sentinel address would read as a bug or a fake, so the slot names WHAT it is and the
 * line below states what it binds to.
 */
function argTextOf(step: TransactionStep, planActor: string): string {
  const actor = planActor.toLowerCase();
  return step.args
    .map((arg) => {
      if (arg.kind === "amount") return "amount";
      if (typeof arg.value === "string" && arg.value.toLowerCase() === actor) return "actor";
      return String(arg.value);
    })
    .join(", ");
}

function stepTouchesActor(step: TransactionStep, planActor: string): boolean {
  const actor = planActor.toLowerCase();
  return step.args.some(
    (arg) =>
      arg.kind === "value" && typeof arg.value === "string" && arg.value.toLowerCase() === actor,
  );
}

function AmountLine({ plan, step }: { readonly plan: PlanSuccess; readonly step: TransactionStep }) {
  const planned = plannedAmountOf(plan, step);
  if (planned.kind === "none") return null;
  if (planned.kind === "bound") {
    return (
      <p className="text-xs text-muted-foreground">
        {`amount: bound to the attributed output of step ${planned.producerStepNumber}`}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {"amount: "}
      <SourcedValue
        value={planned.amount}
        pending={false}
        label={`Step ${step.index} amount`}
        chars={12}
        format={(value) => formatToken(value, 4)}
        unavailableReason="unavailable"
        inline
        provenance="disclosure"
        className={slotClassName(true, false, CONTEXT_RAMP)}
      />
    </p>
  );
}

function FlowLine({ plan, step }: { readonly plan: PlanSuccess; readonly step: TransactionStep }) {
  const flow = plan.flows.find((candidate) => candidate.blockId === step.blockId);
  if (flow === undefined) return null;
  const input = flow.inputAsset !== null && flow.inputWei !== null;
  const output = flow.outputAsset !== null && flow.outputWei !== null;
  if (!input && !output) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {input && flow.inputWei !== null ? (
        <>
          {`${flow.inputAsset} `}
          <SourcedValue
            value={flow.inputWei}
            pending={false}
            label={`${flow.inputAsset} in`}
            chars={12}
            format={(value) => formatToken(value, 4)}
            unavailableReason="unavailable"
            inline
            provenance="disclosure"
            className={slotClassName(true, false, CONTEXT_RAMP)}
          />
        </>
      ) : null}
      {input && output ? " → " : null}
      {output && flow.outputWei !== null ? (
        <>
          {`${flow.outputAsset} `}
          <SourcedValue
            value={flow.outputWei}
            pending={false}
            label={`${flow.outputAsset} out`}
            chars={12}
            format={(value) => formatToken(value, 4)}
            unavailableReason="unavailable"
            inline
            provenance="disclosure"
            className={slotClassName(true, false, CONTEXT_RAMP)}
          />
        </>
      ) : null}
    </p>
  );
}

function RiskLine({
  step,
  checkpoint,
}: {
  readonly step: TransactionStep;
  readonly checkpoint: RiskCheckpoint;
}) {
  const hf: HealthFactor = checkpoint.healthFactor;
  if (hf.status === "no-debt") {
    return (
      <p className="text-xs text-muted-foreground">
        After this step: no debt — no liquidation risk.
      </p>
    );
  }
  if (hf.status === "unknown") {
    return (
      <p className="text-xs text-muted-foreground">
        {`After this step: health factor unavailable — ${hf.reason}.`}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {"After this step: HF "}
      <SourcedValue
        value={predictedHfProvenance(hf.hfWad)}
        pending={false}
        label={`Health factor after step ${step.index}`}
        chars={5}
        format={formatHealthFactor}
        unavailableReason="unavailable"
        inline
        provenance="disclosure"
        className={slotClassName(
          true,
          false,
          riskState(hf) === "warning" ? WARN_RAMP : CONTEXT_RAMP,
        )}
      />
    </p>
  );
}

function StepReview({
  plan,
  step,
  planActor,
  showFlow,
  checkpoint,
}: {
  readonly plan: PlanSuccess;
  readonly step: TransactionStep;
  readonly planActor: string;
  readonly showFlow: boolean;
  readonly checkpoint: RiskCheckpoint | null;
}) {
  return (
    <li className="border-t border-border pt-2 first:border-t-0 first:pt-0">
      <p className="text-xs text-foreground">{`${step.index}. ${step.description}`}</p>
      {showFlow ? <FlowLine plan={plan} step={step} /> : null}
      <p className="mt-0.5 break-all font-mono text-label text-muted-foreground">{step.to}</p>
      <p className="break-all font-mono text-xs text-muted-foreground">
        {`${step.functionName}(${argTextOf(step, planActor)})`}
      </p>
      <AmountLine plan={plan} step={step} />
      {stepTouchesActor(step, planActor) ? (
        <p className="text-xs text-muted-foreground">
          actor: bound to the session account at execution
        </p>
      ) : null}
      {checkpoint === null ? null : <RiskLine step={step} checkpoint={checkpoint} />}
    </li>
  );
}

export function PreSignReview({
  plan,
  planActor,
  tolerance,
  checkpoints,
  session,
  simulatedAtBlock,
  plannedAtMs,
  nowMs,
  onExecute,
  executeGateReason,
}: PreSignReviewProps) {
  const inputStep = plan.steps[0];
  const inputAmount =
    inputStep !== undefined && inputStep.amount.kind === "literal"
      ? inputStep.amount.amount
      : null;
  const bounds = toleranceConstantsProvenance(tolerance);
  const ageSeconds =
    plannedAtMs === null ? null : Math.max(0, Math.round((nowMs - plannedAtMs) / 1000));
  const seenBlocks = new Set<string>();

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-sm font-medium text-foreground">
        {`Execute ${plan.steps.length} steps on the session fork`}
      </p>

      <div className="mt-2 space-y-1">
        {inputAmount === null ? null : (
          <p className="text-xs text-muted-foreground">
            {"Input: "}
            <SourcedValue
              value={inputAmount}
              pending={false}
              label="Input amount"
              chars={12}
              format={(value) => `${formatToken(value, 4)} ETH`}
              unavailableReason="unavailable"
              inline
              provenance="disclosure"
              className={slotClassName(true, false, ROW_RAMP)}
            />
          </p>
        )}
        <p className="text-xs tabular-nums text-muted-foreground">
          {"Simulated at block "}
          <span className="font-mono text-xs">{`${simulatedAtBlock}`}</span>
          {ageSeconds === null ? "" : ` · ${formatDuration(ageSeconds)} ago`}
        </p>
        {/* Operand groups are no-break spans (taste verdict finding 4): the formula
            wraps at prose boundaries only — never "max(" dangling at a line end. */}
        <p className="text-xs text-muted-foreground">
          {"Each measured output must land within "}
          <span className="whitespace-nowrap">
            {"± max("}
            <SourcedValue
              value={bounds.absWei}
              pending={false}
              label="Tolerance absolute floor"
              chars={1}
              format={(value) => `${formatUnits(value, 0, 0)} wei`}
              unavailableReason="unavailable"
              inline
              provenance="disclosure"
              className={slotClassName(true, false, CONTEXT_RAMP)}
            />
            {","}
          </span>{" "}
          <span className="whitespace-nowrap">
            {"predicted ÷ "}
            <SourcedValue
              value={bounds.relPow}
              pending={false}
              label="Tolerance relative divisor"
              chars={9}
              format={(value) => formatUnits(value, 0, 0)}
              unavailableReason="unavailable"
              inline
              provenance="disclosure"
              className={slotClassName(true, false, CONTEXT_RAMP)}
            />
            {")"}
          </span>
          {" of its prediction, or execution halts."}
        </p>
        {session === null ? null : (
          <p className="text-xs text-muted-foreground">
            {`This session expires ${formatDuration(
              Math.round((session.expiresAtMs - session.createdAtMs) / 1000),
            )} after creation. Expiry lands as a designed state; the executed record survives it.`}
          </p>
        )}
      </div>

      <p className="mt-3 text-label uppercase tracking-wider text-muted-foreground">Steps</p>
      <ol aria-label="Planned calls" className="mt-1 space-y-2">
        {plan.steps.map((step) => {
          const showFlow = !seenBlocks.has(step.blockId);
          seenBlocks.add(step.blockId);
          const checkpoint =
            checkpoints === null
              ? null
              : (checkpoints.find(
                  (candidate) =>
                    candidate.blockId === step.blockId && candidate.cause === step.functionName,
                ) ?? null);
          return (
            <StepReview
              key={step.id}
              plan={plan}
              step={step}
              planActor={planActor}
              showFlow={showFlow}
              checkpoint={checkpoint}
            />
          );
        })}
      </ol>

      {session === null ? null : (
        <div className="mt-3 border-t border-border pt-3 font-mono text-xs text-muted-foreground">
          <p className="break-all">{`actor ${session.actor}`}</p>
          <p className="break-all tabular-nums">
            {`fork base block ${session.baseBlock} · ${session.baseBlockHash}`}
          </p>
        </div>
      )}

      <div className="mt-4">
        <TransactionButton variant="primary" onClick={onExecute} gateReason={executeGateReason}>
          Execute
        </TransactionButton>
      </div>
    </div>
  );
}
