/**
 * Rate math (SPEC §5.1, §5.2). Pure, integer WAD/RAY fixed point.
 *
 * Conventions:
 * - Aave `liquidityRate`/`variableBorrowRate` are per-annum APRs in RAY (1e27).
 * - Internally we work in WAD (1e18) fractions: 1e18 == 100% == 1.0.
 * - APR→APY compounding mirrors Aave's on-chain third-order expansion
 *   (`MathUtils.calculateCompoundedInterest`) evaluated over one year. This is a
 *   defensible current-rate *projection*, not an exact realized supplier APY:
 *   Aave's liquidity index accrues with linear interest, and utilization drifts.
 *   The cubic differs from continuous compounding by <1bp at the rates in play,
 *   below the 2-dp display, and is the same shape Aave uses for the debt index.
 *
 * NOTE (D-004): this module is money-math and is slated for Codex senior review
 * before the P1-exit receipt. The compounding order and the net-APY exposure
 * weighting are the review's focus points.
 */
import { RAY, WAD } from "./format";

export const SECONDS_PER_YEAR = 31_536_000n;

/** a * b / WAD — fixed-point multiply of two WAD fractions (floor). */
export function mulWad(a: bigint, b: bigint): bigint {
  return (a * b) / WAD;
}

/** Convert a RAY per-annum rate to a WAD fraction. */
export function rayRateToWad(rateRay: bigint): bigint {
  return (rateRay * WAD) / RAY;
}

/**
 * APY (WAD fraction) from a RAY per-annum APR, using Aave's third-order
 * compounded-interest expansion over one year:
 *   apy ≈ apr + apr²/2 + apr³/6
 * (t/SECONDS_PER_YEAR = 1 for a full year). This is a current-rate projection
 * shaped like Aave's on-chain debt-index compounding; it is NOT the exact
 * realized supplier APY (Aave's liquidity index accrues linearly). The cubic is
 * within <1bp of continuous compounding at the rates in play — below the 2-dp
 * display.
 */
export function rayAprToApyWad(aprRay: bigint): bigint {
  const apr = rayRateToWad(aprRay); // WAD
  const apr2 = mulWad(apr, apr);
  const apr3 = mulWad(apr2, apr);
  return apr + apr2 / 2n + apr3 / 6n;
}

/**
 * Trailing APR (WAD) annualized from an exchange-rate delta:
 *   growth = (rateNow - rateBefore) / rateBefore     (WAD fraction over the window)
 *   apr    = growth * SECONDS_PER_YEAR / secondsElapsed
 * `rateNow`/`rateBefore` are same-unit exchange rates (e.g. weETH.getRate, WAD).
 * Throws on non-positive inputs — a missing endpoint must surface, never default.
 */
export function trailingAprWad(
  rateNow: bigint,
  rateBefore: bigint,
  secondsElapsed: bigint,
): bigint {
  if (rateNow <= 0n) throw new RangeError("rateNow must be positive");
  if (rateBefore <= 0n) throw new RangeError("rateBefore must be positive");
  if (secondsElapsed <= 0n) throw new RangeError("secondsElapsed must be positive");
  const growthWad = ((rateNow - rateBefore) * WAD) / rateBefore;
  return (growthWad * SECONDS_PER_YEAR) / secondsElapsed;
}

/**
 * Aave linear-kinked variable borrow APR (RAY) from the reserve's
 * interest-rate-strategy bps params and a post-action utilization (WAD).
 * Utilization is total variable debt / (available liquidity + total debt).
 * Below optimal: base + slope1 * U/Uopt. Above: base + slope1 + slope2 * (U-Uopt)/(1-Uopt).
 * bps params: 10000 bps = 100%.
 */
export interface RateStrategyBps {
  readonly optimalUsageRatio: number;
  readonly baseVariableBorrowRate: number;
  readonly variableRateSlope1: number;
  readonly variableRateSlope2: number;
}

/** Convert a bps integer to a WAD fraction (250 bps → 0.025e18). */
export function bpsToWad(bps: number): bigint {
  return (BigInt(bps) * WAD) / 10_000n;
}

/** Convert a WAD fraction to a RAY rate. */
export function wadToRay(wad: bigint): bigint {
  return (wad * RAY) / WAD;
}

/**
 * Post-action variable borrow APR (RAY) at a given utilization (WAD).
 * This is the run-rate the borrow leg pays after our own borrow moves U.
 */
export function variableBorrowAprRay(strategy: RateStrategyBps, utilizationWad: bigint): bigint {
  if (utilizationWad < 0n || utilizationWad > WAD) {
    throw new RangeError("utilization must be within [0, 1] (WAD)");
  }
  const uOpt = bpsToWad(strategy.optimalUsageRatio);
  if (uOpt <= 0n || uOpt >= WAD) {
    throw new RangeError("optimalUsageRatio must be strictly within (0, 100%)");
  }
  const base = bpsToWad(strategy.baseVariableBorrowRate);
  const slope1 = bpsToWad(strategy.variableRateSlope1);
  const slope2 = bpsToWad(strategy.variableRateSlope2);
  let aprWad: bigint;
  if (utilizationWad <= uOpt) {
    aprWad = base + mulWad(slope1, (utilizationWad * WAD) / uOpt);
  } else {
    const excessRatio = ((utilizationWad - uOpt) * WAD) / (WAD - uOpt);
    aprWad = base + slope1 + mulWad(slope2, excessRatio);
  }
  return wadToRay(aprWad);
}

/**
 * Net APY (WAD) of one leveraged-restake iteration, normalized to initial equity
 * (SPEC §5.2). All rates are WAD APYs; `bWad` is the borrow allocation as a
 * fraction of collateral value at open.
 *
 *   r_coll = (1 + r_stake)(1 + r_supply) − 1        (compounds on collateral)
 *   netAPY = (1 + b)(1 + r_coll) − b(1 + r_debt) − 1
 *
 * Incentives/points are excluded by construction (not a parameter).
 */
export function netApyWad(
  bWad: bigint,
  rStakeApyWad: bigint,
  rSupplyApyWad: bigint,
  rDebtApyWad: bigint,
): bigint {
  const one = WAD;
  const rColl = mulWad(one + rStakeApyWad, one + rSupplyApyWad) - one;
  const collLeg = mulWad(one + bWad, one + rColl);
  const debtLeg = mulWad(bWad, one + rDebtApyWad);
  return collLeg - debtLeg - one;
}
