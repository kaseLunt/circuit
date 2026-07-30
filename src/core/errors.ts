/**
 * Revert decoding (SPEC §6). Pure — viem's selector/decoder helpers do no I/O.
 *
 * Aave v3.4+ (the deployed Ethereum Core revision is v3.7, matrix §2) reverts
 * with custom errors, so decoding matches a 4-byte selector to a human message
 * first; the legacy `Error(string)` numeric-code table is the fallback for older
 * deployments. The selector table is built at load from the error signatures via
 * viem `toFunctionSelector`, so a mistyped signature can't silently mint a wrong
 * selector — the mapping is derived, not hand-transcribed.
 */
import { toFunctionSelector } from "viem";

/**
 * Aave v3.7 custom errors we surface with tailored copy. Names match
 * aave-v3-origin `Errors.sol`; selectors are derived from the BARE signature
 * (Solidity error selectors == keccak256(canonicalSig)[:4], no "error " prefix).
 * SELECTOR_SELFTEST below pins a few against their known on-chain values so a
 * future viem/API change cannot silently reintroduce a wrong derivation.
 */
const CUSTOM_ERROR_SIGNATURES: Record<string, string> = {
  "SupplyCapExceeded()": "Aave supply cap reached for this reserve",
  "BorrowCapExceeded()": "Aave borrow cap reached for this reserve",
  "HealthFactorLowerThanLiquidationThreshold()":
    "Health factor would fall below the liquidation threshold",
  "CollateralCannotCoverNewBorrow()": "Collateral cannot cover the requested borrow",
  "LtvValidationFailed()": "Loan-to-value validation failed",
  "BorrowingNotEnabled()": "Borrowing is not enabled for this reserve",
  "NotBorrowableInEMode()": "Asset is not borrowable in the selected e-mode category",
  // Parameterized `(address reserve, uint256 categoryId)` — the argument types are read from
  // `Errors.sol` at the pinned revision, not guessed, because the selector is keccak of the
  // CANONICAL signature and a `uint8` there would derive a selector that never matches. The
  // selector still identifies the error; the args ride the raw bytes the decoder preserves
  // beside the message. Thrown by `validateSetUserEMode`'s debt loop — a wallet holding debt
  // the target category cannot borrow may not enter it at all, which is what makes
  // borrow-then-enter-eMode an unreachable sequencing rather than a merely worse one. The
  // fork drill in `tests/fork/usdc-carry.test.ts` pins both selectors against the chain.
  "InvalidDebtInEmode(address,uint256)":
    "An existing debt is not borrowable in that e-mode category",
  "InvalidCollateralInEmode(address,uint256)":
    "An existing collateral is not usable in that e-mode category",
  "ReserveInactive()": "Reserve is inactive",
  "ReserveFrozen()": "Reserve is frozen",
  "ReservePaused()": "Reserve is paused",
  "InconsistentEModeCategory()": "Position is inconsistent with the selected e-mode category",
  "NotEnoughAvailableUserBalance()": "Not enough balance for this action",
};

/**
 * Known-correct selectors (keccak256(sig)[:4]) — a non-tautological guard.
 *
 * The two W09 entries are not transcriptions: they are the bytes the DEPLOYED revision
 * actually returned in `tests/fork/usdc-carry.test.ts` (the e-mode negative control and the
 * reserve-regime LTV boundary). Pinning them here means a signature typo or a viem change
 * that broke the derivation would fail at module load, in every suite, rather than in the one
 * fork drill that has an RPC.
 */
const SELECTOR_SELFTEST: Record<string, string> = {
  "SupplyCapExceeded()": "0xf58f733a",
  "NotBorrowableInEMode()": "0x57db5bba",
  "CollateralCannotCoverNewBorrow()": "0x911ceb81",
};

/** Legacy Error(string) numeric codes (pre-v3.4). Matrix §2 documents the model. */
const LEGACY_CODES: Record<string, string> = {
  "35": "Health factor would fall below the liquidation threshold",
  "36": "Collateral cannot cover the requested borrow",
  "51": "Aave supply cap reached for this reserve",
  "50": "Aave borrow cap reached for this reserve",
};

/** selector (0x + 8 hex) → message, derived from the BARE signature at load. */
const SELECTOR_TO_MESSAGE: ReadonlyMap<string, string> = new Map(
  Object.entries(CUSTOM_ERROR_SIGNATURES).map(([sig, msg]) => [toFunctionSelector(sig), msg]),
);

// Fail fast if the derivation ever diverges from a known on-chain selector.
for (const [sig, expected] of Object.entries(SELECTOR_SELFTEST)) {
  const got = toFunctionSelector(sig);
  if (got !== expected) {
    throw new Error(`error-selector derivation broken: ${sig} → ${got}, expected ${expected}`);
  }
}

export interface DecodedRevert {
  /** Human-readable explanation. */
  readonly message: string;
  /** The raw signal preserved alongside the message (selector or legacy code). */
  readonly raw: string;
  /** How the message was resolved. */
  readonly source: "custom-error" | "legacy-code" | "unknown";
}

/**
 * Decode revert return data. Handles: a bare custom-error selector (4 bytes),
 * ABI-encoded `Error(string)` (selector 0x08c379a0) carrying an Aave numeric
 * code, and unknown data (surfaced raw, never swallowed).
 */
export function decodeRevert(data: string): DecodedRevert {
  const hex = data.startsWith("0x") ? data : `0x${data}`;
  const selector = hex.slice(0, 10).toLowerCase();

  // Error(string): selector 0x08c379a0 — extract the string and match legacy codes.
  if (selector === "0x08c379a0") {
    const reason = decodeErrorString(hex);
    const legacy = LEGACY_CODES[reason.trim()];
    if (legacy) return { message: legacy, raw: reason, source: "legacy-code" };
    return { message: reason || "reverted (Error string)", raw: reason, source: "legacy-code" };
  }

  const custom = SELECTOR_TO_MESSAGE.get(selector);
  if (custom) return { message: custom, raw: selector, source: "custom-error" };

  return { message: "reverted (unrecognized error)", raw: selector, source: "unknown" };
}

/** Minimal ABI string decode for Error(string) payloads. Pure. */
function decodeErrorString(hex: string): string {
  // 0x08c379a0 | offset(32) | length(32) | utf8 bytes
  const body = hex.slice(10);
  if (body.length < 128) return "";
  const len = Number(BigInt(`0x${body.slice(64, 128)}`));
  const strHex = body.slice(128, 128 + len * 2);
  let out = "";
  for (let i = 0; i < strHex.length; i += 2) {
    out += String.fromCharCode(parseInt(strHex.slice(i, i + 2), 16));
  }
  return out;
}
