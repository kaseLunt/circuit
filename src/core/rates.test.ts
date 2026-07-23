import { describe, it, expect } from "vitest";
import { WAD, RAY } from "./format";
import {
  mulWad,
  rayRateToWad,
  rayAprToApyWad,
  trailingAprWad,
  bpsToWad,
  variableBorrowAprRay,
  netApyWad,
  SECONDS_PER_YEAR,
  rayMul,
  rayMulFloor,
  rayMulCeil,
  rayDivFloor,
  rayDivCeil,
  accruedLiquidityIndexRay,
  accruedVariableBorrowIndexRay,
  aTokenBalance,
  vTokenBalance,
  type RateStrategyBps,
} from "./rates";
import { PINNED_TS, bigRead, tupleBig } from "../../tests/helpers/protocol-reads";

const pctWad = (p: number) => (BigInt(Math.round(p * 100)) * WAD) / 10_000n; // p% → WAD

describe("fixed-point helpers", () => {
  it("mulWad multiplies two WAD fractions", () => {
    expect(mulWad(WAD / 2n, WAD / 2n)).toBe(WAD / 4n); // 0.5 * 0.5 = 0.25
  });
  it("rayRateToWad rescales RAY→WAD", () => {
    expect(rayRateToWad(RAY / 20n)).toBe(WAD / 20n); // 5% either scale
  });
  it("bpsToWad converts basis points", () => {
    expect(bpsToWad(250)).toBe((25n * WAD) / 1000n); // 2.5%
  });
});

describe("rayAprToApyWad", () => {
  it("APY exceeds APR and stays close at low rates", () => {
    const aprRay = RAY / 20n; // 5% APR
    const apy = rayAprToApyWad(aprRay);
    // e^0.05 - 1 ≈ 0.051271; third-order ≈ 0.0512708
    expect(apy).toBeGreaterThan(pctWad(5));
    expect(apy).toBeLessThan(pctWad(5.2));
  });
  it("zero APR yields zero APY", () => {
    expect(rayAprToApyWad(0n)).toBe(0n);
  });
});

describe("trailingAprWad", () => {
  it("annualizes a 7-day exchange-rate delta", () => {
    // +0.1% over 7 days → ~5.21% APR
    const before = WAD;
    const now = WAD + WAD / 1000n;
    const week = 7n * 24n * 60n * 60n;
    const apr = trailingAprWad(now, before, week);
    expect(apr).toBeGreaterThan(pctWad(5));
    expect(apr).toBeLessThan(pctWad(5.4));
  });
  it("rejects non-positive endpoints", () => {
    expect(() => trailingAprWad(WAD, 0n, 1n)).toThrow(RangeError);
    expect(() => trailingAprWad(WAD, WAD, 0n)).toThrow(RangeError);
  });
});

describe("variableBorrowAprRay (matrix WETH strategy)", () => {
  // WETH strategy from docs/protocol-matrix.md §4.
  const weth: RateStrategyBps = {
    optimalUsageRatio: 9200,
    baseVariableBorrowRate: 0,
    variableRateSlope1: 235,
    variableRateSlope2: 600,
  };
  it("at optimal utilization equals base + slope1", () => {
    const apr = variableBorrowAprRay(weth, bpsToWad(9200));
    expect(rayRateToWad(apr)).toBe(bpsToWad(235)); // base 0 + slope1 2.35%
  });
  it("below optimal scales slope1 linearly", () => {
    const apr = variableBorrowAprRay(weth, bpsToWad(4600)); // half of optimal
    expect(rayRateToWad(apr)).toBe(bpsToWad(235) / 2n); // ~1.175%
  });
  it("above optimal adds slope2", () => {
    const aprOpt = rayRateToWad(variableBorrowAprRay(weth, bpsToWad(9200)));
    const aprHigh = rayRateToWad(variableBorrowAprRay(weth, WAD)); // 100% util
    expect(aprHigh).toBe(aprOpt + bpsToWad(600)); // + full slope2
  });
});

describe("variableBorrowAprRay — invalid domains rejected (not masked)", () => {
  const weth: RateStrategyBps = {
    optimalUsageRatio: 9200,
    baseVariableBorrowRate: 0,
    variableRateSlope1: 235,
    variableRateSlope2: 600,
  };
  it("rejects utilization outside [0,1]", () => {
    expect(() => variableBorrowAprRay(weth, -1n)).toThrow(RangeError);
    expect(() => variableBorrowAprRay(weth, WAD + 1n)).toThrow(RangeError);
  });
  it("rejects optimalUsageRatio of 0 or 100%", () => {
    expect(() => variableBorrowAprRay({ ...weth, optimalUsageRatio: 0 }, 0n)).toThrow(RangeError);
    expect(() => variableBorrowAprRay({ ...weth, optimalUsageRatio: 10_000 }, WAD)).toThrow(RangeError);
  });
});

describe("netApyWad (§5.2 leveraged-restake)", () => {
  it("unlevered (b=0) equals collateral compound", () => {
    const net = netApyWad(0n, pctWad(3), pctWad(2), pctWad(2.5));
    // (1.03)(1.02) - 1 = 0.0506
    expect(net).toBeGreaterThan(pctWad(5));
    expect(net).toBeLessThan(pctWad(5.1));
  });

  it("exact fixture: b=0.5, stake 3%, supply 2%, debt 2.5% → 0.0634e18", () => {
    // rColl=(1.03)(1.02)-1=0.0506; (1.5)(1.0506)-0.5(1.025)-1 = 0.0634 exactly
    expect(netApyWad(WAD / 2n, pctWad(3), pctWad(2), pctWad(2.5))).toBe(63_400_000_000_000_000n);
  });
  it("leverage amplifies a positive carry", () => {
    const unlev = netApyWad(0n, pctWad(3), pctWad(2), pctWad(2.5));
    const lev = netApyWad(WAD / 2n, pctWad(3), pctWad(2), pctWad(2.5));
    expect(lev).toBeGreaterThan(unlev); // positive carry → leverage helps
  });
  it("negative carry makes leverage hurt", () => {
    // borrow rate above collateral yield
    const lev = netApyWad(WAD / 2n, pctWad(1), pctWad(1), pctWad(8));
    const unlev = netApyWad(0n, pctWad(1), pctWad(1), pctWad(8));
    expect(lev).toBeLessThan(unlev);
  });
});

describe("SECONDS_PER_YEAR", () => {
  it("is the Aave constant", () => {
    expect(SECONDS_PER_YEAR).toBe(31_536_000n);
  });
});

// AaveProtocolDataProvider.getReserveData tuple layout (scripts/protocol-reads.mjs):
// [5] liquidityRate · [6] variableBorrowRate · [9] liquidityIndex ·
// [10] variableBorrowIndex · [11] lastUpdateTimestamp
function reserveAccrual(sym: "WETH" | "weETH") {
  const label = `${sym}.getReserveData`;
  return {
    liquidityRate: tupleBig(label, 5),
    variableBorrowRate: tupleBig(label, 6),
    liquidityIndex: tupleBig(label, 9),
    variableBorrowIndex: tupleBig(label, 10),
    lastUpdateTimestamp: tupleBig(label, 11),
  };
}

const HALF_RAY = RAY / 2n;

describe("aave v3.7 ray roundings (WadRayMath)", () => {
  it("rayMul rounds half-up; Floor/Ceil are directional", () => {
    expect(rayMul(3n, HALF_RAY)).toBe(2n); // 1.5 rounds up
    expect(rayMulFloor(3n, HALF_RAY)).toBe(1n);
    expect(rayMulCeil(3n, HALF_RAY)).toBe(2n);
    expect(rayMulCeil(2n, HALF_RAY)).toBe(1n); // exact — no bump
  });

  it("multiplying by RAY is the identity in every variant", () => {
    const x = 123456789123456789123456789n;
    expect(rayMul(x, RAY)).toBe(x);
    expect(rayMulFloor(x, RAY)).toBe(x);
    expect(rayMulCeil(x, RAY)).toBe(x);
  });

  it("rayDiv floor/ceil bracket an inexact quotient", () => {
    const third = 333333333333333333333333333n; // floor(RAY / 3)
    expect(rayDivFloor(1n, 3n)).toBe(third);
    expect(rayDivCeil(1n, 3n)).toBe(third + 1n);
    expect(rayDivCeil(2n, 2n)).toBe(RAY); // exact — no bump
  });

  it("rejects zero divisors and negative operands instead of defaulting", () => {
    expect(() => rayDivFloor(1n, 0n)).toThrow(RangeError);
    expect(() => rayDivCeil(1n, 0n)).toThrow(RangeError);
    expect(() => rayMulFloor(-1n, RAY)).toThrow(RangeError);
    expect(() => rayMul(RAY, -1n)).toThrow(RangeError);
  });
});

describe("v3.7 index accrual reproduces the pinned reads log exactly", () => {
  // The committed log records scaled AND display totalSupply at the pinned block,
  // plus rate/index/lastUpdateTimestamp. Reproducing display from scaled pins the
  // whole chain — linear/compounded factor (MathUtils), half-up index rayMul
  // (ReserveLogic._updateIndexes), and v3.7 TokenMath directional balance
  // roundings — against the deployed contracts rather than invented fixtures.
  // WETH accrues over 60s, weETH over 11,760s.
  for (const sym of ["WETH", "weETH"] as const) {
    it(`${sym}: aToken totalSupply == scaled.rayMulFloor(accrued liquidity index)`, () => {
      const a = reserveAccrual(sym);
      const idx = accruedLiquidityIndexRay(
        a.liquidityRate,
        a.liquidityIndex,
        a.lastUpdateTimestamp,
        PINNED_TS,
      );
      expect(aTokenBalance(bigRead(`${sym}.aToken.scaledTotalSupply`), idx)).toBe(
        bigRead(`${sym}.aToken.totalSupply`),
      );
    });

    it(`${sym}: variableDebt totalSupply == scaled.rayMulCeil(accrued borrow index)`, () => {
      const a = reserveAccrual(sym);
      const idx = accruedVariableBorrowIndexRay(
        a.variableBorrowRate,
        a.variableBorrowIndex,
        a.lastUpdateTimestamp,
        PINNED_TS,
      );
      expect(vTokenBalance(bigRead(`${sym}.variableDebtToken.scaledTotalSupply`), idx)).toBe(
        bigRead(`${sym}.variableDebtToken.totalSupply`),
      );
    });
  }

  it("zero elapsed time leaves both indices unchanged", () => {
    const a = reserveAccrual("WETH");
    expect(
      accruedLiquidityIndexRay(
        a.liquidityRate,
        a.liquidityIndex,
        a.lastUpdateTimestamp,
        a.lastUpdateTimestamp,
      ),
    ).toBe(a.liquidityIndex);
    expect(
      accruedVariableBorrowIndexRay(
        a.variableBorrowRate,
        a.variableBorrowIndex,
        a.lastUpdateTimestamp,
        a.lastUpdateTimestamp,
      ),
    ).toBe(a.variableBorrowIndex);
  });

  it("a current timestamp before lastUpdateTimestamp is rejected", () => {
    const a = reserveAccrual("WETH");
    expect(() =>
      accruedLiquidityIndexRay(
        a.liquidityRate,
        a.liquidityIndex,
        a.lastUpdateTimestamp,
        a.lastUpdateTimestamp - 1n,
      ),
    ).toThrow(RangeError);
    expect(() =>
      accruedVariableBorrowIndexRay(
        a.variableBorrowRate,
        a.variableBorrowIndex,
        a.lastUpdateTimestamp,
        a.lastUpdateTimestamp - 1n,
      ),
    ).toThrow(RangeError);
  });
});
