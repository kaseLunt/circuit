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

export { HF_NO_DEBT };

/** Warning threshold: below this HF the borrow block shows its warning state. */
export const HF_WARN_WAD = (150n * WAD) / 100n; // 1.50, named constant (SPEC §7)

const PERCENTAGE_FACTOR = 10_000n;

/** Aave wadDiv: (a · WAD + b/2) / b, half-up. Throws on zero denominator. */
export function wadDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError("wadDiv denominator must be positive");
  return (a * WAD + b / 2n) / b;
}

/** Oracle base-currency amount (8 decimals) of an 18-decimal token position. */
export function usdBase(amountWei: bigint, priceBase8: bigint): bigint {
  return (amountWei * priceBase8) / WAD;
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
 * Liquidation ratio for a single correlated collateral/debt pair: the
 * collateral/debt oracle price ratio (WAD) at which HF reaches 1.
 *
 *   HF = collWei·priceColl·LT / (debtWei·priceDebt) = 1
 *   ⇒ priceColl/priceDebt = debtWei / (collWei · LT)
 *   R_liq(WAD) = debtWei · 1e4 · WAD / (collWei · ltBps)
 *
 * Rounded UP (ceiling): a higher liquidation ratio means liquidation triggers
 * on a smaller downward move — conservative for a risk display. Throws on
 * degenerate positions or an invalid threshold (never divides by a floored zero).
 */
export function liquidationRatioWad(
  collateralWei: bigint,
  debtWei: bigint,
  ltBps: number,
): bigint {
  if (collateralWei <= 0n) throw new RangeError("collateralWei must be positive");
  if (debtWei <= 0n) throw new RangeError("debtWei must be positive");
  if (ltBps <= 0 || ltBps > 10_000) throw new RangeError("ltBps out of range");
  const numer = debtWei * PERCENTAGE_FACTOR * WAD;
  const denom = collateralWei * BigInt(ltBps);
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
