import { describe, expect, it } from "vitest";
import {
  SANDBOX_HF_REL_POW,
  SANDBOX_OUTPUT_TOLERANCE,
  relWithin,
  toleranceWeiFor,
  withinOutputTolerance,
} from "./tolerance";

const WAD = 10n ** 18n;

describe("toleranceWeiFor", () => {
  it("floors at the absolute dust bound for small predictions", () => {
    // 1000 wei predicted → relative arm is 0; the 2-wei dust floor governs.
    expect(toleranceWeiFor(1000n, SANDBOX_OUTPUT_TOLERANCE)).toBe(2n);
  });

  it("uses the relative arm once it exceeds the dust floor", () => {
    // 10 ETH predicted → 1e-6 relative = 1e13 wei.
    expect(toleranceWeiFor(10n * WAD, SANDBOX_OUTPUT_TOLERANCE)).toBe(10n ** 13n);
  });

  it("switches arms exactly at the crossover", () => {
    const atFloor = 2n * SANDBOX_OUTPUT_TOLERANCE.relPow; // relative arm == absWei
    expect(toleranceWeiFor(atFloor, SANDBOX_OUTPUT_TOLERANCE)).toBe(2n);
    expect(toleranceWeiFor(atFloor + SANDBOX_OUTPUT_TOLERANCE.relPow, SANDBOX_OUTPUT_TOLERANCE)).toBe(3n);
  });
});

describe("withinOutputTolerance", () => {
  it("accepts exact agreement", () => {
    expect(withinOutputTolerance(10n * WAD, 10n * WAD, SANDBOX_OUTPUT_TOLERANCE)).toBe(true);
  });

  it("accepts drift up to the bound, in both directions", () => {
    const predicted = 10n * WAD;
    const bound = toleranceWeiFor(predicted, SANDBOX_OUTPUT_TOLERANCE);
    expect(withinOutputTolerance(predicted, predicted + bound, SANDBOX_OUTPUT_TOLERANCE)).toBe(true);
    expect(withinOutputTolerance(predicted, predicted - bound, SANDBOX_OUTPUT_TOLERANCE)).toBe(true);
  });

  it("refuses one wei beyond the bound — the gate discriminates", () => {
    const predicted = 10n * WAD;
    const bound = toleranceWeiFor(predicted, SANDBOX_OUTPUT_TOLERANCE);
    expect(withinOutputTolerance(predicted, predicted + bound + 1n, SANDBOX_OUTPUT_TOLERANCE)).toBe(false);
    expect(withinOutputTolerance(predicted, predicted - bound - 1n, SANDBOX_OUTPUT_TOLERANCE)).toBe(false);
  });

  it("covers sub-wei dust on tiny outputs without admitting real errors", () => {
    expect(withinOutputTolerance(5n, 7n, SANDBOX_OUTPUT_TOLERANCE)).toBe(true);
    expect(withinOutputTolerance(5n, 8n, SANDBOX_OUTPUT_TOLERANCE)).toBe(false);
  });
});

describe("relWithin", () => {
  it("matches the fork suite's relative-agreement shape", () => {
    const expected = 15n * 10n ** 17n; // HF 1.5 in wad
    expect(relWithin(expected, expected, SANDBOX_HF_REL_POW)).toBe(true);
    const drift = expected / SANDBOX_HF_REL_POW;
    expect(relWithin(expected + drift, expected, SANDBOX_HF_REL_POW)).toBe(true);
    expect(relWithin(expected + drift + 1n, expected, SANDBOX_HF_REL_POW)).toBe(false);
    expect(relWithin(expected - drift - 1n, expected, SANDBOX_HF_REL_POW)).toBe(false);
  });
});
