import { describe, it, expect } from "vitest";
import {
  formatUnits,
  formatToken,
  formatUsdBase,
  formatHealthFactor,
  formatRayRateAsPct,
  formatAddress,
  formatBlockTime,
  formatBpsAsPercent,
  formatEth,
  formatWadAsMultiple,
  formatWadAsPercent,
  formatWadRatio,
  HF_NO_DEBT,
  RAY,
  WAD,
} from "./format";

describe("formatUnits", () => {
  it("truncates toward zero by default, does not round", () => {
    // 1.99999 at 5 decimals shown to 2 → "1.99"
    expect(formatUnits(199_999n, 5, 2)).toBe("1.99");
  });

  it("nearest mode rounds half-up away from zero", () => {
    expect(formatUnits(199_999n, 5, 2, "nearest")).toBe("2.00");
    expect(formatUnits(125n, 3, 2, "nearest")).toBe("0.13"); // 0.125 → 0.13
    expect(formatUnits(-125n, 3, 2, "nearest")).toBe("-0.13");
  });

  it("groups thousands", () => {
    expect(formatUnits(1_234_567n * WAD, 18, 0)).toBe("1,234,567");
  });

  it("pads fraction when displayDecimals exceeds precision", () => {
    expect(formatUnits(5n, 1, 4)).toBe("0.5000");
  });

  it("handles negatives", () => {
    expect(formatUnits(-3n * WAD, 18, 2)).toBe("-3.00");
  });

  it("zero decimals returns whole only", () => {
    expect(formatUnits(42n * WAD + WAD / 2n, 18, 0)).toBe("42");
  });

  it("rejects negative decimals", () => {
    expect(() => formatUnits(1n, -1, 2)).toThrow(RangeError);
  });
});

describe("formatToken / formatUsdBase", () => {
  it("formats an 18-decimal amount", () => {
    expect(formatToken(1_099_835_630_856_114_428n)).toBe("1.0998");
  });

  it("formats an 8-decimal USD base amount with nearest rounding", () => {
    // 2115.93732385 USD (weETH price base) → "$2,115.94" (nearest, conventional)
    expect(formatUsdBase(211_593_732_385n)).toBe("$2,115.94");
  });
});

describe("formatHealthFactor", () => {
  it("renders unknown for null", () => {
    expect(formatHealthFactor(null)).toBe("unknown");
  });

  it("renders infinity for the no-debt sentinel", () => {
    expect(formatHealthFactor(HF_NO_DEBT)).toBe("∞");
  });

  it("renders a WAD-scaled HF to 2 dp", () => {
    // HF 1.36 → 1.36e18
    expect(formatHealthFactor((136n * WAD) / 100n)).toBe("1.36");
  });
});

describe("formatRayRateAsPct", () => {
  it("converts a RAY per-annum rate to a percent string", () => {
    // 2.35% APR = 0.0235 * RAY
    const rate = (235n * RAY) / 10_000n;
    expect(formatRayRateAsPct(rate)).toBe("2.35%");
  });
});

describe("formatAddress", () => {
  it("shortens with an ellipsis", () => {
    expect(formatAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")).toBe("0xC02a…6Cc2");
  });
});

describe("formatBlockTime", () => {
  it("renders an absolute UTC instant", () => {
    expect(formatBlockTime(1_753_240_451)).toBe("2025-07-23 03:14:11 UTC");
  });

  it("zero-pads every field at the epoch", () => {
    expect(formatBlockTime(0)).toBe("1970-01-01 00:00:00 UTC");
  });
});

describe("component-boundary formatters (W05 canvas batch)", () => {
  it("formats bps as a percent at 0 and 2 dp, sign preserved", () => {
    expect(formatBpsAsPercent(11_500)).toBe("115%");
    expect(formatBpsAsPercent(3_333, 2)).toBe("33.33%");
    expect(formatBpsAsPercent(50, 2)).toBe("0.50%");
    expect(formatBpsAsPercent(-7_000, 2)).toBe("-70.00%");
  });

  it("formats WAD rates as percents", () => {
    expect(formatWadAsPercent(34_200_000_000_000_000n)).toBe("3.42%");
    expect(formatWadAsPercent((17n * WAD) / 10n)).toBe("170.00%");
  });

  it("formats WAD ratios to 4 dp", () => {
    expect(formatWadRatio(912_300_000_000_000_000n)).toBe("0.9123");
  });

  it("formats WAD multiples", () => {
    expect(formatWadAsMultiple((25n * WAD) / 10n)).toBe("2.50×");
  });

  it("formats an ETH amount with its unit", () => {
    expect(formatEth(1_099_835_630_856_114_428n)).toBe("1.0998 ETH");
  });
});
