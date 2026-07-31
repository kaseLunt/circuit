/**
 * Health-factor and liquidation math (SPEC §5.4). Pure, integer, WAD/base8.
 *
 * The HF sequence replicates Aave v3.7 `GenericLogic.calculateUserAccountData`
 * exactly — `wadDiv(Σ base·lt, totalDebt) / 10000` (half-up wadDiv) — so
 * `computeHealthFactor` reproduces the on-chain `getUserAccountData().healthFactor`
 * the fork suite cross-checks against. bigint throughout (no float drift near
 * HF=1); explicit no-debt sentinel and unknown state; and, for the correlated
 * weETH/WETH pair, a liquidation *ratio* (matrix §5: weETH is priced by a capped
 * exchange-rate oracle over ETH/USD).
 *
 * NOTE (D-004): money-math — reviewed by Codex; fork cross-check is authoritative.
 */
import { WAD, HF_NO_DEBT } from "./format";
import { mulDivCeil } from "./rates";

export { HF_NO_DEBT };

/**
 * `10^decimals` for a reserve — GenericLogic's `assetUnit`
 * (`GenericLogic.sol:98 @ fd1fbd9`: `assetUnit = 10 ** decimals`), the divisor both base
 * valuations below use. Derived from the reserve's OWN `decimals` observation at every call
 * site; a hard-wired 1e18 is exactly what made the risk path refuse six-decimal reserves.
 */
export function assetUnitOf(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`assetUnit decimals ${decimals} out of range`);
  }
  return 10n ** BigInt(decimals);
}

/** Warning threshold: below this HF the borrow block shows its warning state. */
export const HF_WARN_WAD = (150n * WAD) / 100n; // 1.50, named constant (SPEC §7)

const PERCENTAGE_FACTOR = 10_000n;

/** Aave wadDiv: (a · WAD + b/2) / b, half-up. Throws on zero denominator. */
export function wadDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError("wadDiv denominator must be positive");
  return (a * WAD + b / 2n) / b;
}

/**
 * Oracle base-currency (8-dec) value of a COLLATERAL position, the way
 * `GenericLogic._getUserBalanceInBaseCurrency` values it
 * (`GenericLogic.sol:242-256 @ fd1fbd9`): `floor(amount × price / assetUnit)`. Floors, so the
 * protocol never OVER-accounts collateral.
 *
 * There is exactly one general form for each side and each lives here; `core/risk.ts` selects
 * between them and restates neither. The pair is asymmetric on purpose — the rounding
 * direction is the protocol's own conservatism and copying one side's rounding onto the other
 * is the defect class `core/borrow-limit.ts`'s header names.
 */
export function collateralBaseValue(
  amountWei: bigint,
  priceBase8: bigint,
  assetUnit: bigint,
): bigint {
  if (assetUnit <= 0n) throw new RangeError("assetUnit must be positive");
  return (amountWei * priceBase8) / assetUnit;
}

/**
 * Oracle base-currency (8-dec) value of a DEBT position, the way
 * `GenericLogic._getUserDebtInBaseCurrency` values it (`GenericLogic.sol:219-229 @ fd1fbd9`):
 * `MathUtils.mulDivCeil(userTotalDebt, assetPrice, assetUnit)`. Ceils, so the protocol never
 * UNDER-accounts debt — the same primitive `core/borrow-limit.ts` already consumes for the
 * SPEC §3 step-4 comparison, imported rather than re-derived.
 */
export function debtBaseValue(amountWei: bigint, priceBase8: bigint, assetUnit: bigint): bigint {
  if (assetUnit <= 0n) throw new RangeError("assetUnit must be positive");
  return mulDivCeil(amountWei, priceBase8, assetUnit);
}

export interface CollateralEntry {
  /** Base-currency (8-dec) value of the collateral. */
  readonly base: bigint;
  /** Liquidation threshold in bps (e-mode category threshold when active). */
  readonly ltBps: number;
}

export type HealthFactor =
  | { readonly status: "healthy"; readonly hfWad: bigint }
  | { readonly status: "no-debt" }
  | { readonly status: "unknown"; readonly reason: string };

/** Tri-state risk classification — "unknown" is never collapsed into a safe boolean. */
export type RiskState = "ok" | "warning" | "unknown";

/**
 * Health factor, matching Aave v3.7 GenericLogic EXACTLY (verified against
 * aave-v3-origin GenericLogic.sol, calculateUserAccountData):
 *
 *   weighted     = Σ base_i · lt_i                          (base8 · bps)
 *   healthFactor = wadDiv(weighted, totalDebtBase) / 10000  (WAD, half-up wadDiv)
 *
 * Note: on-chain, `avgLiquidationThreshold` is only divided by total collateral
 * AFTER the HF line, for the returned average — it does NOT feed HF. HF uses the
 * un-averaged weighted sum directly. (A prior revision used percentMul over the
 * averaged LT; that was wrong at boundaries and is corrected here.) debt == 0 →
 * no-debt; any null input → unknown (never silently "safe").
 */
export function computeHealthFactor(
  collateral: readonly CollateralEntry[] | null,
  totalDebtBase: bigint | null,
): HealthFactor {
  if (collateral === null || totalDebtBase === null) {
    return { status: "unknown", reason: "missing collateral or debt snapshot" };
  }
  if (totalDebtBase === 0n) return { status: "no-debt" };

  let weighted = 0n; // Σ base·ltBps
  for (const c of collateral) {
    if (c.ltBps < 0 || c.ltBps > 10_000) {
      return { status: "unknown", reason: `ltBps ${c.ltBps} out of range` };
    }
    weighted += c.base * BigInt(c.ltBps);
  }
  return { status: "healthy", hfWad: wadDiv(weighted, totalDebtBase) / PERCENTAGE_FACTOR };
}

/** Numeric HF for comparisons; no-debt → sentinel, unknown → null. */
export function hfWadValue(hf: HealthFactor): bigint | null {
  if (hf.status === "healthy") return hf.hfWad;
  if (hf.status === "no-debt") return HF_NO_DEBT;
  return null;
}

/**
 * Tri-state risk. "unknown" is returned distinctly so no caller can read a
 * missing snapshot as safe (SPEC §5.4). A boolean gate must branch on this.
 */
export function riskState(hf: HealthFactor): RiskState {
  const v = hfWadValue(hf);
  if (v === null) return "unknown";
  return v < HF_WARN_WAD ? "warning" : "ok";
}

/**
 * Liquidation ratio for a single collateral/debt pair: the collateral/debt ORACLE PRICE ratio
 * (WAD) at which HF reaches 1.
 *
 *   HF = (collWei/unitColl)·priceColl·LT / ((debtWei/unitDebt)·priceDebt) = 1
 *   ⇒ priceColl/priceDebt = debtWei · unitColl / (collWei · unitDebt · LT)
 *   R_liq(WAD) = ceil( debtWei · unitColl · 1e4 · WAD / (collWei · unitDebt · ltBps) )
 *
 * THE TWO ASSET UNITS ARE PARAMETERS, and that is the whole correction. The previous form
 * divided two token amounts directly, which is dimensionally a price ratio only when both
 * sides share a unit. For a weETH(1e18) collateral against USDC(1e6) debt it was skewed by
 * 1e12 — a wrong number on a money surface, minted with full provenance. With `unitColl ==
 * unitDebt` the two factors cancel inside the same integer expression, so the correlated
 * weETH/WETH pair's proven figures are byte-identical to before; `health-factor.test.ts`
 * property-tests that reduction rather than trusting the algebra.
 *
 * Rounded UP (ceiling): a higher liquidation ratio means liquidation triggers on a smaller
 * downward move — conservative for a risk display. Throws on degenerate positions, an invalid
 * threshold, or a non-positive unit (never divides by a floored zero).
 */
export function liquidationRatioWad(
  collateralWei: bigint,
  debtWei: bigint,
  ltBps: number,
  collateralUnit: bigint,
  debtUnit: bigint,
): bigint {
  if (collateralWei <= 0n) throw new RangeError("collateralWei must be positive");
  if (debtWei <= 0n) throw new RangeError("debtWei must be positive");
  if (ltBps <= 0 || ltBps > 10_000) throw new RangeError("ltBps out of range");
  if (collateralUnit <= 0n) throw new RangeError("collateralUnit must be positive");
  if (debtUnit <= 0n) throw new RangeError("debtUnit must be positive");
  const numer = debtWei * collateralUnit * PERCENTAGE_FACTOR * WAD;
  const denom = collateralWei * debtUnit * BigInt(ltBps);
  return (numer + denom - 1n) / denom; // ceiling
}

/**
 * Signed WAD fraction the collateral/debt ratio must move to reach liquidation:
 * (R_liq − R_now) / R_now. Negative ⇒ ratio must fall (the normal case).
 */
export function ratioMoveToLiquidationWad(currentRatioWad: bigint, liqRatioWad: bigint): bigint {
  if (currentRatioWad <= 0n) throw new RangeError("currentRatioWad must be positive");
  return ((liqRatioWad - currentRatioWad) * WAD) / currentRatioWad;
}
