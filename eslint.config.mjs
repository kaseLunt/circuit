import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const forgedObservedBan = {
  selector: "ObjectExpression > Property[key.name='kind'] > Literal[value='observed']",
  message:
    "Do not forge Observed provenance; construct it via observationMinter(...).observe (provenance boundary).",
};

// W07 finding 4. `no-restricted-globals` only sees a BARE `fetch(...)`; the same call
// reached through an object member sails past it, so the two member forms are banned by
// syntax. Together with the viem client/transport import ban below, this closes the routes
// out of `src/lib/execution/`'s purity contract that a docstring alone left open.
const memberFetchBan = ["globalThis", "window", "self"].map((host) => ({
  selector: `MemberExpression[object.name='${host}'][property.name='fetch']`,
  message:
    "src/lib/execution must stay pure — chain reads are injected through AttributionReads, never fetched here.",
}));

// W07 treatment A6/§5.1 (hardened per Codex round-1 finding 7): the sandbox fork/admin
// RPC is server-only configuration, and a NEXT_PUBLIC_* env var is a client-shipped
// value by Next.js contract — so server modules must not touch the NAME at all. Banning
// only `process.env.X` member access left verified bypasses open (destructuring
// `const {NEXT_PUBLIC_X} = process.env`, aliasing `const env = process.env`), so the ban
// is on every occurrence of the name itself: any Identifier and any string Literal
// matching ^NEXT_PUBLIC_ anywhere in src/server/** (.ts AND .tsx).
const publicEnvInServerBan = [
  {
    selector: "Identifier[name=/^NEXT_PUBLIC_/]",
    message:
      "src/server must not touch NEXT_PUBLIC_* env names — the fork/admin RPC and session config are server-only (SPEC §6, treatment A6).",
  },
  {
    selector: "Literal[value=/^NEXT_PUBLIC_/]",
    message:
      "src/server must not touch NEXT_PUBLIC_* env names — the fork/admin RPC and session config are server-only (SPEC §6, treatment A6).",
  },
];

const numericFallbackBan = [
  {
    selector: "LogicalExpression[operator='??'] > Literal.right[raw=/^[0-9.]/]",
    message:
      "No numeric-literal ?? fallback in core/ — surface the missing source explicitly (SPEC §5/§7).",
  },
  {
    selector: "LogicalExpression[operator='??'] > UnaryExpression.right > Literal[raw=/^[0-9.]/]",
    message:
      "No numeric-literal ?? fallback in core/ — surface the missing source explicitly (SPEC §5/§7).",
  },
];

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "roadmap/**",
      "spikes/**",
      "coverage/**",
      ".remember/**",
      // W07 finding 4: these files exist to FAIL the boundary rules below, which is how we
      // know the rules are not vacuous. They are ignored here so `npm run lint` stays green,
      // and linted deliberately — with ignores disabled — by
      // `npm run check:lint-boundaries`, which fails if any of them ever stops erroring.
      "tests/lint/fixtures/**",
    ],
  },
  {
    // Console-free everywhere, not just in src/: the fork suite and the reads script are
    // evidence-bearing, so their output goes through explicit stdout/stderr writers
    // (tests/fork/harness.ts `record`, scripts/protocol-reads.mjs `out`/`fail`). Linting
    // scripts/** and tests/** at all is the point — ignoring them reported "lint clean"
    // over exactly the paths that produce W03's evidence.
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts", "e2e/**/*.ts", "scripts/**/*.mjs"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // The single sanctioned console writer. The browser has no stderr, so client-side
    // warn/error reach the host console from here and nowhere else. Every other
    // src/** file remains no-console: error.
    files: ["src/lib/log.ts"],
    rules: {
      "no-console": "off",
    },
  },
  // Two structural bans below. ESLint flat config REPLACES (not merges) a rule's
  // options across matching blocks, so each file group lists its full selector set:
  //   forge ban   (D-004): only provenance.ts may construct the Observed shape.
  //   numeric ban (SPEC §5/§7, W03): no `?? <numeric literal>` in core/ — a missing
  //   source surfaces an explicit unavailable state, never a defaulted number.
  {
    // W05 phase exit (Codex 019fa026 finding 1): the numeric ban is src/-wide.
    // It began scoped to core/ plus named money-adjacent files, which left
    // src/app, src/lib/recorded-reads and src/server unguarded — clean in fact,
    // but "lint enforces throughout src/" was false until this block made it true.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/core/**"],
    rules: {
      "no-restricted-syntax": ["error", forgedObservedBan, ...numericFallbackBan],
    },
  },
  {
    files: ["src/core/**/*.ts"],
    ignores: ["src/core/provenance.ts"],
    rules: {
      "no-restricted-syntax": ["error", forgedObservedBan, ...numericFallbackBan],
    },
  },
  {
    files: ["src/core/provenance.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...numericFallbackBan],
    },
  },
  {
    // W05 R10. These four carry money-adjacent contracts outside core/: the bps
    // domains both write paths share, the untrusted share/draft payload, the template
    // defaults, and the document every simulation is computed over. SPEC §7 names the
    // composer alongside core/ for the numeric ban, and a `?? 0` on a missing rate,
    // price or allocation is the same defect here as it is in core/. Listed after the
    // src/** block on purpose — flat config replaces a rule's options rather than
    // merging them, so the forge ban is restated rather than inherited.
    files: [
      "src/lib/share/encode.ts",
      "src/lib/share/share-url.ts",
      "src/lib/strategy/templates.ts",
      "src/lib/strategy/layout.ts",
      "src/app/store/composer-store.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", forgedObservedBan, ...numericFallbackBan],
    },
  },
  {
    // W05 canvas batch (treatment §5 trap 3): the component family is the first
    // consumer path where a `?? 0` on a rate, price or allocation is invisible to
    // review — the same defect there as in core/. forgedObservedBan is restated
    // because this block replaces the catch-all's rule entry for these files.
    files: ["src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", forgedObservedBan, ...numericFallbackBan],
    },
  },
  {
    // W07 treatment §1.2 / A19, the money↔transport quarantine, scoped to the surface this
    // commit creates. `src/lib/execution/` is the client-side execution driver; it may read
    // the chain-record facet of a receipt, so nothing in `core/` may depend on it without
    // dragging transport toward money-math. W08 landed `src/lib/wallet/` and wagmi, so the
    // ban this comment used to defer is now written: a ban on a non-existent path is a claim
    // the linter cannot check, and these paths now exist.
    files: ["src/core/**/*.ts", "tests/lint/fixtures/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/lib/execution/*", "**/lib/execution"],
              message:
                "core/ must not import the execution driver — transport observation never feeds money-math (CLAUDE.md money rules, treatment §1.2).",
            },
            {
              // W08 treatment §1.2, the wallet half of the same quarantine. The injected
              // provider is attacker-controllable; a `core/` module that could reach it
              // could read a forged balance into money-math (seam A1/A19).
              group: ["wagmi", "wagmi/*", "@wagmi/*"],
              message:
                "core/ must not import the wallet stack — the injected provider is transport, and transport never feeds money-math (treatment §1.2, seam A1).",
            },
            {
              group: ["**/lib/wallet", "**/lib/wallet/*"],
              message:
                "core/ must not import the wallet boundary — the wallet's address crosses toward money-math only as captureChainSnapshot's `user` argument (treatment §1.1).",
            },
            {
              // W07: src/server now carries the session service (registry, fork
              // lifecycle, execute path) — stateful, networked, transaction-sending
              // code that core's pure money-math may never depend on (treatment §1.2).
              group: ["**/server/**"],
              message:
                "core/ must not import server modules — snapshots flow INTO core as arguments; core never reaches out (CLAUDE.md money rules, treatment §1.2).",
            },
          ],
        },
      ],
    },
  },
  {
    // W07: the sandbox session service. The catch-all src/** block's syntax bans are
    // restated because flat config replaces a rule's options rather than merging them.
    // Covers .tsx too (finding 7): a server file's extension must not be a bypass.
    files: ["src/server/**/*.{ts,tsx}", "tests/lint/fixtures/server/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        forgedObservedBan,
        ...numericFallbackBan,
        ...publicEnvInServerBan,
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // W08, seam A1 stated from the money side: `src/server/**` is where every
              // money-bearing read is performed. If it could reach the wallet stack, a
              // balance, an allowance or a receipt could be read from the injected provider
              // — the one route the whole boundary exists to close.
              group: ["wagmi", "wagmi/*", "@wagmi/*", "**/lib/wallet", "**/lib/wallet/*"],
              message:
                "src/server must not import the wallet stack — money-bearing reads go through our configured RPC, never the injected provider (treatment §1.1, seam A1).",
            },
          ],
        },
      ],
    },
  },
  {
    // W08 treatment §1.1: the wallet boundary observes TRANSPORT. Two routes out of that
    // contract are closed by name here — minting provenance (it may not: no transport fact
    // becomes `Observed`), and opening its own chain client (it may not: the seam readings
    // come from `server/chain`'s configured RPC, and a read this module performed itself
    // would be a read through the wallet's own stack).
    files: ["src/lib/wallet/**/*.{ts,tsx}", "tests/lint/fixtures/wallet/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "viem",
              importNames: [
                "createClient",
                "createPublicClient",
                "createTestClient",
                "createTransport",
              ],
              message:
                "src/lib/wallet must not open its own chain client — seam readings arrive from server/chain's configured RPC (treatment §1.1, seam A1).",
            },
          ],
          patterns: [
            {
              group: ["**/core/provenance", "**/core/provenance/*"],
              message:
                "src/lib/wallet must not mint provenance — nothing the wallet observes becomes Observed (treatment §1.1, seam A19).",
            },
            {
              group: ["**/server/**"],
              message:
                "src/lib/wallet must not import server modules — chain reads arrive through the injected seam source, never by reaching across the boundary (treatment §1.1).",
            },
          ],
        },
      ],
    },
  },
  {
    // The other half of the same boundary: the attribution module is pure by contract, so
    // its purity is lint-enforced rather than asserted in a docstring. Every chain read it
    // performs arrives through the injected `AttributionReads`.
    //
    // viem is banned by NAME, not wholesale: `getAddress`/`parseAbi`/`decodeEventLog` are
    // pure byte math and legitimately used here (the same reasoning core/ uses). What may
    // not cross is anything that can OPEN a connection — a client or a transport — because
    // that is the difference between decoding a receipt and going and getting one.
    files: ["src/lib/execution/**/*.ts", "tests/lint/fixtures/execution/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "src/lib/execution must stay pure — no React." },
            { name: "react-dom", message: "src/lib/execution must stay pure — no React." },
            {
              name: "viem",
              importNames: [
                "createClient",
                "createPublicClient",
                "createWalletClient",
                "createTestClient",
                "createTransport",
                "custom",
                "fallback",
                "http",
                "ipc",
                "webSocket",
              ],
              message:
                "src/lib/execution must stay pure — viem's ABI utilities are fine, its clients and transports are not; inject reads through AttributionReads.",
            },
          ],
          patterns: [
            {
              group: [
                "next/*",
                "wagmi",
                "wagmi/*",
                // Both forms: a bare `viem/actions` import is exactly as much of an escape
                // as a deep one, and `viem/actions/*` alone does not match it.
                "viem/clients",
                "viem/clients/*",
                "viem/actions",
                "viem/actions/*",
                "viem/window",
                "viem/node",
                "**/server/chain/*",
              ],
              message:
                "src/lib/execution must stay pure — no framework, no wallet stack, no chain client; inject reads instead.",
            },
            {
              // W08: the wallet boundary is React + connector I/O. The execution machine is
              // handed `WalletSession.address` by its driver; it never reaches for the
              // wallet itself, or the purity contract this whole block enforces is moot.
              group: ["**/lib/wallet", "**/lib/wallet/*"],
              message:
                "src/lib/execution must stay pure — the wallet boundary is React and connector I/O; the driver passes its facts in (treatment §1.1).",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "src/lib/execution must stay pure — chain reads are injected through AttributionReads, never fetched here.",
        },
        {
          name: "XMLHttpRequest",
          message: "src/lib/execution must stay pure — no transport of any kind.",
        },
      ],
      // Flat config REPLACES a rule's options rather than merging them, so the src/** bans
      // are restated here or these files would silently lose them.
      "no-restricted-syntax": [
        "error",
        forgedObservedBan,
        ...numericFallbackBan,
        ...memberFetchBan,
      ],
    },
  },
  {
    // The e2e geometry evidence is emitted as a GitHub Actions `::notice` line,
    // which the runner parses from stdout — so this one file writes to the
    // console by design (the B5 pattern: a sanctioned writer is declared here,
    // never dodged via process.stdout).
    files: ["e2e/demo-script.spec.ts", "e2e/demo-script-fork.spec.ts"],
    rules: { "no-console": "off" },
  },
  {
    // W05 R10. The shared fixtures mint every Observed through observationMinter over
    // the committed reads log; a hand-written observed literal here would forge
    // provenance into every suite that imports them — including the ones asserting
    // that provenance is honest.
    files: ["tests/helpers/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", forgedObservedBan],
    },
  },
];

export default eslintConfig;
