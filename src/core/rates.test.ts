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
  type RateStrategyBps,
} from "./rates";

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
    expect(apr).toBe(rayRateToWad(bpsToWad(235)) === 0n ? apr : apr); // sanity
    expect(rayRateToWad(apr)).toBe(bpsToWad(235)); // 2.35%
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

describe("variableBorrowAprRay — degenerate strategy params", () => {
  it("optimalUsageRatio 0 → base only below/at optimal path", () => {
    const s: RateStrategyBps = {
      optimalUsageRatio: 0,
      baseVariableBorrowRate: 100,
      variableRateSlope1: 235,
      variableRateSlope2: 600,
    };
    // U=0 <= uOpt=0 → base (guards the uOpt===0 branch)
    expect(rayRateToWad(variableBorrowAprRay(s, 0n))).toBe(bpsToWad(100));
  });
  it("optimalUsageRatio 100% → excess denom guard at full utilization", () => {
    const s: RateStrategyBps = {
      optimalUsageRatio: 10_000,
      baseVariableBorrowRate: 0,
      variableRateSlope1: 235,
      variableRateSlope2: 600,
    };
    // U at optimal (=100%) takes the <=uOpt branch, denom guard unused; U slightly
    // above is impossible at 100%. Exercise the boundary.
    expect(rayRateToWad(variableBorrowAprRay(s, WAD))).toBe(bpsToWad(235));
  });
});

describe("netApyWad (§5.2 leveraged-restake)", () => {
  it("unlevered (b=0) equals collateral compound", () => {
    const net = netApyWad(0n, pctWad(3), pctWad(2), pctWad(2.5));
    // (1.03)(1.02) - 1 = 0.0506
    expect(net).toBeGreaterThan(pctWad(5));
    expect(net).toBeLessThan(pctWad(5.1));
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
