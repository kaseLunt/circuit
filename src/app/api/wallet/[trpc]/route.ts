/**
 * The wallet readiness router's HTTP mount (Codex D-011 F2) — mounted the same round its
 * first consumer landed (the composer's live-simulation path), per the sandbox mount's
 * rule: an endpoint with no consumer would be live attack surface with no user.
 *
 * Thread-through only (doctrine D10): the input schema, the refusal kinds and the capture
 * itself are imported from covered modules (`wallet-router.ts`, `live-readiness.ts`); this
 * file binds them to Next's route handler contract and adds nothing. `liveReadinessFromEnv`
 * is lazy and memoized, so importing this module demands no env and opens nothing — a
 * deployment without `LIVE_CHAIN_RPC_URL` serves the router's stated
 * `live-chain-unconfigured` refusal, which the gate renders as its designed absence state.
 */
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { walletRouter } from "../../../../server/trpc/wallet-router";
import { liveReadinessFromEnv } from "../../../../server/chain/live-readiness";

export const dynamic = "force-dynamic";

const handler = (req: Request): Promise<Response> =>
  fetchRequestHandler({
    endpoint: "/api/wallet",
    req,
    router: walletRouter,
    createContext: () => ({ readiness: liveReadinessFromEnv() }),
  });

export { handler as GET, handler as POST };
