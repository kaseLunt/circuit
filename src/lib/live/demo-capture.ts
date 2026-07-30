/**
 * The demo/CI capture source — the scenario table (`src/lib/wallet/seam.ts`) extended to
 * the F2 clearing path, so the hermetic SPEC §3 step-7 beat can walk the WHOLE gate:
 * connect → simulate against the wallet → gate clears — with no chain and no secrets.
 *
 * What it serves is the COMMITTED READS LOG, not an invention: the same
 * `recordedProtocol()`/`snapshotFrom` replay the sandbox runs on, pinned to the same block
 * and hash the chrome already cites. The one thing the log cannot back — the user pair —
 * is `Configured` with a definition site, exactly the sandbox's posture
 * (`src/lib/recorded-reads/sandbox-snapshot.ts`): a demo build that minted `Observed` for
 * an account nobody read would be forging the one field it invented.
 *
 * NEVER a production path, and — since Codex round-2 finding 2 — never a path a real wallet
 * can reach either. Two rules keep it there:
 *
 *  1. It FAILS CLOSED. An address outside the scenario table's `accounts` gets the
 *     `not-in-demo-scenario` refusal, not a clean reading. It used to serve every unlisted
 *     address a code-free, footprint-free wallet over a pristine snapshot, on the argument
 *     that only mock accounts could ever arrive — but a mock-enabled build still exposes the
 *     `injected` connector, so an injected wallet could clear the Live gate on fabricated
 *     cleanliness. That is the exact inversion of SPEC §5: an absence became a pass.
 *  2. The composer routes to it per SESSION CONNECTOR (`./readiness-source.ts`), so a real
 *     wallet never reaches it at all. A production build composes `trpcLiveCaptureSource`,
 *     and with no live RPC configured the gate refuses with the stated absence. The fork e2e
 *     suite is the authoritative proof of the real procedure.
 */
import { getAddress, type Hex } from "viem";
import { configured } from "../../core/provenance";
import type { UserSnapshot } from "../../core/plan";
import { PINNED_BLOCK, readsMeta } from "../recorded-reads/reads-log";
import { recordedProtocol, snapshotFrom } from "../recorded-reads/recorded-snapshot";
import { notInDemoScenarioReason, type DemoSeamScenarios } from "../wallet/seam";
import type { LiveCaptureSource } from "./live-transport";
import type { WalletCodeReading, WalletFootprintReading } from "../wallet/types";

const DEFINED_AT = "src/lib/live/demo-capture.ts";

/** The same placeholder bytecode the demo seam serves for its code-bearing scenario. */
const DEMO_CODE: Hex = "0xef0100";

export function demoLiveCaptureSource(scenarios: DemoSeamScenarios): LiveCaptureSource {
  const accounts = new Set(scenarios.accounts.map((a) => getAddress(a)));
  const codeBearing = new Set(scenarios.codeBearing.map((a) => getAddress(a)));
  const occupied = new Set(scenarios.occupied.map((a) => getAddress(a)));
  return {
    capture(target) {
      const key = getAddress(target.address);
      if (!accounts.has(key)) {
        return Promise.resolve({
          ok: false as const,
          kind: "not-in-demo-scenario" as const,
          reason: notInDemoScenarioReason(key),
        });
      }
      const isOccupied = occupied.has(key);
      const code: WalletCodeReading = codeBearing.has(key)
        ? { status: "code-bearing", code: DEMO_CODE }
        : { status: "clear" };
      const footprint: WalletFootprintReading = isOccupied
        ? { status: "occupied" }
        : { status: "clear" };
      const user: UserSnapshot = {
        address: key,
        eModeCategoryId: configured(0, "DEMO_LIVE_USER_EMODE_CATEGORY", DEFINED_AT),
        hasAaveFootprint: configured(isOccupied, "DEMO_LIVE_USER_AAVE_FOOTPRINT", DEFINED_AT),
      };
      return Promise.resolve({
        ok: true as const,
        capture: {
          snapshot: snapshotFrom(recordedProtocol(), user),
          identity: {
            block: PINNED_BLOCK,
            blockHash: readsMeta.pinned_block.hash as Hex,
          },
          code,
          footprint,
        },
      });
    },
  };
}
