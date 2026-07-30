/**
 * Built-plan and borrow-verdict fixtures. Extracted from the wallet suites for the Codex
 * D-011 F5(b) quarantine and its round-2 extension: neither `src/lib/wallet/**` nor
 * `src/components/wallet/**` — their tests included — carries a VALUE import of core
 * money-math, so the plan a wallet test gates against and the verdict a wallet surface renders
 * are computed HERE, outside the boundary, and handed in as the values those surfaces' own
 * type signatures name.
 */
import { borrowLimitVerdict, type BorrowLimitVerdict } from "../../src/core/borrow-limit";
import { buildPlan, type PlanSuccess } from "../../src/core/plan";
import { fixtureSnapshot } from "./chain-snapshot";
import { flagshipGraph } from "./graphs";

/** The canonical 13-step flagship over the reads-log fixture — throws rather than defaults. */
export function canonicalFlagshipPlan(): PlanSuccess {
  const result = buildPlan(flagshipGraph(), fixtureSnapshot());
  if (!result.ok) throw new Error("canonical flagship plan failed to build");
  return result;
}

/** SPEC §3 step 4's verdict for the flagship at a chosen borrow allocation. */
export function flagshipBorrowVerdict(allocationBps: number): BorrowLimitVerdict {
  return borrowLimitVerdict(flagshipGraph(10, allocationBps), fixtureSnapshot());
}

/**
 * One step past the largest allocation the active configuration admits — COMPUTED from the
 * ceiling `core/` reports, never typed. A hardcoded over-limit number would pass while the app
 * and the core disagreed about where the limit is.
 */
export function flagshipOverLimitBps(): number {
  const within = flagshipBorrowVerdict(7000);
  if (within.status !== "within") {
    throw new Error("the flagship at 70% must be within the limit for this fixture to mean anything");
  }
  return within.ceiling.maxAllocationBps + 100;
}
