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
 * Where value comes to rest, as fractions of the base value that entered. Cash is the residual.
 *
 * These are MEASURED (`risk.ts` divides realized base values by realized base values), so the
 * two need not sum to 1: a supplied position marked below the equity that bought it leaves a
 * remainder that is neither a sink nor cash. `netApyWad` never touches that remainder.
 */
export interface SinkFractions {
  readonly suppliedWad: bigint;
  readonly stakedWad: bigint;
}

/**
 * Net APY (WAD) of one iteration, normalized to initial equity (SPEC §5.2). All rates are WAD
 * APYs; every magnitude is a REALIZED exposure per unit of initial equity, measured by
 * `risk.ts` off the plan's own amounts through the oracle (never off the edge allocations).
 *
 *   r_coll  = (1 + r_stake)(1 + r_supply) − 1       (compounds on supplied collateral)
 *   netAPY  = p_s·r_coll + p_k·r_stake
 *           + q_s·b_eff·r_coll + q_k·b_eff·r_stake
 *           − b_eff·r_debt
 *
 * RATES ON EXPOSURES — the form, and why it is not the value-after decomposition it replaces.
 * The earlier form summed the value of the position AFTER one year and subtracted 1:
 * `(p_s + q_s·b_eff)(1 + r_coll) + … + p_c − b_eff(1 + r_debt) − 1`. That is only equal to
 * this one when the fractions sum to exactly 1. They do not: `p_*` and `q_*` are now measured
 * from realized amounts through the Aave Oracle, and the sum falls short of 1 whenever the
 * conversion floors bite or the capped weETH feed diverges from `weETH.getRate` (a live
 * property — `docs/protocol-matrix.md` §2.5). The value-after form nets that instantaneous
 * mark-to-market gap INTO the run-rate: a 1% divergence subtracts about a point of "yield"
 * that no rate earned or paid. A mark is not a yield. Applying each rate to the exposure that
 * actually earns it keeps the two facts separate, and only the run-rate is published here.
 *
 * THE BORROWED VALUE HAS THREE POSSIBLE FATES, and they earn three different rates. `q_s` is
 * the fraction re-SUPPLIED as Aave collateral (earning the full `r_coll`), `q_k` the fraction
 * left in a STAKED position — eETH or weETH, which accrue staking yield whether or not anyone
 * supplies them (earning `r_stake`), and `q_c` the residual genuinely held as CASH: the
 * borrowed token itself, or ETH after an unwrap (earning nothing).
 *
 * WHY THREE AND NOT TWO. A two-way split — "recycled or not" — prices a document ending
 * `borrow → unwrap → stake` as if the borrowed value were idle, when it is sitting in eETH
 * earning the staking rate. That omits `b·r_stake`, which at the flagship's own fixture is
 * about 1.65 percentage points of real return reported as zero. The fix is not a tolerance:
 * it is naming the third fate.
 *
 * WHY THESE RATES NEED NO NEW READS. `r_stake`, `r_supply` and `r_debt` are already the three
 * legs `compositionLegsOf` requires before any composition is published, so every sink below
 * prices off a leg that must already have resolved. A sink whose rate was NOT in that set would
 * have to refuse instead — which is what an unrecognized block kind does.
 *
 * The cash fractions are credited NO yield and appear in no term: the document does not deploy
 * that value, and this function does not guess what a holder might do with it.
 *
 * `b_eff` is the borrow's realized base value per unit of equity — NOT `b` and not `b·p_s`.
 * Those were allocation-nominal readings; the plan sizes debt from token amounts that pass
 * through conversion floors and the borrowed reserve's own oracle, so the exposure the position
 * actually carries is measured, not multiplied out.
 *
 * Incentives/points are excluded by construction (not a parameter).
 */
export function netApyWad(
  equity: SinkFractions,
  borrowed: SinkFractions,
  bEffWad: bigint,
  rStakeApyWad: bigint,
  rSupplyApyWad: bigint,
  rDebtApyWad: bigint,
): bigint {
  const rColl = mulWad(WAD + rStakeApyWad, WAD + rSupplyApyWad) - WAD;
  const suppliedFromBorrow = mulWad(borrowed.suppliedWad, bEffWad);
  const stakedFromBorrow = mulWad(borrowed.stakedWad, bEffWad);
  return (
    mulWad(equity.suppliedWad, rColl) +
    mulWad(equity.stakedWad, rStakeApyWad) +
    mulWad(suppliedFromBorrow, rColl) +
    mulWad(stakedFromBorrow, rStakeApyWad) -
    mulWad(bEffWad, rDebtApyWad)
  );
}

// Aave v3.7 accounting math, implemented byte-exactly from the deployed
// revision's sources (aave-dao/aave-v3-origin; revision evidence in
// docs/protocol-matrix.md §2):
//   math/WadRayMath.sol            rayMul half-up; Floor/Ceil directional variants
//   math/MathUtils.sol             calculateLinearInterest / calculateCompoundedInterest
//   logic/ReserveLogic.sol         _updateIndexes applies factors with half-up rayMul
//   helpers/TokenMath.sol          aToken balances rayMulFloor, vToken balances rayMulCeil
// The rates.test.ts accrual suite reproduces the committed reads log from these
// definitions, pinning them empirically to on-chain state at the fixture block.

const HALF_RAY = RAY / 2n;

function requireUnsigned(a: bigint, b: bigint): void {
  if (a < 0n || b < 0n) throw new RangeError("ray math operands must be non-negative");
}

function requireDivisor(b: bigint): void {
  if (b === 0n) throw new RangeError("ray division by zero");
}

/** WadRayMath.rayMul — half-up. Index accrual only; balances use the directional variants. */
export function rayMul(a: bigint, b: bigint): bigint {
  requireUnsigned(a, b);
  return (a * b + HALF_RAY) / RAY;
}

/** WadRayMath.rayMulFloor — v3.7 aToken-balance rounding. */
export function rayMulFloor(a: bigint, b: bigint): bigint {
  requireUnsigned(a, b);
  return (a * b) / RAY;
}

/** WadRayMath.rayMulCeil — v3.7 vToken-balance rounding. */
export function rayMulCeil(a: bigint, b: bigint): bigint {
  requireUnsigned(a, b);
  const p = a * b;
  return p / RAY + (p % RAY === 0n ? 0n : 1n);
}

/** WadRayMath.rayDivFloor — v3.7 aToken mint scaling. */
export function rayDivFloor(a: bigint, b: bigint): bigint {
  requireUnsigned(a, b);
  requireDivisor(b);
  return (a * RAY) / b;
}

/** WadRayMath.rayDivCeil — v3.7 vToken mint scaling. */
export function rayDivCeil(a: bigint, b: bigint): bigint {
  requireUnsigned(a, b);
  requireDivisor(b);
  const p = a * RAY;
  return p / b + (p % b === 0n ? 0n : 1n);
}

/**
 * MathUtils.mulDivCeil — ceil(a·b/c). The rounding GenericLogic._getUserDebtInBaseCurrency
 * applies when converting a vToken debt balance into oracle base currency
 * (`MathUtils.mulDivCeil(userTotalDebt, assetPrice, assetUnit)`), upward so the protocol
 * never under-accounts debt. Ported byte-exactly; `core/borrow-limit.ts` consumes it for
 * the SPEC §3 step-4 comparison so the client can never accept a borrow the pool rejects.
 */
export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  requireUnsigned(a, b);
  requireDivisor(c);
  const p = a * b;
  return p / c + (p % c === 0n ? 0n : 1n);
}

function requireOrderedTimestamps(lastUpdateTs: bigint, currentTs: bigint): void {
  if (currentTs < lastUpdateTs) {
    throw new RangeError("current timestamp precedes lastUpdateTimestamp");
  }
}

/** MathUtils.calculateLinearInterest: RAY + rate·Δt/SECONDS_PER_YEAR (floor division). */
function linearInterestFactorRay(rateRay: bigint, lastUpdateTs: bigint, currentTs: bigint): bigint {
  requireUnsigned(rateRay, rateRay);
  requireOrderedTimestamps(lastUpdateTs, currentTs);
  return RAY + (rateRay * (currentTs - lastUpdateTs)) / SECONDS_PER_YEAR;
}

/**
 * MathUtils.calculateCompoundedInterest, v3.7 Taylor form:
 * x = rate·Δt/SECONDS_PER_YEAR; factor = RAY + x + rayMul(x, x/2 + rayMul(x, x/6)).
 */
function compoundedInterestFactorRay(
  rateRay: bigint,
  lastUpdateTs: bigint,
  currentTs: bigint,
): bigint {
  requireUnsigned(rateRay, rateRay);
  requireOrderedTimestamps(lastUpdateTs, currentTs);
  const exp = currentTs - lastUpdateTs;
  if (exp === 0n) return RAY;
  const x = (rateRay * exp) / SECONDS_PER_YEAR;
  return RAY + x + rayMul(x, x / 2n + rayMul(x, x / 6n));
}

/** ReserveLogic._updateIndexes: nextLiquidityIndex = linearFactor.rayMul(liquidityIndex). */
export function accruedLiquidityIndexRay(
  rateRay: bigint,
  indexRay: bigint,
  lastUpdateTs: bigint,
  currentTs: bigint,
): bigint {
  return rayMul(linearInterestFactorRay(rateRay, lastUpdateTs, currentTs), indexRay);
}

/** ReserveLogic._updateIndexes: nextVariableBorrowIndex = compoundedFactor.rayMul(index). */
export function accruedVariableBorrowIndexRay(
  rateRay: bigint,
  indexRay: bigint,
  lastUpdateTs: bigint,
  currentTs: bigint,
): bigint {
  return rayMul(compoundedInterestFactorRay(rateRay, lastUpdateTs, currentTs), indexRay);
}

/** TokenMath.getATokenBalance: scaled.rayMulFloor(liquidityIndex). */
export function aTokenBalance(scaledAmount: bigint, liquidityIndexRay: bigint): bigint {
  return rayMulFloor(scaledAmount, liquidityIndexRay);
}

/** TokenMath.getVTokenBalance: scaled.rayMulCeil(variableBorrowIndex). */
export function vTokenBalance(scaledAmount: bigint, variableBorrowIndexRay: bigint): bigint {
  return rayMulCeil(scaledAmount, variableBorrowIndexRay);
}

/** PercentageMath.percentMul — half-up at PERCENTAGE_FACTOR (1e4). */
function percentMul(a: bigint, bps: bigint): bigint {
  return (a * bps + 5_000n) / 10_000n;
}

/** WadRayMath.rayDiv — half-up (the strategy's usage-ratio rounding). */
function rayDivHalfUp(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError("ray division by zero");
  return (a * RAY + b / 2n) / b;
}

export interface CurrentRatesInput {
  readonly strategy: RateStrategyBps;
  readonly reserveFactorBps: number;
  /** vToken balance at the rate-setting index (scaled debt, ceil rounding). */
  readonly totalDebtWei: bigint;
  readonly virtualUnderlyingBalance: bigint;
  readonly liquidityAddedWei: bigint;
  readonly liquidityTakenWei: bigint;
  /** v3.7 passes `reserve.deficit` as the strategy's `unbacked` param. */
  readonly deficitWei: bigint;
}

export interface CurrentRatesRay {
  readonly liquidityRateRay: bigint;
  readonly variableBorrowRateRay: bigint;
}

/**
 * DefaultReserveInterestRateStrategyV2.calculateInterestRates, byte-exact from
 * the deployed revision's source (aave-dao/aave-v3-origin
 * src/contracts/misc/DefaultReserveInterestRateStrategyV2.sol):
 *
 *   borrowU  = totalDebt.rayDiv(virtual + added − taken + totalDebt)
 *   supplyU  = totalDebt.rayDiv(virtual + added − taken + totalDebt + unbacked)
 *   varRate  = U ≤ Uopt ? base + slope1.rayMul(U).rayDiv(Uopt)
 *                       : base + slope1 + slope2.rayMul((U−Uopt).rayDiv(RAY−Uopt))
 *   liqRate  = varRate.rayMul(supplyU).percentMul(1e4 − reserveFactor)
 *
 * with bps strategy params rayified as bps·RAY/1e4 and `unbacked` fed from the
 * v3.7 reserve deficit (ReserveLogic.updateInterestRatesAndVirtualBalance).
 * The rates.test.ts reproduction suite pins this against the recorded current
 * rates at the fixture block.
 */
export function currentRatesRay(input: CurrentRatesInput): CurrentRatesRay {
  const bpsToRay = (bps: number): bigint => (BigInt(bps) * RAY) / 10_000n;
  const base = bpsToRay(input.strategy.baseVariableBorrowRate);
  const slope1 = bpsToRay(input.strategy.variableRateSlope1);
  const slope2 = bpsToRay(input.strategy.variableRateSlope2);
  const uOpt = bpsToRay(input.strategy.optimalUsageRatio);
  if (input.totalDebtWei === 0n) {
    return { liquidityRateRay: 0n, variableBorrowRateRay: base };
  }
  const availableLiquidity =
    input.virtualUnderlyingBalance + input.liquidityAddedWei - input.liquidityTakenWei;
  if (availableLiquidity < 0n) {
    throw new RangeError("liquidity taken exceeds available liquidity");
  }
  const availablePlusDebt = availableLiquidity + input.totalDebtWei;
  const borrowUsageRay = rayDivHalfUp(input.totalDebtWei, availablePlusDebt);
  const supplyUsageRay = rayDivHalfUp(input.totalDebtWei, availablePlusDebt + input.deficitWei);
  let variableBorrowRateRay = base;
  if (borrowUsageRay > uOpt) {
    const excessRay = rayDivHalfUp(borrowUsageRay - uOpt, RAY - uOpt);
    variableBorrowRateRay += slope1 + rayMul(slope2, excessRay);
  } else {
    variableBorrowRateRay += rayDivHalfUp(rayMul(slope1, borrowUsageRay), uOpt);
  }
  const liquidityRateRay = percentMul(
    rayMul(variableBorrowRateRay, supplyUsageRay),
    10_000n - BigInt(input.reserveFactorBps),
  );
  return { liquidityRateRay, variableBorrowRateRay };
}
