/**
 * LINT FIXTURE — every marked line below is SUPPOSED to fail `npm run check:lint-boundaries`.
 *
 * It stands in for a future `src/core/` module that reaches for the execution driver. The
 * money↔transport quarantine (CLAUDE.md money rules, P3 treatment §1.2 / A19) is enforced by
 * `no-restricted-imports` in `eslint.config.mjs`; a rule nobody has ever seen fire is a rule
 * that might not work, so this fixture makes it fire on demand.
 *
 * ONE PROHIBITED ROUTE PER LINE, each tagged `@route:<name>`. `scripts/lint-boundaries.mjs`
 * asserts the exact set of (route, ruleId) pairs, so removing a SINGLE ban from the config
 * fails the gate — a count-based check would have stayed green while the remaining bans
 * covered for the missing one.
 *
 * Excluded from the normal lint run via the global `ignores`, and from tsconfig (these
 * imports are lint targets, not code that has to resolve). Do not "fix" this file: deleting
 * a violation deletes the evidence.
 */
import { applyAllocation } from "../../../../src/lib/execution/attribution"; // @route:core-imports-execution-file
import * as execution from "../../../../src/lib/execution"; // @route:core-imports-execution-dir
import { createSessionRegistry } from "../../../../src/server/sandbox/session-registry"; // @route:core-imports-server

export const attributedShare = applyAllocation(1_000n, 2_500);
export const driver = execution;
export const registry = createSessionRegistry;
