import { describe, expect, it } from "vitest";
import { borrowLimitVerdict, type BorrowCeiling } from "./borrow-limit";
import {
  FORK_PROVEN_BORROW_BPS,
  FORK_PROVEN_CARRY_BPS,
  carryGraph,
  chainOf,
  flagshipGraph,
  mixedLoopAndCarryGraph,
} from "../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../tests/helpers/chain-snapshot";
import type { StrategyGraph } from "./graph";

const snapshot = fixtureSnapshot();

/** The flagship with one borrow allocation substituted — the §3 step-4 slider, in a fixture. */
function graphAt(bps: number): StrategyGraph {
  const base = flagshipGraph();
  return {
    ...base,
    blocks: base.blocks.map((block) =>
      block.type === "borrow"
        ? { ...block, params: { ...block.params, allocationBps: bps } }
        : block,
    ),
  };
}

function ceilingAt(bps: number): BorrowCeiling {
  const verdict = borrowLimitVerdict(graphAt(bps), snapshot);
  if (verdict.status !== "within" && verdict.status !== "over-limit") {
    throw new Error(`expected a ceiling at ${bps} bps, got ${verdict.status}`);
  }
  return verdict.ceiling;
}

describe("borrowLimitVerdict", () => {
  it("reads LTV and LT from the ACTIVE e-mode configuration, and they differ from each other", () => {
    const ceiling = ceilingAt(FORK_PROVEN_BORROW_BPS);
    // The flagship enters an e-mode category; the verdict must name it rather than imply
    // the reserve-level regime (SPEC §3 step 4 — the two regimes differ).
    expect(ceiling.categoryId).not.toBeNull();
    expect(ceiling.ltvBps).toBeGreaterThan(0);
    // Aave's own invariant: a reserve's liquidation threshold is never below its LTV.
    expect(ceiling.ltBps).toBeGreaterThanOrEqual(ceiling.ltvBps);
  });

  it("quotes the same pair the risk ledger's own legs carry — no second derivation", () => {
    const ceiling = ceilingAt(FORK_PROVEN_BORROW_BPS);
    // The ceiling is exactly collateral × LTV in the oracle's base currency.
    expect(ceiling.ceilingBase).toBe((ceiling.collateralBase * BigInt(ceiling.ltvBps)) / 10_000n);
  });

  it("admits the demo's opening and fork-proven allocations", () => {
    expect(borrowLimitVerdict(graphAt(5000), snapshot).status).toBe("within");
    expect(borrowLimitVerdict(graphAt(FORK_PROVEN_BORROW_BPS), snapshot).status).toBe("within");
  });

  it("admits exactly at the ceiling and refuses one step past it", () => {
    const { maxAllocationBps } = ceilingAt(FORK_PROVEN_BORROW_BPS);
    expect(borrowLimitVerdict(graphAt(maxAllocationBps), snapshot).status).toBe("within");
    expect(borrowLimitVerdict(graphAt(maxAllocationBps + 1), snapshot).status).toBe("over-limit");
  });

  it("reports the requested allocation and the ceiling it exceeded, so the block can show the math", () => {
    const past = ceilingAt(9_900);
    expect(past.requestedAllocationBps).toBe(9_900);
    expect(past.debtBase).toBeGreaterThan(past.ceilingBase);
    // One bp BELOW the effective LTV, not equal to it: the protocol's ceil-rounded debt
    // chain (mint rayDivCeil → read-back rayMulCeil → mulDivCeil base conversion) pushes
    // the allocation exactly at LTV one base-unit over the ceiling. Asserted numerically
    // in the pinned boundary test below.
    expect(past.maxAllocationBps).toBe(past.ltvBps - 1);
  });

  it("pins the protocol-rounding boundary: 9299 is accepted, 9300 is rejected (Codex D-011 F1)", () => {
    // The pre-remediation floor-everything debt admitted 9300: floor-rounded debtBase came
    // to 1_789_196_181_658 — one base-unit UNDER the ceiling — while Aave v3.7's own chain
    // (GenericLogic._getUserDebtInBaseCurrency: ceil-scaled mint, ceil balance read-back,
    // mulDivCeil base conversion) values the same borrow at 1_789_196_181_660, one OVER.
    // Both sides of the corrected boundary are pinned with the fixture's exact figures so
    // a regression in any leg of the rounding chain moves a number, not a vibe.
    const within = borrowLimitVerdict(graphAt(9_299), snapshot);
    expect(within.status).toBe("within");
    if (within.status !== "within") throw new Error("unreachable");
    expect(within.ceiling.debtBase).toBe(1_789_003_794_973n);
    expect(within.ceiling.ceilingBase).toBe(1_789_196_181_659n);
    expect(within.ceiling.collateralBase).toBe(1_923_866_861_999n);
    expect(within.ceiling.maxAllocationBps).toBe(9_299);

    const over = borrowLimitVerdict(graphAt(9_300), snapshot);
    expect(over.status).toBe("over-limit");
    if (over.status !== "over-limit") throw new Error("unreachable");
    expect(over.ceiling.debtBase).toBe(1_789_196_181_660n);
    expect(over.ceiling.ceilingBase).toBe(1_789_196_181_659n);
    expect(over.ceiling.maxAllocationBps).toBe(9_299);
  });

  it("is not applicable to a document with no borrow", () => {
    const noBorrow = chainOf([
      { id: "in", type: "input", params: { asset: "ETH", amount: "10" } },
      { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
      { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
      { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    ]);
    expect(borrowLimitVerdict(noBorrow, snapshot).status).toBe("not-applicable");
  });

  it("refuses rather than admits when the strategy does not plan", () => {
    const orphanBorrow: StrategyGraph = {
      blocks: [
        {
          id: "borrow1",
          type: "borrow",
          params: { protocol: "aave-v3", asset: "WETH", allocationBps: 5000 },
        },
      ],
      edges: [],
    };
    const verdict = borrowLimitVerdict(orphanBorrow, snapshot);
    expect(verdict.status).toBe("unavailable");
  });

  it("refuses when a collateral leg has no oracle value in the pinned read set", () => {
    // A price of zero is not a small price: `valueInBase` refuses it rather than valuing the
    // leg at nothing, so the ceiling has no inputs and the verdict says so.
    const priceless = fixtureSnapshot((raw) => {
      raw.weETH.priceBase = 0n;
    });
    const verdict = borrowLimitVerdict(graphAt(FORK_PROVEN_BORROW_BPS), priceless);
    expect(verdict.status).toBe("unavailable");
    if (verdict.status !== "unavailable") throw new Error("unreachable");
    expect(verdict.reason).toContain("no oracle value");
  });

  it("refuses when the borrow block carries no allocation to compare", () => {
    const base = flagshipGraph();
    const noAllocation: StrategyGraph = {
      ...base,
      blocks: base.blocks.map((block) => {
        if (block.type !== "borrow") return block;
        const params = Object.fromEntries(
          Object.entries(block.params).filter(([key]) => key !== "allocationBps"),
        );
        return { ...block, params };
      }),
    };
    const verdict = borrowLimitVerdict(noAllocation, snapshot);
    expect(verdict.status).toBe("unavailable");
  });
});

// ————————————————————————— W09: the carry, at the reserve regime —————————————————————————

/** The carry with one borrow allocation substituted — the same slider, a different regime. */
function carryAt(bps: number): StrategyGraph {
  const base = carryGraph();
  return {
    ...base,
    blocks: base.blocks.map((block) =>
      block.type === "borrow"
        ? { ...block, params: { ...block.params, allocationBps: bps } }
        : block,
    ),
  };
}

function carryCeilingAt(bps: number): BorrowCeiling {
  const verdict = borrowLimitVerdict(carryAt(bps), snapshot);
  if (verdict.status !== "within" && verdict.status !== "over-limit") {
    throw new Error(`expected a carry ceiling at ${bps} bps, got ${verdict.status}`);
  }
  return verdict.ceiling;
}

describe("borrowLimitVerdict — the carry, quoted at the regime it actually stands in", () => {
  /**
   * SPEC §3.4's named bug, and the reason the ceiling reads its category off the PLAN.
   *
   * weETH is a member of category 1's collateral bitmap, so a module that asked "is this
   * collateral eMode-eligible?" would quote 9300/9500 here. The protocol asks a different
   * question — what category is the USER in — and for the carry the answer is none, so the
   * reserve pair governs. Both figures come from the pinned reads; neither is typed.
   */
  it("quotes the reserve pair, not the category pair, for a position in no category", () => {
    const ceiling = carryCeilingAt(FORK_PROVEN_CARRY_BPS);
    expect(ceiling.categoryId).toBeNull();
    expect(ceiling.ltvBps).toBe(snapshot.reserves.weETH.ltvBps.value);
    expect(ceiling.ltBps).toBe(snapshot.reserves.weETH.liquidationThresholdBps.value);
    // …and it is emphatically NOT the category's, which the same collateral would take
    // inside category 1. The contrast is the product's whole point, so it is asserted.
    expect(ceiling.ltvBps).not.toBe(snapshot.eModeCategories[0]!.ltvBps.value);
    expect(ceiling.ltBps).not.toBe(snapshot.eModeCategories[0]!.liquidationThresholdBps.value);
    expect(ceiling.ltBps).toBeGreaterThanOrEqual(ceiling.ltvBps);
  });

  it("admits the shipped carry default with room to spare", () => {
    const verdict = borrowLimitVerdict(carryGraph(), snapshot);
    expect(verdict.status).toBe("within");
    if (verdict.status !== "within") throw new Error("unreachable");
    expect(verdict.ceiling.requestedAllocationBps).toBe(FORK_PROVEN_CARRY_BPS);
    expect(verdict.ceiling.debtBase).toBeLessThan(verdict.ceiling.ceilingBase);
    // The default is deliberately clear of the ceiling — a template that opened one nudge
    // from a refusal would be a bad default, not a bold one.
    expect(verdict.ceiling.maxAllocationBps).toBeGreaterThan(FORK_PROVEN_CARRY_BPS);
  });

  /**
   * W08's both-sides boundary, RE-RUN at the reserve regime.
   *
   * The ceil-chain-vs-floor divergence that motivated the original pin is regime-independent,
   * but its boundary sits at a different `b` — and now also at a different assetUnit, since
   * the debt leg's base conversion divides by 1e6 rather than 1e18. Pinning both sides here
   * proves the rounding chain survived the six-decimal generalization intact.
   */
  it("admits exactly at the reserve-regime ceiling and refuses one bp past it", () => {
    const { maxAllocationBps, ltvBps } = carryCeilingAt(FORK_PROVEN_CARRY_BPS);
    expect(borrowLimitVerdict(carryAt(maxAllocationBps), snapshot).status).toBe("within");
    expect(borrowLimitVerdict(carryAt(maxAllocationBps + 1), snapshot).status).toBe("over-limit");
    // The admissible maximum sits at or just below the effective LTV — the ceil-rounded debt
    // chain never lets it sit above.
    expect(maxAllocationBps).toBeLessThanOrEqual(ltvBps);
    expect(maxAllocationBps).toBeGreaterThan(ltvBps - 10);

    const within = borrowLimitVerdict(carryAt(maxAllocationBps), snapshot);
    const over = borrowLimitVerdict(carryAt(maxAllocationBps + 1), snapshot);
    if (within.status !== "within" || over.status !== "over-limit") throw new Error("unreachable");
    expect(within.ceiling.debtBase).toBeLessThanOrEqual(within.ceiling.ceilingBase);
    expect(over.ceiling.debtBase).toBeGreaterThan(over.ceiling.ceilingBase);
    // Same collateral, same ceiling: only the debt moved across the line.
    expect(over.ceiling.ceilingBase).toBe(within.ceiling.ceilingBase);
  });

  /**
   * The debt side really is denominated at 1e6.
   *
   * `debtBase` is an oracle-base-currency figure, so it is comparable to `collateralBase`
   * regardless of the debt token's decimals — which is exactly the property an assetUnit-blind
   * conversion would destroy. At the shipped default the debt is a shade under 60% of the
   * collateral's value; a 1e18 divisor would have put it twelve orders below that.
   */
  it("values six-decimal debt on the same scale as eighteen-decimal collateral", () => {
    const ceiling = carryCeilingAt(FORK_PROVEN_CARRY_BPS);
    const share = (ceiling.debtBase * 10_000n) / ceiling.collateralBase;
    expect(share).toBeGreaterThan(BigInt(FORK_PROVEN_CARRY_BPS) - 10n);
    expect(share).toBeLessThanOrEqual(BigInt(FORK_PROVEN_CARRY_BPS));
  });

  /**
   * The mixed document forfeits nothing at the ceiling: two debt reserves sum correctly
   * because `protocolDebtBaseOf` groups by reserve and carries each one's own index and unit.
   * The document is gated at the FIRST borrow, at the reserve regime, exactly as planned.
   */
  it("gates a two-borrow document at its first borrow, with both reserves valued in one base", () => {
    const verdict = borrowLimitVerdict(mixedLoopAndCarryGraph(), snapshot);
    expect(verdict.status).toBe("within");
    if (verdict.status !== "within") throw new Error("unreachable");
    expect(verdict.ceiling.categoryId).toBeNull();
    expect(verdict.ceiling.blockId).toBe("borrow");
    expect(verdict.ceiling.ltvBps).toBe(snapshot.reserves.weETH.ltvBps.value);
  });
});
