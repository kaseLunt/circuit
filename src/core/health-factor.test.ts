import { describe, it, expect } from "vitest";
import { WAD } from "./format";
import {
  usdBase,
  computeHealthFactor,
  hfWadValue,
  isWarning,
  liquidationRatioWad,
  ratioMoveToLiquidationWad,
  HF_NO_DEBT,
  HF_WARN_WAD,
  type CollateralEntry,
} from "./health-factor";

// Matrix §5 prices (base8) and e-mode §3 LT.
const PRICE_WEETH = 211_593_732_385n;
const PRICE_WETH = 192_386_686_200n;
const EMODE_LT_BPS = 9500;

describe("usdBase", () => {
  it("prices a 1-token position at its oracle price", () => {
    expect(usdBase(WAD, PRICE_WEETH)).toBe(PRICE_WEETH);
  });
  it("scales with amount", () => {
    expect(usdBase(WAD / 2n, PRICE_WETH)).toBe(PRICE_WETH / 2n);
  });
});

describe("computeHealthFactor", () => {
  it("no debt → no-debt status (never a number)", () => {
    const c: CollateralEntry[] = [{ base: PRICE_WEETH, ltBps: EMODE_LT_BPS }];
    expect(computeHealthFactor(c, 0n)).toEqual({ status: "no-debt" });
  });

  it("null snapshot → unknown, never safe", () => {
    expect(computeHealthFactor(null, 100n).status).toBe("unknown");
    expect(computeHealthFactor([], null).status).toBe("unknown");
  });

  it("leveraged-loop b=0.7 gives HF≈1.357 (matches boundary-review ~1.36)", () => {
    // supply 1 weETH collateral, borrow 70% of collateral value in WETH.
    const collBase = usdBase(WAD, PRICE_WEETH); // 211593732385
    const debtBase = (collBase * 70n) / 100n;
    const hf = computeHealthFactor([{ base: collBase, ltBps: EMODE_LT_BPS }], debtBase);
    expect(hf.status).toBe("healthy");
    const v = hfWadValue(hf)!;
    // 0.95 / 0.70 = 1.3571…
    expect(v).toBeGreaterThan((135n * WAD) / 100n);
    expect(v).toBeLessThan((136n * WAD) / 100n);
  });

  it("HF exactly at LT/borrow ratio", () => {
    // collateral 1000 base, LT 100%, debt 500 base → HF 2.0
    const hf = computeHealthFactor([{ base: 1000n, ltBps: 10_000 }], 500n);
    expect(hfWadValue(hf)).toBe(2n * WAD);
  });
});

describe("hfWadValue / isWarning", () => {
  it("no-debt maps to the sentinel and is not a warning", () => {
    const hf = computeHealthFactor([{ base: 1n, ltBps: 9500 }], 0n);
    expect(hfWadValue(hf)).toBe(HF_NO_DEBT);
    expect(isWarning(hf)).toBe(false);
  });
  it("unknown is never treated as safe (isWarning false but value null)", () => {
    const hf = computeHealthFactor(null, 1n);
    expect(hfWadValue(hf)).toBeNull();
    expect(isWarning(hf)).toBe(false);
  });
  it("HF below the warning threshold warns", () => {
    // HF 1.3 < 1.5
    const hf = computeHealthFactor([{ base: 1300n, ltBps: 10_000 }], 1000n);
    expect(hfWadValue(hf)).toBeLessThan(HF_WARN_WAD);
    expect(isWarning(hf)).toBe(true);
  });
  it("HF above the warning threshold does not warn", () => {
    const hf = computeHealthFactor([{ base: 3000n, ltBps: 10_000 }], 1000n);
    expect(isWarning(hf)).toBe(false);
  });
});

describe("liquidationRatioWad / ratioMoveToLiquidationWad", () => {
  it("liquidation ratio for the b=0.7 loop is below the current ratio", () => {
    const supplyWei = WAD; // 1 weETH
    const debtWei = (usdBase(WAD, PRICE_WEETH) * 70n) / 100n * WAD / PRICE_WETH;
    const rLiq = liquidationRatioWad(supplyWei, debtWei, EMODE_LT_BPS);
    // current ratio = priceWeETH / priceWETH
    const rNow = (PRICE_WEETH * WAD) / PRICE_WETH;
    expect(rLiq).toBeLessThan(rNow); // needs a fall to liquidate
    const move = ratioMoveToLiquidationWad(rNow, rLiq);
    expect(move).toBeLessThan(0n); // negative = must fall
    // roughly −26% (1 − 0.70/0.95/1.0998·... ) — sanity band
    expect(move).toBeLessThan((-20n * WAD) / 100n);
    expect(move).toBeGreaterThan((-35n * WAD) / 100n);
  });
  it("rejects degenerate positions", () => {
    expect(() => liquidationRatioWad(0n, 1n, 9500)).toThrow(RangeError);
    expect(() => liquidationRatioWad(1n, 0n, 9500)).toThrow(RangeError);
    expect(() => ratioMoveToLiquidationWad(0n, 1n)).toThrow(RangeError);
  });
});
