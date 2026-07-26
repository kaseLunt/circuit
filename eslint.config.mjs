import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const forgedObservedBan = {
  selector: "ObjectExpression > Property[key.name='kind'] > Literal[value='observed']",
  message:
    "Do not forge Observed provenance; construct it via observationMinter(...).observe (provenance boundary).",
};

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
    ],
  },
  {
    // Console-free everywhere, not just in src/: the fork suite and the reads script are
    // evidence-bearing, so their output goes through explicit stdout/stderr writers
    // (tests/fork/harness.ts `record`, scripts/protocol-reads.mjs `out`/`fail`). Linting
    // scripts/** and tests/** at all is the point — ignoring them reported "lint clean"
    // over exactly the paths that produce W03's evidence.
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts", "scripts/**/*.mjs"],
    rules: {
      "no-console": "error",
    },
  },
  // Two structural bans below. ESLint flat config REPLACES (not merges) a rule's
  // options across matching blocks, so each file group lists its full selector set:
  //   forge ban   (D-004): only provenance.ts may construct the Observed shape.
  //   numeric ban (SPEC §5/§7, W03): no `?? <numeric literal>` in core/ — a missing
  //   source surfaces an explicit unavailable state, never a defaulted number.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/core/**"],
    rules: {
      "no-restricted-syntax": ["error", forgedObservedBan],
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
      "src/lib/strategy/templates.ts",
      "src/lib/strategy/layout.ts",
      "src/app/store/composer-store.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", forgedObservedBan, ...numericFallbackBan],
    },
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
