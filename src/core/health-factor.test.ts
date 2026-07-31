import { describe, it, expect } from "vitest";
import { WAD } from "./format";
import {
  assetUnitOf,
  collateralBaseValue,
  debtBaseValue,
  wadDiv,
  computeHealthFactor,
  hfWadValue,
  riskState,
  liquidationRatioWad,
  ratioMoveToLiquidationWad,
  HF_NO_DEBT,
  type CollateralEntry,
} from "./health-factor";

// Matrix §5 prices (base8) and e-mode §3 LT.
const PRICE_WEETH = 211_593_732_385n;
const PRICE_WETH = 192_386_686_200n;
const EMODE_LT_BPS = 9500;
/** Matrix §4: weETH/WETH are 18-decimal reserves; USDC is six. */
const UNIT_18 = assetUnitOf(18);
const UNIT_6 = assetUnitOf(6);

describe("wadDiv (Aave half-up)", () => {
  it("rounds half-up and rejects zero", () => {
    expect(wadDiv(1n, 2n)).toBe(WAD / 2n); // (1e18 + 1)/2 → 5e17
    expect(() => wadDiv(1n, 0n)).toThrow(RangeError);
  });
});

describe("base valuation — GenericLogic's two forms, at the reserve's own assetUnit", () => {
  it("prices a 1-token position at its oracle price, on both sides", () => {
    expect(collateralBaseValue(WAD, PRICE_WEETH, UNIT_18)).toBe(PRICE_WEETH);
    expect(debtBaseValue(WAD, PRICE_WEETH, UNIT_18)).toBe(PRICE_WEETH);
  });

  it("values a six-decimal amount at 1e6, not 1e18 (the trap the 18-dec form hid)", () => {
    // 1,000 USDC at the pinned block's capped feed. Hand-computed:
    // floor(1000e6 × 99989420 / 1e6) = 99_989_420_000 base8 ≈ $999.894 — NOT $1,000.
    const oneThousandUsdc = 1_000n * UNIT_6;
    const cappedUsdcPrice = 99_989_420n;
    expect(collateralBaseValue(oneThousandUsdc, cappedUsdcPrice, UNIT_6)).toBe(99_989_420_000n);
    // The 18-decimal divisor would have valued the same position at zero — the silent
    // under-accounting an assetUnit-blind form produces on a six-decimal reserve.
    expect(collateralBaseValue(oneThousandUsdc, cappedUsdcPrice, UNIT_18)).toBe(0n);
  });

  it("collateral floors and debt ceils — the protocol's own asymmetry, not a style choice", () => {
    // 1 wei at a price that does not divide the unit: floor → 0, ceil → 1.
    expect(collateralBaseValue(1n, 1n, UNIT_6)).toBe(0n);
    expect(debtBaseValue(1n, 1n, UNIT_6)).toBe(1n);
    // Exact division agrees: the directions differ only where a remainder exists.
    expect(collateralBaseValue(UNIT_6, 5n, UNIT_6)).toBe(debtBaseValue(UNIT_6, 5n, UNIT_6));
  });

  it("refuses a non-positive unit and an out-of-range decimals rather than defaulting", () => {
    expect(() => collateralBaseValue(1n, 1n, 0n)).toThrow(RangeError);
    expect(() => debtBaseValue(1n, 1n, 0n)).toThrow(RangeError);
    expect(() => assetUnitOf(-1)).toThrow(RangeError);
    expect(() => assetUnitOf(37)).toThrow(RangeError);
    expect(() => assetUnitOf(6.5)).toThrow(RangeError);
  });
});

describe("computeHealthFactor — replicates Aave GenericLogic", () => {
  it("no debt → no-debt status (never a number)", () => {
    const c: CollateralEntry[] = [{ base: PRICE_WEETH, ltBps: EMODE_LT_BPS }];
    expect(computeHealthFactor(c, 0n)).toEqual({ status: "no-debt" });
  });

  it("null snapshot → unknown, never safe", () => {
    expect(computeHealthFactor(null, 100n).status).toBe("unknown");
    expect(computeHealthFactor([], null).status).toBe("unknown");
  });

  it("out-of-range ltBps → unknown", () => {
    expect(computeHealthFactor([{ base: 1n, ltBps: 10_001 }], 1n).status).toBe("unknown");
  });

  it("boundary {base:1, ltBps:9999}, debt:1 → 0.9999e18 (matches on-chain GenericLogic)", () => {
    // weighted=9999; wadDiv(9999,1)/10000 = 9999e18/10000 = 0.9999e18
    const hf = computeHealthFactor([{ base: 1n, ltBps: 9999 }], 1n);
    expect(hfWadValue(hf)).toBe((9999n * WAD) / 10_000n);
  });

  it("zero collateral with debt → HF 0 (liquidatable, not unknown)", () => {
    const hf = computeHealthFactor([], 100n);
    expect(hf.status).toBe("healthy");
    expect(hfWadValue(hf)).toBe(0n);
  });

  it("exact HF=1.0 boundary fixture", () => {
    // collateral 1000 base @ LT 100%, debt 1000 → HF exactly 1.0
    const hf = computeHealthFactor([{ base: 1000n, ltBps: 10_000 }], 1000n);
    expect(hfWadValue(hf)).toBe(WAD);
  });

  it("leveraged-loop b=0.7 gives HF≈1.357 (matches boundary review)", () => {
    const collBase = collateralBaseValue(WAD, PRICE_WEETH, UNIT_18);
    const debtBase = (collBase * 70n) / 100n;
    const v = hfWadValue(computeHealthFactor([{ base: collBase, ltBps: EMODE_LT_BPS }], debtBase))!;
    expect(v).toBeGreaterThan((1357n * WAD) / 1000n);
    expect(v).toBeLessThan((1358n * WAD) / 1000n);
  });
});

describe("riskState — tri-state, unknown never collapses to safe", () => {
  it("no-debt is ok", () => {
    expect(riskState(computeHealthFactor([{ base: 1n, ltBps: 9500 }], 0n))).toBe("ok");
    expect(hfWadValue(computeHealthFactor([{ base: 1n, ltBps: 9500 }], 0n))).toBe(HF_NO_DEBT);
  });
  it("unknown is its own state (not ok, not warning)", () => {
    expect(riskState(computeHealthFactor(null, 1n))).toBe("unknown");
  });
  it("HF below 1.5 warns; above does not", () => {
    expect(riskState(computeHealthFactor([{ base: 1300n, ltBps: 10_000 }], 1000n))).toBe("warning");
    expect(riskState(computeHealthFactor([{ base: 3000n, ltBps: 10_000 }], 1000n))).toBe("ok");
  });
});

describe("liquidationRatioWad / ratioMoveToLiquidationWad", () => {
  it("b=0.7 loop liquidates on a ~26% ratio fall", () => {
    const supplyWei = WAD;
    const debtBase = (collateralBaseValue(WAD, PRICE_WEETH, UNIT_18) * 70n) / 100n;
    const debtWei = (debtBase * WAD) / PRICE_WETH;
    const rLiq = liquidationRatioWad(supplyWei, debtWei, EMODE_LT_BPS, UNIT_18, UNIT_18);
    const rNow = (PRICE_WEETH * WAD) / PRICE_WETH;
    expect(rLiq).toBeLessThan(rNow);
    const move = ratioMoveToLiquidationWad(rNow, rLiq);
    expect(move).toBeLessThan((-25n * WAD) / 100n);
    expect(move).toBeGreaterThan((-28n * WAD) / 100n);
  });

  /**
   * THE REDUCTION PROPERTY. The unit generalization may not move a single figure the
   * correlated pair has already had fork-proven, so the claim "the two factors cancel" is
   * checked rather than argued — across every decimals value a reserve could carry, and over
   * a spread of positions and thresholds, against the pre-generalization expression written
   * out longhand.
   */
  it("reduces byte-identically to the single-unit form whenever both units agree", () => {
    const preGeneralization = (collateralWei: bigint, debtWei: bigint, ltBps: number): bigint => {
      const numer = debtWei * 10_000n * WAD;
      const denom = collateralWei * BigInt(ltBps);
      return (numer + denom - 1n) / denom;
    };
    const positions: ReadonlyArray<readonly [bigint, bigint]> = [
      [1n, 1n],
      [WAD, (7n * WAD) / 10n],
      [3n * WAD + 7n, 999_999_999_999_999_999n],
      [123_456_789n, 987_654_321n],
      [10n ** 24n, 10n ** 23n + 1n],
    ];
    for (let decimals = 0; decimals <= 18; decimals += 1) {
      const unit = assetUnitOf(decimals);
      for (const [collateralWei, debtWei] of positions) {
        for (const ltBps of [1, 7800, 8000, 9500, 10_000]) {
          expect(
            liquidationRatioWad(collateralWei, debtWei, ltBps, unit, unit),
            `decimals ${decimals} coll ${collateralWei} debt ${debtWei} lt ${ltBps}`,
          ).toBe(preGeneralization(collateralWei, debtWei, ltBps));
        }
      }
    }
  });

  /**
   * The mixed-unit case, checked against a hand-derived HF = 1 scenario rather than against
   * the formula that produced it.
   *
   * Position: 1 weETH (1e18) collateral at LT 8000 bps (the non-eMode weETH regime) against
   * 1,000 USDC (1e9 six-decimal units) of debt. HF = 1 when
   *   collAmount · P_coll · LT = debtAmount · P_debt
   *   ⇒ 1 · P_coll · 0.8 = 1000 · P_debt
   *   ⇒ P_coll / P_debt = 1250.
   * So R_liq must be 1250 WAD. The un-normalized form would answer 1250e-12 WAD — the 1e12
   * skew, and a number a user would read as "already liquidated".
   */
  it("normalizes a mixed-decimals pair to the true oracle-price ratio", () => {
    const collateralWei = UNIT_18;
    const debtWei = 1_000n * UNIT_6;
    const rLiq = liquidationRatioWad(collateralWei, debtWei, 8000, UNIT_18, UNIT_6);
    expect(rLiq).toBe(1250n * WAD);
    const unNormalized = liquidationRatioWad(collateralWei, debtWei, 8000, UNIT_18, UNIT_18);
    expect(unNormalized * 10n ** 12n).toBe(rLiq);
  });

  it("ceiling rounding is conservative (never divides by a floored zero)", () => {
    // tiny collateral that would floor to zero under collWei·LT/WAD
    expect(() => liquidationRatioWad(1n, 1n, 9500, UNIT_18, UNIT_18)).not.toThrow();
    expect(liquidationRatioWad(1n, 1n, 9500, UNIT_18, UNIT_18)).toBeGreaterThan(0n);
  });

  it("rejects degenerate positions, thresholds and units", () => {
    expect(() => liquidationRatioWad(0n, 1n, 9500, UNIT_18, UNIT_18)).toThrow(RangeError);
    expect(() => liquidationRatioWad(1n, 0n, 9500, UNIT_18, UNIT_18)).toThrow(RangeError);
    expect(() => liquidationRatioWad(1n, 1n, 0, UNIT_18, UNIT_18)).toThrow(RangeError);
    expect(() => liquidationRatioWad(1n, 1n, 10_001, UNIT_18, UNIT_18)).toThrow(RangeError);
    expect(() => liquidationRatioWad(1n, 1n, 9500, 0n, UNIT_18)).toThrow(RangeError);
    expect(() => liquidationRatioWad(1n, 1n, 9500, UNIT_18, 0n)).toThrow(RangeError);
    expect(() => ratioMoveToLiquidationWad(0n, 1n)).toThrow(RangeError);
  });
});
