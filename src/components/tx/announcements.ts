/**
 * The execution narrator's grammar (T31/T32/T32a): one sentence per machine TRANSITION,
 * never per rendered value — the S-2b lesson is law here. The ExecutionFlow container
 * owns the single `aria-live` region; this module owns what it says.
 *
 * The constraint that shapes every sentence (T32a): an announcement states only what is
 * known at the moment it speaks, and classification precedes any final claim. An unmined
 * transaction is never announced as failed; a replacement is never announced as final
 * until classified; a halt names the disagreement, not a loss.
 *
 * The four rev 3.1/3.2 recovery states T32 does not enumerate get sentences in the same
 * voice, composed under the same constraint (judgment call 8): each states the confirmed
 * truth and the open question, and none claims failure — the transaction did not fail.
 */
import type { ExecutionMachine } from "../../lib/execution/machine";
import type { ExecutionPhase } from "../../lib/execution/types";

/** Announcement identity: same key, same event — the region only speaks on a key change. */
export function announcementKeyOf(phase: ExecutionPhase): string {
  const step = "stepIndex" in phase ? `:${phase.stepIndex}` : "";
  const tx = phase.kind === "pending" && phase.txHash !== null ? `:${phase.txHash}` : "";
  return `${phase.kind}${step}${tx}`;
}

const human = (stepIndex: number): number => stepIndex + 1;

function titleOf(machine: ExecutionMachine, stepIndex: number): string {
  const step = machine.plan?.steps[stepIndex];
  return step === undefined ? `step ${human(stepIndex)}` : step.description;
}

function stepCountOf(machine: ExecutionMachine, plannedStepCount: number | null): number | null {
  return machine.plan?.steps.length ?? plannedStepCount;
}

function pendingSentence(
  machine: ExecutionMachine,
  phase: Extract<ExecutionPhase, { kind: "pending" }>,
  previous: ExecutionPhase | null,
  count: number | null,
): string {
  const k = phase.stepIndex;
  const of = count === null ? "" : ` of ${count}`;
  if (previous !== null) {
    if (previous.kind === "awaiting-signature" && previous.stepIndex === k) {
      return `Step ${human(k)} submitted.`;
    }
    if (previous.kind === "timeout" && previous.stepIndex === k) {
      return `Still watching step ${human(k)}.`;
    }
    if (previous.kind === "pending" && previous.stepIndex === k) {
      return `Step ${human(k)}'s transaction was replaced by a repriced copy — watching the new transaction.`;
    }
    if (previous.kind === "dispatch-vacated" && previous.stepIndex === k) {
      return `Step ${human(k)}${of}: sent again.`;
    }
    if (
      (previous.kind === "attributed" || previous.kind === "attributing") &&
      previous.stepIndex === k - 1
    ) {
      return `Step ${human(k - 1)} confirmed. Step ${human(k)}${of}: ${titleOf(machine, k)}.`;
    }
  }
  return `Executing — step ${human(k)}${of}: ${titleOf(machine, k)}.`;
}

function failedSentence(
  machine: ExecutionMachine,
  phase: Extract<ExecutionPhase, { kind: "failed-at" }>,
): string {
  const k = human(phase.stepIndex);
  switch (phase.cause) {
    case "user-rejected":
      return `Step ${k}: signature declined.`;
    case "timeout-gave-up":
      return `Stopped watching step ${k}; its transaction had not confirmed. Execution stopped.`;
    case "cancelled":
      return `Step ${k}'s transaction was replaced and did not execute. Execution stopped at step ${k}.`;
    case "reverted": {
      const decoded = machine.record?.failure?.decoded;
      return decoded === null || decoded === undefined
        ? `Step ${k} failed.`
        : `Step ${k} failed: ${decoded.message}.`;
    }
  }
}

function haltedSentence(phase: Extract<ExecutionPhase, { kind: "halted-divergent" }>): string {
  const k = human(phase.stepIndex);
  switch (phase.halt.kind) {
    case "output-divergence":
      return `Execution halted: step ${k}'s output differs from the prediction. Nothing further was sent.`;
    case "hf-disagreement":
      return `Execution halted: step ${k}'s health-factor reading differs from the prediction. Nothing further was sent.`;
    case "residual-allowance":
      return `Execution halted: step ${k} left a residual allowance. Nothing further was sent.`;
  }
}

function abandonedSentence(phase: Extract<ExecutionPhase, { kind: "abandoned" }>): string {
  const j = phase.executedSteps;
  if (j === 0) return "Session expired: no steps were executed.";
  if (j === 1) return "Session expired: step 1 was executed.";
  return `Session expired: steps 1 to ${j} were executed.`;
}

/**
 * The sentence for the machine's current phase, given the phase it arrived from.
 * Empty string = the region stays silent (idle, and the coalesced-away intermediates).
 */
export function announcementOf(
  machine: ExecutionMachine,
  previous: ExecutionPhase | null,
  plannedStepCount: number | null,
): string {
  const phase = machine.phase;
  const count = stepCountOf(machine, plannedStepCount);
  switch (phase.kind) {
    case "idle":
      return "";
    case "simulating":
      return count === null ? "Simulation started." : `Simulation started: ${count} steps.`;
    case "ready":
      return count === null ? "Simulation complete." : `Simulation complete: ${count} steps.`;
    case "awaiting-signature":
      return `Step ${human(phase.stepIndex)}${count === null ? "" : ` of ${count}`}: signature requested in your wallet.`;
    case "pending":
      return pendingSentence(machine, phase, previous, count);
    case "timeout":
      return `Step ${human(phase.stepIndex)} has not confirmed within the expected time. It may still land.`;
    case "attributing":
    case "attributed":
      // Coalesced (T32): the step-advance sentence speaks at the NEXT step's dispatch,
      // and the final confirmation speaks at `complete`.
      return "";
    case "complete":
      return count === null
        ? "Execution complete."
        : `Execution complete: ${count} steps confirmed.`;
    case "failed-at":
      return failedSentence(machine, phase);
    case "halted-divergent":
      return haltedSentence(phase);
    case "halted-wallet-changed":
      return "Execution halted: the connected wallet changed. Nothing further was sent.";
    case "abandoned":
      return abandonedSentence(phase);
    case "attribution-unavailable":
      return `Step ${human(phase.stepIndex)} confirmed; its measured output is not yet recorded. Reconciling.`;
    case "persistence-failed":
      return `Step ${human(phase.stepIndex)} confirmed; its record did not persist. Reconciling.`;
    case "dispatch-unresolved":
      return `Step ${human(phase.stepIndex)}'s dispatch outcome is unknown. Reconciling against the chain.`;
    case "dispatch-vacated":
      return `Step ${human(phase.stepIndex)}'s transaction never landed. It can be sent again.`;
  }
}
