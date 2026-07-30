/**
 * Where the connect-time seam READINGS come from.
 *
 * Two facts gate live mode and neither may be asked of the injected provider (seam A1 — the
 * extension is attacker-controllable): whether the address has code deployed
 * (`eth_getCode`, treatment §1.2) and whether it already holds an Aave Core position (the
 * SPEC §2 footprint predicate). Both are chain reads, so both belong to our own configured
 * RPC through `server/chain`.
 *
 * This module is the SOURCE seam, not the reader: it publishes the interface the wallet host
 * consumes and the two implementations W08 ships.
 *
 * `unavailableSeam` is the production default in a deployment with no mainnet RPC wired, and
 * it is deliberately not a stub that answers "clear": a source that did not resolve renders
 * the explicit unavailable state and the gate REFUSES (SPEC §5). The manual live path's
 * first wiring step is documented in `docs/live-execution-checklist.md`.
 *
 * A read is FOR A TARGET (`ReadingTarget`), not for a bare address: which source is allowed
 * to answer depends on the connector the session arrived by, and the routing that enforces it
 * lives in `src/lib/live/readiness-source.ts`.
 */
import { getAddress, type Address } from "viem";
import type {
  ReadingTarget,
  WalletCodeReading,
  WalletFootprintReading,
  WalletSeamReadings,
} from "./types";

export interface WalletSeamSource {
  read(target: ReadingTarget): Promise<WalletSeamReadings>;
}

/** The reading every arm falls back to — stated, never defaulted. */
export function unavailableReadings(reason: string): WalletSeamReadings {
  return { code: { status: "unknown", reason }, footprint: { status: "unknown", reason } };
}

export function unavailableSeam(reason: string): WalletSeamSource {
  return { read: () => Promise.resolve(unavailableReadings(reason)) };
}

/**
 * The demo/CI scenario table: which mock accounts the demo build serves at all, which of them
 * read as code-bearing, and which as already holding a position.
 *
 * These are CONFIGURED values with a definition site — the same honesty posture as
 * `src/lib/recorded-reads/sandbox-snapshot.ts`, which carries the sandbox's `Configured`
 * footprint pair — and they never become `Provenanced`: they feed a REFUSAL, never a
 * displayed quantity, and no money-math reads them. A build with no mock accounts
 * configured has no scenario table at all.
 *
 * `accounts` is the table's DOMAIN and the reason the other two fields are safe to trust: the
 * scenario answers for the demo's own fabricated wallets and refuses for everything else.
 */
export interface DemoSeamScenarios {
  readonly accounts: readonly Address[];
  readonly codeBearing: readonly Address[];
  readonly occupied: readonly Address[];
}

const DEMO_CODE = "0xef0100";

/**
 * The refusal an address outside the scenario table earns. Stated in the same vocabulary the
 * unconfigured-deployment path uses, because it is the same fact: this source cannot answer
 * for this wallet, so nothing is read and nothing is assumed.
 */
export function notInDemoScenarioReason(address: Address): string {
  return `the demo scenario table has no entry for ${address}, and the demo source cannot answer for a real wallet — its readings are configured fixtures, not chain reads`;
}

/**
 * The demo arm this build ships, or NOTHING — `null` so the caller routes to the chain source
 * and its stated absence rather than to a permissive default.
 *
 * `armed` is the composer's single condition for BOTH demo arms (readings and capture): mock
 * accounts configured, and the build has not forced the RPC source.
 */
export function configuredDemoSeam(
  scenarios: DemoSeamScenarios,
  armed: boolean,
): WalletSeamSource | null {
  return armed ? demoSeam(scenarios) : null;
}

/**
 * A scenario-table seam, and it FAILS CLOSED.
 *
 * An address the table's `accounts` do not name gets the stated absence, never "clear". This
 * used to read clear on the argument that no other address could reach here — but a
 * mock-enabled build still exposes the `injected` connector, so a real wallet could, and a
 * fabricated clean reading is exactly what would let it clear the Live gate (Codex round-2
 * finding 2). The connector-level routing in `src/lib/live/readiness-source.ts` keeps real
 * sessions away from this source in the first place; this is the same rule stated where the
 * fabrication actually lives, so neither half is load-bearing alone.
 */
export function demoSeam(scenarios: DemoSeamScenarios): WalletSeamSource {
  const accounts = new Set(scenarios.accounts.map((a) => getAddress(a)));
  const codeBearing = new Set(scenarios.codeBearing.map((a) => getAddress(a)));
  const occupied = new Set(scenarios.occupied.map((a) => getAddress(a)));
  return {
    read(target) {
      const key = getAddress(target.address);
      if (!accounts.has(key)) {
        return Promise.resolve(unavailableReadings(notInDemoScenarioReason(key)));
      }
      const code: WalletCodeReading = codeBearing.has(key)
        ? { status: "code-bearing", code: DEMO_CODE }
        : { status: "clear" };
      const footprint: WalletFootprintReading = occupied.has(key)
        ? { status: "occupied" }
        : { status: "clear" };
      return Promise.resolve({ code, footprint });
    },
  };
}
