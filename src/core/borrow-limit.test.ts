import { describe, expect, it } from "vitest";
import { borrowLimitVerdict, type BorrowCeiling } from "./borrow-limit";
import { chainOf, flagshipGraph, FORK_PROVEN_BORROW_BPS } from "../../tests/helpers/graphs";
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
