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
      "scripts/**",
      "coverage/**",
      ".remember/**",
    ],
  },
  {
    // Application code is console-free; a `log` util gates any debug output.
    files: ["src/**/*.{ts,tsx}"],
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
];

export default eslintConfig;
