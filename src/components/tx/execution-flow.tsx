"use client";

/**
 * The execution column — the tx family's container. The run's single `aria-live`
 * narrator lives one level UP, in the ExecutionHost (T31's one-region invariant kept,
 * moved so it survives the flow unmounting on an arming refusal — a fault must be
 * announced even when the machine returns to idle; Codex W07 finding 6). This
 * component mounts NO live region; `faultAnnouncementOf` is the narrator's sentence
 * source for transport faults.
 *
 * Every machine phase renders here in a designed state; the driver's transport ledger
 * (fault/busy) renders through the designed-stop grammar (T27) beside — never over —
 * the machine's own truth. Terminal receipts are still: no banner, no motion beyond the
 * section's opacity (T23 — the weight of the moment comes from completeness and
 * stillness).
 */
import { AlertTriangle, Check, Clock, Info, Wallet } from "lucide-react";
import {
  formatDuration,
  formatHealthFactor,
  formatWadAsPercent,
  formatWadRatio,
} from "../../core/format";
import { hfWadValue, type HealthFactor } from "../../core/health-factor";
import type { PlanSuccess } from "../../core/plan";
import type { RiskCheckpoint } from "../../core/risk";
import type { SimulationResult } from "../../lib/strategy/types";
import type { ExecutionPhase, SettledStepFact } from "../../lib/execution/types";
import type { DriverFault, DriverSnapshot } from "../../lib/tx/driver";
import { chainHfProvenance } from "../../lib/tx/provenance";
import { SourcedValue, slotClassName, type SlotRamp } from "../shared/sourced-value";
import { PreSignReview } from "./pre-sign-review";
import { StepList } from "./step-list";
import { StopCard } from "./stop-card";

const HERO_RAMP: SlotRamp = {
  resolved: "text-2xl font-semibold text-foreground",
  size: "text-2xl",
};
const ROW_RAMP: SlotRamp = { resolved: "text-sm", size: "text-sm" };
const CONTEXT_RAMP: SlotRamp = {
  resolved: "text-xs text-muted-foreground",
  size: "text-xs",
};

export interface ExecutionFlowProps {
  readonly plan: PlanSuccess;
  /** The plan-build actor, for the review's actor-slot grammar (taste finding 1). */
  readonly planActor: string;
  readonly snapshot: DriverSnapshot;
  /** The run-pinned simulation, for the T23 receipt's PREDICTED column (Codex fix 1). */
  readonly simulation: SimulationResult | null;
  /** The run-pinned risk walk for the pre-execute review's per-step lines (T13). */
  readonly checkpoints: readonly RiskCheckpoint[] | null;
  readonly simulatedAtBlock: bigint;
  readonly nowMs: number;
  readonly onExecute: () => void;
  /** Re-arm: reset (or recreate) the session and re-simulate — every card's recovery. */
  readonly onRearm: () => void;
  /** Resume the action the current fault names (driver.retry). */
  readonly onRetryFault: () => void;
}

function faultCopy(fault: DriverFault): { title: string; explanation: string } {
  if (fault.kind === "refusal") {
    switch (fault.refusal.kind) {
      case "at-capacity":
        return {
          title: "The sandbox is at capacity.",
          explanation:
            "Sessions are capped so each gets an isolated fork. Try again shortly.",
        };
      case "session-busy":
        return {
          title: "Another call is in flight for this session.",
          explanation:
            "One call at a time holds the session; the previous one has not returned.",
        };
      case "rate-limited":
        return {
          title: "Rate limited.",
          explanation: `The session's rate floor refused this call. Try again in about ${formatDuration(
            Math.ceil(fault.refusal.retryAfterMs / 1000),
          )}.`,
        };
      case "tx-cap":
        return {
          title: "This session reached its transaction cap.",
          explanation:
            "Each session gets a bounded number of transactions on its fork. Re-simulating starts a fresh run.",
        };
      case "plan-changed":
        return {
          title: "The server holds a different plan.",
          explanation:
            "The session's recorded plan no longer matches this run. Re-simulate to rebuild both sides from the document.",
        };
      case "out-of-order":
        return {
          title: `The session expects step ${fault.refusal.expectedIndex + 1}.`,
          explanation:
            "The client and server disagree about the next step. Reloading session state re-reads the server's record.",
        };
      default:
        return {
          title: `The sandbox refused: ${fault.refusal.kind}.`,
          explanation: "The refusal is a designed state, not an error — see the session's record.",
        };
    }
  }
  if (fault.kind === "transport-failed") {
    return {
      title: "The sandbox service did not answer.",
      explanation: `The call may still have executed server-side; recovery re-reads the server's record rather than assuming. (${fault.detail})`,
    };
  }
  if (fault.kind === "wire-mismatch") {
    return {
      title: "The server answered in a shape this build cannot read.",
      explanation: `Likely version skew between client and server. Nothing was guessed at: the response was refused. (${fault.detail})`,
    };
  }
  if (fault.kind === "plan-mismatch") {
    return {
      title: "The server built a different plan.",
      explanation: `The two sides' plans must agree step for step before anything executes. (${fault.detail})`,
    };
  }
  return {
    title: "The client and server disagree about this run.",
    explanation: `A transition was refused rather than absorbed. Reloading session state re-reads the server's record. (${fault.detail})`,
  };
}

function retryLabelOf(fault: DriverFault): string {
  switch (fault.retry) {
    case "arm":
      return "Retry";
    case "run":
      return "Retry";
    case "reload":
      return "Reload session state";
  }
}

/** The narrator's sentence for a transport fault — title + mechanism, one voice (T31). */
export function faultAnnouncementOf(fault: DriverFault): string {
  const copy = faultCopy(fault);
  return `${copy.title} ${copy.explanation}`;
}

export function FaultCard({
  fault,
  onRetryFault,
  busyReason,
}: {
  readonly fault: DriverFault;
  readonly onRetryFault: () => void;
  readonly busyReason: string | null;
}) {
  const copy = faultCopy(fault);
  return (
    <StopCard
      icon={fault.kind === "refusal" ? Info : AlertTriangle}
      title={copy.title}
      explanation={copy.explanation}
      action={{ label: retryLabelOf(fault), onAct: onRetryFault, gateReason: busyReason }}
    />
  );
}

const formatHf = (hf: HealthFactor): string => formatHealthFactor(hfWadValue(hf));

/** The last §5.4 chain reading in the executed record — the receipt's CHAIN column. */
function lastChainRisk(settled: readonly SettledStepFact[]): SettledStepFact | null {
  for (let i = settled.length - 1; i >= 0; i -= 1) {
    const entry = settled[i];
    if (entry !== undefined && entry.risk !== null) return entry;
  }
  return null;
}

function CompleteReceipt({
  plan,
  snapshot,
  simulation,
}: {
  readonly plan: PlanSuccess;
  readonly snapshot: DriverSnapshot;
  readonly simulation: SimulationResult | null;
}) {
  const settled = snapshot.machine.record?.settled ?? [];
  const chainRisk = lastChainRisk(settled);
  return (
    <section aria-labelledby="execution-complete-heading" className="transition-fast pb-4">
      <p
        id="execution-complete-heading"
        className="flex items-center gap-2 text-sm font-medium text-foreground"
      >
        <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-success" />
        Execution complete
      </p>
      <div className="mt-2 space-y-2">
        <div>
          <p className="text-label uppercase tracking-wider text-muted-foreground">
            Net APY · current-rate run-rate, one iteration
          </p>
          {simulation === null ? (
            <p className="text-xs text-muted-foreground">
              summary unavailable — the simulation is no longer on screen
            </p>
          ) : (
            <SourcedValue
              value={simulation.netApyWad}
              pending={false}
              label="Net APY"
              chars={8}
              format={formatWadAsPercent}
              unavailableReason="net APY unavailable — a rate did not resolve"
              className={slotClassName(simulation.netApyWad !== null, false, HERO_RAMP)}
            />
          )}
        </div>
        <div>
          <p className="text-label uppercase tracking-wider text-muted-foreground">
            Final health factor
          </p>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span>
              <span className="block text-label uppercase tracking-wider text-muted-foreground">
                Chain
              </span>
              {chainRisk === null || chainRisk.risk === null ? (
                <span className="text-xs text-muted-foreground">
                  no chain reading in the record
                </span>
              ) : (
                <SourcedValue
                  value={chainHfProvenance(chainRisk.risk.chainHfWad, chainRisk.receipt)}
                  pending={false}
                  label="Final health factor, chain reading"
                  chars={5}
                  format={formatHealthFactor}
                  unavailableReason="unavailable"
                  className={slotClassName(true, false, HERO_RAMP)}
                />
              )}
            </span>
            <span>
              <span className="block text-label uppercase tracking-wider text-muted-foreground">
                Predicted
              </span>
              {simulation === null ? (
                <span className="text-xs text-muted-foreground">unavailable</span>
              ) : (
                <SourcedValue
                  value={simulation.finalHealthFactor}
                  pending={false}
                  label="Final health factor, predicted"
                  chars={5}
                  format={formatHf}
                  unavailableReason="unavailable"
                  className={slotClassName(true, false, ROW_RAMP)}
                />
              )}
            </span>
          </div>
        </div>
        {simulation === null ? null : (
          <p className="text-xs text-muted-foreground">
            {"Liquidates when the collateral/debt oracle ratio reaches "}
            <SourcedValue
              value={simulation.liquidationRatioWad}
              pending={false}
              label="Liquidation ratio"
              chars={7}
              format={formatWadRatio}
              unavailableReason="ratio unavailable"
              inline
              className={slotClassName(simulation.liquidationRatioWad !== null, false, CONTEXT_RAMP)}
            />
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {`${plan.steps.length} steps confirmed on the session fork — a forked-mainnet demo, not proof of live behavior.`}
        </p>
      </div>
    </section>
  );
}

/** Step counter for the header: the machine names the step, the plan names the total. */
function counterOf(phase: ExecutionPhase, stepCount: number): string | null {
  if ("stepIndex" in phase) return `step ${phase.stepIndex + 1} of ${stepCount}`;
  if (phase.kind === "complete") return `${stepCount} of ${stepCount}`;
  return null;
}

export function ExecutionFlow({
  plan,
  planActor,
  snapshot,
  simulation,
  checkpoints,
  simulatedAtBlock,
  nowMs,
  onExecute,
  onRearm,
  onRetryFault,
}: ExecutionFlowProps) {
  const { machine, busy, fault, session, plannedAtMs } = snapshot;
  const phase = machine.phase;

  const busyReason = busy === null ? null : "A sandbox call is in flight.";
  const pastReady = phase.kind !== "idle" && phase.kind !== "simulating" && phase.kind !== "ready";
  const counter = counterOf(phase, plan.steps.length);
  const recover = (label: string) => ({ label, onAct: onRearm, gateReason: busyReason });

  if (phase.kind === "idle") return null;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-label uppercase tracking-wider text-muted-foreground">Execution</p>
          {counter === null ? null : (
            <p className="text-label tabular-nums uppercase tracking-wider text-muted-foreground">
              {counter}
            </p>
          )}
          {pastReady ? (
            <p className="text-label uppercase tracking-wider text-muted-foreground">
              No signatures in sandbox
            </p>
          ) : null}
        </div>
        {pastReady && plannedAtMs !== null ? (
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">
            {"Simulated at block "}
            <span className="font-mono text-xs">{`${simulatedAtBlock}`}</span>
            {` · ${formatDuration(Math.max(0, Math.round((nowMs - plannedAtMs) / 1000)))} ago`}
          </p>
        ) : null}
      </div>

      {fault === null ? null : (
        <FaultCard fault={fault} onRetryFault={onRetryFault} busyReason={busyReason} />
      )}

      {phase.kind === "simulating" ? (
        <p className="text-xs text-muted-foreground">
          Preparing the session fork and building the plan…
        </p>
      ) : null}

      {phase.kind === "ready" ? (
        <PreSignReview
          plan={plan}
          planActor={planActor}
          tolerance={machine.tolerance}
          checkpoints={checkpoints}
          session={session}
          simulatedAtBlock={simulatedAtBlock}
          plannedAtMs={plannedAtMs}
          nowMs={nowMs}
          onExecute={onExecute}
          executeGateReason={busyReason}
        />
      ) : null}

      {phase.kind === "complete" ? (
        <CompleteReceipt plan={plan} snapshot={snapshot} simulation={simulation} />
      ) : null}

      {phase.kind === "timeout" ? (
        <StopCard
          icon={Clock}
          title={`Step ${phase.stepIndex + 1} has not confirmed within the expected time.`}
          explanation="It may still land — the chain has not spoken, so nothing here claims it failed."
        />
      ) : null}

      {phase.kind === "halted-wallet-changed" ? (
        <StopCard
          tone="halted"
          icon={Wallet}
          title="Execution halted — the connected wallet changed."
          explanation="Signing from a different account would split the position across two owners. Nothing further was sent."
          action={recover("Re-simulate")}
        />
      ) : null}

      <StepList
        plan={plan}
        machine={machine}
        reconciling={busy === "execute" || busy === "reconcile"}
        recover={recover(
          phase.kind === "halted-divergent" ? "Reset session & re-simulate" : "Re-simulate",
        )}
      />

      {phase.kind === "abandoned" ? (
        <StopCard
          icon={Clock}
          title="This session expired."
          explanation={
            phase.executedSteps === 0
              ? "It expired before any step executed. Sessions are time-bounded so each fork is reclaimed."
              : `Steps 1–${phase.executedSteps} executed on its fork before expiry. The record above is read-only — facts survive their session.`
          }
          action={recover("Start a fresh session")}
        />
      ) : null}
    </div>
  );
}
