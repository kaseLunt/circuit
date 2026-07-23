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

describe("validateGraph — semantic validation (§5.6)", () => {
  const withParams = (id: string, params: Record<string, string | number>): StrategyGraph => {
    const g = flagship();
    return {
      blocks: g.blocks.map((b) => (b.id === id ? { ...b, params } : b)),
      edges: g.edges,
    };
  };

  it("rejects an unsupported stake protocol", () => {
    const r = validateGraph(withParams("stake1", { protocol: "attacker" }));
    expect(r.errors.some((e) => e.includes("unsupported stake protocol"))).toBe(true);
  });
  it("rejects a non-ETH input asset and a missing amount", () => {
    const r = validateGraph(withParams("in", { asset: "USDC" }));
    expect(r.errors.some((e) => e.includes("input asset must be ETH"))).toBe(true);
    expect(r.errors.some((e) => e.includes("positive amount"))).toBe(true);
  });
  it("rejects an unsupported wrap conversion", () => {
    const r = validateGraph(withParams("wrap1", { from: "eETH", to: "USDC" }));
    expect(r.errors.some((e) => e.includes("unsupported wrap"))).toBe(true);
  });
  it("rejects an unsupported unwrap conversion", () => {
    const r = validateGraph(withParams("unwrap", { from: "WETH", to: "USDC" }));
    expect(r.errors.some((e) => e.includes("unsupported unwrap"))).toBe(true);
  });
  it("rejects a bad lend protocol/asset", () => {
    const r = validateGraph(withParams("supply1", { protocol: "compound", asset: "USDC" }));
    expect(r.errors.some((e) => e.includes("lend protocol must be aave-v3"))).toBe(true);
    expect(r.errors.some((e) => e.includes("unsupported lend asset"))).toBe(true);
  });
  it("rejects a collateral-only borrow asset and bad allocationBps", () => {
    const r1 = validateGraph(withParams("borrow", { protocol: "aave-v3", asset: "weETH", allocationBps: 7000 }));
    expect(r1.errors.some((e) => e.includes("collateral-only borrow asset"))).toBe(true);
    const r2 = validateGraph(withParams("borrow", { protocol: "aave-v3", asset: "WETH", allocationBps: 0 }));
    expect(r2.errors.some((e) => e.includes("allocationBps must be in"))).toBe(true);
  });

  it("rejects fan-in (a non-input block with two producers)", () => {
    const g = flagship();
    const fanIn: StrategyGraph = {
      blocks: g.blocks,
      edges: [...g.edges, { id: "extra", source: "wrap1", target: "supply2", allocationBps: 10_000 }],
    };
    const r = validateGraph(fanIn);
    expect(r.errors.some((e) => e.includes("exactly one producer"))).toBe(true);
  });

  it("rejects an unreachable (disconnected) block", () => {
    const g = flagship();
    const island: StrategyGraph = {
      blocks: [...g.blocks, { id: "orphan", type: "stake", params: { protocol: "lido" } }],
      edges: g.edges,
    };
    const r = validateGraph(island);
    expect(r.errors.some((e) => e.includes("orphan") && e.includes("not reachable"))).toBe(true);
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
