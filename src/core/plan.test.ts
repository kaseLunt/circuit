import { describe, expect, it } from "vitest";
import { decodeFunctionData, toFunctionSelector } from "viem";
import type { StrategyGraph } from "./graph";
import { observedBlocks, provenanceTrail } from "./provenance";
import {
  buildPlan,
  encodeStep,
  type PlanError,
  type PlanResult,
  type TransactionStep,
} from "./plan";
import {
  PINNED_BLOCK,
} from "../../tests/helpers/protocol-reads";
import {
  CANONICAL_STEPS,
  EXPECTED_BORROW_WEI,
  WAD_WEI,
  chainOf,
  flagshipGraph,
} from "../../tests/helpers/graphs";
import { FIXTURE_USER as USER, canonicalStepAddresses, fixtureSnapshot } from "../../tests/helpers/chain-snapshot";

// ————————————————————————— pinned expectations —————————————————————————

// Real weETH supply-cap boundary for the flagship at b=7000 (v3.7 formula over
// the recorded scaled values; crossing block is supply2 — the cumulative check):
const CAP_BOUNDARY_E_PASS = "27860.88917679683996625";
const CAP_BOUNDARY_E_FAIL = "27860.889176796839966251";

// WETH borrow-cap boundary for the flagship borrow (existing scaled debt plus
// rayDivCeil(borrowWei) at the accrued index, rayMulCeil display, ceil tokens):
const BORROW_CAP_MIN_PASSING = 1686984n;

// ————————————————————————— helpers —————————————————————————

function expectOk(result: PlanResult): asserts result is Extract<PlanResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`plan unexpectedly failed: ${JSON.stringify(result.errors, bigintJson, 2)}`);
  }
}

function expectFail(result: PlanResult): asserts result is Extract<PlanResult, { ok: false }> {
  if (result.ok) throw new Error("plan unexpectedly succeeded");
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function constraintErrors(errors: readonly PlanError[]) {
  return errors.filter(
    (e): e is Extract<PlanError, { kind: "constraint" }> => e.kind === "constraint",
  );
}

function stepById(steps: readonly TransactionStep[], id: string): TransactionStep {
  const hit = steps.find((s) => s.id === id);
  if (!hit) throw new Error(`step ${id} not found`);
  return hit;
}

function selectorOfStep(step: TransactionStep): string {
  const item = step.abi.find((e) => e.type === "function" && e.name === step.functionName);
  if (!item || item.type !== "function") throw new Error(`abi item missing for ${step.id}`);
  return toFunctionSelector(item);
}

// ————————————————————————— tests —————————————————————————

describe("buildPlan — flagship 13-step canonical fixture (SPEC §2)", () => {
  const snapshot = fixtureSnapshot();
  const addresses = canonicalStepAddresses();

  it("emits exactly the 13 enumerated steps in canonical order", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.steps).toHaveLength(13);
    expect(result.targetEModeCategoryId).toBe(1);
    for (const row of CANONICAL_STEPS) {
      const step = result.steps[row.index - 1]!;
      expect(step.index, row.id).toBe(row.index);
      expect(step.id, row.id).toBe(row.id);
      expect(step.blockId, row.id).toBe(row.blockId);
      expect(step.to, row.id).toBe(addresses[row.to]);
      expect(step.functionName, row.id).toBe(row.functionName);
      expect(step.valueSpec, row.id).toBe(row.valueSpec);
      expect(selectorOfStep(step), row.id).toBe(toFunctionSelector(row.signature));
      const amount = step.amount;
      if (row.amount.kind === "literal") {
        if (amount.kind !== "literal") throw new Error(`${row.id}: expected literal amount`);
        expect(amount.amount.kind).toBe("entered");
        expect(amount.amount.value).toBe(row.amount.wei);
      } else if (row.amount.kind === "step-output") {
        if (amount.kind !== "step-output") throw new Error(`${row.id}: expected step-output`);
        expect(amount.producerStepId, row.id).toBe(row.amount.producer);
        expect(amount.attribution, row.id).toBe(row.amount.attribution);
        expect(amount.allocationBps, row.id).toBe(10_000);
      } else {
        expect(amount.kind, row.id).toBe(row.amount.kind);
      }
    }
  });

  it("derives the borrow amount with floor-at-every-division bigint math", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    const borrow = stepById(result.steps, "borrow:borrow");
    if (borrow.amount.kind !== "derived") throw new Error("borrow amount must be derived");
    expect(borrow.amount.amount.value).toBe(EXPECTED_BORROW_WEI);
    expect(borrow.amount.amount.expression).toMatch(/floor/);
    // Every observed leaf in the derivation sits at the pinned block.
    expect([...observedBlocks(borrow.amount.amount)]).toEqual([PINNED_BLOCK]);
    const trail = provenanceTrail(borrow.amount.amount).join("\n");
    expect(trail).toContain("Oracle.getAssetPrice(weETH)");
    expect(trail).toContain("Oracle.getAssetPrice(WETH)");
    expect(trail).toContain("entered by user");
  });

  it("orders every approval after its producer and binds it to the attributed output", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    for (const step of result.steps) {
      if (step.amount.kind !== "step-output") continue;
      const producer = stepById(result.steps, step.amount.producerStepId);
      expect(producer.index, step.id).toBeLessThan(step.index);
    }
  });

  it("encodes calldata whose selector and args round-trip through the ABI", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);

    const deposit = encodeStep(stepById(result.steps, "stake1:deposit"));
    expect(deposit.to).toBe(addresses.LP);
    expect(deposit.value).toBe(10n * WAD_WEI);
    expect(deposit.data).toBe(toFunctionSelector("function deposit()"));

    const approve = stepById(result.steps, "wrap1:approve");
    const approveEncoded = encodeStep(approve, 12_345n);
    const approveDecoded = decodeFunctionData({ abi: approve.abi, data: approveEncoded.data });
    expect(approveDecoded.functionName).toBe("approve");
    expect(approveDecoded.args).toEqual([addresses.weETH, 12_345n]);

    const supply = stepById(result.steps, "supply1:supply");
    const supplyEncoded = encodeStep(supply, 777n);
    const supplyDecoded = decodeFunctionData({ abi: supply.abi, data: supplyEncoded.data });
    expect(supplyDecoded.args).toEqual([addresses.weETH, 777n, USER, 0]);

    const borrow = stepById(result.steps, "borrow:borrow");
    const borrowEncoded = encodeStep(borrow);
    const borrowDecoded = decodeFunctionData({ abi: borrow.abi, data: borrowEncoded.data });
    expect(borrowDecoded.args).toEqual([addresses.WETH, EXPECTED_BORROW_WEI, 2n, 0, USER]);

    const emode = stepById(result.steps, "supply1:set-emode");
    const emodeDecoded = decodeFunctionData({ abi: emode.abi, data: encodeStep(emode).data });
    expect(emodeDecoded.args).toEqual([1]);

    const withdraw = stepById(result.steps, "unwrap:withdraw");
    const withdrawDecoded = decodeFunctionData({
      abi: withdraw.abi,
      data: encodeStep(withdraw, EXPECTED_BORROW_WEI).data,
    });
    expect(withdrawDecoded.args).toEqual([EXPECTED_BORROW_WEI]);
  });

  it("encodeStep demands a resolved amount exactly when the step's amount is attributed later", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(() => encodeStep(stepById(result.steps, "wrap1:approve"))).toThrow(/resolved/);
    expect(() => encodeStep(stepById(result.steps, "borrow:borrow"), 1n)).toThrow(/fixed/);
    expect(() => encodeStep(stepById(result.steps, "supply1:set-emode"), 1n)).toThrow(/fixed/);
  });

  it("never emits an address that is not in the snapshot — attacker params are inert", () => {
    const attacker = "0x6666666666666666666666666666666666666666";
    const g = flagshipGraph();
    // Keys chosen not to collide with real params (wrap/unwrap use `to`/`from`
    // semantically and graph.ts already rejects tampering with those).
    const poisoned: StrategyGraph = {
      blocks: g.blocks.map((b) => ({
        ...b,
        params: { ...b.params, spender: attacker, recipient: attacker, onBehalfOf: attacker },
      })),
      edges: g.edges,
    };
    const result = buildPlan(poisoned, snapshot);
    expectOk(result);
    const legal = new Set<string>([
      addresses.LP,
      addresses.eETH,
      addresses.weETH,
      addresses.WETH,
      addresses.pool,
    ]);
    for (const step of result.steps) {
      expect(legal.has(step.to), step.id).toBe(true);
      for (const arg of step.args) {
        if (arg.kind === "value" && typeof arg.value === "string") {
          expect(arg.value.toLowerCase()).not.toBe(attacker.toLowerCase());
        }
      }
    }
  });
});

describe("plan.flows — a recording of the pass that already ran, not a second derivation", () => {
  const snapshot = fixtureSnapshot();

  /**
   * The matrix §7 share model, recomputed here from the snapshot's own observations. These
   * are the intermediate values `tests/helpers/graphs.ts` documents above EXPECTED_BORROW_WEI;
   * deriving them rather than retyping them is what makes this an independent check.
   */
  function shareModel(inputWei: bigint) {
    const pooled = snapshot.etherfi.totalPooledEther.value;
    const shares = snapshot.etherfi.totalShares.value;
    const s1 = (inputWei * shares) / pooled;
    const pooledAfter = pooled + inputWei;
    const sharesAfter = shares + s1;
    const b1 = (s1 * pooledAfter) / sharesAfter;
    const w1 = (b1 * sharesAfter) / pooledAfter;
    return { s1, b1, w1 };
  }

  it("carries one flow per block in topological order, with the landed asset semantics", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.flows.map((f) => f.blockId)).toEqual([
      "in",
      "stake1",
      "wrap1",
      "supply1",
      "borrow",
      "unwrap",
      "stake2",
      "wrap2",
      "supply2",
    ]);
    const byId = new Map(result.flows.map((f) => [f.blockId, f] as const));
    const shape = (id: string) => {
      const f = byId.get(id)!;
      return [f.inputAsset, f.outputAsset, f.reserve];
    };
    // An input consumes nothing; a supply produces no consumable token; a borrow's producer
    // edge is a collateral dependency, not a token flow.
    expect(shape("in")).toEqual([null, "ETH", null]);
    expect(shape("stake1")).toEqual(["ETH", "eETH", null]);
    expect(shape("wrap1")).toEqual(["eETH", "weETH", null]);
    expect(shape("supply1")).toEqual(["weETH", null, "weETH"]);
    expect(shape("borrow")).toEqual([null, "WETH", "WETH"]);
    expect(shape("unwrap")).toEqual(["WETH", "ETH", null]);
  });

  it("reproduces the documented derivation chain exactly", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    const byId = new Map(result.flows.map((f) => [f.blockId, f] as const));
    const { b1, w1 } = shareModel(10n * WAD_WEI);

    expect(byId.get("in")!.outputWei!.value).toBe(10n * WAD_WEI);
    expect(byId.get("in")!.outputWei!.kind).toBe("entered");
    expect(byId.get("stake1")!.inputWei!.value).toBe(10n * WAD_WEI);
    expect(byId.get("stake1")!.outputWei!.value).toBe(b1);
    expect(byId.get("wrap1")!.inputWei!.value).toBe(b1);
    expect(byId.get("wrap1")!.outputWei!.value).toBe(w1);
    expect(byId.get("supply1")!.inputWei!.value).toBe(w1);
    expect(byId.get("supply1")!.outputWei).toBeNull();
    expect(byId.get("borrow")!.inputWei).toBeNull();
    expect(byId.get("borrow")!.outputWei!.value).toBe(EXPECTED_BORROW_WEI);
    // WETH→ETH is 1:1, so the unwrap hands its input straight on.
    expect(byId.get("unwrap")!.inputWei!.value).toBe(EXPECTED_BORROW_WEI);
    expect(byId.get("unwrap")!.outputWei!.value).toBe(EXPECTED_BORROW_WEI);
  });

  it("hands out the SAME wrapper the step carries — one object, so the two cannot drift", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    const borrowStep = stepById(result.steps, "borrow:borrow");
    if (borrowStep.amount.kind !== "derived") throw new Error("borrow amount must be derived");
    const borrowFlow = result.flows.find((f) => f.blockId === "borrow")!;
    // Reference identity, not value equality: this is what proves the flow is a RECORDING
    // of the calldata's own derivation rather than a parallel computation of the same number.
    expect(borrowFlow.outputWei).toBe(borrowStep.amount.amount);
    const unwrapFlow = result.flows.find((f) => f.blockId === "unwrap")!;
    expect(unwrapFlow.outputWei).toBe(unwrapFlow.inputWei);
  });

  /**
   * The input-funded step is the one place calldata could still be minted from a SECOND
   * computation: the amount is fixed at plan time, so nothing forces it through the
   * attribution path. It must carry the recorded wrapper by reference, at every allocation.
   */
  it("emits the first deposit from the recorded wrapper at FULL input allocation", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    const deposit = stepById(result.steps, "stake1:deposit");
    const flow = result.flows.find((f) => f.blockId === "stake1")!;
    // The whole input is the user's entered figure, so the spec is genuinely a literal.
    if (deposit.amount.kind !== "literal") throw new Error("expected a literal amount");
    expect(deposit.amount.amount).toBe(flow.inputWei);
    expect(deposit.amount.amount.kind).toBe("entered");
    expect(deposit.amount.amount.value).toBe(10n * WAD_WEI);
  });

  it("emits the first deposit from the recorded wrapper at PARTIAL input allocation", () => {
    const graph = flagshipGraph();
    const split: StrategyGraph = {
      blocks: graph.blocks,
      edges: graph.edges.map((e) =>
        e.source === "in" && e.target === "stake1" ? { ...e, allocationBps: 6_000 } : e,
      ),
    };
    const result = buildPlan(split, snapshot);
    expectOk(result);
    const deposit = stepById(result.steps, "stake1:deposit");
    const flow = result.flows.find((f) => f.blockId === "stake1")!;
    // A partial allocation is `floor(entered × bps / 1e4)` — a DERIVATION over the entered
    // figure, not the entered figure. Calling it a literal would claim the user typed it.
    if (deposit.amount.kind !== "derived") throw new Error("expected a derived amount");
    expect(deposit.amount.amount).toBe(flow.inputWei);
    expect(deposit.amount.amount.value).toBe((10n * WAD_WEI * 6_000n) / 10_000n);
    expect(provenanceTrail(deposit.amount.amount).join("\n")).toContain("entered by user");
    // Still a plan-time amount, so encodeStep refuses a resolved one.
    expect(() => encodeStep(deposit, 1n)).toThrow(/fixed/);
    expect(encodeStep(deposit).value).toBe(deposit.amount.amount.value);
  });

  it("keeps every flow's provenance pinned to the snapshot's block", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    for (const flow of result.flows) {
      for (const wrapper of [flow.inputWei, flow.outputWei]) {
        if (wrapper === null) continue;
        const blocks = [...observedBlocks(wrapper)];
        expect(blocks.length, flow.blockId).toBeLessThanOrEqual(1);
        for (const block of blocks) expect(block, flow.blockId).toBe(PINNED_BLOCK);
      }
    }
  });

  it("records a flow for every block of a plan with no Aave leg at all", () => {
    const result = buildPlan(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "s", type: "stake", params: { protocol: "etherfi" } },
      ]),
      snapshot,
    );
    expectOk(result);
    expect(result.flows.map((f) => f.blockId)).toEqual(["in", "s"]);
    expect(result.flows.every((f) => f.reserve === null)).toBe(true);
  });
});

describe("e-mode policy (SPEC §5.4, matrix §3)", () => {
  it("skips setUserEMode when the wallet is already in the target category", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.user.eModeCategoryId = 1;
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.targetEModeCategoryId).toBe(1);
    expect(result.steps).toHaveLength(12);
    expect(result.steps.some((s) => s.functionName === "setUserEMode")).toBe(false);
    expect(result.steps.map((s) => s.index)).toEqual(result.steps.map((_, i) => i + 1));
  });

  it("rejects a wallet parked in a category the snapshot does not describe", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.user.eModeCategoryId = 5;
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectFail(result);
    const hits = constraintErrors(result.errors).filter((e) => e.constraint === "emode-unknown-category");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.blockId).toBe("borrow");
  });

  // Active-category semantics per matrix §3, source-verified from
  // ValidationLogic.getUserReserveLtv. An active category cannot be exited in v1, so the plan
  // runs under it — but only an effective LTV of 0 makes the plan unexecutable.
  it("ACCEPTS out-of-bitmap collateral under a NON-isolated active category (reserve LTV applies)", () => {
    // The branch a bitmap-membership test gets wrong: outside the collateral bitmap with
    // isolated == false falls through to `reserveData.configuration.getLtv()` (weETH 7750),
    // so the flagship borrow remains valid and must NOT be rejected.
    const snapshot = fixtureSnapshot((raw) => {
      raw.user.eModeCategoryId = raw.eModes[0]!.id;
      raw.eModes[0]!.isIsolated = false;
      raw.eModes[0]!.collateralBitmap &= ~(1n << BigInt(raw.weETH.reserveIndex));
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.targetEModeCategoryId).toBe(1);
  });

  it("rejects out-of-bitmap collateral under an ISOLATED active category (LTV 0)", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.user.eModeCategoryId = raw.eModes[0]!.id;
      raw.eModes[0]!.isIsolated = true;
      raw.eModes[0]!.collateralBitmap &= ~(1n << BigInt(raw.weETH.reserveIndex));
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectFail(result);
    const hits = constraintErrors(result.errors).filter(
      (e) => e.constraint === "emode-active-category-rejects-plan",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.blockId).toBe("borrow");
  });

  it("rejects in-bitmap collateral that the active category marks LTV-zero", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.user.eModeCategoryId = raw.eModes[0]!.id;
      raw.eModes[0]!.ltvZeroBitmap |= 1n << BigInt(raw.weETH.reserveIndex);
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectFail(result);
    expect(
      constraintErrors(result.errors).filter(
        (e) => e.constraint === "emode-active-category-rejects-plan",
      ),
    ).toHaveLength(1);
  });

  it("rejects an active category that cannot borrow the requested asset", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.user.eModeCategoryId = raw.eModes[0]!.id;
      raw.eModes[0]!.borrowableBitmap = 0n;
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectFail(result);
    expect(
      constraintErrors(result.errors).filter(
        (e) => e.constraint === "emode-active-category-rejects-plan",
      ),
    ).toHaveLength(1);
  });

  it("builds without e-mode when no category admits the pair (borrowable bitmap)", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.eModes[0]!.borrowableBitmap = 0n;
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.targetEModeCategoryId).toBeNull();
    expect(result.steps).toHaveLength(12);
    expect(result.steps.some((s) => s.functionName === "setUserEMode")).toBe(false);
  });

  it("builds without e-mode when the collateral is not a category member", () => {
    const snapshot = fixtureSnapshot((raw) => {
      const idx = BigInt(raw.weETH.reserveIndex);
      raw.eModes[0]!.collateralBitmap &= ~(1n << idx);
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.targetEModeCategoryId).toBeNull();
  });

  it("refuses a category whose LTV-zero bitmap covers the plan collateral", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.eModes[0]!.ltvZeroBitmap = 1n << BigInt(raw.weETH.reserveIndex);
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.targetEModeCategoryId).toBeNull();
  });

  it("an isolated category still admits a fresh wallet whose collateral is all in-category", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.eModes[0]!.isIsolated = true;
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.targetEModeCategoryId).toBe(1);
    expect(result.steps.some((s) => s.functionName === "setUserEMode")).toBe(true);
  });

  it("a borrow-free plan never touches e-mode", () => {
    const g = chainOf([
      { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
      { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
      { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
      { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    ]);
    const result = buildPlan(g, fixtureSnapshot());
    expectOk(result);
    expect(result.targetEModeCategoryId).toBeNull();
    expect(result.steps.map((s) => s.functionName)).toEqual(["deposit", "approve", "wrap", "approve", "supply"]);
  });
});

describe("phase support — EtherFi flagship only (W03)", () => {
  const snapshot = () => fixtureSnapshot();

  function expectUnsupported(g: StrategyGraph, blockId: string) {
    const result = buildPlan(g, snapshot());
    expectFail(result);
    const hits = result.errors.filter(
      (e): e is Extract<PlanError, { kind: "unsupported-in-phase" }> =>
        e.kind === "unsupported-in-phase" && e.blockId === blockId,
    );
    expect(hits.length, `unsupported-in-phase for ${blockId}`).toBeGreaterThan(0);
  }

  it("lido staking is schema-valid but unsupported in P1", () => {
    expectUnsupported(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "lido" } },
      ]),
      "stake1",
    );
  });

  it("stETH wrapping is unsupported in P1", () => {
    expectUnsupported(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
        { id: "wrap1", type: "wrap", params: { from: "stETH", to: "wstETH" } },
      ]),
      "wrap1",
    );
  });

  it("weETH→eETH unwrapping is unsupported in P1", () => {
    expectUnsupported(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
        { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
        { id: "unwrap1", type: "unwrap", params: { from: "weETH", to: "eETH" } },
      ]),
      "unwrap1",
    );
  });

  it("ETH→WETH wrapping is unsupported in P1", () => {
    expectUnsupported(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "wrap1", type: "wrap", params: { from: "ETH", to: "WETH" } },
      ]),
      "wrap1",
    );
  });

  it("lending anything but weETH is unsupported in P1", () => {
    expectUnsupported(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "wrap1", type: "wrap", params: { from: "ETH", to: "WETH" } },
        { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "WETH" } },
      ]),
      "supply1",
    );
  });
});

describe("asset flow (graph.ts boundary note: computed and validated in plan.ts)", () => {
  function expectFlowError(g: StrategyGraph, blockId: string) {
    const result = buildPlan(g, fixtureSnapshot());
    expectFail(result);
    const hits = result.errors.filter(
      (e): e is Extract<PlanError, { kind: "asset-flow" }> =>
        e.kind === "asset-flow" && e.blockId === blockId,
    );
    expect(hits.length, `asset-flow for ${blockId}`).toBeGreaterThan(0);
  }

  it("a stake fed anything but ETH is a flow error", () => {
    expectFlowError(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
        { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
        { id: "stake2", type: "stake", params: { protocol: "etherfi" } },
      ]),
      "stake2",
    );
  });

  it("a borrow without an aave lend producer is a flow error", () => {
    expectFlowError(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
        { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
        { id: "borrow", type: "borrow", params: { protocol: "aave-v3", asset: "WETH", allocationBps: 5000 } },
      ]),
      "borrow",
    );
  });

  it("a lend fed the wrong asset is a flow error", () => {
    expectFlowError(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
        { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
      ]),
      "supply1",
    );
  });
});

describe("graph gate — structural validation runs before any plan is built (§5.6)", () => {
  it("a cyclic graph is rejected as graph-invalid", () => {
    const g = flagshipGraph();
    const cyclic: StrategyGraph = {
      blocks: g.blocks,
      edges: [...g.edges, { id: "back", source: "supply2", target: "in", allocationBps: 10_000 }],
    };
    const result = buildPlan(cyclic, fixtureSnapshot());
    expectFail(result);
    expect(result.errors[0]!.kind).toBe("graph-invalid");
  });

  it("duplicate block ids are rejected as graph-invalid", () => {
    const g = flagshipGraph();
    const dup: StrategyGraph = { blocks: [...g.blocks, g.blocks[1]!], edges: g.edges };
    const result = buildPlan(dup, fixtureSnapshot());
    expectFail(result);
    expect(result.errors[0]!.kind).toBe("graph-invalid");
  });
});

describe("validation matrix (SPEC §5.7 — the recorded v3.7 constraint set)", () => {
  function expectConstraint(
    result: PlanResult,
    constraint: string,
    blockId: string,
  ) {
    expectFail(result);
    const hits = constraintErrors(result.errors).filter(
      (e) => e.constraint === constraint && e.blockId === blockId,
    );
    expect(hits.length, `${constraint} on ${blockId}`).toBeGreaterThan(0);
  }

  it("frozen supply reserve rejects the supply", () => {
    const s = fixtureSnapshot((raw) => {
      raw.weETH.frozen = true;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "reserve-frozen", "supply1");
  });

  it("paused supply reserve rejects the supply", () => {
    const s = fixtureSnapshot((raw) => {
      raw.weETH.paused = true;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "reserve-paused", "supply1");
  });

  it("inactive supply reserve rejects the supply", () => {
    const s = fixtureSnapshot((raw) => {
      raw.weETH.active = false;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "reserve-inactive", "supply1");
  });

  it("borrowing-disabled reserve rejects the borrow", () => {
    const s = fixtureSnapshot((raw) => {
      raw.WETH.borrowingEnabled = false;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "borrowing-disabled", "borrow");
  });

  it("paused borrow reserve rejects the borrow", () => {
    const s = fixtureSnapshot((raw) => {
      raw.WETH.paused = true;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "reserve-paused", "borrow");
  });

  it("collateral-disabled supply reserve rejects a borrowing plan", () => {
    const s = fixtureSnapshot((raw) => {
      raw.weETH.usageAsCollateralAllowed = false;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "collateral-not-allowed", "supply1");
  });

  it("an existing aave footprint is refused (SPEC §2 predicate)", () => {
    const s = fixtureSnapshot((raw) => {
      raw.user.hasAaveFootprint = true;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "existing-footprint", "supply1");
  });

  it("supply cap: the flagship passes at the real weETH headroom boundary and fails one wei above", () => {
    expectOk(buildPlan(flagshipGraph(CAP_BOUNDARY_E_PASS), fixtureSnapshot()));
    // The crossing supply is the SECOND one — cumulative in-plan tracking, not
    // per-step-versus-snapshot.
    expectConstraint(
      buildPlan(flagshipGraph(CAP_BOUNDARY_E_FAIL), fixtureSnapshot()),
      "supply-cap",
      "supply2",
    );
  });

  it("borrow cap: exact v3.7 scaled-debt formula at the boundary", () => {
    const pass = fixtureSnapshot((raw) => {
      raw.WETH.borrowCap = BORROW_CAP_MIN_PASSING;
    });
    expectOk(buildPlan(flagshipGraph(), pass));
    const fail = fixtureSnapshot((raw) => {
      raw.WETH.borrowCap = BORROW_CAP_MIN_PASSING - 1n;
    });
    expectConstraint(buildPlan(flagshipGraph(), fail), "borrow-cap", "borrow");
  });

  it("virtual liquidity bounds the borrow exactly", () => {
    const pass = fixtureSnapshot((raw) => {
      raw.WETH.virtualUnderlyingBalance = EXPECTED_BORROW_WEI;
    });
    expectOk(buildPlan(flagshipGraph(), pass));
    const fail = fixtureSnapshot((raw) => {
      raw.WETH.virtualUnderlyingBalance = EXPECTED_BORROW_WEI - 1n;
    });
    expectConstraint(buildPlan(flagshipGraph(), fail), "insufficient-liquidity", "borrow");
  });
});

describe("input amount parsing — exact, or an explicit error", () => {
  it("parses a decimal string exactly", () => {
    const result = buildPlan(flagshipGraph("1.5"), fixtureSnapshot());
    expectOk(result);
    const deposit = stepById(result.steps, "stake1:deposit");
    if (deposit.amount.kind !== "literal") throw new Error("expected literal");
    expect(deposit.amount.amount.value).toBe(1_500_000_000_000_000_000n);
  });

  it("accepts a whole-number amount", () => {
    const result = buildPlan(flagshipGraph(10), fixtureSnapshot());
    expectOk(result);
    const deposit = stepById(result.steps, "stake1:deposit");
    if (deposit.amount.kind !== "literal") throw new Error("expected literal");
    expect(deposit.amount.amount.value).toBe(10n * WAD_WEI);
  });

  it("rejects more than 18 decimals instead of silently truncating", () => {
    const result = buildPlan(flagshipGraph("0.1234567890123456789"), fixtureSnapshot());
    expectFail(result);
    const hits = constraintErrors(result.errors).filter((e) => e.constraint === "input-amount");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.blockId).toBe("in");
  });

  it("rejects a fractional number param — binary floats cannot carry money exactly", () => {
    const result = buildPlan(flagshipGraph(0.1), fixtureSnapshot());
    expectFail(result);
    const hits = constraintErrors(result.errors).filter((e) => e.constraint === "input-amount");
    expect(hits).toHaveLength(1);
  });
});
