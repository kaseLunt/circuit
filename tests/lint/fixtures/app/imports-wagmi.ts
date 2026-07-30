/**
 * LINT FIXTURE — every marked line below is SUPPOSED to fail the boundary gate.
 *
 * Codex D-011 F5(a): wagmi is confined to `src/lib/wallet/**` and `src/components/wallet/**`.
 * This file stands in for every NON-BOUNDARY surface — components, app routes, lib modules —
 * where an injected-provider import would put attacker-controllable transport one hop from a
 * rendered number. The catch-all ban must fire here or it enforces nothing.
 *
 * ONE PROHIBITED ROUTE PER LINE, each tagged `@route:<name>`; the exact (route, ruleId)
 * multiset is asserted by `scripts/lint-boundaries.mjs` (doctrine D5 — gaps AND surplus both
 * fail). Do not "fix" this file: deleting a violation deletes the evidence.
 */
import { useAccount } from "wagmi"; // @route:app-imports-wagmi
import { mock } from "wagmi/connectors"; // @route:app-imports-wagmi-subpath
import { getAccount } from "@wagmi/core"; // @route:app-imports-wagmi-scoped

export const account = useAccount;
export const connector = mock;
export const reader = getAccount;
