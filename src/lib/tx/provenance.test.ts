import { describe, expect, it } from "vitest";
import { buildPlan, type PlanSuccess } from "../../core/plan";
import { provenanceTrailText, valueOf } from "../../core/provenance";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import { SANDBOX_OUTPUT_TOLERANCE, toleranceWeiFor } from "../execution/tolerance";
import type { ReceiptRef } from "../execution/types";
import {
  attributedProvenance,
  chainHfProvenance,
  divergenceDeltaProvenance,
  mechanismLabel,
  predictedHfProvenance,
  predictedOutputProvenance,
  residualAllowanceProvenance,
  resolvedAmountProvenance,
  toleranceConstantsProvenance,
  toleranceProvenance,
} from "./provenance";

const plan: PlanSuccess = (() => {
  const built = buildPlan(flagshipGraph(), fixtureSnapshot());
  if (!built.ok) throw new Error("flagship plan failed to build");
  return built;
})();

const receipt: ReceiptRef = {
  txHash: `0x${"ab".repeat(32)}`,
  blockNumber: 23_000_007n,
  blockHash: `0x${"cd".repeat(32)}`,
  gasUsed: 210_000n,
};

describe("mechanismLabel", () => {
  it("uses T10's tooltip vocabulary verbatim", () => {
    expect(mechanismLabel("share-delta")).toBe("share delta");
    expect(mechanismLabel("transfer-event")).toBe("Transfer event");
    expect(mechanismLabel("withdraw-argument")).toBe("withdraw argument");
  });
});

describe("attributedProvenance", () => {
  it("names the mechanism in the trail's first line and cites tx + block", () => {
    const wrapped = attributedProvenance(123n, "share-delta", receipt);
    expect(valueOf(wrapped)).toBe(123n);
    const trail = provenanceTrailText(wrapped);
    expect(trail[0]).toContain("share delta");
    expect(trail[0]).toContain(receipt.txHash);
    expect(trail[0]).toContain("23000007");
  });
});

describe("resolved / chain-read / residual wrappers", () => {
  it("each cites the receipt that pins the read", () => {
    for (const wrapped of [
      resolvedAmountProvenance(5n, receipt),
      chainHfProvenance(2n * 10n ** 18n, receipt),
      residualAllowanceProvenance(1n, receipt),
    ]) {
      expect(provenanceTrailText(wrapped).join("\n")).toContain(receipt.txHash);
    }
  });
});

describe("toleranceProvenance", () => {
  it("RECOMPUTES the bound from the prediction wrapper and the named constants", () => {
    const producing = plan.flows.find((flow) => flow.outputWei !== null);
    if (producing === undefined || producing.outputWei === null) throw new Error("fixture");
    const predicted = producing.outputWei;
    const wrapped = toleranceProvenance(predicted, SANDBOX_OUTPUT_TOLERANCE);
    // The trail derives what it claims: the value IS the formula over these inputs.
    expect(valueOf(wrapped)).toBe(toleranceWeiFor(predicted.value, SANDBOX_OUTPUT_TOLERANCE));
    expect(wrapped.inputs).toContain(predicted);
    const trail = provenanceTrailText(wrapped).join("\n");
    expect(trail).toContain("SANDBOX_OUTPUT_TOLERANCE.absWei");
    expect(trail).toContain("SANDBOX_OUTPUT_TOLERANCE.relPow");
    expect(trail).toContain("src/lib/execution/tolerance.ts");
  });

  it("exposes the constants themselves as Configured for the review's bounds line", () => {
    const bounds = toleranceConstantsProvenance(SANDBOX_OUTPUT_TOLERANCE);
    expect(bounds.absWei.kind).toBe("configured");
    expect(valueOf(bounds.absWei)).toBe(2n);
    expect(valueOf(bounds.relPow)).toBe(10n ** 6n);
  });
});

describe("predictedOutputProvenance", () => {
  it("returns the plan's OWN flows wrapper when the value matches (§6.2 one-source)", () => {
    const producing = plan.steps.findIndex((step) => {
      const flow = plan.flows.find((candidate) => candidate.blockId === step.blockId);
      return flow !== undefined && flow.outputWei !== null;
    });
    expect(producing).toBeGreaterThanOrEqual(0);
    const step = plan.steps[producing];
    if (step === undefined) throw new Error("fixture");
    const flow = plan.flows.find((candidate) => candidate.blockId === step.blockId);
    if (flow === undefined || flow.outputWei === null) throw new Error("fixture");
    const wrapped = predictedOutputProvenance(plan, producing, flow.outputWei.value);
    expect(wrapped).toBe(flow.outputWei);
  });

  it("refuses a wire prediction the plan cannot vouch for — null, never a fallback figure", () => {
    expect(predictedOutputProvenance(plan, 0, 999_999n)).toBeNull();
  });

  it("refuses an index outside the plan", () => {
    expect(predictedOutputProvenance(plan, 99, 1n)).toBeNull();
  });
});

describe("divergenceDeltaProvenance (Codex fix 4)", () => {
  it("derives the signed delta over BOTH source wrappers with the trail intact", () => {
    const producing = plan.steps.findIndex((step) => {
      const flow = plan.flows.find((candidate) => candidate.blockId === step.blockId);
      return flow !== undefined && flow.outputWei !== null;
    });
    const step = plan.steps[producing];
    if (step === undefined) throw new Error("fixture");
    const flow = plan.flows.find((candidate) => candidate.blockId === step.blockId);
    if (flow === undefined || flow.outputWei === null) throw new Error("fixture");
    const predicted = flow.outputWei;
    const attributed = attributedProvenance(
      predicted.value + 7n,
      "transfer-event",
      receipt,
    );
    const delta = divergenceDeltaProvenance(predicted, attributed);
    expect(valueOf(delta)).toBe(7n);
    expect(delta.inputs).toContain(predicted);
    expect(delta.inputs).toContain(attributed);
    const trail = provenanceTrailText(delta).join("\n");
    expect(trail).toContain("attributed − predicted");
    expect(trail).toContain(receipt.txHash);
  });
});

describe("predictedHfProvenance", () => {
  it("cites the plan's risk walk as the prediction home", () => {
    const wrapped = predictedHfProvenance(2n * 10n ** 18n);
    expect(valueOf(wrapped)).toBe(2n * 10n ** 18n);
    expect(provenanceTrailText(wrapped).join("\n")).toContain("risk walk");
  });
});
