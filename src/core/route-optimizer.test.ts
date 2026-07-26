import { afterEach, describe, expect, it, vi } from "vitest";
import { validateGraph, type Block, type StrategyGraph } from "./graph";
import { observationMinter, type ObservationMinter } from "./provenance";
import { buildPlan, type ChainSnapshot, type PlanError, type ReserveSnapshot } from "./plan";
import {
  PINNED_BLOCK,
  PINNED_TS,
  addrRead,
  addressOf,
  anchorAddr,
  bigRead,
  readResult,
  readsMeta,
  tupleBig,
  tupleBool,
  tupleRead,
} from "../../tests/helpers/protocol-reads";
import {
  ASSETS,
  WRAP_PAIRS,
  WRAP_PAIRS_DO_NOT_COMPOSE,
  analyzeRouteCompatibility,
  expectedInputAssetOf,
  findWrapStep,
  optimizeRoute,
  outputAssetOf,
  validateRoute,
} from "./route-optimizer";

// ————————————————————————— fixture graphs —————————————————————————

function chainGraph(blocks: Block[], allocationBps = 10_000): StrategyGraph {
  const edges = blocks.slice(0, -1).map((b, i) => ({
    id: `e${i}`,
    source: b.id,
    target: blocks[i + 1]!.id,
    allocationBps,
  }));
  return { blocks, edges };
}

/** The flagship expanded DAG (SPEC §2) — already fully wrapped, nothing to insert. */
function flagship(): StrategyGraph {
  return chainGraph([
    { id: "in", type: "input", params: { asset: "ETH", amount: "10" } },
    { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
    { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
    { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    { id: "borrow", type: "borrow", params: { protocol: "aave-v3", asset: "WETH", allocationBps: 7000 } },
    { id: "unwrap", type: "unwrap", params: { from: "WETH", to: "ETH" } },
    { id: "stake2", type: "stake", params: { protocol: "etherfi" } },
    { id: "wrap2", type: "wrap", params: { from: "eETH", to: "weETH" } },
    { id: "supply2", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
  ]);
}

/** stake(etherfi) → lend(weETH): eETH must be wrapped. One insertion. */
function needsWrap(allocationBps = 10_000): StrategyGraph {
  return chainGraph(
    [
      { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
      { id: "s", type: "stake", params: { protocol: "etherfi" } },
      { id: "l", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    ],
    allocationBps,
  );
}

/** stake(lido) → lend(weETH): stETH cannot reach weETH by any wrapper. */
function unroutable(): StrategyGraph {
  return chainGraph([
    { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
    { id: "s", type: "stake", params: { protocol: "lido" } },
    { id: "l", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
  ]);
}

/** stake(lido) → lend(wstETH): schema-valid and routable, but outside P1. */
function lidoLane(): StrategyGraph {
  return chainGraph([
    { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
    { id: "s", type: "stake", params: { protocol: "lido" } },
    { id: "l", type: "lend", params: { protocol: "aave-v3", asset: "wstETH" } },
  ]);
}

// ————————————————————————— pinned fixture snapshot —————————————————————————
//
// buildPlan's P1 phase gate returns before it dereferences the snapshot, but the
// signature demands a real one and this repo does not fabricate snapshots: every
// value below is drawn from the committed reads log at the pinned block, exactly
// the way plan.test.ts builds its fixture. Deliberately duplicated rather than
// imported — importing one test file into another registers its suites twice. If
// a third consumer appears, lift this into tests/helpers/ and have plan.test.ts
// adopt it in its own commit.

const FIXTURE_USER = addressOf("0x1111111111111111111111111111111111111111", "fixture user");

function numericField(raw: unknown, key: string, what: string): number {
  if (typeof raw !== "object" || raw === null) throw new Error(`${what} is not an object`);
  const entry = Object.entries(raw).find(([k]) => k === key);
  if (entry === undefined) throw new Error(`${what} has no ${key}`);
  const value: unknown = entry[1];
  if (typeof value !== "number") throw new Error(`${what}.${key} is not a number`);
  return value;
}

function reserveSnapshot(sym: "weETH" | "WETH", mint: ObservationMinter): ReserveSnapshot {
  const cfg = `${sym}.getReserveConfigurationData`;
  const rd = `${sym}.getReserveData`;
  const caps = `${sym}.getReserveCaps`;
  const toks = tupleRead(`${sym}.getReserveTokensAddresses`);
  const underlying = anchorAddr(sym);
  const index = tupleRead("Pool.getReservesList").findIndex(
    (a) => typeof a === "string" && a.toLowerCase() === underlying.toLowerCase(),
  );
  if (index < 0) throw new Error(`${sym} is not in Pool.getReservesList`);
  return {
    underlying,
    aToken: addressOf(toks[0], `${sym} aToken`),
    variableDebtToken: addressOf(toks[2], `${sym} variableDebtToken`),
    reserveIndex: mint.observe(index, `Pool.getReservesList.indexOf(${sym})`),
    decimals: mint.observe(Number(tupleBig(cfg, 0)), `${cfg}.decimals`),
    active: mint.observe(tupleBool(cfg, 8), `${cfg}.isActive`),
    frozen: mint.observe(tupleBool(cfg, 9), `${cfg}.isFrozen`),
    paused: mint.observe(readResult(`${sym}.getPaused`) === true, `${sym}.getPaused`),
    borrowingEnabled: mint.observe(tupleBool(cfg, 6), `${cfg}.borrowingEnabled`),
    usageAsCollateralAllowed: mint.observe(tupleBool(cfg, 5), `${cfg}.usageAsCollateralEnabled`),
    ltvBps: mint.observe(Number(tupleBig(cfg, 1)), `${cfg}.ltv`),
    liquidationThresholdBps: mint.observe(Number(tupleBig(cfg, 2)), `${cfg}.liquidationThreshold`),
    supplyCap: mint.observe(tupleBig(caps, 1), `${caps}.supplyCap`),
    borrowCap: mint.observe(tupleBig(caps, 0), `${caps}.borrowCap`),
    aTokenScaledTotalSupply: mint.observe(
      bigRead(`${sym}.aToken.scaledTotalSupply`),
      `${sym}.aToken.scaledTotalSupply`,
    ),
    variableDebtScaledTotalSupply: mint.observe(
      bigRead(`${sym}.variableDebtToken.scaledTotalSupply`),
      `${sym}.variableDebtToken.scaledTotalSupply`,
    ),
    accruedToTreasury: mint.observe(tupleBig(rd, 1), `${rd}.accruedToTreasury`),
    liquidityRateRay: mint.observe(tupleBig(rd, 5), `${rd}.liquidityRate`),
    variableBorrowRateRay: mint.observe(tupleBig(rd, 6), `${rd}.variableBorrowRate`),
    liquidityIndexRay: mint.observe(tupleBig(rd, 9), `${rd}.liquidityIndex`),
    variableBorrowIndexRay: mint.observe(tupleBig(rd, 10), `${rd}.variableBorrowIndex`),
    lastUpdateTimestamp: mint.observe(tupleBig(rd, 11), `${rd}.lastUpdateTimestamp`),
    virtualUnderlyingBalance: mint.observe(
      bigRead(`${sym}.getVirtualUnderlyingBalance`),
      `${sym}.getVirtualUnderlyingBalance`,
    ),
    priceBase: mint.observe(bigRead(`Oracle.getAssetPrice(${sym})`), `Oracle.getAssetPrice(${sym})`),
    rateStrategy: mint.observe(rateStrategy(sym), `${sym}.strategy.getInterestRateDataBps`),
    reserveFactorBps: mint.observe(Number(tupleBig(cfg, 4)), `${cfg}.reserveFactor`),
    deficit: mint.observe(bigRead(`${sym}.getReserveDeficit`), `${sym}.getReserveDeficit`),
  };
}

function rateStrategy(sym: "weETH" | "WETH") {
  const label = `${sym}.strategy.getInterestRateDataBps`;
  const raw = readResult(label);
  return {
    optimalUsageRatio: numericField(raw, "optimalUsageRatio", label),
    baseVariableBorrowRate: numericField(raw, "baseVariableBorrowRate", label),
    variableRateSlope1: numericField(raw, "variableRateSlope1", label),
    variableRateSlope2: numericField(raw, "variableRateSlope2", label),
  };
}

function fixtureSnapshot(): ChainSnapshot {
  const mint = observationMinter(PINNED_BLOCK, Number(PINNED_TS));
  const label = readResult("eMode1.label");
  if (typeof label !== "string") throw new Error("eMode1.label is not a string");
  const collateralConfig = readResult("eMode1.collateralConfig");
  return {
    block: PINNED_BLOCK,
    blockTimestamp: PINNED_TS,
    pool: addressOf(readsMeta.pool, "pool"),
    reserves: { weETH: reserveSnapshot("weETH", mint), WETH: reserveSnapshot("WETH", mint) },
    eModeCategories: [
      {
        id: 1,
        label: mint.observe(label, "eMode1.label"),
        ltvBps: mint.observe(
          numericField(collateralConfig, "ltv", "eMode1.collateralConfig"),
          "eMode1.collateralConfig.ltv",
        ),
        liquidationThresholdBps: mint.observe(
          numericField(collateralConfig, "liquidationThreshold", "eMode1.collateralConfig"),
          "eMode1.collateralConfig.liquidationThreshold",
        ),
        collateralBitmap: mint.observe(bigRead("eMode1.collateralBitmap"), "eMode1.collateralBitmap"),
        borrowableBitmap: mint.observe(bigRead("eMode1.borrowableBitmap"), "eMode1.borrowableBitmap"),
        isIsolated: mint.observe(readResult("eMode1.isIsolated (v3.7)") === true, "eMode1.isIsolated"),
        ltvZeroBitmap: mint.observe(bigRead("eMode1.ltvZeroBitmap (v3.7)"), "eMode1.ltvZeroBitmap"),
      },
    ],
    etherfi: {
      liquidityPool: addrRead("weETH.liquidityPool (round-trip)"),
      eETH: addrRead("LP.eETH (round-trip)"),
      weETH: anchorAddr("weETH"),
      totalPooledEther: mint.observe(bigRead("LP.getTotalPooledEther"), "LP.getTotalPooledEther"),
      totalShares: mint.observe(bigRead("eETH.totalShares"), "eETH.totalShares"),
      // The route optimizer never reaches a rate; the window would be noise in this fixture.
      rateWindow: null,
    },
    // A deliberately clean fixture wallet: no e-mode, no Aave footprint. The
    // phase gate returns before either is read, so neither steers this suite.
    user: {
      address: FIXTURE_USER,
      eModeCategoryId: mint.observe(0, "Pool.getUserEMode(user)"),
      hasAaveFootprint: mint.observe(false, "user aave footprint predicate"),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ————————————————————————— tests —————————————————————————

describe("asset semantics", () => {
  it("reads each block type's output", () => {
    expect(outputAssetOf({ id: "a", type: "input", params: { asset: "ETH" } })).toBe("ETH");
    expect(outputAssetOf({ id: "a", type: "stake", params: { protocol: "etherfi" } })).toBe("eETH");
    expect(outputAssetOf({ id: "a", type: "stake", params: { protocol: "lido" } })).toBe("stETH");
    expect(outputAssetOf({ id: "a", type: "wrap", params: { from: "eETH", to: "weETH" } })).toBe("weETH");
    expect(outputAssetOf({ id: "a", type: "unwrap", params: { from: "WETH", to: "ETH" } })).toBe("ETH");
    expect(outputAssetOf({ id: "a", type: "borrow", params: { asset: "WETH" } })).toBe("WETH");
    expect(outputAssetOf({ id: "a", type: "lend", params: { asset: "weETH" } })).toBeNull();
  });

  it("reads each block type's expected input", () => {
    expect(expectedInputAssetOf({ id: "a", type: "input", params: { asset: "ETH" } })).toBeNull();
    expect(expectedInputAssetOf({ id: "a", type: "borrow", params: { asset: "WETH" } })).toBeNull();
    expect(expectedInputAssetOf({ id: "a", type: "stake", params: { protocol: "etherfi" } })).toBe("ETH");
    expect(expectedInputAssetOf({ id: "a", type: "stake", params: { protocol: "lido" } })).toBe("ETH");
    expect(expectedInputAssetOf({ id: "a", type: "wrap", params: { from: "eETH", to: "weETH" } })).toBe("eETH");
    expect(expectedInputAssetOf({ id: "a", type: "unwrap", params: { from: "WETH", to: "ETH" } })).toBe("WETH");
    expect(expectedInputAssetOf({ id: "a", type: "lend", params: { asset: "weETH" } })).toBe("weETH");
  });

  // The asset set is derived from a Readonly<Record<Asset, true>>, so a new
  // member in graph.ts is a compile error here rather than a silent rejection
  // that would make incompatibilities disappear instead of being reported.
  it("derives its asset list from graph.ts's Asset union", () => {
    expect([...ASSETS].sort()).toEqual(["ETH", "WETH", "eETH", "stETH", "weETH", "wstETH"]);
    for (const pair of WRAP_PAIRS) {
      expect(ASSETS).toContain(pair.unwrapped);
      expect(ASSETS).toContain(pair.wrapped);
    }
  });
});

// TRANSPLANT.md L189/194/198/201: unknown or unconfigured must be unknown, never ETH.
describe("no silent ETH fallback (L189/L194/L198/L201)", () => {
  it("returns null for an unknown stake protocol rather than assuming ETH→eETH", () => {
    const b: Block = { id: "a", type: "stake", params: { protocol: "rocketpool" } };
    expect(outputAssetOf(b)).toBeNull();
    expect(expectedInputAssetOf(b)).toBeNull();
  });

  it("returns null for a non-string protocol param", () => {
    const b: Block = { id: "a", type: "stake", params: { protocol: 7 } };
    expect(outputAssetOf(b)).toBeNull();
    expect(expectedInputAssetOf(b)).toBeNull();
  });

  it("returns null for a missing, numeric, or out-of-scope asset param", () => {
    expect(outputAssetOf({ id: "a", type: "input", params: {} })).toBeNull();
    expect(outputAssetOf({ id: "a", type: "input", params: { asset: 1 } })).toBeNull();
    expect(outputAssetOf({ id: "a", type: "input", params: { asset: "rETH" } })).toBeNull();
    expect(expectedInputAssetOf({ id: "a", type: "lend", params: {} })).toBeNull();
    expect(expectedInputAssetOf({ id: "a", type: "wrap", params: { from: "cbETH" } })).toBeNull();
  });

  it("makes an unconfigured block produce no incompatibility claim at all", () => {
    const g = chainGraph([
      { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
      { id: "s", type: "stake", params: {} },
    ]);
    expect(analyzeRouteCompatibility(g)).toEqual([]);
    expect(validateRoute(g).ok).toBe(true);
  });
});

describe("findWrapStep", () => {
  it("finds the wrap direction for each v1 pair", () => {
    expect(findWrapStep("eETH", "weETH")).toEqual([{ from: "eETH", to: "weETH", direction: "wrap" }]);
    expect(findWrapStep("stETH", "wstETH")).toEqual([{ from: "stETH", to: "wstETH", direction: "wrap" }]);
    expect(findWrapStep("ETH", "WETH")).toEqual([{ from: "ETH", to: "WETH", direction: "wrap" }]);
  });

  it("finds the unwrap direction for each v1 pair", () => {
    expect(findWrapStep("weETH", "eETH")).toEqual([{ from: "weETH", to: "eETH", direction: "unwrap" }]);
    expect(findWrapStep("wstETH", "stETH")).toEqual([{ from: "wstETH", to: "stETH", direction: "unwrap" }]);
    expect(findWrapStep("WETH", "ETH")).toEqual([{ from: "WETH", to: "ETH", direction: "unwrap" }]);
  });

  // The old contract at route-optimizer.ts:206 — an EMPTY path means "nothing
  // needed"; null is reserved for "no conversion exists". Collapsing the two
  // would make validateRoute call a matching pair unroutable.
  it("returns an empty path for identical assets, not the unroutable sentinel", () => {
    for (const asset of ASSETS) {
      expect(findWrapStep(asset, asset)).toEqual([]);
    }
  });

  it("returns null only when no wrapper conversion exists", () => {
    expect(findWrapStep("stETH", "weETH")).toBeNull();
    expect(findWrapStep("ETH", "eETH")).toBeNull(); // a stake, not a wrap
    expect(findWrapStep("weETH", "WETH")).toBeNull();
  });

  // L46-52 / L35+L50: no addresses, no fabricated method names may reappear.
  it("carries no contract address or method name", () => {
    for (const pair of WRAP_PAIRS) {
      expect(Object.keys(pair).sort()).toEqual(["unwrapped", "wrapped"]);
    }
    expect(JSON.stringify(WRAP_PAIRS)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  // L29-84: out-of-scope wrappers must not have been carried over.
  it("has no rETH, cbETH or sfrxETH wrapper", () => {
    const symbols = WRAP_PAIRS.flatMap((p) => [p.unwrapped, p.wrapped]);
    for (const cut of ["rETH", "cbETH", "sfrxETH", "USDC", "USDT", "DAI"]) {
      expect(symbols).not.toContain(cut);
    }
  });
});

// TRANSPLANT.md L440-442, delete arm. The predecessor's dangling beforeBlockId
// lived only in the NON-FINAL step of a multi-step chain, and no such chain is
// reachable under v1's pair set — which is why the chain machinery and its
// bookkeeping are deleted rather than "fixed and tested". These two tests plus
// the WRAP_PAIRS_DO_NOT_COMPOSE compile pin are what make that deletion safe:
// adding a composing pair breaks the build AND this suite, forcing whoever adds
// it to reintroduce chaining deliberately, with linked-reference tests.
describe("one-hop invariant — WRAP_PAIRS is a matching (L440-442)", () => {
  it("gives every asset at most one wrapper counterpart", () => {
    for (const asset of ASSETS) {
      const counterparts = ASSETS.filter((other) => other !== asset && findWrapStep(asset, other) !== null);
      expect(counterparts.length).toBeLessThanOrEqual(1);
    }
  });

  it("cannot compose two conversions into a route one conversion misses", () => {
    for (const from of ASSETS) {
      for (const mid of ASSETS) {
        if (mid === from || findWrapStep(from, mid) === null) continue;
        for (const to of ASSETS) {
          if (to === mid || findWrapStep(mid, to) === null) continue;
          // Two hops can only land back where they started. If this ever fails,
          // a composing pair was added: optimizeRoute must grow a chain and the
          // deleted insertion bookkeeping must come back with it.
          expect(to).toBe(from);
        }
      }
    }
    expect(WRAP_PAIRS_DO_NOT_COMPOSE).toBe(true);
  });
});

describe("analyzeRouteCompatibility", () => {
  it("reports nothing for the already-wrapped flagship DAG", () => {
    expect(analyzeRouteCompatibility(flagship())).toEqual([]);
    expect(validateRoute(flagship()).ok).toBe(true);
  });

  it("reports a wrappable mismatch with the closing step", () => {
    const found = analyzeRouteCompatibility(needsWrap());
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      edgeId: "e1",
      sourceBlockId: "s",
      targetBlockId: "l",
      sourceOutput: "eETH",
      targetExpects: "weETH",
      wrapStep: { from: "eETH", to: "weETH", direction: "wrap" },
    });
  });

  it("ignores dependency edges (lend→borrow) and dangling endpoints", () => {
    const dependency: StrategyGraph = {
      blocks: [
        { id: "l", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
        { id: "b", type: "borrow", params: { protocol: "aave-v3", asset: "WETH", allocationBps: 7000 } },
      ],
      edges: [{ id: "e", source: "l", target: "b", allocationBps: 10_000 }],
    };
    expect(analyzeRouteCompatibility(dependency)).toEqual([]);

    const dangling: StrategyGraph = {
      blocks: [{ id: "s", type: "stake", params: { protocol: "etherfi" } }],
      edges: [
        { id: "e1", source: "s", target: "ghost", allocationBps: 10_000 },
        { id: "e2", source: "ghost", target: "s", allocationBps: 10_000 },
      ],
    };
    expect(analyzeRouteCompatibility(dangling)).toEqual([]);
  });
});

// TRANSPLANT.md L298-323 + L551-559: the predecessor dropped unroutable edges,
// leaving the incompatible_tokens branch unreachable and impossible routes clean.
describe("REGRESSION — unroutable edges must not vanish (L298-323 + L551-559)", () => {
  it("still reports the incompatibility when no wrapper closes the gap", () => {
    const found = analyzeRouteCompatibility(unroutable());
    expect(found).toHaveLength(1);
    expect(found[0]?.sourceOutput).toBe("stETH");
    expect(found[0]?.targetExpects).toBe("weETH");
    expect(found[0]?.wrapStep).toBeNull();
  });

  it("fails validation instead of passing clean", () => {
    const result = validateRoute(unroutable());
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      kind: "unroutable-edge",
      edgeId: "e1",
      sourceBlockId: "s",
      targetBlockId: "l",
      from: "stETH",
      to: "weETH",
    });
  });

  it("leaves the graph untouched and still fails after optimizeRoute", () => {
    const g = unroutable();
    const result = optimizeRoute(g);
    expect(result.graph).toBe(g);
    expect(result.autoInsertedBlockIds).toEqual([]);
    expect(validateRoute(result.graph).ok).toBe(false);
  });

  it("routes what it can and reports what it cannot, in one graph", () => {
    const g: StrategyGraph = {
      blocks: [
        { id: "in", type: "input", params: { asset: "ETH", amount: "2" } },
        { id: "etherfi", type: "stake", params: { protocol: "etherfi" } },
        { id: "lido", type: "stake", params: { protocol: "lido" } },
        { id: "good", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
        { id: "bad", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
      ],
      edges: [
        { id: "e0", source: "in", target: "etherfi", allocationBps: 5000 },
        { id: "e1", source: "in", target: "lido", allocationBps: 5000 },
        { id: "e2", source: "etherfi", target: "good", allocationBps: 10_000 },
        { id: "e3", source: "lido", target: "bad", allocationBps: 10_000 },
      ],
    };
    const result = optimizeRoute(g);
    expect(result.autoInsertedBlockIds).toEqual(["auto-wrap:e2"]);
    const errors = validateRoute(result.graph).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.edgeId).toBe("e3");
  });
});

describe("optimizeRoute", () => {
  it("returns the same graph when nothing needs wrapping", () => {
    const g = flagship();
    const result = optimizeRoute(g);
    expect(result.graph).toBe(g);
    expect(result.autoInsertedBlockIds).toEqual([]);
  });

  it("inserts the wrap block and rewires the edge through it", () => {
    const result = optimizeRoute(needsWrap());
    expect(result.autoInsertedBlockIds).toEqual(["auto-wrap:e1"]);

    const inserted = result.graph.blocks.find((b) => b.id === "auto-wrap:e1");
    expect(inserted).toEqual({
      id: "auto-wrap:e1",
      type: "wrap",
      params: { from: "eETH", to: "weETH" },
    });

    expect(result.graph.edges.map((e) => e.id)).toEqual(["e0", "e1:in", "e1:out"]);
    expect(result.graph.edges.find((e) => e.id === "e1:in")).toMatchObject({
      source: "s",
      target: "auto-wrap:e1",
    });
    expect(result.graph.edges.find((e) => e.id === "e1:out")).toMatchObject({
      source: "auto-wrap:e1",
      target: "l",
    });
    expect(result.graph.edges.some((e) => e.id === "e1")).toBe(false);
  });

  it("inserts an unwrap when the consumer needs the unwrapped form", () => {
    const g = chainGraph([
      { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
      { id: "w", type: "wrap", params: { from: "ETH", to: "WETH" } },
      { id: "s", type: "stake", params: { protocol: "etherfi" } },
    ]);
    const result = optimizeRoute(g);
    expect(result.graph.blocks.find((b) => b.id === "auto-wrap:e1")).toEqual({
      id: "auto-wrap:e1",
      type: "unwrap",
      params: { from: "WETH", to: "ETH" },
    });
  });

  it("preserves the source allocation and passes 100% out of the wrap block", () => {
    const result = optimizeRoute(needsWrap(6000));
    expect(result.graph.edges.find((e) => e.id === "e1:in")?.allocationBps).toBe(6000);
    expect(result.graph.edges.find((e) => e.id === "e1:out")?.allocationBps).toBe(10_000);
  });

  it("does not rewrite the consumer's declared asset param (L484-491)", () => {
    const result = optimizeRoute(needsWrap());
    const lend = result.graph.blocks.find((b) => b.id === "l");
    expect(lend?.params).toEqual({ protocol: "aave-v3", asset: "weETH" });
    expect(JSON.stringify(result.graph)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it("emits a graph graph.ts accepts, and one plan.ts sees as flow-clean", () => {
    const result = optimizeRoute(needsWrap());
    expect(validateGraph(result.graph)).toEqual({ ok: true, errors: [] });
    expect(validateRoute(result.graph).ok).toBe(true);
    expect(analyzeRouteCompatibility(result.graph)).toEqual([]);
  });

  it("is idempotent — re-optimizing inserts nothing more", () => {
    const once = optimizeRoute(needsWrap());
    const twice = optimizeRoute(once.graph);
    expect(twice.autoInsertedBlockIds).toEqual([]);
    expect(twice.graph).toBe(once.graph);
  });

  it("refuses to emit a colliding block id", () => {
    const g = needsWrap();
    const collided: StrategyGraph = {
      blocks: [...g.blocks, { id: "auto-wrap:e1", type: "wrap", params: { from: "eETH", to: "weETH" } }],
      edges: g.edges,
    };
    expect(() => optimizeRoute(collided)).toThrow(RangeError);
  });

  // The added in→l edge is ETH→weETH, which no wrapper closes, so it is filtered
  // out of `routable` and is never itself optimized — it survives purely as a
  // pre-existing id for e1's derived edge ids to collide with. That is what makes
  // the throw reachable in both of the next two tests.
  it("refuses to emit a colliding in-edge id", () => {
    const g = needsWrap();
    const collided: StrategyGraph = {
      blocks: g.blocks,
      edges: [...g.edges, { id: "e1:in", source: "in", target: "l", allocationBps: 1 }],
    };
    expect(() => optimizeRoute(collided)).toThrow(RangeError);
  });

  it("refuses to emit a colliding out-edge id", () => {
    const g = needsWrap();
    const collided: StrategyGraph = {
      blocks: g.blocks,
      edges: [...g.edges, { id: "e1:out", source: "in", target: "l", allocationBps: 1 }],
    };
    expect(() => optimizeRoute(collided)).toThrow(RangeError);
  });
});

// TRANSPLANT.md L400: ids embedded Date.now(), which breaks plan-snapshot tests.
describe("REGRESSION — deterministic ids and live references (L400 + L440-442)", () => {
  it("derives ids from the edge id, not the clock", () => {
    const nowSpy = vi.spyOn(Date, "now");

    nowSpy.mockReturnValue(1_000_000_000_000);
    const first = optimizeRoute(needsWrap());
    nowSpy.mockReturnValue(1_999_999_999_999);
    const second = optimizeRoute(needsWrap());

    expect(second.graph).toEqual(first.graph);
    expect(second.autoInsertedBlockIds).toEqual(first.autoInsertedBlockIds);
    for (const block of first.graph.blocks) {
      expect(block.id).not.toMatch(/\d{10,}/);
    }
    for (const edge of first.graph.edges) {
      expect(edge.id).not.toMatch(/\d{10,}/);
    }
  });

  it("leaves every edge and every reported id pointing at a block that exists", () => {
    const result = optimizeRoute(needsWrap());
    const ids = new Set(result.graph.blocks.map((b) => b.id));
    for (const edge of result.graph.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
    expect(result.autoInsertedBlockIds).toEqual(["auto-wrap:e1"]);
    for (const id of result.autoInsertedBlockIds) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("keeps references live when several edges are wrapped at once", () => {
    const g: StrategyGraph = {
      blocks: [
        { id: "in", type: "input", params: { asset: "ETH", amount: "2" } },
        { id: "s1", type: "stake", params: { protocol: "etherfi" } },
        { id: "s2", type: "stake", params: { protocol: "etherfi" } },
        { id: "l1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
        { id: "l2", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
      ],
      edges: [
        { id: "a", source: "in", target: "s1", allocationBps: 5000 },
        { id: "b", source: "in", target: "s2", allocationBps: 5000 },
        { id: "c", source: "s1", target: "l1", allocationBps: 10_000 },
        { id: "d", source: "s2", target: "l2", allocationBps: 10_000 },
      ],
    };
    const result = optimizeRoute(g);
    const ids = new Set(result.graph.blocks.map((b) => b.id));
    expect(result.autoInsertedBlockIds).toEqual(["auto-wrap:c", "auto-wrap:d"]);
    for (const id of result.autoInsertedBlockIds) {
      expect(ids.has(id)).toBe(true);
    }
    for (const edge of result.graph.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
    expect(validateGraph(result.graph).ok).toBe(true);
  });
});

/**
 * TRANSPLANT.md L90-95. graph.ts deliberately keeps Lido and wstETH
 * schema-representable — a W03 design decision — so the composer can express the
 * lane and plan.ts, not this module, decides it is out of phase. Narrowing the
 * optimizer to the P1 execution set would silently delete blocks the user placed.
 *
 * The consequence is a graph that is simultaneously route-clean and
 * plan-rejected, and the canvas MUST render that honestly: name each block and
 * say it is not executable in this phase. It must never show a generic failure,
 * and never hide the blocks the optimizer just routed. If a future change makes
 * any of these three layers disagree with the others, one of these tests breaks.
 */
describe("three-layer contract — schema-valid, route-clean, plan-rejected (lido/wstETH)", () => {
  it("layer 2: the optimizer routes the lane with a stETH→wstETH wrap", () => {
    const result = optimizeRoute(lidoLane());
    expect(result.autoInsertedBlockIds).toEqual(["auto-wrap:e1"]);
    expect(result.graph.blocks.find((b) => b.id === "auto-wrap:e1")).toEqual({
      id: "auto-wrap:e1",
      type: "wrap",
      params: { from: "stETH", to: "wstETH" },
    });
    expect(validateRoute(result.graph)).toEqual({ ok: true, errors: [] });
  });

  it("layer 1: graph.ts accepts the routed graph as structurally valid", () => {
    const result = optimizeRoute(lidoLane());
    expect(validateGraph(result.graph)).toEqual({ ok: true, errors: [] });
  });

  it("layer 3: buildPlan rejects it with typed unsupported-in-phase errors naming every block", () => {
    const result = optimizeRoute(lidoLane());
    const plan = buildPlan(result.graph, fixtureSnapshot());
    if (plan.ok) throw new Error("buildPlan unexpectedly accepted a lido/wstETH graph");

    const phase = plan.errors.filter(
      (e): e is Extract<PlanError, { kind: "unsupported-in-phase" }> => e.kind === "unsupported-in-phase",
    );
    expect(phase).toHaveLength(plan.errors.length);
    expect(phase.map((e) => e.blockId).sort()).toEqual(["auto-wrap:e1", "l", "s"]);
    for (const error of phase) {
      expect(error.detail).toMatch(/not executable in P1/);
    }
  });

  it("is route-clean and plan-rejected at the same time — the state the canvas must render", () => {
    const result = optimizeRoute(lidoLane());
    const plan = buildPlan(result.graph, fixtureSnapshot());
    expect(validateRoute(result.graph).ok).toBe(true);
    expect(plan.ok).toBe(false);
  });

  it("does not pre-filter the lane away: the user's blocks all survive optimization", () => {
    const result = optimizeRoute(lidoLane());
    for (const id of ["in", "s", "l"]) {
      expect(result.graph.blocks.some((b) => b.id === id)).toBe(true);
    }
  });
});

// The anti-drift guard: WRAP_PAIRS here must stay a subset of graph.ts's private
// WRAP_PAIRS / UNWRAP_PAIRS, which only validateGraph can attest to.
describe("inserted blocks are legal under graph.ts", () => {
  it("accepts every wrap and unwrap this module can emit", () => {
    for (const pair of WRAP_PAIRS) {
      for (const [from, to, type] of [
        [pair.unwrapped, pair.wrapped, "wrap"] as const,
        [pair.wrapped, pair.unwrapped, "unwrap"] as const,
      ]) {
        const g: StrategyGraph = {
          blocks: [
            { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
            { id: "w", type, params: { from, to } },
          ],
          edges: [{ id: "e", source: "in", target: "w", allocationBps: 10_000 }],
        };
        const errors = validateGraph(g).errors.filter((e) => e.startsWith("block w:"));
        expect(errors).toEqual([]);
      }
    }
  });
});
