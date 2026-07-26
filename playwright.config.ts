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
    url: BASE_URL,
    reuseExistingServer: !process.env["CI"],
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
