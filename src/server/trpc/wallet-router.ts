/**
 * The wallet readiness router (Codex D-011 F2) — the ONE transport across which the
 * connected address travels toward money-math, and deliberately NOT a procedure on the
 * sandbox router: that router's A3 property is structural ("no procedure accepts a `to`,
 * `data`, address, or amount"), and this router exists precisely because a readiness
 * capture must accept an address. Keeping them separate keeps both claims checkable.
 *
 * What the address buys, and all it buys: `captureChainSnapshot(client, { user })` through
 * our configured RPC — the crossing `src/lib/wallet/types.ts` names as the boundary's whole
 * purpose — plus `eth_getCode` for the stipend gate. No `to`, no `data`, no amount, no
 * calldata of any kind rides here (`z.strictObject` refuses unknown keys).
 *
 * Designed states return as typed `{ ok: false, refusal }` payloads (the sandbox router's
 * doctrine): a deployment with no live RPC answers `live-chain-unconfigured`, a capture the
 * chain refused answers `capture-failed` with the reason. The client maps either onto the
 * gate's stated-absence refusals — a missing source renders an explicit unavailable state
 * (SPEC §5), and the gate REFUSES rather than admits.
 */
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { getAddress } from "viem";
import type { LiveReadinessService } from "../chain/live-readiness";

export interface WalletContext {
  /** Null when the deployment has no live chain source — a stated absence. */
  readonly readiness: LiveReadinessService | null;
}

const t = initTRPC.context<WalletContext>().create();

const readinessInput = z.strictObject({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "address shape"),
});

/**
 * Capture failures relay their reason to the BROWSER, and viem transport errors embed the
 * request URL in `message` — which, for a keyed RPC (the usual shape of LIVE_CHAIN_RPC_URL),
 * is the credential. The reason stays stated (SPEC §5) but every URL is scrubbed before the
 * text crosses the trust boundary; nothing else in the message is touched.
 */
function publicReasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[configured rpc]");
}

export const walletRouter = t.router({
  readiness: t.procedure.input(readinessInput).query(async ({ ctx, input }) => {
    if (ctx.readiness === null) {
      return {
        ok: false as const,
        refusal: {
          kind: "live-chain-unconfigured" as const,
          reason:
            "no live chain source is configured in this deployment (LIVE_CHAIN_RPC_URL), so the wallet's code, footprint and balances cannot be read",
        },
      };
    }
    let readiness;
    try {
      readiness = await ctx.readiness.capture(getAddress(input.address));
    } catch (error) {
      // A failed capture is a designed state, not an exception to bury in a 500: the
      // client renders the stated reason and the gate stays refused.
      return {
        ok: false as const,
        refusal: {
          kind: "capture-failed" as const,
          reason: publicReasonOf(error),
        },
      };
    }
    return { ok: true as const, readiness };
  }),
});

export type WalletRouter = typeof walletRouter;

export const createWalletCaller = t.createCallerFactory(walletRouter);
