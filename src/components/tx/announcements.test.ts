import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { buildPlan, type PlanSuccess } from "../../core/plan";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import { wireAttributed } from "../../../tests/helpers/sandbox-transport";
import { receiptMinter } from "../../lib/execution/attribution";
import { SANDBOX_OUTPUT_TOLERANCE } from "../../lib/execution/tolerance";
import {
  createExecutionMachine,
  reduce,
  type ExecutionMachine,
} from "../../lib/execution/machine";
import { stepResultFactOf } from "../../lib/execution/resume";
import type { ExecutionEvent } from "../../lib/execution/types";
import { announcementKeyOf, announcementOf } from "./announcements";

const PLAN_HASH = `0x${"cd".repeat(32)}` as Hex;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const plan: PlanSuccess = (() => {
  const built = buildPlan(flagshipGraph(), fixtureSnapshot());
  if (!built.ok) throw new Error("flagship plan failed to build");
  return built;
})();

const N = plan.steps.length;
const NULL_FACTS = { nonce: null, resolvedAmountWei: null, approval: null, beforeShares: null };

function ok(machine: ExecutionMachine, event: ExecutionEvent): ExecutionMachine {
  const result = reduce(machine, event);
  if (result.refusal !== null) throw new Error(`refused: ${result.refusal.kind}`);
  return result.machine;
}

function simulating(): ExecutionMachine {
  return ok(createExecutionMachine({ mode: "sandbox" }), { type: "simulate" });
}

function ready(): ExecutionMachine {
  return ok(simulating(), { type: "plan-ready", plan, planHash: PLAN_HASH, address: null });
}

function settled(machine: ExecutionMachine, index: number): ExecutionMachine {
  const parsed = stepResultFactOf(wireAttributed(plan, index));
  if (!parsed.ok) throw new Error("wire fixture failed to parse");
  return ok(machine, { type: "step-result", result: parsed.value });
}

function liveReady(): ExecutionMachine {
  let machine = createExecutionMachine({ mode: "live", tolerance: SANDBOX_OUTPUT_TOLERANCE });
  machine = ok(machine, { type: "simulate" });
  return ok(machine, {
    type: "plan-ready",
    plan,
    planHash: PLAN_HASH,
    address: `0x${"aa".repeat(20)}` as Hex,
  });
}

describe("announcementOf — the T32 grammar", () => {
  it("announces simulation start with the known step count (T32a.1)", () => {
    expect(announcementOf(simulating(), null, N)).toBe(`Simulation started: ${N} steps.`);
    expect(announcementOf(simulating(), null, null)).toBe("Simulation started.");
  });

  it("announces ready as simulation complete", () => {
    expect(announcementOf(ready(), null, null)).toBe(`Simulation complete: ${N} steps.`);
  });

  it("announces the run start with step 1's title", () => {
    const machine = ok(ready(), { type: "execute", facts: NULL_FACTS });
    const title = plan.steps[0]?.description ?? "";
    expect(announcementOf(machine, ready().phase, null)).toBe(
      `Executing — step 1 of ${N}: ${title}.`,
    );
  });

  it("coalesces a step advance into one sentence (confirmed + next)", () => {
    let machine = ok(ready(), { type: "execute", facts: NULL_FACTS });
    machine = settled(machine, 0);
    const attributedPhase = machine.phase;
    machine = ok(machine, { type: "advance", facts: NULL_FACTS });
    const title = plan.steps[1]?.description ?? "";
    expect(announcementOf(machine, attributedPhase, null)).toBe(
      `Step 1 confirmed. Step 2 of ${N}: ${title}.`,
    );
  });

  it("stays silent at attributed and attributing (coalesced away)", () => {
    let machine = ok(ready(), { type: "execute", facts: NULL_FACTS });
    machine = settled(machine, 0);
    expect(announcementOf(machine, null, null)).toBe("");
  });

  it("announces completion with the count", () => {
    let machine = ok(ready(), { type: "execute", facts: NULL_FACTS });
    machine = settled(machine, 0);
    for (let index = 1; index < N; index += 1) {
      machine = ok(machine, { type: "advance", facts: NULL_FACTS });
      machine = settled(machine, index);
    }
    expect(machine.phase.kind).toBe("complete");
    expect(announcementOf(machine, null, null)).toBe(`Execution complete: ${N} steps confirmed.`);
  });

  it("halt sentences state the disagreement and the stop, never a loss (T32)", () => {
    let machine = ok(ready(), { type: "execute", facts: NULL_FACTS });
    const step = plan.steps[0];
    if (step === undefined) throw new Error("fixture");
    const base = wireAttributed(plan, 0);
    if (base.status !== "attributed") throw new Error("fixture");
    const parsed = stepResultFactOf({
      status: "halted",
      stepIndex: 0,
      stepId: step.id,
      receipt: base.receipt,
      resolvedAmountWei: null,
      sharesDelta: null,
      halt: {
        kind: "output-divergence",
        stepIndex: 0,
        stepId: step.id,
        mechanism: "share-delta",
        predictedWei: "100",
        attributedWei: "500",
        toleranceWei: "2",
        detail: null,
        receipt: base.receipt,
      },
    });
    if (!parsed.ok) throw new Error("fixture");
    machine = ok(machine, { type: "step-result", result: parsed.value });
    expect(announcementOf(machine, null, null)).toBe(
      "Execution halted: step 1's output differs from the prediction. Nothing further was sent.",
    );
  });

  it("abandoned states the executed count honestly at 0, 1, and many", () => {
    const at = (executedSteps: number) =>
      announcementOf(
        ok(ready(), { type: "session-lost", executedSteps }),
        null,
        null,
      );
    expect(at(0)).toBe("Session expired: no steps were executed.");
    expect(at(1)).toBe("Session expired: step 1 was executed.");
    expect(at(4)).toBe("Session expired: steps 1 to 4 were executed.");
  });

  it("failure sentences discriminate by cause and never misclaim finality (T32a)", () => {
    let machine = ok(liveReady(), { type: "execute", facts: { ...NULL_FACTS, nonce: 1n } });
    const awaiting = machine.phase;
    machine = ok(machine, { type: "user-rejected" });
    expect(announcementOf(machine, awaiting, null)).toBe("Step 1: signature declined.");

    let watched = ok(liveReady(), { type: "execute", facts: { ...NULL_FACTS, nonce: 1n } });
    watched = ok(watched, { type: "signed", txHash: hash(1) });
    watched = ok(watched, { type: "tx-timeout" });
    expect(announcementOf(watched, null, null)).toBe(
      "Step 1 has not confirmed within the expected time. It may still land.",
    );
    const timeoutPhase = watched.phase;
    const kept = ok(watched, { type: "keep-waiting" });
    expect(announcementOf(kept, timeoutPhase, null)).toBe("Still watching step 1.");
    const gaveUp = ok(watched, { type: "give-up" });
    expect(announcementOf(gaveUp, timeoutPhase, null)).toBe(
      "Stopped watching step 1; its transaction had not confirmed. Execution stopped.",
    );
  });

  it("classified replacements speak per classification; a repriced copy stays pending", () => {
    let machine = ok(liveReady(), { type: "execute", facts: { ...NULL_FACTS, nonce: 1n } });
    machine = ok(machine, { type: "signed", txHash: hash(1) });
    const pendingPhase = machine.phase;
    const repriced = ok(machine, {
      type: "tx-replaced",
      classification: "repriced",
      replacedHash: hash(1),
      replacementHash: hash(2),
    });
    expect(announcementOf(repriced, pendingPhase, null)).toBe(
      "Step 1's transaction was replaced by a repriced copy — watching the new transaction.",
    );
    const superseded = ok(machine, {
      type: "tx-replaced",
      classification: "superseded",
      replacedHash: hash(1),
      replacementHash: hash(3),
    });
    expect(announcementOf(superseded, pendingPhase, null)).toBe(
      "Step 1's transaction was replaced and did not execute. Execution stopped at step 1.",
    );
  });

  it("the reconcile-family states speak both truths without claiming failure (§8a)", () => {
    let machine = ok(liveReady(), { type: "execute", facts: { ...NULL_FACTS, nonce: 1n } });
    machine = ok(machine, { type: "signed", txHash: hash(1) });
    const minter = receiptMinter("test-rpc");
    const receipt = minter.confirm({
      status: 1n,
      txHash: hash(1),
      blockNumber: 123n,
      blockHash: hash(0xb),
      logs: [],
    });
    machine = ok(machine, { type: "tx-confirmed", receipt });
    const unavailable = ok(machine, { type: "attribution-unavailable", beforeShares: 7n });
    expect(announcementOf(unavailable, null, null)).toBe(
      "Step 1 confirmed; its measured output is not yet recorded. Reconciling.",
    );
    const persistence = ok(machine, {
      type: "persistence-failed",
      measurement: { status: "measured", beforeShares: 7n, sharesDelta: 3n },
    });
    expect(announcementOf(persistence, null, null)).toBe(
      "Step 1 confirmed; its record did not persist. Reconciling.",
    );
  });
});

describe("announcementKeyOf", () => {
  it("keys on phase kind, step, and the watched hash — a repriced watch re-keys", () => {
    const idle = createExecutionMachine({ mode: "sandbox" });
    expect(announcementKeyOf(idle.phase)).toBe("idle");
    let machine = ok(liveReady(), { type: "execute", facts: { ...NULL_FACTS, nonce: 1n } });
    machine = ok(machine, { type: "signed", txHash: hash(1) });
    const before = announcementKeyOf(machine.phase);
    const replaced = ok(machine, {
      type: "tx-replaced",
      classification: "repriced",
      replacedHash: hash(1),
      replacementHash: hash(2),
    });
    expect(announcementKeyOf(replaced.phase)).not.toBe(before);
  });
});

describe("the halted family speaks with one voice (T18/T32a.4)", () => {
  const receipt = {
    txHash: hash(0xa),
    blockNumber: 123n,
    blockHash: hash(0xb),
    gasUsed: null,
  };

  function machineWithPhase(phase: ExecutionMachine["phase"]): ExecutionMachine {
    return { ...ready(), phase };
  }

  it("hf-disagreement and residual-allowance open and close like output divergence", () => {
    const hf = machineWithPhase({
      kind: "halted-divergent",
      stepIndex: 4,
      halt: {
        kind: "hf-disagreement",
        stepIndex: 4,
        stepId: "s",
        expected: { status: "healthy", hfWad: 2n * 10n ** 18n },
        chainHfWad: 10n ** 18n,
        receipt,
      },
    });
    expect(announcementOf(hf, null, null)).toBe(
      "Execution halted: step 5's health-factor reading differs from the prediction. Nothing further was sent.",
    );
    const residual = machineWithPhase({
      kind: "halted-divergent",
      stepIndex: 4,
      halt: {
        kind: "residual-allowance",
        stepIndex: 4,
        stepId: "s",
        spender: `0x${"aa".repeat(20)}`,
        residualAllowanceWei: 5n,
        receipt,
      },
    });
    expect(announcementOf(residual, null, null)).toBe(
      "Execution halted: step 5 left a residual allowance. Nothing further was sent.",
    );
    const wallet = machineWithPhase({ kind: "halted-wallet-changed" });
    expect(announcementOf(wallet, null, null)).toBe(
      "Execution halted: the connected wallet changed. Nothing further was sent.",
    );
  });

  it("the dispatch pair states what discovery knows and nothing more", () => {
    const unresolved = machineWithPhase({
      kind: "dispatch-unresolved",
      stepIndex: 2,
      txHash: null,
    });
    expect(announcementOf(unresolved, null, null)).toBe(
      "Step 3's dispatch outcome is unknown. Reconciling against the chain.",
    );
    const vacated = machineWithPhase({ kind: "dispatch-vacated", stepIndex: 2 });
    expect(announcementOf(vacated, null, null)).toBe(
      "Step 3's transaction never landed. It can be sent again.",
    );
    const resent = machineWithPhase({ kind: "pending", stepIndex: 2, txHash: null });
    expect(announcementOf(resent, vacated.phase, null)).toBe(`Step 3 of ${N}: sent again.`);
  });

  it("awaiting-signature names the step and the wallet", () => {
    const machine = ok(liveReady(), { type: "execute", facts: { ...NULL_FACTS, nonce: 1n } });
    expect(announcementOf(machine, null, null)).toBe(
      `Step 1 of ${N}: signature requested in your wallet.`,
    );
  });

  it("idle stays silent", () => {
    expect(announcementOf(createExecutionMachine({ mode: "sandbox" }), null, null)).toBe("");
  });
});

