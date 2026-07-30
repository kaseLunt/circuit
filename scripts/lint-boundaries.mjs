/**
 * Boundary-lint regression gate (W07 finding 4).
 *
 * The money↔transport quarantine and the execution module's purity contract are ESLint rules.
 * A rule that has never been observed to fire is a claim, not a gate — a mistyped selector, a
 * path glob that stopped matching after a file moved, or a flat-config block that got REPLACED
 * instead of merged all fail SILENTLY, reporting "lint clean" over exactly the code the rule
 * existed to catch.
 *
 * So the fixtures under `tests/lint/fixtures/` violate every prohibited route exactly once, one
 * per line, each tagged `@route:<name>`; this script asserts the EXACT set of (route, ruleId)
 * pairs they produce. Matching on rule IDs alone would let the boundary rot one ban at a time —
 * twenty `no-restricted-imports` hits in one file stay nineteen when a single import name is
 * dropped from the config, and a rule-ID check would not care. Route-level matching does.
 *
 * Run:  npm run check:lint-boundaries
 */
import { ESLint } from "eslint";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";

// CLI output channel, routed through stdout/stderr directly so `no-console` stays an error
// repo-wide (the scripts/protocol-reads.mjs pattern).
const emit = (line) => process.stdout.write(`${line}\n`);
const fail = (line) => process.stderr.write(`${line}\n`);

/**
 * Every fixture, and the exact (route, rule) pairs it must produce. One entry per prohibited
 * route: adding a ban to the config means adding a fixture line AND an entry here, and
 * removing one from the config fails this gate.
 */
const EXPECTED = {
  "tests/lint/fixtures/core/imports-execution.ts": [
    ["core-imports-execution-file", "no-restricted-imports"],
    ["core-imports-execution-dir", "no-restricted-imports"],
    ["core-imports-server", "no-restricted-imports"],
  ],
  "tests/lint/fixtures/server/leaks-public-env.ts": [
    ["next-public-env-dot", "no-restricted-syntax"],
    ["next-public-env-bracket", "no-restricted-syntax"],
    ["next-public-env-destructure", "no-restricted-syntax"],
    ["next-public-env-alias", "no-restricted-syntax"],
  ],
  "tests/lint/fixtures/server/leaks-public-env.tsx": [
    ["next-public-env-tsx", "no-restricted-syntax"],
  ],
  // W08 wallet-seam routes (treatment §1.1/§1.2, doctrine D5): folded in from the
  // interim tests/lint/w08-boundaries.test.ts gate once scripts/** joined the charter.
  "tests/lint/fixtures/core/imports-wallet.ts": [
    ["core-imports-wagmi", "no-restricted-imports"],
    ["core-imports-wagmi-subpath", "no-restricted-imports"],
    ["core-imports-wallet-file", "no-restricted-imports"],
    ["core-imports-wallet-dir", "no-restricted-imports"],
  ],
  "tests/lint/fixtures/execution/imports-wallet.ts": [
    ["execution-imports-wallet-file", "no-restricted-imports"],
    ["execution-imports-wallet-dir", "no-restricted-imports"],
  ],
  "tests/lint/fixtures/server/imports-wallet.ts": [
    ["server-imports-wagmi", "no-restricted-imports"],
    ["server-imports-wagmi-subpath", "no-restricted-imports"],
    ["server-imports-wallet-dir", "no-restricted-imports"],
    ["server-imports-wallet-file", "no-restricted-imports"],
  ],
  "tests/lint/fixtures/wallet/impure.ts": [
    ["wallet-viem-createClient", "no-restricted-imports"],
    ["wallet-viem-createPublicClient", "no-restricted-imports"],
    ["wallet-viem-createTestClient", "no-restricted-imports"],
    ["wallet-viem-createTransport", "no-restricted-imports"],
    ["wallet-mints-provenance", "no-restricted-imports"],
    ["wallet-imports-server", "no-restricted-imports"],
  ],
  // Codex D-011 F5 routes: the repo-wide wagmi confinement (a) and the wallet boundary's
  // value-imports-of-core-money ban (b). The (b) fixture also carries a LEGAL type-only
  // import line that must NOT fire — the exact-multiset check makes its silence an
  // assertion too.
  "tests/lint/fixtures/app/imports-wagmi.ts": [
    ["app-imports-wagmi", "no-restricted-imports"],
    ["app-imports-wagmi-subpath", "no-restricted-imports"],
    ["app-imports-wagmi-scoped", "no-restricted-imports"],
  ],
  "tests/lint/fixtures/wallet/imports-core-money.ts": [
    ["wallet-imports-core-plan", "@typescript-eslint/no-restricted-imports"],
    ["wallet-imports-core-risk", "@typescript-eslint/no-restricted-imports"],
    ["wallet-imports-core-borrow-limit", "@typescript-eslint/no-restricted-imports"],
    ["wallet-imports-core-rates", "@typescript-eslint/no-restricted-imports"],
  ],
  // Codex round-2 finding 3: the same ban on the wallet's RENDERING surface, which wagmi is
  // legal in and which the F5(b) rule had left out. Same four routes, same legal type-only
  // line whose SILENCE the exact-multiset check also asserts.
  "tests/lint/fixtures/components-wallet/imports-core-money.ts": [
    ["components-wallet-imports-core-plan", "@typescript-eslint/no-restricted-imports"],
    ["components-wallet-imports-core-risk", "@typescript-eslint/no-restricted-imports"],
    ["components-wallet-imports-core-borrow-limit", "@typescript-eslint/no-restricted-imports"],
    ["components-wallet-imports-core-rates", "@typescript-eslint/no-restricted-imports"],
  ],
  "tests/lint/fixtures/execution/impure.ts": [
    ["react", "no-restricted-imports"],
    ["react-dom", "no-restricted-imports"],
    ["viem-createClient", "no-restricted-imports"],
    ["viem-createPublicClient", "no-restricted-imports"],
    ["viem-createTestClient", "no-restricted-imports"],
    ["viem-createTransport", "no-restricted-imports"],
    ["viem-createWalletClient", "no-restricted-imports"],
    ["viem-custom", "no-restricted-imports"],
    ["viem-fallback", "no-restricted-imports"],
    ["viem-http", "no-restricted-imports"],
    ["viem-ipc", "no-restricted-imports"],
    ["viem-webSocket", "no-restricted-imports"],
    ["viem-clients-bare", "no-restricted-imports"],
    ["viem-clients-subpath", "no-restricted-imports"],
    ["viem-actions-bare", "no-restricted-imports"],
    ["viem-actions-subpath", "no-restricted-imports"],
    ["viem-window-subpath", "no-restricted-imports"],
    ["viem-node-subpath", "no-restricted-imports"],
    ["wagmi", "no-restricted-imports"],
    ["wagmi-subpath", "no-restricted-imports"],
    ["next-subpath", "no-restricted-imports"],
    ["server-chain-subpath", "no-restricted-imports"],
    ["fetch-bare", "no-restricted-globals"],
    ["xmlhttprequest", "no-restricted-globals"],
    ["fetch-globalthis", "no-restricted-syntax"],
    ["fetch-window", "no-restricted-syntax"],
    ["fetch-self", "no-restricted-syntax"],
    ["forged-observed", "no-restricted-syntax"],
    ["numeric-fallback-literal", "no-restricted-syntax"],
    ["numeric-fallback-unary", "no-restricted-syntax"],
  ],
};

const ROUTE_TAG = /@route:([a-zA-Z0-9-]+)/;

const asKey = (route, ruleId) => `${route} => ${ruleId}`;

/** Multiset difference: entries of `expected` that `found` does not account for, and vice versa. */
function reconcile(expected, found) {
  const remaining = [...found];
  const gaps = [];
  for (const entry of expected) {
    const at = remaining.indexOf(entry);
    if (at === -1) gaps.push(entry);
    else remaining.splice(at, 1);
  }
  return { gaps, surplus: remaining };
}

async function main() {
  const eslint = new ESLint({ ignore: false });
  const results = await eslint.lintFiles(Object.keys(EXPECTED));

  const observed = new Map();
  for (const result of results) {
    const file = relative(process.cwd(), result.filePath).split(sep).join("/");
    const lines = readFileSync(result.filePath, "utf8").split(/\r?\n/);
    const found = [];
    for (const message of result.messages) {
      if (message.ruleId === null) continue;
      const source = lines[message.line - 1] ?? "";
      const tag = ROUTE_TAG.exec(source);
      found.push(asKey(tag === null ? `UNTAGGED-LINE-${message.line}` : tag[1], message.ruleId));
    }
    observed.set(file, found);
  }

  const problems = [];
  for (const [file, routes] of Object.entries(EXPECTED)) {
    const found = observed.get(file);
    if (found === undefined) {
      problems.push(`${file}: fixture was not linted at all — has it been moved or deleted?`);
      continue;
    }
    const expected = routes.map(([route, ruleId]) => asKey(route, ruleId));
    const { gaps, surplus } = reconcile(expected, found);
    for (const gap of gaps) {
      problems.push(
        `${file}: expected [${gap}] and it did NOT fire — that boundary is no longer enforced.`,
      );
    }
    for (const extra of surplus) {
      problems.push(
        `${file}: unexpected [${extra}] — add it to this script's EXPECTED table or remove it.`,
      );
    }
    emit(`${file}: ${found.length}/${expected.length} prohibited routes still refused`);
  }

  const undeclared = [...observed.keys()].filter((file) => EXPECTED[file] === undefined);
  for (const file of undeclared) {
    problems.push(`${file}: fixture is not declared in this script's EXPECTED table`);
  }

  if (problems.length > 0) {
    fail("boundary-lint regression FAILED:");
    for (const problem of problems) fail(`  - ${problem}`);
    process.exit(1);
  }
  const total = Object.values(EXPECTED).reduce((sum, routes) => sum + routes.length, 0);
  emit(`boundary-lint regression OK: ${total} prohibited routes, each still refused exactly once`);
}

main().catch((error) => {
  fail(`boundary-lint regression could not run: ${error?.stack ?? String(error)}`);
  process.exit(1);
});
