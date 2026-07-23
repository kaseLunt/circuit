import { describe, it, expect } from "vitest";
import { validateGraph, topologicalOrder, type StrategyGraph, type Block } from "./graph";

// The flagship leveraged-restake loop as an expanded finite DAG (SPEC §2, 9 blocks).
function flagship(): StrategyGraph {
  const blocks: Block[] = [
    { id: "in", type: "input" as const, params: { asset: "ETH", amount: "10" } },
    { id: "stake1", type: "stake" as const, params: { protocol: "etherfi" } },
    { id: "wrap1", type: "wrap" as const, params: { from: "eETH", to: "weETH" } },
    { id: "supply1", type: "lend" as const, params: { protocol: "aave-v3", asset: "weETH" } },
    { id: "borrow", type: "borrow" as const, params: { protocol: "aave-v3", asset: "WETH", allocationBps: 7000 } },
    { id: "unwrap", type: "unwrap" as const, params: { from: "WETH", to: "ETH" } },
    { id: "stake2", type: "stake" as const, params: { protocol: "etherfi" } },
    { id: "wrap2", type: "wrap" as const, params: { from: "eETH", to: "weETH" } },
    { id: "supply2", type: "lend" as const, params: { protocol: "aave-v3", asset: "weETH" } },
  ];
  const chain = ["in", "stake1", "wrap1", "supply1", "borrow", "unwrap", "stake2", "wrap2", "supply2"];
  const edges = chain.slice(0, -1).map((source, i) => ({
    id: `e${i}`,
    source,
    target: chain[i + 1]!,
    allocationBps: 10_000,
  }));
  return { blocks, edges };
}

describe("validateGraph — flagship", () => {
  it("accepts the expanded finite DAG", () => {
    const r = validateGraph(flagship());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe("validateGraph — structural rejections (§5.6)", () => {
  it("rejects a cycle (the un-expanded loop)", () => {
    const g = flagship();
    const withCycle: StrategyGraph = {
      blocks: g.blocks,
      edges: [...g.edges, { id: "back", source: "supply2", target: "in", allocationBps: 10_000 }],
    };
    const r = validateGraph(withCycle);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("graph is not acyclic");
  });

  it("rejects a dangling edge target (malformed-but-schema-valid)", () => {
    const g = flagship();
    const bad: StrategyGraph = {
      blocks: g.blocks,
      edges: [...g.edges, { id: "x", source: "supply2", target: "ATTACKER", allocationBps: 10_000 }],
    };
    const r = validateGraph(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("target ATTACKER is not a block"))).toBe(true);
  });

  it("rejects over-allocation of a source", () => {
    const g = flagship();
    const over: StrategyGraph = {
      blocks: g.blocks,
      edges: g.edges.map((e) => (e.source === "borrow" ? { ...e, allocationBps: 12_000 } : e)),
    };
    const r = validateGraph(over);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("out of [0,10000]") || e.includes("over-allocates"))).toBe(true);
  });

  it("rejects duplicate block ids", () => {
    const g = flagship();
    const dup: StrategyGraph = {
      blocks: [...g.blocks, { id: "in", type: "stake", params: {} }],
      edges: g.edges,
    };
    expect(validateGraph(dup).errors.some((e) => e.includes("duplicate block id: in"))).toBe(true);
  });

  it("rejects self-loops", () => {
    const bad: StrategyGraph = {
      blocks: [{ id: "in", type: "input", params: {} }],
      edges: [{ id: "s", source: "in", target: "in", allocationBps: 100 }],
    };
    expect(validateGraph(bad).errors.some((e) => e.includes("self-loop"))).toBe(true);
  });

  it("rejects zero or multiple input blocks", () => {
    const none: StrategyGraph = { blocks: [{ id: "a", type: "stake", params: {} }], edges: [] };
    expect(validateGraph(none).errors.some((e) => e.includes("exactly one input"))).toBe(true);
  });

  it("rejects an empty graph", () => {
    expect(validateGraph({ blocks: [], edges: [] }).ok).toBe(false);
  });
});

describe("topologicalOrder", () => {
  it("orders the flagship producers before consumers", () => {
    const order = topologicalOrder(flagship());
    expect(order[0]).toBe("in");
    expect(order.indexOf("stake1")).toBeLessThan(order.indexOf("supply1"));
    expect(order.indexOf("borrow")).toBeLessThan(order.indexOf("unwrap"));
    expect(order).toHaveLength(9);
  });

  it("throws on a cyclic graph", () => {
    const g = flagship();
    const cyc: StrategyGraph = {
      blocks: g.blocks,
      edges: [...g.edges, { id: "back", source: "supply2", target: "in", allocationBps: 10_000 }],
    };
    expect(() => topologicalOrder(cyc)).toThrow(/acyclic/);
  });
});
