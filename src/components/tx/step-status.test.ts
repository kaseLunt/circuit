import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { buildPlan, type PlanSuccess } from "../../core/plan";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import { wireAttributed } from "../../../tests/helpers/sandbox-transport";
import {
  createExecutionMachine,
  reduce,
  stepRequirementsOf,
  type ExecutionMachine,
} from "../../lib/execution/machine";
import { SANDBOX_OUTPUT_TOLERANCE } from "../../lib/execution/tolerance";
import { stepResultFactOf } from "../../lib/execution/resume";
import type { ExecutionEvent, SandboxStepResult } from "../../lib/execution/types";
import {
  approveConsumerOf,
  approveSpenderAddressOf,
  executingBlockIdOf,
  plannedAmountOf,
  stepRowStatusOf,
} from "./step-status";

const PLAN_HASH = `0x${"cd".repeat(32)}` as Hex;

const plan: PlanSuccess = (() => {
  const built = buildPlan(flagshipGraph(), fixtureSnapshot());
  if (!built.ok) throw new Error("flagship plan failed to build");
  return built;
})();

const NULL_FACTS = { nonce: null, resolvedAmountWei: null, approval: null, beforeShares: null };

function ok(machine: ExecutionMachine, event: ExecutionEvent): ExecutionMachine {
  const result = reduce(machine, event);
  if (result.refusal !== null) throw new Error(`refused: ${result.refusal.kind}`);
  return result.machine;
}

function attributedResult(index: number): SandboxStepResult {
  const parsed = stepResultFactOf(wireAttributed(plan, index));
  if (!parsed.ok) throw new Error("wire fixture failed to parse");
  return parsed.value;
}

function readyMachine(): ExecutionMachine {
  let machine = createExecutionMachine({ mode: "sandbox" });
  machine = ok(machine, { type: "simulate" });
  return ok(machine, { type: "plan-ready", plan, planHash: PLAN_HASH, address: null });
}

function settledThrough(count: number): ExecutionMachine {
  let machine = readyMachine();
  for (let index = 0; index < count; index += 1) {
    machine = ok(machine, index === 0 ? { type: "execute", facts: NULL_FACTS } : { type: "advance", facts: NULL_FACTS });
    machine = ok(machine, { type: "step-result", result: attributedResult(index) });
  }
  return machine;
}

describe("stepRowStatusOf", () => {
  it("marks every row queued at ready", () => {
    const machine = readyMachine();
    for (let index = 0; index < plan.steps.length; index += 1) {
      expect(stepRowStatusOf(machine, index).kind).toBe("queued");
    }
  });

  it("gives the settled prefix its record entries and the active row its spinner state", () => {
    let machine = settledThrough(2);
    machine = ok(machine, { type: "advance", facts: NULL_FACTS });
    expect(stepRowStatusOf(machine, 0).kind).toBe("settled");
    expect(stepRowStatusOf(machine, 1).kind).toBe("settled");
    expect(stepRowStatusOf(machine, 2)).toMatchObject({ kind: "active", txHash: null });
    expect(stepRowStatusOf(machine, 3).kind).toBe("queued");
  });

  it("the settled arm carries the receipt-bearing record entry, never a boolean (T5)", () => {
    const machine = settledThrough(1);
    const status = stepRowStatusOf(machine, 0);
    if (status.kind !== "settled") throw new Error("expected settled");
    expect(status.settled.receipt.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("renders the T20 trichotomy after a failure: prefix settled, step failed, suffix not-sent", () => {
    let machine = settledThrough(2);
    machine = ok(machine, { type: "advance", facts: NULL_FACTS });
    const step = plan.steps[2];
    if (step === undefined) throw new Error("fixture");
    machine = ok(machine, {
      type: "step-result",
      result: {
        status: "failed",
        failure: {
          stepIndex: 2,
          stepId: step.id,
          txHash: `0x${"11".repeat(32)}` as Hex,
          decoded: null,
          raw: null,
        },
      },
    });
    expect(stepRowStatusOf(machine, 1).kind).toBe("settled");
    expect(stepRowStatusOf(machine, 2).kind).toBe("failed");
    expect(stepRowStatusOf(machine, 3).kind).toBe("not-sent");
    expect(stepRowStatusOf(machine, plan.steps.length - 1).kind).toBe("not-sent");
  });

  it("abandoned: executed-but-unevidenced rows are recovery, the rest not-sent", () => {
    let machine = settledThrough(2);
    machine = ok(machine, { type: "session-lost", executedSteps: 3 });
    expect(stepRowStatusOf(machine, 0).kind).toBe("settled");
    expect(stepRowStatusOf(machine, 2)).toMatchObject({ kind: "recovery", receipt: null });
    expect(stepRowStatusOf(machine, 3).kind).toBe("not-sent");
  });
});

describe("plannedAmountOf", () => {
  it("the input step's literal amount is a provenanced figure", () => {
    const step = plan.steps[0];
    if (step === undefined) throw new Error("fixture");
    const planned = plannedAmountOf(plan, step);
    expect(planned.kind).toBe("figure");
  });

  it("a step-output amount states which step it is bound to, by 1-based number", () => {
    const approve = plan.steps.find((step) => step.functionName === "approve");
    if (approve === undefined) throw new Error("fixture");
    const planned = plannedAmountOf(plan, approve);
    if (planned.kind !== "bound") throw new Error("expected bound");
    expect(planned.producerStepNumber).toBeGreaterThanOrEqual(1);
    const producer = plan.steps.find((step) => step.index === planned.producerStepNumber);
    expect(producer).toBeDefined();
  });
});

describe("approve pair readers", () => {
  it("finds the consumer by amount-spec reference identity (D1/D4)", () => {
    const approve = plan.steps.find((step) => step.functionName === "approve");
    if (approve === undefined) throw new Error("fixture");
    const consumer = approveConsumerOf(plan, approve);
    expect(consumer).not.toBeNull();
    expect(consumer?.amount).toBe(approve.amount);
    const spender = approveSpenderAddressOf(approve);
    expect(spender).toMatch(/^0x/);
    // The machine's own classifier agrees about the pair — one relation, two readers.
    if (consumer === null) throw new Error("unreachable");
    expect(stepRequirementsOf(plan, consumer).consumesApprovalFrom).not.toBeNull();
  });

  it("returns null for non-approve steps", () => {
    const step = plan.steps[0];
    if (step === undefined) throw new Error("fixture");
    expect(approveConsumerOf(plan, step)).toBeNull();
  });
});

describe("stepRowStatusOf — remaining grammar states", () => {
  it("idle machines mark every row queued", () => {
    const idle = createExecutionMachine({ mode: "sandbox" });
    expect(stepRowStatusOf(idle, 0).kind).toBe("queued");
  });

  it("live awaiting-signature and timeout map to their own arms", () => {
    let machine = createExecutionMachine({ mode: "live", tolerance: SANDBOX_OUTPUT_TOLERANCE });
    machine = ok(machine, { type: "simulate" });
    machine = ok(machine, {
      type: "plan-ready",
      plan,
      planHash: PLAN_HASH,
      address: `0x${"aa".repeat(20)}` as Hex,
    });
    machine = ok(machine, { type: "execute", facts: { ...NULL_FACTS, nonce: 1n } });
    expect(stepRowStatusOf(machine, 0).kind).toBe("awaiting-signature");
    machine = ok(machine, { type: "signed", txHash: `0x${"11".repeat(32)}` as Hex });
    expect(stepRowStatusOf(machine, 0)).toMatchObject({
      kind: "active",
      txHash: `0x${"11".repeat(32)}`,
    });
    machine = ok(machine, { type: "tx-timeout" });
    expect(stepRowStatusOf(machine, 0).kind).toBe("timeout");
  });

  it("dispatch-unresolved and dispatch-vacated map to recovery and vacated", () => {
    let machine = settledThrough(1);
    machine = ok(machine, { type: "advance", facts: NULL_FACTS });
    const step = plan.steps[1];
    if (step === undefined) throw new Error("fixture");
    const unresolved = ok(machine, {
      type: "step-result",
      result: { status: "dispatch-unresolved", stepIndex: 1, stepId: step.id, txHash: null },
    });
    expect(stepRowStatusOf(unresolved, 1)).toMatchObject({ kind: "recovery", receipt: null });
    const vacated = ok(machine, {
      type: "step-result",
      result: { status: "dispatch-vacated", stepIndex: 1, stepId: step.id },
    });
    expect(stepRowStatusOf(vacated, 1).kind).toBe("vacated");
  });

  it("the abandoned recovery fact renders its own interrupted arm", () => {
    const base = settledThrough(2);
    const step = plan.steps[2];
    if (step === undefined) throw new Error("fixture");
    const machine: ExecutionMachine = {
      ...base,
      phase: {
        kind: "abandoned",
        executedSteps: 3,
        recovery: {
          kind: "attribution-pending",
          stepIndex: 2,
          stepId: step.id,
          receipt: {
            txHash: `0x${"22".repeat(32)}` as Hex,
            blockNumber: 5n,
            blockHash: `0x${"33".repeat(32)}` as Hex,
            gasUsed: null,
          },
          resolvedAmountWei: null,
          beforeShares: null,
          sharesDelta: null,
        },
      },
    };
    expect(stepRowStatusOf(machine, 2).kind).toBe("interrupted");
    expect(stepRowStatusOf(machine, 3).kind).toBe("not-sent");
  });
});

describe("plannedAmountOf — no-amount steps", () => {
  it("a none-spec step has no amount to show, and that is not an unavailable state", () => {
    const none = plan.steps.find((step) => step.amount.kind === "none");
    if (none === undefined) throw new Error("fixture: expected a none-spec step");
    expect(plannedAmountOf(plan, none).kind).toBe("none");
  });
});

describe("approveSpenderAddressOf — non-approve shapes", () => {
  it("returns null when the first argument is not an address value", () => {
    const none = plan.steps.find((step) => step.amount.kind === "none");
    if (none === undefined) throw new Error("fixture");
    expect(approveSpenderAddressOf({ ...none, args: [] })).toBeNull();
  });
});

describe("executingBlockIdOf — the T26 frame appears during executing(k) and only then", () => {
  it("maps the in-flight step to its block and every other phase to null", () => {
    expect(executingBlockIdOf(createExecutionMachine({ mode: "sandbox" }))).toBeNull();
    const ready = readyMachine();
    expect(executingBlockIdOf(ready)).toBeNull();
    const pending = ok(ready, { type: "execute", facts: NULL_FACTS });
    if (pending.phase.kind !== "pending") throw new Error("fixture");
    const activeBlock = plan.steps[0]?.blockId;
    expect(executingBlockIdOf(pending)).toBe(activeBlock);
    const settled = ok(pending, { type: "step-result", result: attributedResult(0) });
    expect(executingBlockIdOf(settled)).toBeNull();
    const advanced = ok(settled, { type: "advance", facts: NULL_FACTS });
    expect(executingBlockIdOf(advanced)).toBe(plan.steps[1]?.blockId);
  });

  it("keeps the frame through the live watch states and drops it at the halt family", () => {
    let live = createExecutionMachine({ mode: "live", tolerance: SANDBOX_OUTPUT_TOLERANCE });
    live = ok(live, { type: "simulate" });
    live = ok(live, {
      type: "plan-ready",
      plan,
      planHash: PLAN_HASH,
      address: `0x${"aa".repeat(20)}` as Hex,
    });
    live = ok(live, { type: "execute", facts: { ...NULL_FACTS, nonce: 1n } });
    expect(executingBlockIdOf(live)).toBe(plan.steps[0]?.blockId);
    live = ok(live, { type: "signed", txHash: `0x${"11".repeat(32)}` as Hex });
    expect(executingBlockIdOf(live)).toBe(plan.steps[0]?.blockId);
    const timedOut = ok(live, { type: "tx-timeout" });
    expect(executingBlockIdOf(timedOut)).toBe(plan.steps[0]?.blockId);
    const halted = ok(live, { type: "wallet-changed" });
    expect(executingBlockIdOf(halted)).toBeNull();
  });
});

