/**
 * The live readiness transport seam — the one place the wallet router's client is composed
 * (the `src/lib/tx/transport.ts` pattern, applied to `/api/wallet`).
 *
 * The router import is TYPE-ONLY, so no server module reaches the client bundle; the
 * RESPONSE is treated as `unknown` and strict-parsed by `./snapshot-wire.ts` — version skew
 * lands on a stated refusal, never a guess.
 *
 * Two consumers, one source:
 *
 *  - `liveSeam` adapts a capture source to `WalletSeamSource`, which is how a PRODUCTION
 *    build (no mock accounts) reads the connect-time code/footprint facts through our own
 *    RPC. Any refusal or transport failure maps to `unavailableReadings` — the gate then
 *    refuses with the reason on screen (SPEC §5's stated absence, not a permissive default).
 *  - The composer's live-simulation path calls the SAME source for the block-pinned capture
 *    it simulates against (F2), so the readings and the snapshot can never come from two
 *    different moments' chain state.
 */
import { createTRPCClient, httpLink } from "@trpc/client";
import type { Address } from "viem";
import type { WalletRouter } from "../../server/trpc/wallet-router";
import { unavailableReadings, type WalletSeamSource } from "../wallet/seam";
import { parseLiveReadiness, type ParsedLiveReadiness } from "./snapshot-wire";

/** One readiness call: the seam readings and the block-pinned capture, or a stated refusal. */
export interface LiveCaptureSource {
  capture(address: Address): Promise<ParsedLiveReadiness>;
}

export const WALLET_TRPC_ENDPOINT = "/api/wallet";

/** The production source: the mounted wallet router, strict-parsed. */
export function trpcLiveCaptureSource(url: string = WALLET_TRPC_ENDPOINT): LiveCaptureSource {
  const client = createTRPCClient<WalletRouter>({ links: [httpLink({ url })] });
  return {
    async capture(address) {
      let response: unknown;
      try {
        response = await client.readiness.query({ address });
      } catch (error) {
        return {
          ok: false,
          reason: `the live readiness call failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (typeof response !== "object" || response === null) {
        return { ok: false, reason: "the live readiness response is not an object" };
      }
      const envelope = response as { ok?: unknown; readiness?: unknown; refusal?: unknown };
      if (envelope.ok !== true) {
        const refusal = envelope.refusal as { reason?: unknown } | undefined;
        return {
          ok: false,
          reason:
            typeof refusal?.reason === "string"
              ? refusal.reason
              : "the live readiness call was refused without a stated reason",
        };
      }
      return parseLiveReadiness(envelope.readiness);
    },
  };
}

/**
 * The connect-time seam over a capture source. A capture that refused — no RPC configured,
 * chain unreachable, malformed wire — answers the explicit unknown state, and the gate
 * refuses with that reason rendered; it never answers "clear".
 */
export function liveSeam(source: LiveCaptureSource): WalletSeamSource {
  return {
    async read(address) {
      const outcome = await source.capture(address);
      if (!outcome.ok) return unavailableReadings(outcome.reason);
      return { code: outcome.capture.code, footprint: outcome.capture.footprint };
    },
  };
}
