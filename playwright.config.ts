import { defineConfig, devices } from "@playwright/test";

/**
 * The SPEC §3 demo script as an executable gate (SPEC §8: "Playwright: the §3 script end to
 * end"). W05's evidence target is steps 1–3 and 8 green on the recorded read set.
 *
 * PRODUCTION BUILD, NOT `next dev`, and the difference is correctness rather than speed:
 *   - `next dev` compiles routes on demand, so the first navigation of a run measures a
 *     compile and every timing assertion is a race against the bundler.
 *   - dev enables React Strict Mode's double-invoked effects. The §3 step-8 arrival is a
 *     LAYOUT effect that swaps the composer's store; asserting it under a double-mount would
 *     be asserting a behaviour no user ever runs.
 * The gate therefore exercises the artefact CI ships. `npm run build` is part of the command
 * rather than a documented precondition, because a suite that silently tests yesterday's
 * bundle is worse than one that takes twenty extra seconds.
 */
const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // The sandbox execution arc needs a live sandbox upstream and runs under
  // playwright.fork.config.ts; this suite must stay green with no chain and no
  // secrets on every external PR.
  testIgnore: "**/demo-script-fork.spec.ts",
  // A demo script whose steps interleave is a gate whose failures cannot be reproduced.
  // Determinism is the product of this suite; parallelism is not.
  fullyParallel: false,
  workers: 1,
  // Zero on purpose. This suite is EVIDENCE, and a pass that needed a second attempt is a
  // flake with a green tick on it — exactly the reading SPEC §8 exists to prevent.
  retries: 0,
  forbidOnly: Boolean(process.env["CI"]),
  reporter: process.env["CI"] ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    // §3 step 8 is a clipboard beat. `localhost` is a secure context, so `navigator.clipboard`
    // is the real API here rather than a stub — the test drives the same path a person does.
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
    // Deterministic geometry: the canvas solves its own viewport from the field's rect, so a
    // window size that varies between machines varies what fitView produces.
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npm run start -- -p ${PORT}`,
    /*
     * SPEC §3: "wallet interactions driven by a wagmi mock connector". These are BUILD-TIME
     * values — Next inlines `NEXT_PUBLIC_*` — so they are set on the whole webServer command,
     * build included, and a production deployment that does not set them ships exactly one
     * connector (`injected`) and no scenario table at all.
     *
     * Two accounts, and what each one stands for, declared together. The scenario is what
     * makes step 7's footprint refusal executable: one wallet reads clear, the other reads as
     * already holding an Aave Core position. They drive REFUSALS only — no money-math reads
     * them and no quantity is derived from them.
     */
    env: {
      NEXT_PUBLIC_WALLET_MOCK_ACCOUNTS:
        "0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222",
      NEXT_PUBLIC_WALLET_MOCK_OCCUPIED: "0x2222222222222222222222222222222222222222",
    },
    url: BASE_URL,
    reuseExistingServer: !process.env["CI"],
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
