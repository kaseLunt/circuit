/**
 * Health-factor and liquidation math (SPEC §5.4). Pure, integer, WAD/base8.
 *
 * Algebra ported from the prototype's liquidation service (its strongest code),
 * rebuilt with the boundary-review corrections: bigint throughout (no float drift
 * near HF=1), e-mode-category liquidation thresholds, an explicit no-debt sentinel
 * and unknown state, and — for the correlated weETH/WETH pair — a liquidation
 * *ratio* rather than a misleading USD liquidation price (matrix §5: weETH is
 * priced by a capped exchange-rate oracle over ETH/USD, so pair risk moves with
 * the ratio, not the ETH price level).
 *
 * NOTE (D-004): money-math — Codex senior review before the P1-exit receipt.
 */
import { WAD, HF_NO_DEBT } from "./format";

export { HF_NO_DEBT };

/** Warning threshold: below this HF the borrow block shows its warning state. */
export const HF_WARN_WAD = (150n * WAD) / 100n; // 1.50, named constant (SPEC §7)

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

/**
 * Health factor from collateral entries and total debt (base8).
 *   hf = Σ(collateral_i.base · lt_i) / totalDebtBase        (WAD)
 * debt == 0 → no-debt; any null input → unknown (never silently "safe").
 */
export function computeHealthFactor(
  collateral: readonly CollateralEntry[] | null,
  totalDebtBase: bigint | null,
): HealthFactor {
  if (collateral === null || totalDebtBase === null) {
    return { status: "unknown", reason: "missing collateral or debt snapshot" };
  }
  if (totalDebtBase === 0n) return { status: "no-debt" };
  let weighted = 0n; // Σ base·ltBps  (base8 × bps)
  for (const c of collateral) weighted += c.base * BigInt(c.ltBps);
  const adjustedBase = weighted / 10_000n; // base8
  const hfWad = (adjustedBase * WAD) / totalDebtBase;
  return { status: "healthy", hfWad };
}

/** Numeric HF for comparisons; no-debt → sentinel, unknown → null. */
export function hfWadValue(hf: HealthFactor): bigint | null {
  if (hf.status === "healthy") return hf.hfWad;
  if (hf.status === "no-debt") return HF_NO_DEBT;
  return null;
}

/** True when a known HF sits below the warning threshold (unknown ⇒ not "safe"). */
export function isWarning(hf: HealthFactor): boolean {
  const v = hfWadValue(hf);
  return v !== null && v < HF_WARN_WAD;
}

/**
 * Liquidation ratio for a single correlated collateral/debt pair: the
 * collateral/debt oracle price ratio (WAD) at which HF reaches 1.
 *
 *   HF = collWei·priceColl·LT / (debtWei·priceDebt)
 *   HF = 1  ⇒  priceColl/priceDebt = debtWei / (collWei · LT)
 *
 * Returns the WAD ratio `R_liq`. Compare to the current ratio to render
 * "liquidates if weETH/WETH falls −X%". Throws if the position cannot be
 * liquidated by a ratio move (no collateral or no debt).
 */
export function liquidationRatioWad(
  collateralWei: bigint,
  debtWei: bigint,
  ltBps: number,
): bigint {
  if (collateralWei <= 0n) throw new RangeError("collateralWei must be positive");
  if (debtWei <= 0n) throw new RangeError("debtWei must be positive");
  const ltWad = (BigInt(ltBps) * WAD) / 10_000n;
  const denom = (collateralWei * ltWad) / WAD;
  return (debtWei * WAD) / denom;
}

/**
 * Signed WAD fraction the collateral/debt ratio must move to reach liquidation:
 * (R_liq − R_now) / R_now. Negative ⇒ ratio must fall (the normal case);
 * the display is "−X% from now".
 */
export function ratioMoveToLiquidationWad(currentRatioWad: bigint, liqRatioWad: bigint): bigint {
  if (currentRatioWad <= 0n) throw new RangeError("currentRatioWad must be positive");
  return ((liqRatioWad - currentRatioWad) * WAD) / currentRatioWad;
}
