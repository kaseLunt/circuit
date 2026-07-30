/**
 * "Fabricated readings may only ever attach to fabricated wallets" — the invariant Codex
 * round-2 finding 2 found broken, proven from both ends.
 *
 * The bug had two halves and so does this suite: the ROUTER must send every non-mock session
 * to the chain arm regardless of which arms exist, and the DEMO SOURCES must refuse an address
 * their scenario table does not name even if something routed one to them. Either half alone
 * would close the reported hole; both are asserted because a defence that depends on the other
 * one holding is not a defence.
 *
 * The component-level proof that the composer is wired this way lives in
 * `src/components/wallet/live-gating.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import { INJECTED_CONNECTOR_ID, MOCK_CONNECTOR_ID } from "../wallet/connectors";
import { demoSeam, unavailableSeam, type WalletSeamSource } from "../wallet/seam";
import type { ReadingTarget } from "../wallet/types";
import { demoLiveCaptureSource } from "./demo-capture";
import type { LiveCaptureSource } from "./live-transport";
import { demoMayAnswerFor, routedCaptureSource, routedSeam } from "./readiness-source";

const MOCK_WALLET: Address = getAddress("0x1111111111111111111111111111111111111111");
const REAL_WALLET: Address = getAddress("0x9999999999999999999999999999999999999999");

const NO_RPC = "no live chain source is configured in this deployment";

function target(address: Address, connectorId: string): ReadingTarget {
  return { address, connectorId };
}

/** A stand-in for either arm, labelled so a test can say WHICH one answered. */
function labelledCaptureSource(label: string): LiveCaptureSource {
  return {
    capture: () => Promise.resolve({ ok: false as const, kind: "call-failed" as const, reason: label }),
  };
}

function labelledSeam(label: string): WalletSeamSource {
  return unavailableSeam(label);
}

describe("demoMayAnswerFor", () => {
  it("admits the mock connector and every re-identified sibling", () => {
    expect(demoMayAnswerFor(target(MOCK_WALLET, MOCK_CONNECTOR_ID))).toBe(true);
    expect(demoMayAnswerFor(target(MOCK_WALLET, "mock-2"))).toBe(true);
    expect(demoMayAnswerFor(target(MOCK_WALLET, "mock-7"))).toBe(true);
  });

  it("refuses the injected connector and anything it does not recognize", () => {
    expect(demoMayAnswerFor(target(REAL_WALLET, INJECTED_CONNECTOR_ID))).toBe(false);
    expect(demoMayAnswerFor(target(REAL_WALLET, "walletConnect"))).toBe(false);
    expect(demoMayAnswerFor(target(REAL_WALLET, "unknown"))).toBe(false);
    // Near-misses are real wallets: the allow list is exact, and being wrong in this
    // direction costs a refusal rather than a fabricated pass.
    expect(demoMayAnswerFor(target(REAL_WALLET, "mockingbird"))).toBe(false);
    expect(demoMayAnswerFor(target(REAL_WALLET, "my-mock"))).toBe(false);
  });
});

describe("routedCaptureSource", () => {
  it("routes a mock-connector session to the demo arm", async () => {
    const source = routedCaptureSource({
      demo: labelledCaptureSource("demo"),
      rpc: labelledCaptureSource("rpc"),
    });
    const outcome = await source.capture(target(MOCK_WALLET, MOCK_CONNECTOR_ID));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("demo");
  });

  it("routes an injected-connector session to the RPC arm even though a demo arm exists", async () => {
    const source = routedCaptureSource({
      demo: labelledCaptureSource("demo"),
      rpc: labelledCaptureSource("rpc"),
    });
    const outcome = await source.capture(target(REAL_WALLET, INJECTED_CONNECTOR_ID));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("rpc");
  });

  it("routes everything to the RPC arm when no demo arm was composed", async () => {
    const source = routedCaptureSource({ demo: null, rpc: labelledCaptureSource("rpc") });
    for (const connectorId of [MOCK_CONNECTOR_ID, INJECTED_CONNECTOR_ID]) {
      const outcome = await source.capture(target(MOCK_WALLET, connectorId));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.reason).toBe("rpc");
    }
  });
});

describe("routedSeam", () => {
  it("routes the connect readings by the same rule as the capture", async () => {
    const seam = routedSeam({ demo: labelledSeam("demo"), rpc: labelledSeam("rpc") });

    const mock = await seam.read(target(MOCK_WALLET, MOCK_CONNECTOR_ID));
    expect(mock.code).toEqual({ status: "unknown", reason: "demo" });

    const real = await seam.read(target(REAL_WALLET, INJECTED_CONNECTOR_ID));
    expect(real.code).toEqual({ status: "unknown", reason: "rpc" });
  });

  it("sends a real wallet to the RPC arm's stated absence in a mock-enabled build", async () => {
    // The demo/CI deployment: mock accounts configured, no LIVE_CHAIN_RPC_URL. The RPC arm's
    // answer is an explicit unavailable state, which the gate turns into a refusal — the whole
    // point being that it is NOT "clear".
    const seam = routedSeam({
      demo: demoSeam({ accounts: [MOCK_WALLET], codeBearing: [], occupied: [] }),
      rpc: unavailableSeam(NO_RPC),
    });

    const readings = await seam.read(target(REAL_WALLET, INJECTED_CONNECTOR_ID));
    expect(readings.code.status).toBe("unknown");
    expect(readings.footprint.status).toBe("unknown");
    if (readings.footprint.status !== "unknown") throw new Error("unreachable");
    expect(readings.footprint.reason).toBe(NO_RPC);
  });
});

describe("the demo sources fail closed", () => {
  const scenarios = { accounts: [MOCK_WALLET], codeBearing: [], occupied: [] };

  it("refuses a capture for an address the scenario table does not name", async () => {
    const outcome = await demoLiveCaptureSource(scenarios).capture(
      target(REAL_WALLET, MOCK_CONNECTOR_ID),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.kind).toBe("not-in-demo-scenario");
    expect(outcome.reason).toContain(REAL_WALLET);
    expect(outcome.reason).toContain("cannot answer for a real wallet");
  });

  it("still serves the scenario for an address it does name", async () => {
    const outcome = await demoLiveCaptureSource(scenarios).capture(
      target(MOCK_WALLET, MOCK_CONNECTOR_ID),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`the demo scenario must answer for its own wallet: ${outcome.reason}`);
    expect(outcome.capture.code).toEqual({ status: "clear" });
    expect(outcome.capture.footprint).toEqual({ status: "clear" });
    // The committed reads log, replayed — the same pinned block the sandbox runs on.
    expect(outcome.capture.snapshot.block).toBe(fixtureSnapshot().block);
    expect(outcome.capture.snapshot.user.address).toBe(MOCK_WALLET);
  });

  it("refuses connect readings for an address the scenario table does not name", async () => {
    const readings = await demoSeam(scenarios).read(target(REAL_WALLET, MOCK_CONNECTOR_ID));
    expect(readings.code.status).toBe("unknown");
    expect(readings.footprint.status).toBe("unknown");
    if (readings.code.status !== "unknown") throw new Error("unreachable");
    expect(readings.code.reason).toContain("no entry for");
  });

  it("serves the scenario it was configured with for its own accounts", async () => {
    const seam = demoSeam({
      accounts: [MOCK_WALLET, REAL_WALLET],
      codeBearing: [MOCK_WALLET],
      occupied: [REAL_WALLET],
    });
    const bearing = await seam.read(target(MOCK_WALLET, MOCK_CONNECTOR_ID));
    expect(bearing.code.status).toBe("code-bearing");
    expect(bearing.footprint).toEqual({ status: "clear" });

    const occupied = await seam.read(target(REAL_WALLET, MOCK_CONNECTOR_ID));
    expect(occupied.code).toEqual({ status: "clear" });
    expect(occupied.footprint).toEqual({ status: "occupied" });
  });
});
