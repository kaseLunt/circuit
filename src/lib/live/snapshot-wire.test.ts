/**
 * The live-capture wire codec, proven as a ROUND TRIP: a minted snapshot serialized and
 * strict-parsed back must plan to the SAME fingerprint and walk to the SAME risk numbers —
 * `planHashOf` equality is the strongest single equivalence the repo owns, because it walks
 * every money-bearing field of every step. Malformed wire refuses with the failing path
 * named, never a guess (SPEC §5).
 */
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { hfWadValue } from "../../core/health-factor";
import { buildPlan } from "../../core/plan";
import { riskLedger } from "../../core/risk";
import { fixtureSnapshot, FIXTURE_USER } from "../../../tests/helpers/chain-snapshot";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { planHashOf } from "../execution/plan-hash";
import { parseLiveReadiness, wireLiveCaptureOf, type WireLiveReadiness } from "./snapshot-wire";

const HASH: Hex = `0x${"ab".repeat(32)}`;
const DOC = flagshipGraph(10, 7000);

function readiness(): WireLiveReadiness {
  return {
    code: { status: "clear" },
    capture: wireLiveCaptureOf(fixtureSnapshot(), HASH),
  };
}

/** The wire must survive the actual transport: JSON with no bigint anywhere. */
function overTheWire(value: WireLiveReadiness): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("wireLiveCaptureOf → parseLiveReadiness round trip", () => {
  it("is JSON-safe end to end — nothing on the wire is a bigint", () => {
    expect(() => JSON.stringify(readiness())).not.toThrow();
  });

  it("rebuilds a snapshot that plans to the identical fingerprint", () => {
    const original = fixtureSnapshot();
    const parsed = parseLiveReadiness(overTheWire(readiness()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    const before = buildPlan(DOC, original);
    const after = buildPlan(DOC, parsed.capture.snapshot);
    if (!before.ok || !after.ok) throw new Error("the flagship must plan on both sides");
    expect(planHashOf(after.steps)).toBe(planHashOf(before.steps));
  });

  it("rebuilds a snapshot whose risk walk lands on the same minimum health factor", () => {
    const parsed = parseLiveReadiness(overTheWire(readiness()));
    if (!parsed.ok) throw new Error("the round trip must parse");
    const before = riskLedger(DOC, fixtureSnapshot());
    const after = riskLedger(DOC, parsed.capture.snapshot);
    if (!before.ok || !after.ok || before.min === null || after.min === null) {
      throw new Error("the flagship risk walk must resolve on both sides");
    }
    expect(hfWadValue(after.min.healthFactor)).toBe(hfWadValue(before.min.healthFactor));
  });

  it("carries the capture's own block identity, and mints observations against it", () => {
    const original = fixtureSnapshot();
    const parsed = parseLiveReadiness(overTheWire(readiness()));
    if (!parsed.ok) throw new Error("the round trip must parse");
    expect(parsed.capture.identity).toEqual({ block: original.block, blockHash: HASH });
    expect(parsed.capture.snapshot.block).toBe(original.block);
    expect(parsed.capture.snapshot.blockTimestamp).toBe(original.blockTimestamp);
    const user = parsed.capture.snapshot.user;
    expect(user.address).toBe(FIXTURE_USER);
    // The live replacement for the sandbox's Configured pair: Observed, at the capture's
    // block, with server/chain's own source labels.
    expect(user.eModeCategoryId.kind).toBe("observed");
    expect(user.hasAaveFootprint.kind).toBe("observed");
    if (user.eModeCategoryId.kind !== "observed") throw new Error("unreachable");
    expect(user.eModeCategoryId.block).toBe(original.block);
    expect(user.eModeCategoryId.source).toBe("Pool.getUserEMode(user)");
  });

  it("preserves the staking window's two-block identity — the earlier endpoint keeps its own block", () => {
    const original = fixtureSnapshot();
    const parsed = parseLiveReadiness(overTheWire(readiness()));
    if (!parsed.ok) throw new Error("the round trip must parse");
    const window = parsed.capture.snapshot.etherfi.rateWindow;
    const originalWindow = original.etherfi.rateWindow;
    if (window === null || originalWindow === null) throw new Error("the fixture has a window");
    expect(window.rateBefore.value).toBe(originalWindow.rateBefore.value);
    expect(window.rateBefore.block).toBe(originalWindow.rateBefore.block);
    expect(window.rateNow.block).toBe(original.block);
  });

  it("rebuilds a windowless capture with a null rate window and no window pin demanded", () => {
    const wire = readiness();
    const parsed = parseLiveReadiness(
      overTheWire({
        ...wire,
        capture: {
          ...wire.capture,
          window: null,
          etherfi: { ...wire.capture.etherfi, rateWindow: null },
        },
      }),
    );
    if (!parsed.ok) throw new Error(`windowless capture must parse: ${parsed.reason}`);
    expect(parsed.capture.snapshot.etherfi.rateWindow).toBeNull();
  });

  it("maps the footprint reading from the capture's own predicate — occupied when true", () => {
    const occupiedSnapshot = fixtureSnapshot((raw) => {
      raw.user.hasAaveFootprint = true;
    });
    const parsed = parseLiveReadiness(
      overTheWire({ code: { status: "clear" }, capture: wireLiveCaptureOf(occupiedSnapshot, HASH) }),
    );
    if (!parsed.ok) throw new Error("the round trip must parse");
    expect(parsed.capture.footprint).toEqual({ status: "occupied" });
    expect(parsed.capture.snapshot.user.hasAaveFootprint.value).toBe(true);
  });

  it("carries a code-bearing reading with its bytes — the refusal card renders the evidence", () => {
    const parsed = parseLiveReadiness(
      overTheWire({ ...readiness(), code: { status: "code-bearing", code: "0xef0100" } }),
    );
    if (!parsed.ok) throw new Error("the round trip must parse");
    expect(parsed.capture.code).toEqual({ status: "code-bearing", code: "0xef0100" });
  });
});

describe("parseLiveReadiness — malformed wire refuses with the path named", () => {
  it("refuses a non-object payload", () => {
    const parsed = parseLiveReadiness("nope");
    expect(parsed).toEqual({ ok: false, reason: "live capture wire field readiness is not an object" });
  });

  it("refuses an unknown code status", () => {
    const wire = overTheWire(readiness()) as { code: { status: string } };
    wire.code.status = "probably-fine";
    const parsed = parseLiveReadiness(wire);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).toContain("readiness.code.status");
  });

  it("refuses a corrupted bigint field, naming its path", () => {
    const wire = overTheWire(readiness()) as { capture: { weETH: { priceBase: string } } };
    wire.capture.weETH.priceBase = "12.5";
    const parsed = parseLiveReadiness(wire);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).toContain("capture.weETH.priceBase");
  });

  it("refuses a malformed block hash — the standing's identity is not negotiable", () => {
    const wire = overTheWire(readiness()) as { capture: { blockHash: string } };
    wire.capture.blockHash = "0x1234";
    const parsed = parseLiveReadiness(wire);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).toContain("capture.blockHash");
  });

  it("refuses a rate window with no window identity to pin its earlier endpoint to", () => {
    const wire = overTheWire(readiness()) as { capture: { window: unknown } };
    wire.capture.window = null;
    const parsed = parseLiveReadiness(wire);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).toContain("capture.window");
  });

  it("refuses a non-address user, a non-integer strategy field, and a non-boolean flag", () => {
    const badUser = overTheWire(readiness()) as { capture: { user: { address: string } } };
    badUser.capture.user.address = "0x123";
    const parsedUser = parseLiveReadiness(badUser);
    expect(parsedUser.ok).toBe(false);
    if (parsedUser.ok) throw new Error("unreachable");
    expect(parsedUser.reason).toContain("capture.user.address");

    const badStrategy = overTheWire(readiness()) as {
      capture: { WETH: { rateStrategy: { variableRateSlope1: unknown } } };
    };
    badStrategy.capture.WETH.rateStrategy.variableRateSlope1 = "6";
    const parsedStrategy = parseLiveReadiness(badStrategy);
    expect(parsedStrategy.ok).toBe(false);
    if (parsedStrategy.ok) throw new Error("unreachable");
    expect(parsedStrategy.reason).toContain("capture.WETH.rateStrategy.variableRateSlope1");

    const badFlag = overTheWire(readiness()) as { capture: { weETH: { frozen: unknown } } };
    badFlag.capture.weETH.frozen = "false";
    const parsedFlag = parseLiveReadiness(badFlag);
    expect(parsedFlag.ok).toBe(false);
    if (parsedFlag.ok) throw new Error("unreachable");
    expect(parsedFlag.reason).toContain("capture.weETH.frozen");
  });
});
