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
 * NEVER a production path: the composer wires this exactly like `configuredDemoSeam` —
 * only when mock accounts are configured (the demo/CI build). A production build composes
 * `trpcLiveCaptureSource`, and with no live RPC configured the gate refuses with the
 * stated absence. The fork e2e suite is the authoritative proof of the real procedure.
 */
import { getAddress, type Address, type Hex } from "viem";
import { configured } from "../../core/provenance";
import type { UserSnapshot } from "../../core/plan";
import { PINNED_BLOCK, readsMeta } from "../recorded-reads/reads-log";
import { recordedProtocol, snapshotFrom } from "../recorded-reads/recorded-snapshot";
import type { DemoSeamScenarios } from "../wallet/seam";
import type { LiveCaptureSource } from "./live-transport";
import type { WalletCodeReading, WalletFootprintReading } from "../wallet/types";

const DEFINED_AT = "src/lib/live/demo-capture.ts";

/** The same placeholder bytecode the demo seam serves for its code-bearing scenario. */
const DEMO_CODE: Hex = "0xef0100";

export function demoLiveCaptureSource(scenarios: DemoSeamScenarios): LiveCaptureSource {
  const codeBearing = new Set(scenarios.codeBearing.map((a) => getAddress(a)));
  const occupied = new Set(scenarios.occupied.map((a) => getAddress(a)));
  return {
    capture(address: Address) {
      const key = getAddress(address);
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
