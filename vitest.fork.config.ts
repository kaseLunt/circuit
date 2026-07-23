import { defineConfig } from "vitest/config";

// Anvil fork suite (W03): pinned block 25,592,678, spawned by the global setup.
// Kept apart from the unit config so `npm test` stays fast and RPC-free.
export default defineConfig({
  test: {
    include: ["tests/fork/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    globalSetup: ["tests/fork/global-setup.ts"],
    // The 13-step plan mutates one shared fork; keep execution strictly serial.
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    sequence: { concurrent: false },
  },
});
