import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit suite only; the anvil fork suite runs via vitest.fork.config.ts.
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts"],
      exclude: ["src/core/**/*.test.ts"],
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
});
