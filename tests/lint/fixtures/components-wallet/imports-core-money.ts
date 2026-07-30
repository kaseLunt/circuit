/**
 * LINT FIXTURE — every marked line below is SUPPOSED to fail the boundary gate.
 *
 * Codex round-2 finding 3: the same type-only restriction the wallet BOUNDARY carries
 * (`../wallet/imports-core-money.ts`), applied to the wallet's RENDERING surface. wagmi is
 * legal in `src/components/wallet/**` — that is where the connect control lives — so a value
 * import of `buildPlan`, `riskLedger`, `borrowLimitVerdict` or the ray primitives would put an
 * attacker-controllable provider and money-math in one module. Money is computed outside and
 * arrives as props.
 *
 * The type-only import at the bottom is the LEGAL form and must stay clean: if it ever fires,
 * `allowTypeImports` has been dropped and the refusal card's own type surface would be illegal
 * with it.
 *
 * ONE PROHIBITED ROUTE PER LINE, each tagged `@route:<name>`; the exact (route, ruleId)
 * multiset is asserted by `scripts/lint-boundaries.mjs` (doctrine D5 — gaps AND surplus both
 * fail). Do not "fix" this file: deleting a violation deletes the evidence.
 */
import { buildPlan } from "../../../../src/core/plan"; // @route:components-wallet-imports-core-plan
import { riskLedger } from "../../../../src/core/risk"; // @route:components-wallet-imports-core-risk
import { borrowLimitVerdict } from "../../../../src/core/borrow-limit"; // @route:components-wallet-imports-core-borrow-limit
import { rayMul } from "../../../../src/core/rates"; // @route:components-wallet-imports-core-rates
import type { PlanSuccess } from "../../../../src/core/plan"; // legal on purpose: type-only

export const plan = buildPlan;
export const ledger = riskLedger;
export const verdict = borrowLimitVerdict;
export const ray = rayMul;
export type CardPlan = PlanSuccess;
