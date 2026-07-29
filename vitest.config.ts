import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit suite only; the anvil fork suite runs via vitest.fork.config.ts.
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
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
        "src/lib/execution/*.ts": { lines: 100, branches: 100, statements: 100 },
      },
    },
  },
});
