/**
 * LINT FIXTURE — every marked line below is SUPPOSED to fail the boundary gate.
 *
 * Codex D-011 F5(b): the wallet boundary may reference core money-math TYPES but never its
 * VALUES. A value import of `buildPlan`, `riskLedger`, `borrowLimitVerdict` or the ray
 * primitives would let wallet code run money-math over transport facts — the composer
 * computes those and passes results in. The type-only import at the bottom is the LEGAL
 * form and must stay clean: if it ever fires, `allowTypeImports` has been dropped and the
 * gate's own `PlanSuccess` parameter would be illegal with it.
 *
 * ONE PROHIBITED ROUTE PER LINE, each tagged `@route:<name>`; the exact (route, ruleId)
 * multiset is asserted by `scripts/lint-boundaries.mjs` (doctrine D5 — gaps AND surplus both
 * fail). Do not "fix" this file: deleting a violation deletes the evidence.
 */
import { buildPlan } from "../../../../src/core/plan"; // @route:wallet-imports-core-plan
import { riskLedger } from "../../../../src/core/risk"; // @route:wallet-imports-core-risk
import { borrowLimitVerdict } from "../../../../src/core/borrow-limit"; // @route:wallet-imports-core-borrow-limit
import { rayMul } from "../../../../src/core/rates"; // @route:wallet-imports-core-rates
import type { PlanSuccess } from "../../../../src/core/plan"; // legal on purpose: type-only

export const plan = buildPlan;
export const ledger = riskLedger;
export const verdict = borrowLimitVerdict;
export const ray = rayMul;
export type GatePlan = PlanSuccess;
