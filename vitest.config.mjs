import { defineConfig } from "vitest/config";

// The coverage object lives in scripts/coverage.config.mjs, and this file is plain JS so
// scripts/check-coverage-manifest.mjs can import THIS config's resolved default export and
// assert test.coverage is that object BY IDENTITY — a later spread or override replacing the
// coverage value produces a different object and fails the guard structurally.
import { coverageConfig } from "./scripts/coverage.config.mjs";

export default defineConfig({
  test: {
    // Unit suite only; the anvil fork suite runs via vitest.fork.config.ts.
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: coverageConfig,
  },
});
