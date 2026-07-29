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
  formatDuration,
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

  /**
   * A real, non-zero rate rendered as "0.00%" is a lie about a value the chain reported —
   * the display asserting ZERO where the truth is "small". The threshold form states the
   * bound instead. The headline case is real: at the pinned block the weETH supply APY is
   * ~2.6e-7 WAD, and it is what the lend block shows.
   */
  describe("a non-zero rate that rounds away says so, rather than claiming zero", () => {
    /** The recorded weETH post-action supply APY at the pinned block (b = 7000). */
    const REAL_WEETH_SUPPLY_APY = 264_681_551_200n;

    it("renders the real weETH supply APY as a bound, never as 0.00%", () => {
      expect(formatWadAsPercent(REAL_WEETH_SUPPLY_APY)).toBe("<0.01%");
      expect(formatWadAsPercent(REAL_WEETH_SUPPLY_APY)).not.toBe("0.00%");
    });

    it("keeps an actual zero an actual zero — the bound is not a stand-in for nothing", () => {
      expect(formatWadAsPercent(0n)).toBe("0.00%");
      expect(formatRayRateAsPct(0n)).toBe("0.00%");
    });

    it("preserves sign: a value that costs a little is not one that earns a little", () => {
      expect(formatWadAsPercent(-1n)).toBe(">-0.01%");
      expect(formatWadAsPercent(1n)).toBe("<0.01%");
      // A RAY rate is scaled down before formatting and BigInt division truncates toward
      // zero, so the sign has to come from the input rather than the rendered string.
      expect(formatRayRateAsPct(-1n)).toBe(">-0.01%");
      expect(formatRayRateAsPct(1n)).toBe("<0.01%");
    });

    it("moves the threshold with the requested precision", () => {
      expect(formatWadAsPercent(1n, 0)).toBe("<1%");
      expect(formatWadAsPercent(1n, 4)).toBe("<0.0001%");
      expect(formatWadAsPercent(-1n, 4)).toBe(">-0.0001%");
      // Enough precision to show the figure: no bound, the real digits.
      expect(formatWadAsPercent(50_000_000_000_000n, 4)).toBe("0.0050%");
    });

    it("is exact at the half-up boundary — only values that ROUND to zero get the bound", () => {
      expect(formatWadAsPercent(49_999_999_999_999n)).toBe("<0.01%");
      expect(formatWadAsPercent(50_000_000_000_000n)).toBe("0.01%");
      expect(formatWadAsPercent(-49_999_999_999_999n)).toBe(">-0.01%");
      expect(formatWadAsPercent(-50_000_000_000_000n)).toBe("-0.01%");
    });

    it("leaves a RAY rate that rounds away with the same treatment", () => {
      // The post-action weETH liquidity rate, in RAY.
      expect(formatRayRateAsPct(264_681_516_172_345_992_079n)).toBe("<0.01%");
    });

    it("never widens past the slot the canvas reserves for a rate", () => {
      // base-block.ts RATE_SLOT_CHARS = 7, sized for "12.34%". The bound forms must fit it.
      for (const rendered of [
        formatWadAsPercent(1n),
        formatWadAsPercent(-1n),
        formatRayRateAsPct(1n),
        formatRayRateAsPct(-1n),
      ]) {
        expect(rendered.length).toBeLessThanOrEqual(7);
      }
    });
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

describe("formatDuration (W07 tx family: simulation age, TTL prose)", () => {
  it("renders seconds, minutes and hours locale-free with zero-padded remainders", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(60)).toBe("1m 00s");
    expect(formatDuration(185)).toBe("3m 05s");
    expect(formatDuration(3600)).toBe("1h 00m");
    expect(formatDuration(8_040)).toBe("2h 14m");
  });

  it("truncates fractions and clamps a backwards clock to zero, never a negative age", () => {
    expect(formatDuration(59.9)).toBe("59s");
    expect(formatDuration(-15)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});
