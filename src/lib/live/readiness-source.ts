/**
 * WHICH readiness source may answer for a session — the one decision that keeps fabricated
 * readings attached to fabricated wallets (Codex round-2 finding 2).
 *
 * The defect this module closes: source selection used to be a BUILD-WIDE choice. Configure
 * mock accounts and the whole app served demo readiness — while `config.ts` still exposed the
 * `injected` connector, and the demo source still answered for any address it had never heard
 * of with a code-free, footprint-free wallet over a pristine snapshot. A real wallet
 * connecting to a mock-enabled build could therefore clear the Live gate on cleanliness
 * nobody read. One flag, and the gate's whole evidentiary basis became an invention.
 *
 * The rule now: the demo source answers for MOCK-CONNECTOR SESSIONS AND NOTHING ELSE. Every
 * other session — `injected`, or any connector id this build does not recognize — goes to the
 * RPC source, which reads the chain through `server/chain` or answers the stated absence when
 * `LIVE_CHAIN_RPC_URL` is unconfigured (SPEC §5). No public flag can move that boundary: the
 * flag chooses whether a demo arm EXISTS, never who it is allowed to answer for.
 *
 * ON TREATMENT §1.2 ("no gate, no money-math and no execution state branches on the connector
 * id"): that row still holds, and this is not a breach of it. What branches here is which
 * TRANSPORT a reading arrives by — a question about provenance, decided before any reading
 * exists — not a verdict, a quantity, or a step. Nothing downstream of this module can see the
 * id: the gate receives readings and a capture whose provenance is already settled, and it
 * treats them identically whatever produced them. The row forbids privileging a connector;
 * this refuses to privilege one, by denying the fabricated source every session but its own.
 */
import { isMockConnectorId } from "../wallet/connectors";
import type { WalletSeamSource } from "../wallet/seam";
import type { ReadingTarget } from "../wallet/types";
import type { LiveCaptureSource } from "./live-transport";

/**
 * May the demo source answer for this session at all?
 *
 * An allow list, not a deny list (`isMockConnectorId`): an unrecognized connector id reads as
 * a real wallet and gets the chain, which is the safe direction to be wrong in.
 */
export function demoMayAnswerFor(target: ReadingTarget): boolean {
  return isMockConnectorId(target.connectorId);
}

export interface ReadinessArms<T> {
  /** The demo/CI arm, or null in a build that configured no mock accounts. */
  readonly demo: T | null;
  /** The chain arm — always present, and itself the source of the stated absence. */
  readonly rpc: T;
}

/** The capture source the composer's live-simulation path uses, routed per session. */
export function routedCaptureSource(arms: ReadinessArms<LiveCaptureSource>): LiveCaptureSource {
  return {
    capture(target) {
      const source =
        arms.demo !== null && demoMayAnswerFor(target) ? arms.demo : arms.rpc;
      return source.capture(target);
    },
  };
}

/** The connect-time seam, routed by the same rule — readings and capture cannot diverge. */
export function routedSeam(arms: ReadinessArms<WalletSeamSource>): WalletSeamSource {
  return {
    read(target) {
      const source =
        arms.demo !== null && demoMayAnswerFor(target) ? arms.demo : arms.rpc;
      return source.read(target);
    },
  };
}
