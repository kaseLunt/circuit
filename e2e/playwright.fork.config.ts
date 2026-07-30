import { defineConfig, devices } from "@playwright/test";

/**
 * The sandbox execution arc — arm, review, execute, attribute, receipt — against a REAL
 * sandbox session. A separate config from playwright.config.ts because the two suites have
 * different environmental truths: the main suite runs on the recorded read set alone and
 * must stay green with no chain and no secrets on every external PR, while this one
 * REQUIRES a pristine upstream anvil at the pinned block for the session service to fork
 * from (`SANDBOX_FORK_URL`, server-only env — fork-session.ts throws per request rather
 * than defaulting).
 *
 * Locally this reuses the running sandbox harness (`next dev` on :3000 beside the anvil
 * upstream on :8547) — dev is NOT what CI measures, and the difference is real (on-demand
 * compilation, Strict Mode double effects), which is why every wait here is generous and
 * every assertion is state-based rather than timing-based. CI has no server to reuse, so
 * the webServer command builds and serves the production bundle, exactly like the sibling
 * config and for the same reason: the gate exercises the artefact CI ships.
 */
const PORT = process.env["FORK_E2E_PORT"] ?? "3000";
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: ".",
  testMatch: "**/demo-script-fork.spec.ts",
  // One worker, no retries: this is the same evidence discipline as the main config, and
  // the sandbox registry is capacity-capped — parallel runs would contend for forks.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A 13-step flagship execution against a fork is minutes, not seconds — the fork
  // vitest suite's own per-test budget, for the same run.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env["CI"]),
  reporter: process.env["CI"] ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // The sibling config's deterministic geometry, kept: the canvas solves its viewport
    // from the field's rect.
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium-fork", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env["CI"],
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      SANDBOX_FORK_URL: process.env["SANDBOX_FORK_URL"] ?? "http://127.0.0.1:8547",
      /*
       * The live-gating fork beat (Codex D-011 F2/F4): the wallet router captures the
       * connected address's readiness against OUR configured RPC — here the same pristine
       * pinned-block upstream the session service forks from, so the capture is
       * deterministic and the standing binds to the recorded block hash.
       */
      LIVE_CHAIN_RPC_URL:
        process.env["LIVE_CHAIN_RPC_URL"] ??
        process.env["SANDBOX_FORK_URL"] ??
        "http://127.0.0.1:8547",
      /*
       * ONE mock account — a high-entropy constant with no mainnet history, so the pinned
       * upstream reads it as a clean EOA (no code, no Aave footprint). Deliberately NOT the
       * hermetic suite's 0x1111… vanity address, whose mainnet state nobody controls.
       * `rpc` forces the REAL capture path even though a mock connector is configured: the
       * mock supplies the session, the wallet router performs the capture — which is what
       * makes this suite the authoritative proof of the F2 clearing path.
       */
      NEXT_PUBLIC_WALLET_MOCK_ACCOUNTS: "0x7f3a921c5be694fa8f3ba14e58cd06897e9dd47e",
      NEXT_PUBLIC_WALLET_LIVE_SOURCE: "rpc",
    },
  },
});
