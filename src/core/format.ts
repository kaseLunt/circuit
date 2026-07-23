/**
 * The single formatting module (SPEC §4): BigInt → display strings.
 *
 * All on-screen numbers pass through here; components never inline `toFixed`
 * or `toLocaleString`. Pure, integer-based — no float intermediate for token
 * amounts. No silent fallbacks: callers pass real values or render an explicit
 * unavailable state upstream.
 */

/** RAY = 1e27 (Aave rate/index fixed point). */
export const RAY = 10n ** 27n;
/** WAD = 1e18 (Aave health-factor fixed point, and 18-decimal tokens). */
export const WAD = 10n ** 18n;

/**
 * Format a fixed-point bigint as a decimal string with exactly `displayDecimals`
 * fraction digits, truncated (not rounded) toward zero. `decimals` is the
 * value's own fixed-point scale.
 */
export function formatUnits(value: bigint, decimals: number, displayDecimals: number): string {
  if (decimals < 0 || displayDecimals < 0) {
    throw new RangeError("decimals and displayDecimals must be non-negative");
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;

  const sign = negative ? "-" : "";
  const wholeStr = groupThousands(whole);
  if (displayDecimals === 0) return `${sign}${wholeStr}`;

  const fracFull = frac.toString().padStart(decimals, "0");
  const fracShown =
    displayDecimals <= decimals
      ? fracFull.slice(0, displayDecimals)
      : fracFull.padEnd(displayDecimals, "0");
  return `${sign}${wholeStr}.${fracShown}`;
}

/** Group the integer part with commas: 1234567 → "1,234,567". */
function groupThousands(n: bigint): string {
  const s = n.toString();
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

/** Format an 18-decimal token amount (wei) for display. */
export function formatToken(wei: bigint, displayDecimals = 4): string {
  return formatUnits(wei, 18, displayDecimals);
}

/**
 * Format an Aave USD base amount (8-decimal, per AaveOracle BASE_CURRENCY_UNIT)
 * as a currency string.
 */
export function formatUsdBase(base8: bigint, displayDecimals = 2): string {
  return `$${formatUnits(base8, 8, displayDecimals)}`;
}

/**
 * Format a health factor. Aave returns WAD-scaled HF, with the no-debt sentinel
 * `type(uint256).max`. Callers pass either the WAD value or the explicit unknown
 * marker `null`; a no-debt position renders "∞".
 */
export const HF_NO_DEBT = (1n << 256n) - 1n;

export function formatHealthFactor(hfWad: bigint | null): string {
  if (hfWad === null) return "unknown";
  if (hfWad >= HF_NO_DEBT) return "∞";
  return formatUnits(hfWad, 18, 2);
}

/**
 * Format a RAY-scaled per-annum rate (Aave liquidityRate/variableBorrowRate) as
 * a percentage string with `displayDecimals` fraction digits. This is an APR
 * display; APR→APY conversion lives in rates.ts.
 */
export function formatRayRateAsPct(ratePerAnnumRay: bigint, displayDecimals = 2): string {
  // percent = rate / RAY * 100; scale to keep integer math, truncate.
  const scale = 10n ** BigInt(displayDecimals);
  const pctScaled = (ratePerAnnumRay * 100n * scale) / RAY;
  return `${formatUnits(pctScaled, displayDecimals, displayDecimals)}%`;
}

/** Shorten an address for display: 0x1234…abcd. */
export function formatAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
}
