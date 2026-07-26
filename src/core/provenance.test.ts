import { describe, it, expect } from "vitest";
import {
  derived,
  entered,
  configured,
  valueOf,
  provenanceTrail,
  observationMinter,
} from "./provenance";

const m = observationMinter(25_592_678n, 1_753_240_451);

describe("provenance constructors", () => {
  it("observe carries source, block, fetchedAt", () => {
    const p = m.observe(100n, "AaveOracle.getAssetPrice(WETH)");
    expect(p.kind).toBe("observed");
    expect(valueOf(p)).toBe(100n);
    expect(p.source).toContain("AaveOracle");
    expect(p.block).toBe(25_592_678n);
  });

  it("derived records the expression and its inputs", () => {
    const a = m.observe(3n, "x");
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
    const p = m.observe(211_593_732_385n, "AaveOracle.getAssetPrice(weETH)");
    expect(p.block).toBe(25_592_678n);
    expect(p.fetchedAt).toBe(1_753_240_451);
  });
  it("rejects a non-positive block", () => {
    expect(() => observationMinter(0n, 0)).toThrow(RangeError);
  });
});

describe("derived — same-block enforcement", () => {
  it("allows a derivation whose observations share a block", () => {
    const a = m.observe(3n, "a");
    const b = m.observe(4n, "b");
    expect(() => derived(12n, "a*b", [a, b])).not.toThrow();
  });
  it("throws when observations come from different blocks", () => {
    const a = observationMinter(100n, 0).observe(3n, "a");
    const b = observationMinter(101n, 0).observe(4n, "b");
    expect(() => derived(12n, "a*b", [a, b])).toThrow(/multiple blocks/);
  });
  it("allows mixing observed with entered/configured (no extra block)", () => {
    const a = m.observe(3n, "a");
    expect(() => derived(9n, "a*3", [a, entered(3n)])).not.toThrow();
  });
});

describe("provenanceTrail", () => {
  it("renders a nested derivation chain", () => {
    const price = m.observe(192386686200n, "AaveOracle.getAssetPrice(WETH)");
    const alloc = entered(7000n);
    const borrow = derived(1n, "collateralBase * b_bps / 1e4 (floor)", [price, alloc]);
    const trail = provenanceTrail(borrow);
    expect(trail[0]).toContain("derived: collateralBase");
    expect(trail.some((l) => l.includes("observed AaveOracle"))).toBe(true);
    expect(trail.some((l) => l.includes("entered by user"))).toBe(true);
  });

  it("renders each leaf kind", () => {
    const observedLine = provenanceTrail(m.observe(1n, "s"))[0];
    expect(observedLine).toContain("@ block 25592678");
    expect(observedLine).toContain("2025-07-23 03:14:11 UTC");
    expect(provenanceTrail(configured(1, "N", "f.ts"))[0]).toContain("configured N");
    expect(provenanceTrail(entered(1))[0]).toContain("entered by user");
  });
});
