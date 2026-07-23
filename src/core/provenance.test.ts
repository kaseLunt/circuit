import { describe, it, expect } from "vitest";
import {
  observed,
  derived,
  entered,
  configured,
  valueOf,
  provenanceTrail,
  observationMinter,
} from "./provenance";

describe("provenance constructors", () => {
  it("observed carries source, block, fetchedAt", () => {
    const p = observed(100n, "AaveOracle.getAssetPrice(WETH)", 25592678n, 1_753_240_451);
    expect(p.kind).toBe("observed");
    expect(valueOf(p)).toBe(100n);
    expect(p.source).toContain("AaveOracle");
    expect(p.block).toBe(25592678n);
  });

  it("derived records the expression and its inputs", () => {
    const a = observed(3n, "x", 1n, 0);
    const b = entered(4n);
    const p = derived(12n, "a * b", [a, b]);
    expect(p.kind).toBe("derived");
    expect(valueOf(p)).toBe(12n);
    expect(p.inputs).toHaveLength(2);
  });

  it("entered and configured wrap plainly", () => {
    expect(entered(70).kind).toBe("entered");
    const c = configured(150, "HF_WARN_BPS", "health-factor.ts");
    expect(c.kind).toBe("configured");
    expect(c.name).toBe("HF_WARN_BPS");
  });
});

describe("observationMinter — snapshot-bound observations", () => {
  it("stamps every observation with the snapshot's block", () => {
    const m = observationMinter(25_592_678n, 1_753_240_451);
    const p = m.observe(211_593_732_385n, "AaveOracle.getAssetPrice(weETH)");
    expect(p.kind).toBe("observed");
    expect(p.block).toBe(25_592_678n);
    expect(p.fetchedAt).toBe(1_753_240_451);
  });
  it("rejects a non-positive block", () => {
    expect(() => observationMinter(0n, 0)).toThrow(RangeError);
  });
});

describe("derived — same-block enforcement", () => {
  it("allows a derivation whose observations share a block", () => {
    const m = observationMinter(100n, 0);
    const a = m.observe(3n, "a");
    const b = m.observe(4n, "b");
    expect(() => derived(12n, "a*b", [a, b])).not.toThrow();
  });
  it("throws when observations come from different blocks", () => {
    const a = observed(3n, "a", 100n, 0);
    const b = observed(4n, "b", 101n, 0);
    expect(() => derived(12n, "a*b", [a, b])).toThrow(/multiple blocks/);
  });
  it("allows mixing observed with entered/configured (no extra block)", () => {
    const a = observed(3n, "a", 100n, 0);
    expect(() => derived(9n, "a*3", [a, entered(3n)])).not.toThrow();
  });
});

describe("provenanceTrail", () => {
  it("renders a nested derivation chain", () => {
    const price = observed(192386686200n, "AaveOracle.getAssetPrice(WETH)", 25592678n, 0);
    const alloc = entered(7000n);
    const borrow = derived(1n, "collateralBase * b_bps / 1e4 (floor)", [price, alloc]);
    const trail = provenanceTrail(borrow);
    expect(trail[0]).toContain("derived: collateralBase");
    expect(trail.some((l) => l.includes("observed AaveOracle"))).toBe(true);
    expect(trail.some((l) => l.includes("entered by user"))).toBe(true);
  });

  it("renders each leaf kind", () => {
    expect(provenanceTrail(observed(1n, "s", 2n, 0))[0]).toContain("@ block 2");
    expect(provenanceTrail(configured(1, "N", "f.ts"))[0]).toContain("configured N");
    expect(provenanceTrail(entered(1))[0]).toContain("entered by user");
  });
});
