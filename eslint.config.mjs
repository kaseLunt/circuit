import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [".next/**", "node_modules/**", "roadmap/**", "spikes/**", "scripts/**", "coverage/**"],
  },
  {
    // Application code is console-free; a `log` util gates any debug output.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // Provenance boundary (D-004): only src/core/provenance.ts may construct the
    // Observed shape. Everywhere else must go through observationMinter().observe,
    // so a bare `{ kind: "observed", ... }` literal cannot forge a chain reading.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/core/provenance.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ObjectExpression > Property[key.name='kind'] > Literal[value='observed']",
          message:
            "Do not forge Observed provenance; construct it via observationMinter(...).observe (provenance boundary).",
        },
      ],
    },
  },
];

export default eslintConfig;
