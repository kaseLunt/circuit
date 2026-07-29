/**
 * The sandbox router's HTTP mount — deliberately deferred until this, its first consumer,
 * existed (`sandbox-router.ts` header: "an execution endpoint with no consumer would be
 * live attack surface with no user"). The tx-family surface is that consumer.
 *
 * Thread-through only (doctrine D10): every decision — schemas, refusal kinds, session
 * lifecycle, env composition — is imported from covered modules (`sandbox-router.ts`,
 * `fork-session.ts`); this file binds them to Next's route handler contract and adds
 * nothing. `sandboxServiceFromEnv` is lazy and memoized, so importing this module demands
 * no env and spawns nothing — only a request does, and a missing `SANDBOX_FORK_URL`
 * surfaces as the request's own 500, which the client renders as a designed
 * service-unavailable state rather than a build-time crash.
 */
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { sandboxRouter } from "../../../../server/trpc/sandbox-router";
import { sandboxServiceFromEnv } from "../../../../server/sandbox/fork-session";

export const dynamic = "force-dynamic";

const handler = (req: Request): Promise<Response> =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: sandboxRouter,
    createContext: () => sandboxServiceFromEnv(),
  });

export { handler as GET, handler as POST };
