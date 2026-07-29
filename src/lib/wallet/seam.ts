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
 */
import { getAddress, type Address } from "viem";
import type { WalletCodeReading, WalletFootprintReading, WalletSeamReadings } from "./types";

export interface WalletSeamSource {
  read(address: Address): Promise<WalletSeamReadings>;
}

/** The reading every arm falls back to — stated, never defaulted. */
export function unavailableReadings(reason: string): WalletSeamReadings {
  return { code: { status: "unknown", reason }, footprint: { status: "unknown", reason } };
}

export function unavailableSeam(reason: string): WalletSeamSource {
  return { read: () => Promise.resolve(unavailableReadings(reason)) };
}

/**
 * The demo/CI scenario table: which mock accounts read as code-bearing, and which read as
 * already holding a position.
 *
 * These are CONFIGURED values with a definition site — the same honesty posture as
 * `src/lib/recorded-reads/sandbox-snapshot.ts`, which carries the sandbox's `Configured`
 * footprint pair — and they never become `Provenanced`: they feed a REFUSAL, never a
 * displayed quantity, and no money-math reads them. A build with no mock accounts
 * configured has no scenario table at all.
 */
export interface DemoSeamScenarios {
  readonly codeBearing: readonly Address[];
  readonly occupied: readonly Address[];
}

const DEMO_CODE = "0xef0100";

/**
 * The seam this build ships with: the scenario table when mock accounts are configured
 * (the demo/CI build), and NOTHING otherwise — `null` so the caller falls back to the
 * provider's stated-unavailable default rather than to a permissive one.
 */
export function configuredDemoSeam(scenarios: DemoSeamScenarios, hasMocks: boolean): WalletSeamSource | null {
  return hasMocks ? demoSeam(scenarios) : null;
}

/**
 * A scenario-table seam. An address the table does not name reads CLEAR — which is correct
 * for a demo build precisely because the table enumerates the demo's own accounts; any other
 * address never reaches here (the mock connector cannot produce one).
 */
export function demoSeam(scenarios: DemoSeamScenarios): WalletSeamSource {
  const codeBearing = new Set(scenarios.codeBearing.map((a) => getAddress(a)));
  const occupied = new Set(scenarios.occupied.map((a) => getAddress(a)));
  return {
    read(address) {
      const key = getAddress(address);
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
