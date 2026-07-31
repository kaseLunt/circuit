/**
 * The fork suite's anvil endpoints, and the port map that keeps them apart.
 *
 * TWO anvils face the metered provider, and that count is the point (R-3a74989b
 * consolidation). Everything else in the suite is a LOCAL child forked from one of them, and
 * a local fork costs the upstream endpoint nothing.
 *
 *  - `ANVIL_URL` (8547): the base fork the flagship suite EXECUTES on. It mines — the W03
 *    rebase drills advance its head deliberately — so it can never be shared with a suite
 *    that needs historical-tag reads (see the wedge note below), and it keeps its own boot.
 *  - `SESSION_UPSTREAM_URL` (9639): ONE pristine, never-mined upstream serving every
 *    session-shaped suite. `tests/fork/global-setup.ts` boots it once per vitest invocation
 *    and asserts `head == PIN` at boot AND at teardown.
 *
 * WHY ONE PRISTINE UPSTREAM IS SAFE, and why the three suites used to spawn three. An anvil
 * serving concurrent historical-tag state reads to forked children WEDGES PERMANENTLY once
 * its own head passes the tag — silent total unresponsiveness, not an error. The fix was a
 * dedicated upstream whose head never moves. But "never moves" is a property of the upstream,
 * not of the suite that owns it: a never-mined anvil stays at the pin forever, so one of them
 * serves N suites exactly as safely as N of them serve one each. What made three necessary was
 * ownership, not correctness — and three cold bootstraps against a free-tier endpoint is what
 * the CI flake was made of.
 *
 * PORT MAP. Session children fork from the shared upstream and get their own disjoint ranges
 * so a leaked child can never be mistaken for another suite's:
 *
 *   8547         base anvil (flagship; MINES) — also the e2e-fork rig's SANDBOX_FORK_URL
 *   9545+        the production sandbox default range — left clear
 *   9639         the SHARED pristine session upstream
 *   9645–9648    session-isolation children
 *   9655–9658    execution-drills children
 *   9665–9669    usdc-carry children
 *
 * RETIRED, and deliberately left unused so a stale process from an older checkout cannot be
 * mistaken for a live one: 9640, 9653, 9663 (the three per-suite upstreams this consolidation
 * replaced).
 */
export const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? "8547");
export const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

/**
 * The shared pristine upstream. One below the session-child family so every child range can
 * grow upward without ever colliding with it.
 */
export const SESSION_UPSTREAM_PORT = Number(process.env.SESSION_UPSTREAM_PORT ?? "9639");
export const SESSION_UPSTREAM_URL = `http://127.0.0.1:${SESSION_UPSTREAM_PORT}`;
