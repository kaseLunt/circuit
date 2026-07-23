import { describe, it, expect } from "vitest";
import { toFunctionSelector } from "viem";
import { decodeRevert } from "./errors";

/** Build an ABI-encoded Error(string) payload. */
function errorString(reason: string): string {
  const bytes = Buffer.from(reason, "utf8");
  const lenHex = bytes.length.toString(16).padStart(64, "0");
  const dataHex = bytes.toString("hex").padEnd(Math.ceil((bytes.length || 1) / 32) * 64, "0");
  const offset = (32).toString(16).padStart(64, "0");
  return `0x08c379a0${offset}${lenHex}${dataHex}`;
}

describe("decodeRevert — custom errors (v3.7)", () => {
  it("maps a known custom-error selector to human copy", () => {
    const data = toFunctionSelector("error SupplyCapExceeded()");
    const r = decodeRevert(data);
    expect(r.source).toBe("custom-error");
    expect(r.message).toContain("supply cap");
    expect(r.raw).toBe(data);
  });

  it("maps the HF liquidation-threshold error (the failure-beat revert)", () => {
    const data = toFunctionSelector("error HealthFactorLowerThanLiquidationThreshold()");
    const r = decodeRevert(data);
    expect(r.source).toBe("custom-error");
    expect(r.message).toContain("liquidation threshold");
  });
});

describe("decodeRevert — legacy Error(string) codes", () => {
  it("maps legacy code 35 to the HF message", () => {
    const r = decodeRevert(errorString("35"));
    expect(r.source).toBe("legacy-code");
    expect(r.message).toContain("liquidation threshold");
    expect(r.raw).toBe("35");
  });

  it("maps legacy code 51 to the supply-cap message", () => {
    const r = decodeRevert(errorString("51"));
    expect(r.message).toContain("supply cap");
  });

  it("preserves an unknown Error(string) reason", () => {
    const r = decodeRevert(errorString("SOMETHING_ELSE"));
    expect(r.source).toBe("legacy-code");
    expect(r.raw).toBe("SOMETHING_ELSE");
  });
});

describe("decodeRevert — empty and truncated Error(string)", () => {
  it("empty reason falls back to a generic revert message", () => {
    const r = decodeRevert(errorString(""));
    expect(r.source).toBe("legacy-code");
    expect(r.message).toContain("reverted");
  });

  it("truncated Error(string) payload decodes to empty, not a throw", () => {
    const r = decodeRevert(`0x08c379a0${"00".repeat(10)}`); // body < 128 hex chars
    expect(r.source).toBe("legacy-code");
    expect(r.message).toContain("reverted");
  });
});

describe("decodeRevert — unknown data is surfaced, never swallowed", () => {
  it("returns the raw selector for an unrecognized custom error", () => {
    const r = decodeRevert("0xdeadbeef");
    expect(r.source).toBe("unknown");
    expect(r.raw).toBe("0xdeadbeef");
    expect(r.message).toContain("unrecognized");
  });

  it("normalizes data without a 0x prefix", () => {
    const sel = toFunctionSelector("error ReservePaused()").slice(2);
    const r = decodeRevert(sel);
    expect(r.message).toContain("paused");
  });
});
