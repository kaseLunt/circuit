import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { BlockFlow, PlanSuccess, TransactionStep } from "../../core/plan";
import { SANDBOX_OUTPUT_TOLERANCE, toleranceWeiFor } from "./tolerance";
import type { HaltFact, ReceiptRef, SandboxStepResult } from "./types";
import {
  haltClaimMismatch,
  outputClaimMismatch,
  stepResultClaimMismatch,
} from "./output-claims";

const WAD = 10n ** 18n;
const PREDICTED = 10n * WAD;
const TOL = SANDBOX_OUTPUT_TOLERANCE;
const BOUND = toleranceWeiFor(PREDICTED, TOL);
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const configured = (value: bigint) => ({
  kind: "configured" as const,
  value,
  name: "test-figure",
  definedAt: "output-claims.test.ts",
});

function step(id: string, index: number, blockId: string): TransactionStep {
  return {
    id,
    index,
    blockId,
    description: `step ${id}`,
    to: `0x${"aa".repeat(20)}` as Hex,
    abi: [],
    functionName: "deposit",
    args: [],
    valueSpec: "none",
    amount: { kind: "none" },
  };
}

const flow = (blockId: string): BlockFlow => ({
  blockId,
  type: "stake",
  inputAsset: "ETH",
  inputWei: null,
  outputAsset: "eETH",
  outputWei: configured(PREDICTED),
  reserve: null,
});

/** b1 deliberately has NO flow — the flow-missing arm's fixture. */
const plan: PlanSuccess = {
  ok: true,
  steps: [step("s0", 0, "b0"), step("s1", 1, "b1")],
  targetEModeCategoryId: null,
  flows: [flow("b0")],
};

const receipt: ReceiptRef = {
  txHash: hash(0x51),
  blockNumber: 123n,
  blockHash: hash(0xb),
  gasUsed: null,
};

const claim = (over: Partial<Parameters<typeof outputClaimMismatch>[2]> = {}) => ({
  stepIndex: 0,
  predictedWei: PREDICTED,
  attributedWei: PREDICTED,
  toleranceWei: BOUND,
  arrivedAs: "attributed" as const,
  ...over,
});

function attributedResult(over: Partial<{ attributedWei: bigint; toleranceWei: bigint }> = {}): SandboxStepResult {
  return {
    status: "attributed",
    stepIndex: 0,
    stepId: "s0",
    receipt,
    resolvedAmountWei: null,
    sharesDelta: null,
    output: {
      mechanism: "share-delta",
      predictedWei: PREDICTED,
      attributedWei: over.attributedWei ?? PREDICTED,
      toleranceWei: over.toleranceWei ?? BOUND,
    },
    approval: null,
    consumedApproval: null,
    risk: null,
  };
}

const divergenceHalt = (attributedWei: bigint | null): HaltFact => ({
  kind: "output-divergence",
  stepIndex: 0,
  stepId: "s0",
  mechanism: "share-delta",
  predictedWei: PREDICTED,
  attributedWei,
  toleranceWei: BOUND,
  detail: null,
  receipt,
});

describe("outputClaimMismatch — every refusal arm discriminates", () => {
  it("accepts a claim the plan can recompute exactly", () => {
    expect(outputClaimMismatch(plan, TOL, claim())).toBeNull();
    expect(
      outputClaimMismatch(plan, TOL, claim({ attributedWei: 3n * PREDICTED, arrivedAs: "halted" })),
    ).toBeNull();
  });

  it("refuses a step index the plan does not have", () => {
    expect(outputClaimMismatch(plan, TOL, claim({ stepIndex: 9 }))).toContain(
      "which the plan does not have",
    );
  });

  it("refuses an output claim on a step whose flows carry none", () => {
    expect(outputClaimMismatch(plan, TOL, claim({ stepIndex: 1 }))).toContain(
      "the plan's flows do not",
    );
  });

  it("refuses a prediction that is not the flows wrapper's figure", () => {
    expect(outputClaimMismatch(plan, TOL, claim({ predictedWei: PREDICTED + 1n }))).toContain(
      "disagrees with the plan's flows wrapper",
    );
  });

  it("refuses a tolerance that is not the recomputed bound", () => {
    expect(outputClaimMismatch(plan, TOL, claim({ toleranceWei: BOUND + 1n }))).toContain(
      "disagrees with the machine's recomputed bound",
    );
  });

  it("refuses classifications that disagree with the numbers, both directions", () => {
    expect(
      outputClaimMismatch(plan, TOL, claim({ attributedWei: 3n * PREDICTED })),
    ).toContain("outside the machine's bound but arrived as attributed");
    expect(
      outputClaimMismatch(plan, TOL, claim({ arrivedAs: "halted" })),
    ).toContain("within the machine's bound but arrived as a halt");
  });

  it("skips only the classification arm when attribution itself refused (null figure)", () => {
    expect(
      outputClaimMismatch(plan, TOL, claim({ attributedWei: null, arrivedAs: "halted" })),
    ).toBeNull();
    expect(
      outputClaimMismatch(plan, TOL, claim({ attributedWei: null, toleranceWei: BOUND + 1n })),
    ).toContain("recomputed bound");
  });
});

describe("haltClaimMismatch", () => {
  it("validates output-divergence halts and passes the other halt kinds through", () => {
    expect(haltClaimMismatch(plan, TOL, divergenceHalt(3n * PREDICTED))).toBeNull();
    expect(haltClaimMismatch(plan, TOL, divergenceHalt(PREDICTED))).toContain(
      "within the machine's bound",
    );
    expect(
      haltClaimMismatch(plan, TOL, {
        kind: "residual-allowance",
        stepIndex: 0,
        stepId: "s0",
        spender: `0x${"bb".repeat(20)}` as Hex,
        residualAllowanceWei: 5n,
        receipt,
      }),
    ).toBeNull();
  });
});

describe("stepResultClaimMismatch", () => {
  it("passes results that carry no output claims, and a null plan", () => {
    expect(stepResultClaimMismatch(null, TOL, attributedResult())).toBeNull();
    expect(
      stepResultClaimMismatch(plan, TOL, {
        ...attributedResult(),
        output: null,
      } as SandboxStepResult),
    ).toBeNull();
    expect(
      stepResultClaimMismatch(plan, TOL, {
        status: "dispatch-vacated",
        stepIndex: 0,
        stepId: "s0",
      }),
    ).toBeNull();
  });

  it("routes attributed and halted results through the claim gate", () => {
    expect(stepResultClaimMismatch(plan, TOL, attributedResult())).toBeNull();
    expect(
      stepResultClaimMismatch(plan, TOL, attributedResult({ toleranceWei: BOUND + 1n })),
    ).toContain("recomputed bound");
    expect(
      stepResultClaimMismatch(plan, TOL, {
        status: "halted",
        stepIndex: 0,
        stepId: "s0",
        receipt,
        resolvedAmountWei: null,
        sharesDelta: null,
        halt: divergenceHalt(PREDICTED),
      }),
    ).toContain("within the machine's bound");
  });
});
