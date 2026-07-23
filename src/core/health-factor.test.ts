import { describe, it, expect } from "vitest";
import { WAD } from "./format";
import {
  usdBase,
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

describe("wadDiv (Aave half-up)", () => {
  it("rounds half-up and rejects zero", () => {
    expect(wadDiv(1n, 2n)).toBe(WAD / 2n); // (1e18 + 1)/2 → 5e17
    expect(() => wadDiv(1n, 0n)).toThrow(RangeError);
  });
});

describe("usdBase", () => {
  it("prices a 1-token position at its oracle price", () => {
    expect(usdBase(WAD, PRICE_WEETH)).toBe(PRICE_WEETH);
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
    const collBase = usdBase(WAD, PRICE_WEETH);
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
    const debtBase = (usdBase(WAD, PRICE_WEETH) * 70n) / 100n;
    const debtWei = (debtBase * WAD) / PRICE_WETH;
    const rLiq = liquidationRatioWad(supplyWei, debtWei, EMODE_LT_BPS);
    const rNow = (PRICE_WEETH * WAD) / PRICE_WETH;
    expect(rLiq).toBeLessThan(rNow);
    const move = ratioMoveToLiquidationWad(rNow, rLiq);
    expect(move).toBeLessThan((-25n * WAD) / 100n);
    expect(move).toBeGreaterThan((-28n * WAD) / 100n);
  });

  it("ceiling rounding is conservative (never divides by a floored zero)", () => {
    // tiny collateral that would floor to zero under collWei·LT/WAD
    expect(() => liquidationRatioWad(1n, 1n, 9500)).not.toThrow();
    expect(liquidationRatioWad(1n, 1n, 9500)).toBeGreaterThan(0n);
  });

  it("rejects degenerate positions and thresholds", () => {
    expect(() => liquidationRatioWad(0n, 1n, 9500)).toThrow(RangeError);
    expect(() => liquidationRatioWad(1n, 0n, 9500)).toThrow(RangeError);
    expect(() => liquidationRatioWad(1n, 1n, 0)).toThrow(RangeError);
    expect(() => liquidationRatioWad(1n, 1n, 10_001)).toThrow(RangeError);
    expect(() => ratioMoveToLiquidationWad(0n, 1n)).toThrow(RangeError);
  });
});
