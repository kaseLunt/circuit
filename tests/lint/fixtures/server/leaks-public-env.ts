/**
 * LINT FIXTURE — every marked line below is SUPPOSED to fail `npm run check:lint-boundaries`.
 *
 * It stands in for a `src/server/` module that reads the sandbox fork/admin RPC (or any
 * other server-only configuration) out of a NEXT_PUBLIC_* env var — a value Next.js ships
 * to every client by contract (SPEC §6, P3 treatment A6/§5.1). Every OCCURRENCE route is
 * probed, one per line, tagged `@route:<name>`: dot access, bracket access, destructuring,
 * and alias access — Codex round-1 finding 7 verified the last two walked past a
 * member-expression-only ban. `scripts/lint-boundaries.mjs` asserts the exact
 * (route, ruleId) pairs; the .tsx sibling probes the extension route.
 *
 * Excluded from the normal lint run via the global `ignores`, and from tsconfig. Do not
 * "fix" this file: deleting a violation deletes the evidence.
 */
export const dotLeak = process.env.NEXT_PUBLIC_FORK_RPC_URL; // @route:next-public-env-dot
export const bracketLeak = process.env["NEXT_PUBLIC_ANVIL_URL"]; // @route:next-public-env-bracket
const { NEXT_PUBLIC_FORK_UPSTREAM: destructuredLeak } = process.env; // @route:next-public-env-destructure
export const destructured = destructuredLeak;
const aliasedEnv = process.env;
export const aliasLeak = aliasedEnv.NEXT_PUBLIC_SESSION_RPC; // @route:next-public-env-alias
