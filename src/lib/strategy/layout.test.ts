import { describe, expect, it } from "vitest";
import type { Block, StrategyGraph } from "../../core/graph";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { FULL_ALLOCATION_BPS } from "./types";
import { COLUMN_GAP, ROW_GAP, layoutGraph } from "./layout";

/** Stake blocks with the given ids, wired by the given (source, target) pairs. */
function graphOf(
  blockIds: readonly string[],
  wires: ReadonlyArray<readonly [string, string]>,
): StrategyGraph {
  const blocks: Block[] = blockIds.map((id) => ({
    id,
    type: "stake",
    params: { protocol: "etherfi" },
  }));
  return {
    blocks,
    edges: wires.map(([source, target]) => ({
      id: `e:${source}>${target}`,
      source,
      target,
      allocationBps: FULL_ALLOCATION_BPS,
    })),
  };
}

function coordinates(view: Record<string, { x: number; y: number }>): string[] {
  return Object.values(view).map((at) => `${at.x},${at.y}`);
}

describe("layoutGraph places every block, deterministically", () => {
  it("gives a coordinate to every block, in document order", () => {
    const graph = flagshipGraph();
    const view = layoutGraph(graph);
    expect(Object.keys(view)).toEqual(graph.blocks.map((b) => b.id));
  });

  it("returns the same layout for the same document, call after call", () => {
    // No clock, no randomness, no measurement: a shared link must rehydrate to the
    // canvas the author saw.
    expect(layoutGraph(flagshipGraph())).toEqual(layoutGraph(flagshipGraph()));
  });

  it("draws a single-producer chain as one left-to-right row", () => {
    const view = layoutGraph(flagshipGraph());
    const xs = flagshipGraph().blocks.map((b) => view[b.id]!.x);
    expect(xs).toEqual(xs.map((_unused, i) => i * COLUMN_GAP));
    expect(flagshipGraph().blocks.every((b) => view[b.id]!.y === 0)).toBe(true);
  });

  it("never places two blocks on the same point", () => {
    const fanOut = graphOf(
      ["in", "a", "b", "c"],
      [
        ["in", "a"],
        ["in", "b"],
        ["in", "c"],
      ],
    );
    for (const graph of [flagshipGraph(), fanOut]) {
      const points = coordinates(layoutGraph(graph));
      expect(new Set(points).size).toBe(points.length);
    }
  });

  it("stacks siblings down a shared column in document order", () => {
    const view = layoutGraph(
      graphOf(
        ["in", "a", "b"],
        [
          ["in", "a"],
          ["in", "b"],
        ],
      ),
    );
    expect(view["in"]).toEqual({ x: 0, y: 0, isAutoInserted: false });
    expect(view["a"]).toEqual({ x: COLUMN_GAP, y: 0, isAutoInserted: false });
    expect(view["b"]).toEqual({ x: COLUMN_GAP, y: ROW_GAP, isAutoInserted: false });
  });

  it("columns a block by its LONGEST path, so a shortcut edge never pulls it left", () => {
    // in→out exists directly AND through a/b; `out` must still sit right of both.
    const view = layoutGraph(
      graphOf(
        ["in", "a", "b", "out"],
        [
          ["in", "a"],
          ["in", "b"],
          ["in", "out"],
          ["a", "out"],
          ["b", "out"],
        ],
      ),
    );
    expect(view["out"]!.x).toBe(2 * COLUMN_GAP);
    expect(view["a"]!.x).toBe(COLUMN_GAP);
    expect(view["b"]!.x).toBe(COLUMN_GAP);
  });
});

describe("layoutGraph marks what the optimizer inserted", () => {
  it("flags exactly the auto-inserted ids and no others", () => {
    const view = layoutGraph(flagshipGraph(), ["wrap1", "wrap2"]);
    const flagged = Object.entries(view)
      .filter(([, at]) => at.isAutoInserted === true)
      .map(([id]) => id);
    expect(flagged).toEqual(["wrap1", "wrap2"]);
  });

  it("flags nothing when the caller names nothing", () => {
    const view = layoutGraph(flagshipGraph());
    expect(Object.values(view).some((at) => at.isAutoInserted === true)).toBe(false);
  });
});

describe("layoutGraph is total, even for documents no validator would accept", () => {
  it("lays out an empty document instead of throwing", () => {
    expect(layoutGraph({ blocks: [], edges: [] })).toEqual({});
  });

  it("places blocks a cycle leaves unranked, after everything ranked", () => {
    const partial = graphOf(
      ["in", "a", "b"],
      [
        ["in", "a"],
        ["a", "b"],
        ["b", "a"],
      ],
    );
    const partialView = layoutGraph(partial);
    expect(Object.keys(partialView)).toEqual(["in", "a", "b"]);
    expect(partialView["a"]!.x).toBe(COLUMN_GAP);
    expect(partialView["b"]!.x).toBe(COLUMN_GAP);

    const allCycle = graphOf(
      ["a", "b"],
      [
        ["a", "b"],
        ["b", "a"],
      ],
    );
    expect(layoutGraph(allCycle)).toEqual({
      a: { x: 0, y: 0, isAutoInserted: false },
      b: { x: 0, y: ROW_GAP, isAutoInserted: false },
    });
  });

  it("ignores an edge whose source or target is not a block", () => {
    const dangling = graphOf(
      ["in", "a"],
      [
        ["in", "a"],
        ["in", "GONE"],
        ["GONE", "a"],
      ],
    );
    expect(layoutGraph(dangling)).toEqual({
      in: { x: 0, y: 0, isAutoInserted: false },
      a: { x: COLUMN_GAP, y: 0, isAutoInserted: false },
    });
  });

  it("keeps a hostile block id as an own property, never a prototype write", () => {
    // "__proto__" is inside the share transport's id charset, so a decoded graph can
    // carry it; a plain `record[id] = …` would set the prototype instead.
    const view = layoutGraph(graphOf(["__proto__"], []));
    expect(Object.hasOwn(view, "__proto__")).toBe(true);
    expect(Object.keys(view)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });
});
