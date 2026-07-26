import { describe, expect, it } from "vitest";
import { simulate, riskLedger } from "./risk";
import {
  HF_WARN_WAD,
  computeHealthFactor,
  hfWadValue,
  liquidationRatioWad,
  riskState,
  usdBase,
  type CollateralEntry,
  type HealthFactor,
} from "./health-factor";
import { effectiveLiquidationThresholdBps, buildPlan, type ChainSnapshot } from "./plan";
import { WAD, formatHealthFactor, formatWadAsMultiple, formatWadRatio } from "./format";
import {
  accruedVariableBorrowIndexRay,
  currentRatesRay,
  rayDivCeil,
  vTokenBalance,
} from "./rates";
import {
  observedBlocks,
  provenanceTrail,
  valueOf,
  type Provenanced,
} from "./provenance";
import { PINNED_BLOCK } from "../../tests/helpers/protocol-reads";
import { EXPECTED_BORROW_WEI, chainOf, flagshipGraph } from "../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../tests/helpers/chain-snapshot";
import type { Block } from "./graph";

// ————————————————————————— helpers —————————————————————————

const snapshot = fixtureSnapshot();

/** The slider's granularity, restated from the borrow block's exported step. */
const BORROW_STEP_BPS = 100;

function hfOf(p: Provenanced<HealthFactor>): bigint | null {
  return hfWadValue(valueOf(p));
}

function requireValue(p: Provenanced<bigint> | null, what: string): bigint {
  if (p === null) throw new Error(`${what} is unexpectedly unavailable`);
  return p.value;
}

/**
 * The flagship's collateral/debt legs, rebuilt in the TEST from the fixture snapshot rather
 * than read back off the result. This is what makes the parity assertions below a claim
 * about `risk.ts` selecting a checkpoint rather than about it agreeing with itself.
 */
function fixtureLegs(allocationBps: number, snap: ChainSnapshot = snapshot) {
  const plan = buildPlan(flagshipGraph("10", allocationBps), snap);
  if (!plan.ok) throw new Error(`fixture plan failed: ${JSON.stringify(plan.errors, bigintJson)}`);
  const category =
    plan.targetEModeCategoryId === null
      ? null
      : (snap.eModeCategories.find((c) => c.id === plan.targetEModeCategoryId) ?? null);
  const weETH = snap.reserves.weETH;
  const WETH = snap.reserves.WETH;
  const ltBps = effectiveLiquidationThresholdBps(weETH, category);
  const supplies = plan.flows
    .filter((f) => f.type === "lend")
    .map((f) => f.inputWei!.value);
  const borrows = plan.flows
    .filter((f) => f.type === "borrow")
    .map((f) => f.outputWei!.value);
  const entryOf = (wei: bigint): CollateralEntry => ({
    base: usdBase(wei, weETH.priceBase.value),
    ltBps,
  });
  const debtBase = borrows.reduce((a, wei) => a + usdBase(wei, WETH.priceBase.value), 0n);
  return { plan, ltBps, supplies, borrows, entryOf, debtBase, weETH, WETH };
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

const INPUT: Block = { id: "in", type: "input", params: { asset: "ETH", amount: "10" } };
const STAKE: Block = { id: "stake1", type: "stake", params: { protocol: "etherfi" } };
const WRAP: Block = { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } };
const LEND: Block = { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } };

// ————————————————————————— §6.1 parity —————————————————————————

describe("core parity (SPEC §3 step 3) — risk.ts selects a checkpoint, it does not re-implement HF", () => {
  it("reproduces computeHealthFactor over independently built legs, at min and at final", () => {
    const { supplies, entryOf, debtBase } = fixtureLegs(7000);
    const result = simulate(flagshipGraph("10", 7000), snapshot);

    // The minimum is the borrow step: debt opens against supply1 ALONE, before the loop's
    // second collateral lands. A plan-level reading after the fact would miss it entirely.
    const atBorrow = computeHealthFactor([entryOf(supplies[0]!)], debtBase);
    const atFinal = computeHealthFactor(supplies.map(entryOf), debtBase);

    expect(valueOf(result.minHealthFactor)).toEqual(atBorrow);
    expect(valueOf(result.finalHealthFactor)).toEqual(atFinal);
    expect(atBorrow).not.toEqual(atFinal);
  });

  it("puts the minimum at the borrow checkpoint, not the last one", () => {
    const ledger = riskLedger(flagshipGraph("10", 7000), snapshot);
    expect(ledger.ok).toBe(true);
    expect(ledger.checkpoints.map((c) => `${c.blockId}:${c.cause}`)).toEqual([
      "supply1:supply",
      "borrow:borrow",
      "supply2:supply",
    ]);
    expect(ledger.min?.blockId).toBe("borrow");
    expect(ledger.final?.blockId).toBe("supply2");
    // The pre-borrow checkpoint carries no debt, so it can never win the minimum.
    expect(ledger.checkpoints[0]!.healthFactor).toEqual({ status: "no-debt" });
  });
});

// ————————————————————————— §6.2 fixture-driven pins —————————————————————————

describe("pinned worked example (design §2.10, block 25,592,678)", () => {
  it("borrows exactly the amount plan.ts derives — one number, not two", () => {
    const { borrows } = fixtureLegs(7000);
    expect(borrows).toEqual([EXPECTED_BORROW_WEI]);
    const result = simulate(flagshipGraph("10", 7000), snapshot);
    expect(requireValue(result.blockValues["borrow"]!.outputAmountWei, "borrow output")).toBe(
      EXPECTED_BORROW_WEI,
    );
  });

  it("pins the b = 7000 row", () => {
    const result = simulate(flagshipGraph("10", 7000), snapshot);
    expect(hfOf(result.minHealthFactor)).toBe(1_357_142_857_144_167_216n);
    expect(hfOf(result.finalHealthFactor)).toBe(2_307_142_857_144_167_216n);
    expect(requireValue(result.liquidationRatioWad, "ratio")).toBe(810_405_201_682_850_969n);
    expect(requireValue(result.leverageWad, "leverage")).toBe(1_699_999_999_998_440_640n);
    expect(requireValue(result.initialAmountWei, "equity")).toBe(10n * WAD);
  });

  it("pins the b = 5000 row", () => {
    const result = simulate(flagshipGraph("10", 5000), snapshot);
    expect(hfOf(result.minHealthFactor)).toBe(1_900_000_000_002_962_782n);
    expect(hfOf(result.finalHealthFactor)).toBe(2_850_000_000_002_962_782n);
    expect(requireValue(result.liquidationRatioWad, "ratio")).toBe(578_860_858_344_721_616n);
    expect(requireValue(result.leverageWad, "leverage")).toBe(1_499_999_999_998_440_640n);
  });

  it("renders the pinned wads through core/format.ts, truncated as the display truncates", () => {
    const at = (bps: number) => simulate(flagshipGraph("10", bps), snapshot);
    // formatHealthFactor truncates, so 1.357… is "1.35" and never "1.36".
    expect(formatHealthFactor(hfOf(at(7000).minHealthFactor))).toBe("1.35");
    expect(formatHealthFactor(hfOf(at(5000).minHealthFactor))).toBe("1.90");
    expect(formatWadRatio(requireValue(at(7000).liquidationRatioWad, "ratio"))).toBe("0.8104");
    expect(formatWadRatio(requireValue(at(5000).liquidationRatioWad, "ratio"))).toBe("0.5789");
    expect(formatWadAsMultiple(requireValue(at(7000).leverageWad, "leverage"))).toBe("1.70×");
    expect(formatWadAsMultiple(requireValue(at(5000).leverageWad, "leverage"))).toBe("1.50×");
  });

  it("computes the liquidation ratio at the MINIMUM checkpoint, not the final one", () => {
    const ledger = riskLedger(flagshipGraph("10", 7000), snapshot);
    const min = ledger.min!;
    const final = ledger.final!;
    const result = simulate(flagshipGraph("10", 7000), snapshot);
    const atMin = liquidationRatioWad(min.collateralWei!, min.debtWei!, min.supplies[0]!.ltBps);
    const atFinal = liquidationRatioWad(
      final.collateralWei!,
      final.debtWei!,
      final.supplies[0]!.ltBps,
    );
    expect(requireValue(result.liquidationRatioWad, "ratio")).toBe(atMin);
    // The final checkpoint is far more forgiving; showing it beside the min HF would be two
    // surfaces disagreeing about the same position.
    expect(atFinal).toBeLessThan(atMin);
  });

  it("exposes no USD liquidation price for the correlated pair (SPEC §5.4)", () => {
    const result = simulate(flagshipGraph("10", 7000), snapshot);
    expect("liquidationPriceUsd" in result).toBe(false);
    expect("liquidationPrice" in result).toBe(false);
  });
});

describe("e-mode regime (SPEC §3 step 4 — quoting the wrong regime is a correctness bug)", () => {
  it("applies the CATEGORY threshold of 9500 and cites why, not the reserve's 8000", () => {
    const { ltBps, weETH } = fixtureLegs(7000);
    expect(ltBps).toBe(9500);
    expect(weETH.liquidationThresholdBps.value).toBe(8000);

    const trail = provenanceTrail(simulate(flagshipGraph("10", 7000), snapshot).minHealthFactor);
    const text = trail.join("\n");
    expect(text).toContain("eMode1.collateralConfig.liquidationThreshold");
    expect(text).toContain("eMode1.collateralBitmap");
    expect(text).toContain("Pool.getReservesList.indexOf(weETH)");
    expect(text).toContain("Oracle.getAssetPrice(weETH)");
  });

  /**
   * The matrix §3 asymmetry, and the reason the citation is a predicate rather than a value
   * comparison: a wallet already parked in a category runs under it even when the category's
   * collateral bitmap excludes the supplied reserve — and then the RESERVE's threshold
   * applies while the category is still active. Quoting the category's 9500 here would be
   * the correctness bug SPEC §3 step 4 names.
   */
  it("uses the reserve threshold inside an active category whose bitmap excludes the collateral", () => {
    const parked = fixtureSnapshot((raw) => {
      raw.user.eModeCategoryId = 1;
      // WETH (index 0) stays a bitmap member; weETH (index 28) is dropped.
      raw.eModes[0]!.collateralBitmap = 1n;
    });
    const plan = buildPlan(flagshipGraph("10", 7000), parked);
    if (!plan.ok) throw new Error("parked plan failed");
    // The category is still the active one — it simply does not supply this reserve's LT.
    expect(plan.targetEModeCategoryId).toBe(1);

    const { ltBps } = fixtureLegs(7000, parked);
    expect(ltBps).toBe(parked.reserves.weETH.liquidationThresholdBps.value);
    expect(ltBps).toBe(8000);

    const result = simulate(flagshipGraph("10", 7000), parked);
    const trail = provenanceTrail(result.minHealthFactor).join("\n");
    // The reserve's observation is cited, and the bitmap and index that decided it are too.
    expect(trail).toContain("weETH.getReserveConfigurationData.liquidationThreshold");
    expect(trail).toContain("eMode1.collateralBitmap");
    expect(trail).toContain("Pool.getReservesList.indexOf(weETH)");
    expect(trail).not.toContain("eMode1.collateralConfig.liquidationThreshold");
    expect(hfOf(result.minHealthFactor)!).toBeLessThan(
      hfOf(simulate(flagshipGraph("10", 7000), snapshot).minHealthFactor)!,
    );
  });

  it("falls back to the reserve threshold — and a lower HF — when the bitmap excludes weETH", () => {
    // Editing the RAW read before it is minted is how a test says "the same block, with this
    // one bitmap cleared" without forging provenance.
    const excluded = fixtureSnapshot((raw) => {
      raw.eModes[0]!.collateralBitmap = 0n;
    });
    const { ltBps } = fixtureLegs(7000, excluded);
    expect(ltBps).toBe(8000);

    const fallback = simulate(flagshipGraph("10", 7000), excluded);
    const inCategory = simulate(flagshipGraph("10", 7000), snapshot);
    expect(hfOf(fallback.minHealthFactor)!).toBeLessThan(hfOf(inCategory.minHealthFactor)!);
    expect(provenanceTrail(fallback.minHealthFactor).join("\n")).toContain(
      "weETH.getReserveConfigurationData.liquidationThreshold",
    );
  });
});

describe("post-action rates (§2.6) — assembled here, proven against the recorded reads", () => {
  it("reproduces the recorded current rates byte-exactly with zero deltas", () => {
    // The reproduction is what makes the post-action DELTA a claim about our own action
    // rather than about the model. It is re-asserted through risk.ts's own input assembly,
    // which is the part that could pair the wrong debt total with the wrong index.
    for (const key of ["weETH", "WETH"] as const) {
      const r = snapshot.reserves[key];
      const baseline = currentRatesRay({
        strategy: r.rateStrategy.value,
        reserveFactorBps: r.reserveFactorBps.value,
        totalDebtWei: vTokenBalance(
          r.variableDebtScaledTotalSupply.value,
          r.variableBorrowIndexRay.value,
        ),
        virtualUnderlyingBalance: r.virtualUnderlyingBalance.value,
        liquidityAddedWei: 0n,
        liquidityTakenWei: 0n,
        deficitWei: r.deficit.value,
      });
      expect(baseline.liquidityRateRay, `${key} liquidityRate`).toBe(r.liquidityRateRay.value);
      expect(baseline.variableBorrowRateRay, `${key} variableBorrowRate`).toBe(
        r.variableBorrowRateRay.value,
      );
    }
  });

  /**
   * Aave's own post-action sequence, spelled out so the test IS the model:
   *
   *   updateState()                 -> nextVariableBorrowIndex accrued to block.timestamp
   *   vToken.mint(amt, nextIndex)   -> nextScaledVariableDebt += rayDivCeil(amt, nextIndex)
   *   updateInterestRatesAndVirtualBalance(cache, asset, added, taken)
   *       totalDebt = nextScaledVariableDebt.rayMulCeil(nextVariableBorrowIndex)
   *
   * The debt the rate model sees is therefore ACCRUED to this block, not the debt the
   * previous rate was written at. A supply mints no debt but still accrues the index.
   */
  function postActionDebt(
    reserve: ChainSnapshot["reserves"]["WETH"],
    borrowedWei: bigint,
  ): bigint {
    const nextIndex = accruedVariableBorrowIndexRay(
      reserve.variableBorrowRateRay.value,
      reserve.variableBorrowIndexRay.value,
      reserve.lastUpdateTimestamp.value,
      snapshot.blockTimestamp,
    );
    return vTokenBalance(
      reserve.variableDebtScaledTotalSupply.value + rayDivCeil(borrowedWei, nextIndex),
      nextIndex,
    );
  }

  it("pins the post-action rays and their direction: our borrow raises, our supply lowers", () => {
    const WETH = snapshot.reserves.WETH;
    const weETH = snapshot.reserves.weETH;
    const { borrows, supplies } = fixtureLegs(7000);

    const postBorrow = currentRatesRay({
      strategy: WETH.rateStrategy.value,
      reserveFactorBps: WETH.reserveFactorBps.value,
      // Both legs: the borrow MINTS debt (into the accrued total) and DRAINS the virtual
      // balance. Passing only `liquidityTakenWei` models D/(V−X+D) and understates the rate.
      totalDebtWei: postActionDebt(WETH, borrows[0]!),
      virtualUnderlyingBalance: WETH.virtualUnderlyingBalance.value,
      liquidityAddedWei: 0n,
      liquidityTakenWei: borrows[0]!,
      deficitWei: WETH.deficit.value,
    });
    const postSupply = currentRatesRay({
      strategy: weETH.rateStrategy.value,
      reserveFactorBps: weETH.reserveFactorBps.value,
      totalDebtWei: postActionDebt(weETH, 0n),
      virtualUnderlyingBalance: weETH.virtualUnderlyingBalance.value,
      liquidityAddedWei: supplies.reduce((a, w) => a + w, 0n),
      liquidityTakenWei: 0n,
      deficitWei: weETH.deficit.value,
    });

    expect(postBorrow.variableBorrowRateRay).toBe(21_314_707_729_619_294_450_253_508n);
    expect(postSupply.liquidityRateRay).toBe(264_681_516_172_345_992_079n);
    expect(postBorrow.variableBorrowRateRay).toBeGreaterThan(WETH.variableBorrowRateRay.value);
    expect(postSupply.liquidityRateRay).toBeLessThan(weETH.liquidityRateRay.value);
  });

  /**
   * The regression guard for the corrected model. Reconstructing debt at the STORED index is
   * the baseline's job and nothing else's; using it for a post-action rate understates
   * utilization by the entire accrual since `lastUpdateTimestamp` (60s on WETH, 3h16m on
   * weETH at this block). The deltas are pinned so a silent revert to the stale model cannot
   * pass as a rounding difference.
   */
  it("feeds the rate model debt accrued to this block, not the debt the rates were written at", () => {
    const WETH = snapshot.reserves.WETH;
    const weETH = snapshot.reserves.weETH;
    const { borrows, supplies } = fixtureLegs(7000);

    const staleDebt = (r: ChainSnapshot["reserves"]["WETH"], borrowedWei: bigint) =>
      vTokenBalance(r.variableDebtScaledTotalSupply.value, r.variableBorrowIndexRay.value) +
      borrowedWei;

    expect(postActionDebt(WETH, borrows[0]!) - staleDebt(WETH, borrows[0]!)).toBe(
      68_411_831_910_049_430n,
    );
    expect(postActionDebt(weETH, 0n) - staleDebt(weETH, 0n)).toBe(189_677_486_949_482n);

    const rateWith = (
      r: ChainSnapshot["reserves"]["WETH"],
      totalDebtWei: bigint,
      taken: bigint,
      added: bigint,
    ) =>
      currentRatesRay({
        strategy: r.rateStrategy.value,
        reserveFactorBps: r.reserveFactorBps.value,
        totalDebtWei,
        virtualUnderlyingBalance: r.virtualUnderlyingBalance.value,
        liquidityAddedWei: added,
        liquidityTakenWei: taken,
        deficitWei: r.deficit.value,
      });
    const suppliedTotal = supplies.reduce((a, w) => a + w, 0n);
    const borrowDelta =
      rateWith(WETH, postActionDebt(WETH, borrows[0]!), borrows[0]!, 0n).variableBorrowRateRay -
      rateWith(WETH, staleDebt(WETH, borrows[0]!), borrows[0]!, 0n).variableBorrowRateRay;
    const supplyDelta =
      rateWith(weETH, postActionDebt(weETH, 0n), 0n, suppliedTotal).liquidityRateRay -
      rateWith(weETH, staleDebt(weETH, 0n), 0n, suppliedTotal).liquidityRateRay;
    expect(borrowDelta).toBe(143_098_107_621_621_733n);
    expect(supplyDelta).toBe(989_181_058_343_819n);
  });

  it("puts those rates on the blocks that earn and pay them", () => {
    const at7000 = simulate(flagshipGraph("10", 7000), snapshot);
    const at5000 = simulate(flagshipGraph("10", 5000), snapshot);
    expect(requireValue(at7000.blockValues["borrow"]!.apyWad, "r_debt")).toBe(21_543_480_050_598_075n);
    expect(requireValue(at7000.blockValues["supply1"]!.apyWad, "r_supply")).toBe(264_681_551_200n);
    expect(requireValue(at5000.blockValues["borrow"]!.apyWad, "r_debt")).toBe(21_543_454_236_632_190n);
    expect(requireValue(at5000.blockValues["supply1"]!.apyWad, "r_supply")).toBe(264_682_007_088n);

    // Both supplies sit on one reserve, so both carry the SAME post-action supply rate —
    // one derivation, two renderings.
    expect(at7000.blockValues["supply2"]!.apyWad).toBe(at7000.blockValues["supply1"]!.apyWad);
    // A conversion earns no rate, and the staking leg has no window in this snapshot.
    expect(at7000.blockValues["wrap1"]!.apyWad).toBeNull();
    expect(at7000.blockValues["unwrap"]!.apyWad).toBeNull();
    expect(at7000.blockValues["stake1"]!.apyWad).toBeNull();
    expect(at7000.blockValues["in"]!.apyWad).toBeNull();
  });
});

// ————————————————————————— §6.3 the §3 step-3 drag —————————————————————————

describe("the SPEC §3 step-3 drag, 50% → 70%", () => {
  it("moves every risk quantity in the direction the gesture implies", () => {
    const low = simulate(flagshipGraph("10", 5000), snapshot);
    const high = simulate(flagshipGraph("10", 7000), snapshot);

    expect(riskState(valueOf(low.minHealthFactor))).toBe("ok");
    expect(riskState(valueOf(high.minHealthFactor))).toBe("warning");
    expect(hfOf(high.minHealthFactor)!).toBeLessThan(hfOf(low.minHealthFactor)!);
    // Liquidation gets CLOSER: the ratio the pair must fall to rises.
    expect(requireValue(high.liquidationRatioWad, "ratio")).toBeGreaterThan(
      requireValue(low.liquidationRatioWad, "ratio"),
    );
    expect(requireValue(high.leverageWad, "leverage")).toBeGreaterThan(
      requireValue(low.leverageWad, "leverage"),
    );
    expect(
      requireValue(high.blockValues["borrow"]!.outputAmountWei, "borrow"),
    ).toBeGreaterThan(requireValue(low.blockValues["borrow"]!.outputAmountWei, "borrow"));
  });

  it("crosses the warning threshold at 6400 bps, mid-gesture", () => {
    // No literal "1.5" is authored: the threshold is core's named constant.
    const ok = simulate(flagshipGraph("10", 6300), snapshot);
    const warning = simulate(flagshipGraph("10", 6400), snapshot);
    expect(hfOf(ok.minHealthFactor)!).toBeGreaterThanOrEqual(HF_WARN_WAD);
    expect(hfOf(warning.minHealthFactor)!).toBeLessThan(HF_WARN_WAD);
    expect(riskState(valueOf(ok.minHealthFactor))).toBe("ok");
    expect(riskState(valueOf(warning.minHealthFactor))).toBe("warning");
  });

  it("is monotone across the whole slider: HF never rises, the ratio never falls", () => {
    let previousHf: bigint | null = null;
    let previousRatio: bigint | null = null;
    for (let bps = BORROW_STEP_BPS; bps <= 9300; bps += BORROW_STEP_BPS) {
      const result = simulate(flagshipGraph("10", bps), snapshot);
      const hf = hfOf(result.minHealthFactor)!;
      const ratio = requireValue(result.liquidationRatioWad, `ratio at ${bps}`);
      if (previousHf !== null) expect(hf, `HF at ${bps} bps`).toBeLessThanOrEqual(previousHf);
      if (previousRatio !== null) {
        expect(ratio, `ratio at ${bps} bps`).toBeGreaterThanOrEqual(previousRatio);
      }
      previousHf = hf;
      previousRatio = ratio;
    }
  });
});

// ————————————————————————— §6.4 edges and properties —————————————————————————

describe("degenerate but valid graphs (§5.3)", () => {
  it("a graph with collateral and no borrow is no-debt, with leverage but no ratio", () => {
    const result = simulate(chainOf([INPUT, STAKE, WRAP, LEND]), snapshot);
    expect(result.isValid).toBe(true);
    expect(valueOf(result.minHealthFactor)).toEqual({ status: "no-debt" });
    expect(valueOf(result.finalHealthFactor)).toEqual({ status: "no-debt" });
    expect(result.liquidationRatioWad).toBeNull();
    expect(result.netApyWad).toBeNull();
    expect(result.yieldSources).toEqual([]);
    // Leverage is 1.0× — the collateral IS the equity, no debt on top.
    expect(formatWadAsMultiple(requireValue(result.leverageWad, "leverage"))).toBe("1.00×");
    // Every block still carries its values; the missing borrow removes risk, not amounts.
    expect(Object.keys(result.blockValues)).toEqual(["in", "stake1", "wrap1", "supply1"]);
    for (const value of Object.values(result.blockValues)) {
      expect(value.gasCostBase).toBeNull();
    }
  });

  it("a graph with no Aave position at all has no checkpoints and no leverage", () => {
    const result = simulate(chainOf([INPUT, STAKE, WRAP]), snapshot);
    expect(result.isValid).toBe(true);
    const ledger = riskLedger(chainOf([INPUT, STAKE, WRAP]), snapshot);
    expect(ledger.checkpoints).toEqual([]);
    expect(ledger.min).toBeNull();
    expect(ledger.final).toBeNull();
    expect(valueOf(result.minHealthFactor)).toEqual({ status: "no-debt" });
    expect(result.leverageWad).toBeNull();
    expect(result.liquidationRatioWad).toBeNull();
    expect(Object.keys(result.blockValues)).toEqual(["in", "stake1", "wrap1"]);
  });

  it("still returns a real health factor above the LTV ceiling — the override needs to see it", () => {
    // buildPlan does not reject on LTV: that gate is the store's, and "Simulate anyway"
    // exists precisely to show what the refused position would look like.
    const result = simulate(flagshipGraph("10", 9500), snapshot);
    expect(result.isValid).toBe(true);
    expect(valueOf(result.minHealthFactor).status).toBe("healthy");
    expect(riskState(valueOf(result.minHealthFactor))).toBe("warning");
  });

  it("handles the slider minimum without inventing anything", () => {
    const result = simulate(flagshipGraph("10", BORROW_STEP_BPS), snapshot);
    expect(valueOf(result.minHealthFactor).status).toBe("healthy");
    expect(riskState(valueOf(result.minHealthFactor))).toBe("ok");
  });
});

describe("missing reads inside a valid plan (§5.2)", () => {
  it("keeps the APY family unavailable without touching risk — the legs are independent", () => {
    // SPEC §5.1's staking APR needs a trailing two-block window this snapshot does not carry
    // (ruling Q1), so §5.2's composition is complete-or-nothing.
    const result = simulate(flagshipGraph("10", 7000), snapshot);
    expect(result.grossApyWad).toBeNull();
    expect(result.netApyWad).toBeNull();
    expect(result.yieldSources).toEqual([]);
    // …and the whole risk path is unaffected.
    expect(valueOf(result.minHealthFactor).status).toBe("healthy");
    expect(result.liquidationRatioWad).not.toBeNull();
    expect(result.leverageWad).not.toBeNull();
    expect(result.blockValues["supply1"]!.inputAmountWei).not.toBeNull();
  });

  it("an unusable oracle price makes the health factor unknown, never silently safe", () => {
    const noPrice = fixtureSnapshot((raw) => {
      raw.weETH.priceBase = 0n;
    });
    const result = simulate(flagshipGraph("10", 7000), noPrice);
    expect(result.isValid).toBe(true);
    const hf = valueOf(result.minHealthFactor);
    expect(hf.status).toBe("unknown");
    expect(riskState(hf)).toBe("unknown");
    expect(formatHealthFactor(hfWadValue(hf))).not.toBe("∞");
    expect(result.blockValues["supply1"]!.inputValueBase).toBeNull();
    // The amount is still known — only its VALUE is missing.
    expect(result.blockValues["supply1"]!.inputAmountWei).not.toBeNull();
  });

  it("lets the unknown checkpoint dominate the minimum rather than losing a comparison", () => {
    const noPrice = fixtureSnapshot((raw) => {
      raw.weETH.priceBase = 0n;
    });
    const ledger = riskLedger(flagshipGraph("10", 7000), noPrice);
    expect(ledger.min?.healthFactor.status).toBe("unknown");
    // The first checkpoint is the one that went unknown; the walk stops comparing there.
    expect(ledger.min?.blockId).toBe("supply1");
    expect(ledger.checkpoints.every((c) => c.healthFactor.status === "unknown")).toBe(true);
  });

  it("refuses a base valuation outside the recorded 18-decimal matrix", () => {
    // `usdBase` is the 18-decimal form. Mutating the DEBT reserve takes the borrow's oracle
    // value away while leaving the collateral's intact. The cap is cleared alongside it
    // because plan.ts's cap comparison scales the recorded 18-decimal totals by the mutated
    // unit — an artifact of the mutation, not the behaviour under test.
    const odd = fixtureSnapshot((raw) => {
      raw.WETH.decimals = 6;
      raw.WETH.borrowCap = 0n;
    });
    const result = simulate(flagshipGraph("10", 7000), odd);
    expect(result.isValid).toBe(true);
    expect(valueOf(result.minHealthFactor).status).toBe("unknown");
    expect(result.blockValues["borrow"]!.outputValueBase).toBeNull();
    // The weETH collateral is 18-decimal and still values normally — one reserve's scale
    // does not blank the other's.
    expect(result.blockValues["supply1"]!.inputValueBase).not.toBeNull();
    // Equity is ETH, priced by that same WETH feed, so leverage goes with it.
    expect(result.leverageWad).toBeNull();
  });

  it("drops a rate leg whose strategy parameters are out of domain, and only that leg", () => {
    const broken = fixtureSnapshot((raw) => {
      raw.WETH.rateStrategy = { ...raw.WETH.rateStrategy, optimalUsageRatio: 0 };
    });
    const result = simulate(flagshipGraph("10", 7000), broken);
    expect(result.blockValues["borrow"]!.apyWad).toBeNull();
    // The supply leg sits on the other reserve and is untouched, as is the health factor.
    expect(result.blockValues["supply1"]!.apyWad).not.toBeNull();
    expect(valueOf(result.minHealthFactor).status).toBe("healthy");
  });
});

describe("refusals (§5.1) — a complete refusal, never a partial reading", () => {
  const expectRefusal = (result: ReturnType<typeof simulate>, fragment: string) => {
    expect(result.isValid).toBe(false);
    expect(result.errorMessage).toContain(fragment);
    expect(result.grossApyWad).toBeNull();
    expect(result.netApyWad).toBeNull();
    expect(result.initialAmountWei).toBeNull();
    expect(result.gasCostBase).toBeNull();
    expect(result.liquidationRatioWad).toBeNull();
    expect(result.leverageWad).toBeNull();
    expect(result.yieldSources).toEqual([]);
    expect(result.blockValues).toEqual({});
    for (const hf of [result.minHealthFactor, result.finalHealthFactor]) {
      expect(valueOf(hf).status).toBe("unknown");
      // Zero-input derivation: honest here because it genuinely consumed nothing, and it
      // implies no observation.
      expect(observedBlocks(hf).size).toBe(0);
      expect(provenanceTrail(hf)[0]).toContain("no plan:");
    }
  };

  it("reports the validator's own first message for a structurally invalid graph", () => {
    const cyclic = {
      blocks: [INPUT, STAKE],
      edges: [
        { id: "e0", source: "in", target: "stake1", allocationBps: 10_000 },
        { id: "e1", source: "stake1", target: "in", allocationBps: 10_000 },
      ],
    };
    expectRefusal(simulate(cyclic, snapshot), "acyclic");
  });

  it("refuses an empty document", () => {
    expectRefusal(simulate({ blocks: [], edges: [] }, snapshot), "no blocks");
  });

  it("refuses an over-allocated source", () => {
    const over = {
      blocks: [INPUT, STAKE, { ...WRAP, id: "wrap1" }],
      edges: [
        { id: "e0", source: "in", target: "stake1", allocationBps: 10_000 },
        { id: "e1", source: "in", target: "wrap1", allocationBps: 10_000 },
      ],
    };
    expectRefusal(simulate(over, snapshot), "over-allocates");
  });

  it("carries a recorded v3.7 constraint through as the sentence, with no HF invented", () => {
    const frozen = fixtureSnapshot((raw) => {
      raw.weETH.frozen = true;
    });
    expectRefusal(simulate(flagshipGraph("10", 7000), frozen), "frozen");
  });

  /**
   * The borrow denominates a base-currency amount back into token wei by DIVIDING by the
   * debt asset's price. A zero there is a BigInt division by zero, which would throw
   * straight through `simulate`'s pure/total contract — so it is validated before the
   * arithmetic and refused with a sentence instead.
   */
  it("refuses an unusable debt-oracle price rather than dividing by it", () => {
    const noDebtPrice = fixtureSnapshot((raw) => {
      raw.WETH.priceBase = 0n;
    });
    const graph = flagshipGraph("10", 7000);
    expect(() => simulate(graph, noDebtPrice)).not.toThrow();
    expect(() => riskLedger(graph, noDebtPrice)).not.toThrow();
    expectRefusal(simulate(graph, noDebtPrice), "no usable price for WETH");

    const errors = riskLedger(graph, noDebtPrice).errors;
    expect(errors).toHaveLength(1);
    const first = errors[0]!;
    if (first.kind !== "constraint") throw new Error("expected a typed constraint");
    expect(first.constraint).toBe("oracle-price-unavailable");
    expect(first.blockId).toBe("borrow");
  });

  it("keeps the full error list available for per-block surfacing", () => {
    const frozen = fixtureSnapshot((raw) => {
      raw.weETH.frozen = true;
    });
    const ledger = riskLedger(flagshipGraph("10", 7000), frozen);
    expect(ledger.ok).toBe(false);
    expect(ledger.checkpoints).toEqual([]);
    expect(ledger.min).toBeNull();
    expect(ledger.final).toBeNull();
    expect(ledger.errors.length).toBeGreaterThan(0);
    expect(ledger.errors[0]!.kind).toBe("constraint");
  });
});

// ————————————————————————— per-block values (§2.9) —————————————————————————

describe("per-block values", () => {
  const result = simulate(flagshipGraph("10", 7000), snapshot);

  it("gives the input block an output and no input", () => {
    const value = result.blockValues["in"]!;
    expect(value.inputAsset).toBeNull();
    expect(value.inputAmountWei).toBeNull();
    expect(value.inputValueBase).toBeNull();
    expect(value.outputAsset).toBe("ETH");
    expect(requireValue(value.outputAmountWei, "input output")).toBe(10n * WAD);
    expect(value.outputAmountWei!.kind).toBe("entered");
  });

  it("gives the borrow block an output and no input — its edge is a dependency", () => {
    const value = result.blockValues["borrow"]!;
    expect(value.inputAsset).toBeNull();
    expect(value.inputAmountWei).toBeNull();
    expect(value.outputAsset).toBe("WETH");
    expect(requireValue(value.outputAmountWei, "borrow")).toBe(EXPECTED_BORROW_WEI);
  });

  it("renders a supply's output as the collateral position it creates, not as unavailable", () => {
    const value = result.blockValues["supply1"]!;
    const { supplies } = fixtureLegs(7000);
    expect(value.inputAsset).toBe("weETH");
    expect(requireValue(value.inputAmountWei, "supply in")).toBe(supplies[0]!);
    expect(value.outputAsset).toBe("weETH");
    // The aToken balance: rayDivFloor then rayMulFloor at the accrued index — the identical
    // pair plan.ts uses for the supply cap, so the canvas and the cap validator agree.
    const aBalance = requireValue(value.outputAmountWei, "supply out");
    expect(aBalance).toBe(9_092_267_716_600_505_492n);
    expect(aBalance).toBeLessThanOrEqual(supplies[0]!);
    expect(provenanceTrail(value.outputAmountWei!)[0]).toContain("aTokenBalance");
  });

  it("values ETH and eETH through the ETH/USD feed, and says so in the expression", () => {
    const stake = result.blockValues["stake1"]!;
    expect(stake.inputAsset).toBe("ETH");
    expect(stake.outputAsset).toBe("eETH");
    const inTrail = provenanceTrail(stake.inputValueBase!).join("\n");
    const outTrail = provenanceTrail(stake.outputValueBase!).join("\n");
    expect(inTrail).toContain("ETH ≡ WETH by wrap");
    expect(outTrail).toContain("eETH ≡ ETH 1:1");
    for (const trail of [inTrail, outTrail]) {
      expect(trail).toContain("Oracle.getAssetPrice(WETH)");
    }
  });

  it("quotes no gas anywhere in P2", () => {
    expect(result.gasCostBase).toBeNull();
    for (const [id, value] of Object.entries(result.blockValues)) {
      expect(value.gasCostBase, `${id} gas`).toBeNull();
    }
  });
});

// ————————————————————————— §6.4 determinism and provenance honesty —————————————————————————

describe("determinism and provenance honesty", () => {
  it("is a pure function of its two arguments, provenance trees included", () => {
    const graph = flagshipGraph("10", 7000);
    expect(simulate(graph, snapshot)).toEqual(simulate(graph, snapshot));
    expect(provenanceTrail(simulate(graph, snapshot).minHealthFactor)).toEqual(
      provenanceTrail(simulate(graph, snapshot).minHealthFactor),
    );
  });

  it("reads the same snapshot the same way regardless of a fresh fixture instance", () => {
    const graph = flagshipGraph("10", 7000);
    expect(simulate(graph, fixtureSnapshot())).toEqual(simulate(graph, fixtureSnapshot()));
  });

  it("has every observed leaf at the pinned block — a drifted observation would fail here", () => {
    const result = simulate(flagshipGraph("10", 7000), snapshot);
    const wrappers: Array<Provenanced<unknown> | null> = [
      result.minHealthFactor,
      result.finalHealthFactor,
      result.initialAmountWei,
      result.liquidationRatioWad,
      result.leverageWad,
    ];
    for (const value of Object.values(result.blockValues)) {
      wrappers.push(
        value.inputAmountWei,
        value.inputValueBase,
        value.outputAmountWei,
        value.outputValueBase,
        value.apyWad,
      );
    }
    for (const wrapper of wrappers) {
      if (wrapper === null) continue;
      const blocks = [...observedBlocks(wrapper)];
      // Either a pure derivation over entered input, or observations from ONE block: this
      // commit has no cross-block quantity at all.
      expect(blocks.length).toBeLessThanOrEqual(1);
      for (const block of blocks) expect(block).toBe(PINNED_BLOCK);
    }
  });

  it("mints only derived quantities — it never forges an observation", () => {
    const result = simulate(flagshipGraph("10", 7000), snapshot);
    // The entered input amount is passed through from plan.ts; everything risk.ts mints
    // itself is a derivation over provenanced inputs.
    expect(result.initialAmountWei!.kind).toBe("entered");
    for (const wrapper of [
      result.minHealthFactor,
      result.finalHealthFactor,
      result.liquidationRatioWad!,
      result.leverageWad!,
      result.blockValues["supply1"]!.apyWad!,
      result.blockValues["supply1"]!.inputValueBase!,
      result.blockValues["supply1"]!.outputAmountWei!,
    ]) {
      expect(wrapper.kind).toBe("derived");
    }
  });
});
