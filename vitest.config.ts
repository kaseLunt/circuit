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
        "src/lib/strategy/templates.ts",
        "src/lib/strategy/layout.ts",
        "src/app/store/composer-store.ts",
      ],
      exclude: ["src/**/*.test.{ts,tsx}"],
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
});
