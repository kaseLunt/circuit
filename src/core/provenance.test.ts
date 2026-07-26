import { describe, it, expect } from "vitest";
import {
  derived,
  derivedOverWindow,
  entered,
  configured,
  valueOf,
  provenanceTrail,
  observationMinter,
  observedBlocks,
  provenanceDepth,
  provenanceTrailText,
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

/**
 * The two guards are INVERSES, and that is the whole design: `derived` forbids a crossing,
 * `derivedOverWindow` REQUIRES one. Neither can stand in for the other, so the narrow
 * exception cannot become a general escape hatch — which is what these tests exist to pin.
 */
describe("derivedOverWindow — cross-block enforcement, the inverse of derived's", () => {
  const now = observationMinter(25_592_678n, 1_784_776_451).observe(1_099_835_630_856_114_428n, "weETH.getRate");
  const before = observationMinter(25_542_278n, 1_784_169_383).observe(1_099_335_886_710_212_705n, "weETH.getRate");
  const REASON = "an instantaneous exchange rate is not an APR";

  it("accepts a derivation whose observations span two blocks — the case derived refuses", () => {
    expect(() => derived(1n, "trailing apr", [now, before])).toThrow(/multiple blocks/);
    expect(() => derivedOverWindow(1n, "trailing apr", [now, before], REASON)).not.toThrow();
  });

  it("REFUSES a single-block derivation — it is not a way around the same-block rule", () => {
    const a = m.observe(3n, "a");
    const b = m.observe(4n, "b");
    // The exact case `derived` is for. Routing it through here would launder an ordinary
    // derivation into one that claims a window it does not have.
    expect(() => derivedOverWindow(12n, "a*b", [a, b], REASON)).toThrow(/at least two distinct blocks/);
  });

  it("refuses a derivation with no observations at all", () => {
    expect(() => derivedOverWindow(1n, "x", [entered(1n)], REASON)).toThrow(/at least two distinct blocks/);
    expect(() => derivedOverWindow(1n, "x", [], REASON)).toThrow(/at least two distinct blocks/);
  });

  it("requires a non-empty reason — an unexplained crossing is what derived() forbids", () => {
    for (const reason of ["", "   ", "	"]) {
      expect(() => derivedOverWindow(1n, "trailing apr", [now, before], reason)).toThrow(
        /requires a windowReason/,
      );
    }
  });

  it("puts the reason in the NOTE, not the formula, and cites both blocks", () => {
    const apr = derivedOverWindow(1n, "trailing apr", [now, before], REASON);
    expect(apr.kind).toBe("derived");
    // The formula stays a formula. The justification is a separate field, so a renderer can
    // style it apart instead of being handed one unbreakable string.
    expect(apr.expression).toBe("trailing apr");
    expect(apr.expression).not.toContain(REASON);
    expect(apr.notes).toEqual([`cross-block window: ${REASON}`]);

    const trail = provenanceTrail(apr);
    expect(trail[0]?.notes?.join(" ")).toContain(REASON);
    // Both read points, each carrying the block it was actually read at.
    expect(trail.some((e) => e.text.includes("@ block 25592678"))).toBe(true);
    expect(trail.some((e) => e.text.includes("@ block 25542278"))).toBe(true);
    expect([...observedBlocks(apr)].sort((a, b) => (a < b ? -1 : 1))).toEqual([
      25_542_278n,
      25_592_678n,
    ]);
  });

  it("produces an ordinary Derived, so nothing downstream needs to know", () => {
    const apr = derivedOverWindow(42n, "trailing apr", [now, before], REASON);
    expect(valueOf(apr)).toBe(42n);
    expect(Object.keys(apr).sort()).toEqual(["expression", "inputs", "kind", "notes", "value"]);
  });
});

describe("provenanceTrail", () => {
  it("renders a nested derivation chain", () => {
    const price = m.observe(192386686200n, "AaveOracle.getAssetPrice(WETH)");
    const alloc = entered(7000n);
    const borrow = derived(1n, "collateralBase * b_bps / 1e4 (floor)", [price, alloc]);
    const trail = provenanceTrail(borrow);
    expect(trail[0]?.text).toContain("derived: collateralBase");
    expect(trail.some((e) => e.text.includes("observed AaveOracle"))).toBe(true);
    expect(trail.some((e) => e.text.includes("entered by user"))).toBe(true);
  });

  it("renders each leaf kind", () => {
    const observedLine = provenanceTrail(m.observe(1n, "s"))[0]?.text ?? "";
    expect(observedLine).toContain("@ block 25592678");
    expect(observedLine).toContain("2025-07-23 03:14:11 UTC");
    expect(provenanceTrail(configured(1, "N", "f.ts"))[0]?.text).toContain("configured N");
    expect(provenanceTrail(entered(1))[0]?.text).toContain("entered by user");
  });

  /**
   * Depth is DATA, not leading spaces. Baked-in indentation forced every renderer to treat
   * the trail as preformatted: a wrapped line put its continuation back at column zero, under
   * the wrong parent, so a deep tree read as a flat list of unrelated claims.
   */
  it("carries nesting as a number, with no indentation baked into the text", () => {
    const price = m.observe(1n, "AaveOracle.getAssetPrice(WETH)");
    const inner = derived(2n, "inner formula", [price]);
    const outer = derived(3n, "outer formula", [inner, entered(4n)]);
    const trail = provenanceTrail(outer);

    expect(trail.map((e) => e.depth)).toEqual([0, 1, 2, 1]);
    for (const entry of trail) {
      expect(entry.text, entry.text).toBe(entry.text.trimStart());
    }
  });

  it("keeps a derivation's note beside its entry rather than inside the formula", () => {
    const price = m.observe(1n, "AaveOracle.getAssetPrice(WETH)");
    const withNote = derived(2n, "a × b", [price], "because the oracle prices it that way");
    const [entry] = provenanceTrail(withNote);
    expect(entry?.text).toBe("derived: a × b");
    expect(entry?.notes).toEqual(["because the oracle prices it that way"]);

    const withoutNote = derived(2n, "a × b", [price]);
    expect(provenanceTrail(withoutNote)[0]?.notes).toBeUndefined();
  });

  it("flattens to text without losing a note — nothing a derivation claimed is dropped", () => {
    const price = m.observe(1n, "AaveOracle.getAssetPrice(WETH)");
    const withNote = derived(2n, "a × b", [price], "the WHY");
    const text = provenanceTrailText(withNote);
    expect(text[0]).toBe("derived: a × b [the WHY]");
    expect(text[1]).toContain("  observed AaveOracle");
  });

  it("reports the deepest level, which is what a capped renderer caps against", () => {
    const price = m.observe(1n, "s");
    expect(provenanceDepth(price)).toBe(0);
    expect(provenanceDepth(derived(1n, "f", [price]))).toBe(1);
    expect(provenanceDepth(derived(1n, "f", [derived(1n, "g", [price])]))).toBe(2);
  });
});
