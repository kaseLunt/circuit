/**
 * Built-plan fixtures. Extracted from `src/lib/wallet/gate.test.ts` for the Codex D-011
 * F5(b) quarantine: `src/lib/wallet/**` — its tests included — carries no VALUE import of
 * core money-math, so the plan a wallet test gates against is built HERE, outside the
 * boundary, and handed in as the `PlanSuccess` value the gate's own type surface names.
 */
import { buildPlan, type PlanSuccess } from "../../src/core/plan";
import { fixtureSnapshot } from "./chain-snapshot";
import { flagshipGraph } from "./graphs";

/** The canonical 13-step flagship over the reads-log fixture — throws rather than defaults. */
export function canonicalFlagshipPlan(): PlanSuccess {
  const result = buildPlan(flagshipGraph(), fixtureSnapshot());
  if (!result.ok) throw new Error("canonical flagship plan failed to build");
  return result;
}
