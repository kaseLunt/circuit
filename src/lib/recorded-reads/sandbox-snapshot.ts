/**
 * The sandbox `ChainSnapshot` — SPEC §3's "no wallet connected" default experience,
 * running on the committed block-pinned read set.
 *
 * Protocol state replays from the reads log through `./recorded-snapshot`, so every rate,
 * price, cap and threshold on screen is an `Observed` carrying the real pinned block and
 * the real source-block timestamp. The provenance tooltips cite that block; the chrome
 * says "sandbox" out loud. Nothing here pretends to be live.
 *
 * The USER is the one thing the log cannot back — the matrix run captured protocol state,
 * not an account — so the sandbox actor is `Configured`: a named constant with a definition
 * site, which is exactly what it is. It is NOT minted as `Observed`; a sandbox that forged
 * a chain read for its own actor would be lying about the one field it invented, in the
 * product whose thesis is that it does not do that.
 *
 * The two configured facts are load-bearing, not decoration. `eModeCategoryId = 0` is why
 * `core/plan.ts` emits the `setUserEMode` step that makes the flagship 13 steps rather than
 * 12, and `hasAaveFootprint = false` is the SPEC §2 predicate that lets the plan proceed.
 * Both become live reads the moment a wallet connects (P3), which is why they are values
 * rather than assumptions baked into the planner.
 */
import type { Address } from "viem";
import { configured } from "../../core/provenance";
import type { ChainSnapshot, UserSnapshot } from "../../core/plan";
import { recordedProtocol, snapshotFrom } from "./recorded-snapshot";

const DEFINED_AT = "src/lib/recorded-reads/sandbox-snapshot.ts";

/**
 * The sandbox actor. Not a wallet, never a signer, and deliberately not an address anyone
 * holds keys to: in sandbox it only ever reaches `onBehalfOf` in calldata that is simulated
 * against a fork, and a connected wallet replaces it wholesale in live mode. The repeated
 * nibble is the point — it reads as a placeholder at a glance in a decoded step list.
 */
export const SANDBOX_USER = "0x1111111111111111111111111111111111111111" as Address;

export function sandboxUser(): UserSnapshot {
  return {
    address: SANDBOX_USER,
    eModeCategoryId: configured(0, "SANDBOX_USER_EMODE_CATEGORY", DEFINED_AT),
    hasAaveFootprint: configured(false, "SANDBOX_USER_AAVE_FOOTPRINT", DEFINED_AT),
  };
}

/**
 * Throws if the reads log is missing or mis-shaped — every accessor in `./reads-log` does.
 * Callers turn that into a designed unavailable state rather than a defaulted snapshot:
 * there is no partial snapshot worth rendering, and SPEC §5 has no fallback numbers.
 */
export function sandboxSnapshot(): ChainSnapshot {
  return snapshotFrom(recordedProtocol(), sandboxUser());
}
