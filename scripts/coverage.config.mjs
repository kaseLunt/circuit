/**
 * Single source of the vitest coverage configuration (W07 phase re-review, round 4).
 *
 * This object used to live inline in `vitest.config.ts`, and `scripts/check-coverage-manifest.mjs`
 * validated it by searching that file's RAW TEXT. Raw-text validation cannot tell code from a
 * comment: an include entry commented out — or a commented-out copy of the 100% threshold left
 * beside a softened live one — satisfied every check while the config vitest actually loads had
 * dropped them. The guard reported green over the exact drift it existed to catch.
 *
 * So the config is exported from here, and the guard imports THIS OBJECT and asserts on it.
 * `vitest.config.ts` consumes the same export, which makes the thing under test and the thing
 * that runs one value rather than two texts that have to agree.
 */

/** The threshold key this manifest exists to keep honest, and the directory it resolves over. */
export const EXECUTION_DIR = "src/lib/execution";
export const EXECUTION_GLOB = "src/lib/execution/*.ts";

/**
 * Every file `EXECUTION_GLOB` must resolve to — the modules the 100% threshold covers. Test
 * files are excluded because the coverage config excludes them.
 */
export const EXECUTION_FILES = [
  "attribution.ts",
  "machine.ts",
  "output-claims.ts",
  "plan-hash.ts",
  "record.ts",
  "resume.ts",
  "tolerance.ts",
  // Type-only — no runtime statements, so it contributes no uncovered lines. Named anyway:
  // this manifest is a claim about what the glob RESOLVES to, not about who carries weight.
  "types.ts",
];

/** @type {import("vitest/node").CoverageOptions} */
export const coverageConfig = {
  provider: "v8",
  /**
   * W05 R10: the four modules this phase adds are named FILE BY FILE, not by a
   * `src/lib/**` / `src/app/**` glob. A directory glob would silently enrol every
   * future module in the same thresholds, which moves the gate instead of
   * extending it — the next uncovered component would either fail an unrelated
   * PR or force the numbers down. Adding a module here is a deliberate act.
   */
  include: [
    "src/core/**/*.ts",
    "src/lib/share/encode.ts",
    "src/lib/share/share-url.ts",
    "src/lib/strategy/templates.ts",
    "src/lib/strategy/layout.ts",
    "src/app/store/composer-store.ts",
    // W05 close (ledger D6): the canvas/composer families were the largest
    // surface carrying zero coverage weight. Enrolled deliberately, per the
    // rule above — each entry is a file this phase shipped and tested.
    "src/app/store/composer-provider.tsx",
    "src/lib/recorded-reads/reads-log.ts",
    "src/lib/recorded-reads/recorded-snapshot.ts",
    "src/lib/recorded-reads/sandbox-snapshot.ts",
    "src/lib/strategy/types.ts",
    "src/components/shared/sourced-value.tsx",
    "src/components/composer/arrival.ts",
    "src/components/composer/simulation-host.tsx",
    // W07: the attribution module is §5.5 money-path and fork-proven by identity.
    "src/lib/execution/attribution.ts",
    // W07 session service: the pure decision surfaces are enrolled file by file.
    // fork-session.ts is deliberately NOT here — it is process/socket I/O end to
    // end and is proven where that is honest (tests/fork/session-isolation.test.ts);
    // enrolling it would either fake coverage with mocked sockets or drag the gate.
    "src/lib/execution/tolerance.ts",
    // W07 execution-state-machine surface: the pure machine, its durable record,
    // the resume/wire adapter, and the shared type grammar — each a deliberate enrol.
    "src/lib/execution/types.ts",
    "src/lib/execution/record.ts",
    "src/lib/execution/machine.ts",
    "src/lib/execution/resume.ts",
    // W07 hard-gate round: the plan fingerprint, extracted verbatim from
    // execute-step.ts so the client pointer can bind to it (one definition, §10.10).
    "src/lib/execution/plan-hash.ts",
    // W07 verification round: the money-claim validator both adoption seams share.
    "src/lib/execution/output-claims.ts",
    "src/server/sandbox/session-registry.ts",
    "src/server/sandbox/execute-step.ts",
    "src/server/sandbox/deadlines.ts",
    "src/server/sandbox/port-lease.ts",
    "src/server/sandbox/process-exit.ts",
    "src/server/sandbox/anvil-args.ts",
    "src/server/trpc/sandbox-router.ts",
    // W07 tx-family surface: the impure driver, the wire-fact provenance wrappers,
    // and the components' pure derivations — each shipped and tested this round.
    // Deliberately NOT enrolled: src/lib/tx/transport.ts (tRPC client composition —
    // I/O thread-through per D10; its one narrowing helper is exercised through the
    // driver suite) and src/app/api/trpc/[trpc]/route.ts (route-handler binding of
    // covered modules; proven where honest — the router's own suite and the fork
    // gate).
    // W08 wallet boundary: the live gate is the decision home (doctrine D10) — every
    // refusal in SPEC §3 step 7 is decided here, so it carries the money-path bar below.
    // Deliberately NOT enrolled: config.ts/seam.ts/wallet-provider.tsx (connector I/O and
    // scenario thread-through, proven in live-gating.test.tsx and the e2e beats).
    "src/lib/wallet/gate.ts",
    // W08 remediation (Codex D-011 F2): the live-capture wire codec, the wallet router,
    // and the composer's live-simulation decisions — each shipped and tested this round.
    // Deliberately NOT enrolled: src/lib/live/live-transport.ts (tRPC client composition —
    // I/O thread-through per D10, the src/lib/tx/transport.ts precedent),
    // src/lib/live/demo-capture.ts (scenario thread-through, the seam.ts precedent, proven
    // in live-gating.test.tsx), and src/server/chain/live-readiness.ts (chain I/O end to
    // end, proven where honest — the fork e2e suite against a real upstream).
    "src/lib/live/snapshot-wire.ts",
    "src/server/trpc/wallet-router.ts",
    "src/components/composer/live-simulation.ts",
    "src/lib/tx/driver.ts",
    "src/lib/tx/provenance.ts",
    "src/components/tx/step-status.ts",
    "src/components/tx/announcements.ts",
    "src/components/tx/step-list.tsx",
    "src/components/tx/transaction-button.tsx",
    "src/components/tx/halt-card.tsx",
    "src/components/tx/failure-card.tsx",
    "src/components/tx/stop-card.tsx",
    "src/components/tx/pre-sign-review.tsx",
    "src/components/tx/execution-flow.tsx",
    "src/components/tx/execution-host.tsx",
  ],
  exclude: ["src/**/*.test.{ts,tsx}"],
  thresholds: {
    lines: 95,
    branches: 90,
    functions: 95,
    statements: 95,
    // The execution money path holds 100% as an enforced, commit-bound claim
    // (phase-review finding: a percentage nobody enforces is a claim, not evidence).
    // process-exit.ts carries one uncovered function: the never-invoked no-op
    // placeholder its promise executor replaces at construction.
    // A per-glob threshold that matches nothing is silence, not an error, so
    // `scripts/check-coverage-manifest.mjs` runs first (via `npm run test:coverage`)
    // and refuses the run if this glob stops resolving to its named files.
    "src/lib/execution/*.ts": { lines: 100, branches: 100, statements: 100 },
    // W08: the wallet decision module holds the same bar — a live-mode refusal decided
    // by an uncovered branch is exactly the drift the execution gate exists to refuse.
    "src/lib/wallet/gate.ts": { lines: 100, branches: 100, statements: 100 },
  },
};
