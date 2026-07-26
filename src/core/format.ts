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

export type RoundingMode = "trunc" | "nearest";

/**
 * Format a fixed-point bigint as a decimal string with exactly `displayDecimals`
 * fraction digits. `decimals` is the value's own fixed-point scale. `mode`:
 * "trunc" (default, conservative — never overstates a token amount) or "nearest"
 * (half-up away from zero, conventional for money and rate displays).
 */
export function formatUnits(
  value: bigint,
  decimals: number,
  displayDecimals: number,
  mode: RoundingMode = "trunc",
): string {
  if (decimals < 0 || displayDecimals < 0) {
    throw new RangeError("decimals and displayDecimals must be non-negative");
  }
  const negative = value < 0n;
  let abs = negative ? -value : value;
  // Half-up rounding when dropping precision for a "nearest" display.
  if (mode === "nearest" && displayDecimals < decimals) {
    const drop = 10n ** BigInt(decimals - displayDecimals);
    abs = ((abs + drop / 2n) / drop) * drop;
  }
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
  return `$${formatUnits(base8, 8, displayDecimals, "nearest")}`;
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
  // Scale to one extra digit, then round half-up to displayDecimals.
  const scale = 10n ** BigInt(displayDecimals + 1);
  const pctScaledPlus1 = (ratePerAnnumRay * 100n * scale) / RAY;
  return `${formatUnits(pctScaledPlus1, displayDecimals + 1, displayDecimals, "nearest")}%`;
}

/** Shorten an address for display: 0x1234…abcd. */
export function formatAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
}

/**
 * Format a block timestamp (Unix seconds) as an absolute UTC instant:
 * "2025-07-23 03:14:11 UTC". Deliberately never a locale string and never
 * relative time — a provenance citation must not go stale on screen or
 * render differently per viewer. (SPEC §3: tooltip cites method + block +
 * timestamp.)
 *
 * It is the SOURCE BLOCK'S time, never a fetch or poll time — `Observed.fetchedAt` says so
 * at its definition. Surfaces label it "block time" for that reason: replaying the same
 * block tomorrow must render the same citation, which a fetch time would not.
 */
export function formatBlockTime(unixSeconds: number): string {
  const iso = new Date(unixSeconds * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** Integer bps rendered as a percent — bps ARE a 1e2-scaled percent. Sign preserved. */
export function formatBpsAsPercent(bps: number, displayDecimals = 0): string {
  return `${formatUnits(BigInt(bps), 2, displayDecimals, "nearest")}%`;
}

/** WAD-scaled rate/share rendered as a percent: 1e18 = 100%, so percent lives at 1e16. */
export function formatWadAsPercent(wad: bigint, displayDecimals = 2): string {
  return `${formatUnits(wad, 16, displayDecimals, "nearest")}%`;
}

/** WAD-scaled ratio to 4 dp, e.g. the oracle collateral/debt ratio at liquidation. */
export function formatWadRatio(wad: bigint): string {
  return formatUnits(wad, 18, 4, "nearest");
}

/** WAD-scaled multiple, e.g. leverage: 2.5e18 → "2.50×". */
export function formatWadAsMultiple(wad: bigint): string {
  return `${formatUnits(wad, 18, 2, "nearest")}×`;
}

/** An 18-decimal ETH amount with its unit, e.g. equity: "1.0998 ETH". */
export function formatEth(wei: bigint): string {
  return `${formatToken(wei, 4)} ETH`;
}
