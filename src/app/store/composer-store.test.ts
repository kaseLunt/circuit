import { describe, expect, it, vi } from "vitest";
import {
  MAX_EDGES,
  topologicalOrder,
  validateGraph,
  type Block,
  type Edge,
  type StrategyGraph,
} from "../../core/graph";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import {
  SHARE_VERSION,
  decodeShareGraph,
  encodeShareGraph,
  isAllowedParamValue,
} from "../../lib/share/encode";
import { STRATEGY_TEMPLATES } from "../../lib/strategy/templates";
import { FULL_ALLOCATION_BPS } from "../../lib/strategy/types";
import {
  connectRejection,
  createComposerStore,
  overAllocatedSourceIds,
  readBorrowAllocationBps,
  readInputAmount,
  selectGraph,
  selectRedoLabel,
  selectUndoLabel,
  type ComposerStoreApi,
} from "./composer-store";

/** Hostile payloads are minted here, not by `encodeShareGraph`: the encoder now refuses
 *  the documents this suite feeds the store, and an attacker does not use our encoder. */
function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tokenFor(graph: StrategyGraph): string {
  return b64url(
    JSON.stringify({
      v: SHARE_VERSION,
      b: graph.blocks.map((b) => ({ i: b.id, t: b.type, p: b.params })),
      e: graph.edges.map((e) => ({ i: e.id, s: e.source, t: e.target, a: e.allocationBps })),
    }),
  );
}

function tokenOf(graph: StrategyGraph): string {
  const encoded = encodeShareGraph(graph);
  if (!encoded.ok) throw new Error(`fixture is not shareable: ${JSON.stringify(encoded.failure)}`);
  return encoded.token;
}

/** Edge ids are the fixture's business, never this suite's: every reference is derived
 *  from the single producer of a block, so an edge-id scheme change cannot silently
 *  rewrite what these tests assert. */
function edgeTo(doc: StrategyGraph, target: string): Edge {
  const edge = doc.edges.find((e) => e.target === target);
  if (edge === undefined) throw new Error(`no edge into ${target}`);
  return edge;
}

function paramsOf(doc: StrategyGraph, id: string): Readonly<Record<string, string | number>> {
  const block = doc.blocks.find((b) => b.id === id);
  if (block === undefined) throw new Error(`no block ${id}`);
  return block.params;
}

function seeded(graph: StrategyGraph = flagshipGraph()): ComposerStoreApi {
  const store = createComposerStore();
  expect(store.getState().loadFromShare(tokenOf(graph))).toEqual({ ok: true });
  return store;
}

/** stake1 hands over eETH, supply1 expects weETH: exactly one wrap is missing. */
function unwrapped(): StrategyGraph {
  return {
    blocks: [
      { id: "in", type: "input", params: { asset: "ETH", amount: "10" } },
      { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
      { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    ],
    edges: [
      { id: "e:stake1", source: "in", target: "stake1", allocationBps: FULL_ALLOCATION_BPS },
      { id: "e:supply1", source: "stake1", target: "supply1", allocationBps: FULL_ALLOCATION_BPS },
    ],
  };
}

function cyclic(): StrategyGraph {
  const g = flagshipGraph();
  return {
    blocks: g.blocks,
    edges: [
      ...g.edges,
      { id: "back", source: "supply2", target: "in", allocationBps: FULL_ALLOCATION_BPS },
    ],
  };
}

/** Deterministic PRNG: a property test that fails only on some runs is not evidence. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("composer store — allocation edits", () => {
  it("changes only params.allocationBps, bumps rev, leaves edges untouched", () => {
    const store = seeded();
    const before = store.getState();
    expect(paramsOf(before.doc, "borrow")["allocationBps"]).toBe(7000);

    expect(store.getState().setBorrowAllocationBps("borrow", 5000)).toEqual({ ok: true });
    const after = store.getState();

    expect(after.rev).toBe(before.rev + 1);
    expect(after.doc.edges).toEqual(before.doc.edges);
    expect(paramsOf(after.doc, "borrow")).toEqual({
      protocol: "aave-v3",
      asset: "WETH",
      allocationBps: 5000,
    });
    expect(after.doc.blocks.filter((b) => b.id !== "borrow")).toEqual(
      before.doc.blocks.filter((b) => b.id !== "borrow"),
    );
    expect(selectGraph(after)).toBe(after.doc);
    // Setting the value it already holds is not an edit.
    expect(store.getState().setBorrowAllocationBps("borrow", 5000)).toEqual({ ok: true });
    expect(store.getState().rev).toBe(after.rev);
  });

  it("rejects non-integer and out-of-range values with a typed reason", () => {
    const store = seeded();
    for (const bad of [0, -1, 10_001, 70.5, Number.NaN]) {
      const result = store.getState().setBorrowAllocationBps("borrow", bad);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/\[1, 10000\]/);
    }
    expect(store.getState().doc).toEqual(flagshipGraph());
    expect(store.getState().setBorrowAllocationBps("supply1", 5000).ok).toBe(false);
    expect(store.getState().setBorrowAllocationBps("nope", 5000).ok).toBe(false);
  });

  it("does not clamp to any LTV ceiling — the over-limit value stays representable (§3.4)", () => {
    const store = seeded();
    expect(store.getState().setBorrowAllocationBps("borrow", 9500)).toEqual({ ok: true });
    expect(readBorrowAllocationBps(store.getState().doc, "borrow")).toEqual({
      kind: "entered",
      value: 9500,
    });
  });

  it("never rewrites sibling edges, and surfaces over-allocation on the source", () => {
    const store = seeded();
    const intoWrap1 = edgeTo(store.getState().doc, "wrap1");
    expect(store.getState().setEdgeAllocationBps(intoWrap1.id, 4000)).toEqual({ ok: true });
    const edges = store.getState().doc.edges;
    expect(edges.find((e) => e.id === intoWrap1.id)?.allocationBps).toBe(4000);
    expect(
      edges.filter((e) => e.id !== intoWrap1.id).every((e) => e.allocationBps === 10_000),
    ).toBe(true);
    expect(overAllocatedSourceIds(store.getState().doc)).toEqual([]);

    // A second consumer at 100% over-allocates the source immediately — permitted state,
    // surfaced rather than silently redistributed.
    const id = store.getState().addBlock("lend", { x: 0, y: 0 });
    expect(store.getState().connect("stake1", id)).toEqual({ ok: true });
    expect(store.getState().setEdgeAllocationBps(edgeTo(store.getState().doc, id).id, 10_000)).toEqual(
      { ok: true },
    );
    expect(overAllocatedSourceIds(store.getState().doc)).toEqual(["stake1"]);
  });

  it("refuses a bad bps or an unknown edge without touching the doc", () => {
    const store = seeded();
    const before = store.getState().doc;
    expect(store.getState().setEdgeAllocationBps(edgeTo(before, "wrap1").id, 0).ok).toBe(false);
    expect(store.getState().setEdgeAllocationBps("no-such-edge", 5000).ok).toBe(false);
    // Re-setting the current value is a no-op, not a history entry.
    const same = edgeTo(before, "wrap1");
    expect(store.getState().setEdgeAllocationBps(same.id, same.allocationBps)).toEqual({ ok: true });
    expect(store.getState().doc).toBe(before);
  });
});

describe("composer store — one parameter whitelist, two write paths (R7)", () => {
  it("refuses an ADDRESS on a WHITELISTED key, so no doc can carry one", () => {
    const store = seeded();
    const before = store.getState().doc;
    const result = store
      .getState()
      .setBlockParam("supply1", "asset", "0x000000000000000000000000000000000000dEaD");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not an accepted lend parameter value");
    expect(store.getState().doc).toBe(before);
  });

  it("refuses a key core does not read, and an unknown block", () => {
    const store = seeded();
    const before = store.getState().doc;
    const stray = store.getState().setBlockParam("supply1", "to", "weETH");
    expect(stray.ok).toBe(false);
    if (stray.ok) return;
    expect(stray.reason).toContain("not a parameter of a lend block");
    expect(store.getState().setBlockParam("nope", "asset", "weETH").ok).toBe(false);
    expect(store.getState().doc).toBe(before);
  });

  it("agrees with the codec on every key it is offered", () => {
    const store = seeded();
    const cases: ReadonlyArray<readonly [string, string, string | number]> = [
      ["in", "amount", "12.5"],
      ["in", "amount", "1e3"],
      ["in", "asset", "ETH"],
      ["in", "asset", "USDT"],
      ["stake1", "protocol", "lido"],
      ["stake1", "protocol", "attacker"],
      ["wrap1", "to", "wstETH"],
      ["wrap1", "to", "0xdeadbeef"],
      ["borrow", "allocationBps", 6500],
      ["borrow", "allocationBps", 10_001],
      ["supply1", "asset", "wstETH"],
    ];
    for (const [id, key, value] of cases) {
      const type = store.getState().doc.blocks.find((b) => b.id === id)!.type;
      expect(store.getState().setBlockParam(id, key, value).ok, `${id}.${key}`).toBe(
        isAllowedParamValue(type, key, value),
      );
    }
    // Per-key domains deliberately do not enforce cross-field pair validity —
    // blocks may be invalid mid-edit; the graph-level gate is transport. So
    // restore graph-valid values for every key the loop mutated before
    // asserting the accepted vocabulary is transportable.
    store.getState().setBlockParam("in", "amount", "10");
    store.getState().setBlockParam("in", "asset", "ETH");
    store.getState().setBlockParam("stake1", "protocol", "etherfi");
    store.getState().setBlockParam("wrap1", "to", "weETH");
    store.getState().setBlockParam("borrow", "allocationBps", 7000);
    store.getState().setBlockParam("supply1", "asset", "weETH");
    expect(encodeShareGraph(store.getState().doc).ok).toBe(true);
    expect(store.getState().setBlockParam("stake1", "protocol", "lido")).toEqual({ ok: true });
    expect(store.getState().rev).toBeGreaterThan(0);
  });

  it("mints only transportable structural defaults from addBlock", () => {
    const store = createComposerStore();
    for (const type of ["input", "stake", "wrap", "unwrap", "lend", "borrow"] as const) {
      const id = store.getState().addBlock(type, { x: 0, y: 0 });
      const block = store.getState().doc.blocks.find((b) => b.id === id)!;
      for (const [key, value] of Object.entries(block.params)) {
        expect(isAllowedParamValue(type, key, value), `${type}.${key}`).toBe(true);
      }
      expect(id.includes(":")).toBe(false);
    }
  });
});

describe("composer store — gesture coalescing and history", () => {
  it("collapses one drag into exactly one undo step", () => {
    const store = seeded();
    const base = store.getState().doc;

    store.getState().beginEdit("set borrow allocation");
    store.getState().beginEdit("ignored while a gesture is open");
    for (let bps = 5000; bps <= 5019; bps += 1) {
      store.getState().setBorrowAllocationBps("borrow", bps);
    }
    store.getState().endEdit();

    expect(store.getState().past).toHaveLength(1);
    expect(selectUndoLabel(store.getState())).toBe("set borrow allocation");
    expect(paramsOf(store.getState().doc, "borrow")["allocationBps"]).toBe(5019);

    store.getState().undo();
    expect(store.getState().doc).toEqual(base);
    expect(store.getState().past).toHaveLength(0);
    expect(selectUndoLabel(store.getState())).toBeNull();
    expect(selectRedoLabel(store.getState())).toBe("set borrow allocation");
  });

  it("leaves no history entry for a gesture that changed nothing", () => {
    const store = seeded();
    store.getState().endEdit(); // no gesture open: a no-op, not a crash
    store.getState().beginEdit("set borrow allocation");
    store.getState().setBorrowAllocationBps("borrow", 7000); // already 7000
    store.getState().endEdit();
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().pendingEdit).toBeNull();
  });

  it("undoes exactly one thing when Ctrl+Z lands mid-gesture", () => {
    const store = seeded();
    store.getState().setBorrowAllocationBps("borrow", 6000);
    const beforeGesture = store.getState().doc;

    store.getState().beginEdit("set borrow allocation");
    store.getState().setBorrowAllocationBps("borrow", 6500);
    store.getState().undo();

    expect(store.getState().doc).toEqual(beforeGesture);
    expect(store.getState().pendingEdit).toBeNull();
    expect(store.getState().past).toHaveLength(1);
  });

  it("drops an untouched open gesture when there is nothing left to undo", () => {
    const store = createComposerStore();
    store.getState().beginEdit("set borrow allocation");
    store.getState().undo();
    expect(store.getState().pendingEdit).toBeNull();
    store.getState().undo();
    store.getState().redo();
    expect(store.getState().doc).toEqual({ blocks: [], edges: [] });
  });

  it("n edits then n undos returns the initial doc; redo restores; a new edit clears future", () => {
    const store = seeded();
    const initial = store.getState().doc;
    for (const bps of [1000, 2000, 3000, 4000]) {
      store.getState().setBorrowAllocationBps("borrow", bps);
    }
    const latest = store.getState().doc;

    for (let i = 0; i < 4; i += 1) store.getState().undo();
    expect(store.getState().doc).toEqual(initial);

    for (let i = 0; i < 4; i += 1) store.getState().redo();
    expect(store.getState().doc).toEqual(latest);

    store.getState().undo();
    expect(store.getState().future).toHaveLength(1);
    store.getState().setBorrowAllocationBps("borrow", 1234);
    expect(store.getState().future).toHaveLength(0);
    expect(selectRedoLabel(store.getState())).toBeNull();
  });

  it("caps history at 50 entries", () => {
    const store = seeded();
    for (let i = 1; i <= 60; i += 1) store.getState().setBorrowAllocationBps("borrow", i * 100);
    expect(store.getState().past).toHaveLength(50);
  });

  it("does not touch view or selection on undo/redo", () => {
    const store = seeded();
    store.getState().moveBlock("borrow", { x: 42, y: 7 });
    store.getState().moveBlock("nope", { x: 1, y: 1 });
    store.getState().setSelection(["borrow", "borrow", "ghost"]);
    expect(store.getState().selectedBlockIds).toEqual(["borrow"]);
    const view = store.getState().view;
    const selection = store.getState().selectedBlockIds;
    store.getState().setSelection(["borrow"]);
    expect(store.getState().selectedBlockIds).toBe(selection);

    store.getState().setBorrowAllocationBps("borrow", 5000);
    store.getState().undo();
    store.getState().redo();

    expect(store.getState().view).toEqual(view);
    expect(store.getState().selectedBlockIds).toEqual(selection);
    expect(store.getState().view["borrow"]).toEqual({ x: 42, y: 7, isAutoInserted: false });
  });

  it("moveBlock does not bump rev or push history", () => {
    const store = seeded();
    const { rev, past } = store.getState();
    store.getState().moveBlock("in", { x: 1, y: 2 });
    expect(store.getState().rev).toBe(rev);
    expect(store.getState().past).toBe(past);
  });
});

describe("composer store — connect, disconnect, remove", () => {
  const cases: ReadonlyArray<readonly [string, string, string, string]> = [
    ["self-loop", "in", "in", "self-loop"],
    ["duplicate edge", "in", "stake1", "duplicate-edge"],
    // A non-cyclic occupied target: "in" is upstream of everything, so the probe
    // passes and the producer arm answers. The cyclic case (supply2 -> wrap2) has
    // its own reasoned test below — disconnecting the producer would not unloop it.
    ["second producer", "in", "wrap2", "target-already-has-producer"],
    ["input as target", "supply2", "in", "input-cannot-consume"],
    ["unknown block", "in", "nope", "unknown-block"],
  ];

  it.each(cases)("rejects %s and leaves the doc unchanged", (_name, source, target, code) => {
    const store = seeded();
    const before = store.getState().doc;
    const result = store.getState().connect(source, target);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe(code);
    expect(store.getState().doc).toBe(before);
  });

  it("answers would-create-cycle even when the target already has a producer", () => {
    // The check-order regression: with the probe behind the single-producer check, this
    // pair reported "disconnect the existing producer" for an edge that closes a loop
    // whatever you disconnect. `wrap2` has a producer (`stake2`) AND supply2 → wrap2
    // would close stake2 → wrap2 → supply2.
    const store = seeded();
    const before = store.getState().doc;
    expect(connectRejection(before, "supply2", "wrap2")).toEqual({ code: "would-create-cycle" });
    expect(store.getState().connect("supply2", "wrap2")).toEqual({
      ok: false,
      rejection: { code: "would-create-cycle" },
    });
    expect(store.getState().doc).toBe(before);
    // …and the producer arm still answers where there is genuinely no cycle.
    expect(connectRejection(before, "wrap1", "supply2")).toEqual({
      code: "target-already-has-producer",
      producerId: "wrap2",
    });
  });

  it("rejects a connection past MAX_EDGES", () => {
    const blocks: Block[] = [{ id: "in", type: "input", params: { asset: "ETH", amount: "1" } }];
    const edges: Edge[] = [];
    for (let i = 0; i < MAX_EDGES; i += 1) {
      blocks.push({ id: `stake${i}`, type: "stake", params: { protocol: "etherfi" } });
      edges.push({ id: `e:stake${i}`, source: "in", target: `stake${i}`, allocationBps: 1 });
    }
    blocks.push({ id: "tail", type: "stake", params: { protocol: "etherfi" } });
    expect(connectRejection({ blocks, edges }, "in", "tail")).toEqual({ code: "edge-limit" });
  });

  it("infers structural params only — never a rate, an LTV or isConfigured", () => {
    const store = createComposerStore();
    const input = store.getState().addBlock("input", { x: 0, y: 0 });
    const stake = store.getState().addBlock("stake", { x: 1, y: 0 });
    const wrap = store.getState().addBlock("wrap", { x: 2, y: 0 });
    const lend = store.getState().addBlock("lend", { x: 3, y: 0 });

    expect(store.getState().setBlockParam(input, "amount", "10")).toEqual({ ok: true });
    expect(store.getState().setBlockParam(stake, "protocol", "etherfi")).toEqual({ ok: true });
    expect(store.getState().connect(input, stake)).toEqual({ ok: true });
    expect(store.getState().connect(stake, wrap)).toEqual({ ok: true });
    expect(store.getState().connect(wrap, lend)).toEqual({ ok: true });

    const doc = store.getState().doc;
    expect(paramsOf(doc, wrap)).toEqual({ from: "eETH", to: "weETH" });
    expect(paramsOf(doc, lend)).toEqual({ protocol: "aave-v3", asset: "weETH" });
    expect(validateGraph(doc).ok).toBe(true);

    // A producer with no routable output (a supply position) and a pair the wrapper set
    // does not cover both infer nothing rather than guessing.
    const orphanWrap = store.getState().addBlock("unwrap", { x: 4, y: 0 });
    expect(store.getState().connect(lend, orphanWrap)).toEqual({ ok: true });
    expect(paramsOf(store.getState().doc, orphanWrap)).toEqual({});
  });

  it("suffixes a minted edge id that a foreign payload already claimed", () => {
    const store = seeded({
      blocks: [
        { id: "in", type: "input", params: { asset: "ETH", amount: "10" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
      ],
      edges: [{ id: "e:supply1", source: "in", target: "stake1", allocationBps: 10_000 }],
    });
    const lend = store.getState().addBlock("lend", { x: 0, y: 0 });
    expect(lend).toBe("supply1");
    expect(store.getState().connect("stake1", lend)).toEqual({ ok: true });
    expect(edgeTo(store.getState().doc, "supply1").id).toBe("e:supply1-2");
  });

  it("removeBlock drops incident edges and never leaves a dangling edge", () => {
    const random = rng(7);
    for (let run = 0; run < 25; run += 1) {
      const store = seeded();
      const ids = store.getState().doc.blocks.map((b) => b.id);
      const victim = ids[Math.floor(random() * ids.length)]!;
      store.getState().removeBlock(victim);
      store.getState().removeBlock("never-existed");
      const doc = store.getState().doc;
      const present = new Set(doc.blocks.map((b) => b.id));
      expect(present.has(victim)).toBe(false);
      for (const e of doc.edges) {
        expect(present.has(e.source)).toBe(true);
        expect(present.has(e.target)).toBe(true);
      }
    }
  });

  it("disconnects one edge, undoably, and ignores an unknown id", () => {
    const store = seeded();
    const before = store.getState().doc;
    store.getState().disconnect("no-such-edge");
    expect(store.getState().doc).toBe(before);
    store.getState().disconnect(edgeTo(before, "borrow").id);
    expect(store.getState().doc.edges).toHaveLength(before.edges.length - 1);
    store.getState().undo();
    expect(store.getState().doc).toEqual(flagshipGraph());
  });

  it("restores a deleted block to the position it was dragged to", () => {
    const store = seeded();
    store.getState().moveBlock("borrow", { x: 99, y: 11 });
    store.getState().removeBlock("borrow");
    store.getState().undo();
    expect(store.getState().doc).toEqual(flagshipGraph());
    expect(store.getState().view["borrow"]).toEqual({ x: 99, y: 11, isAutoInserted: false });
  });

  it("allocates block ids deterministically — identical sequences give identical ids", () => {
    const run = (): readonly string[] => {
      const store = createComposerStore();
      return [
        store.getState().addBlock("stake", { x: 0, y: 0 }),
        store.getState().addBlock("stake", { x: 0, y: 0 }),
        store.getState().addBlock("lend", { x: 0, y: 0 }),
        store.getState().addBlock("borrow", { x: 0, y: 0 }),
      ];
    };
    expect(run()).toEqual(run());
    expect(run()).toEqual(["stake1", "stake2", "supply1", "borrow1"]);
  });
});

describe("composer store — insertRequiredWraps (R9)", () => {
  it("inserts under canonical ids, badges them in the view, and lays the canvas out once", () => {
    const store = seeded(unwrapped());
    store.getState().moveBlock("supply1", { x: 999, y: 999 });
    expect(store.getState().insertRequiredWraps()).toEqual({ inserted: 1 });

    const doc = store.getState().doc;
    const view = store.getState().view;
    expect(store.getState().past).toHaveLength(1);
    expect(validateGraph(doc).ok).toBe(true);
    // Colon-free block ids keep `${blockId}:supply` step ids unambiguous — the optimizer's
    // own `auto-wrap:e:supply1` never reaches the document.
    expect(doc.blocks.every((b) => !b.id.includes(":"))).toBe(true);
    const wrap = doc.blocks.find((b) => b.type === "wrap");
    expect(wrap).toBeDefined();
    if (wrap === undefined) return;
    expect(wrap.id).toBe("wrap1");
    expect(wrap.params).toEqual({ from: "eETH", to: "weETH" });

    // The badge rides the CANONICAL id, so the canvas can render "Auto" at all…
    expect(view[wrap.id]?.isAutoInserted).toBe(true);
    // …one layout generation covers every block, so nothing is dropped on top of a
    // user-dragged node…
    for (const b of doc.blocks) expect(view[b.id], b.id).toBeDefined();
    expect(view["supply1"]).not.toEqual({ x: 999, y: 999, isAutoInserted: false });
    // …and the result survives the share transport byte for byte.
    const round = decodeShareGraph(tokenOf(doc));
    expect(round.ok).toBe(true);
    expect(round.ok && round.graph).toEqual(doc);

    // Idempotent: a second pass inserts nothing, costs no undo step, and the badge holds
    // through later edits and relayouts.
    expect(store.getState().insertRequiredWraps()).toEqual({ inserted: 0 });
    expect(store.getState().past).toHaveLength(1);
    store.getState().setBlockParam("in", "amount", "11");
    store.getState().moveBlock(wrap.id, { x: 5, y: 6 });
    expect(store.getState().view[wrap.id]).toEqual({ x: 5, y: 6, isAutoInserted: true });
  });

  it("is undoable as one entry, badge and all", () => {
    const store = seeded(unwrapped());
    store.getState().insertRequiredWraps();
    expect(selectUndoLabel(store.getState())).toBe("insert required wraps");
    store.getState().undo();
    expect(store.getState().doc).toEqual(unwrapped());
  });
});

describe("composer store — documents all pass core's gate (R2)", () => {
  it("loads a share payload, resets history, and lays the graph out", () => {
    const store = createComposerStore();
    store.getState().addBlock("stake", { x: 0, y: 0 });
    expect(store.getState().past.length).toBeGreaterThan(0);

    expect(store.getState().loadFromShare(tokenOf(flagshipGraph()))).toEqual({ ok: true });
    const state = store.getState();
    expect(state.doc).toEqual(flagshipGraph());
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
    expect(state.loadedFrom).toEqual({ kind: "share-url" });
    expect(state.lastLoadProblem).toBeNull();
    expect(state.selectedBlockIds).toEqual([]);
    for (const b of state.doc.blocks) expect(state.view[b.id], b.id).toBeDefined();
  });

  it("reports a rejected link and never applies part of it", () => {
    const store = seeded();
    const before = store.getState().doc;
    const result = store.getState().loadFromShare(tokenFor(cyclic()));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure?.code).toBe("graph-invalid");
    expect(store.getState().doc).toBe(before);
    expect(store.getState().lastLoadProblem?.code).toBe("graph-invalid");
  });

  it("hydrates a local draft through the SAME pipeline, and rejects a tampered one", () => {
    const token = tokenOf(flagshipGraph());
    const store = createComposerStore();
    expect(store.getState().hydrateLocalDraft(token)).toEqual({ ok: true });
    expect(store.getState().doc).toEqual(flagshipGraph());
    expect(store.getState().loadedFrom).toEqual({ kind: "local-draft" });

    // Same hostile payload, both transports, identical typed rejection.
    const tampered = tokenFor({
      blocks: flagshipGraph().blocks.map((b) =>
        b.id === "supply1"
          ? { ...b, params: { protocol: "aave-v3", asset: "0x000000000000000000000000000000000000dEaD" } }
          : b,
      ),
      edges: flagshipGraph().edges,
    });
    const viaDraft = createComposerStore();
    const viaUrl = createComposerStore();
    const draftResult = viaDraft.getState().hydrateLocalDraft(tampered);
    const urlResult = viaUrl.getState().loadFromShare(tampered);
    expect(draftResult).toEqual(urlResult);
    expect(draftResult.ok).toBe(false);
    expect(viaDraft.getState().doc.blocks).toEqual([]);
    expect(viaDraft.getState().lastLoadProblem?.code).toBe("schema");

    // Byte-level tampering is rejected too, and an absent draft is silence, not an error.
    expect(viaDraft.getState().hydrateLocalDraft(`${token}!!`).ok).toBe(false);
    expect(viaDraft.getState().hydrateLocalDraft(null)).toEqual({ ok: false, failure: null });
    expect(viaDraft.getState().hydrateLocalDraft("")).toEqual({ ok: false, failure: null });
  });

  it("loads every shipped template into a structurally valid, laid-out document", () => {
    const store = createComposerStore();
    expect(STRATEGY_TEMPLATES.length).toBeGreaterThan(0);
    for (const template of STRATEGY_TEMPLATES) {
      expect(store.getState().loadTemplate(template.id), template.id).toBe(true);
      const state = store.getState();
      expect(validateGraph(state.doc).errors, template.id).toEqual([]);
      expect(state.loadedFrom).toEqual({ kind: "template", templateId: template.id });
      expect(state.lastLoadProblem).toBeNull();
      for (const b of state.doc.blocks) expect(state.view[b.id], b.id).toBeDefined();
    }
    expect(store.getState().loadTemplate("no-such-template")).toBe(false);
  });

  it("refuses a template whose graph core rejects — the gate is not skippable", async () => {
    // The template builders take open parameters, so a template load is an untrusted-input
    // path the moment a caller supplies one. Proven by substituting the roster: nothing
    // about "it came from a template" bypasses validateGraph.
    const hostile: StrategyGraph = {
      blocks: [
        { id: "in", type: "input", params: { asset: "ETH", amount: "10" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
      ],
      edges: [{ id: "e:stake1", source: "in", target: "stake1", allocationBps: 12_000 }],
    };
    expect(validateGraph(hostile).ok).toBe(false);

    vi.resetModules();
    vi.doMock("../../lib/strategy/templates", () => ({
      STRATEGY_TEMPLATES: [],
      getTemplate: (id: string) =>
        id === "hostile"
          ? { id, name: "Hostile", summary: "", graph: () => hostile }
          : undefined,
    }));
    const isolated = await import("./composer-store");
    const store = isolated.createComposerStore();
    expect(store.getState().loadTemplate("hostile")).toBe(false);
    expect(store.getState().doc).toEqual({ blocks: [], edges: [] });
    expect(store.getState().lastLoadProblem?.code).toBe("graph-invalid");
    vi.doUnmock("../../lib/strategy/templates");
    vi.resetModules();
  });

  it("clear is undoable and stops claiming the document came from a template", () => {
    const store = seeded();
    store.getState().clear();
    expect(store.getState().doc).toEqual({ blocks: [], edges: [] });
    expect(store.getState().loadedFrom).toEqual({ kind: "blank" });
    const empty = store.getState().doc;
    store.getState().clear();
    expect(store.getState().doc).toBe(empty);
    store.getState().undo();
    expect(store.getState().doc).toEqual(flagshipGraph());
  });
});

describe("composer store — gate, provenance and transport invariants", () => {
  it("disarms the override on any graph mutation and on undo/redo", () => {
    const store = seeded();
    store.getState().armOverride();
    expect(store.getState().overrideGateArmed).toBe(true);
    store.getState().setBorrowAllocationBps("borrow", 5000);
    expect(store.getState().overrideGateArmed).toBe(false);

    store.getState().armOverride();
    store.getState().undo();
    expect(store.getState().overrideGateArmed).toBe(false);
    store.getState().armOverride();
    store.getState().redo();
    expect(store.getState().overrideGateArmed).toBe(false);
    store.getState().armOverride();
    store.getState().loadFromShare(tokenOf(flagshipGraph()));
    expect(store.getState().overrideGateArmed).toBe(false);
  });

  it("exposes no Observed value anywhere in state, and Entered at the display boundary", () => {
    const store = seeded();
    const seen = new Set<unknown>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (Object.hasOwn(value, "kind")) {
        expect((value as { kind: unknown }).kind).not.toBe("observed");
      }
      for (const child of Object.values(value)) walk(child);
    };
    walk(store.getState());

    expect(readInputAmount(store.getState().doc, "in")).toEqual({ kind: "entered", value: "10" });
    expect(readInputAmount(store.getState().doc, "borrow")).toBeNull();
    expect(readInputAmount(store.getState().doc, "nope")).toBeNull();
    expect(readBorrowAllocationBps(store.getState().doc, "borrow")).toEqual({
      kind: "entered",
      value: 7000,
    });
    expect(readBorrowAllocationBps(store.getState().doc, "in")).toBeNull();

    // A numeric transported amount is read losslessly rather than coerced to a float.
    const numeric = seeded(flagshipGraph(100_000));
    expect(readInputAmount(numeric.getState().doc, "in")).toEqual({
      kind: "entered",
      value: "100000",
    });
  });

  it("keeps every state it can reach acyclic, integral and shareable", () => {
    const random = rng(20260725);
    const store = seeded();
    for (let i = 0; i < 200; i += 1) {
      const s = store.getState();
      const pick = Math.floor(random() * 8);
      const blockIds = s.doc.blocks.map((b) => b.id);
      const edgeIds = s.doc.edges.map((e) => e.id);
      const someBlock = blockIds[Math.floor(random() * blockIds.length)];
      const otherBlock = blockIds[Math.floor(random() * blockIds.length)];
      const someEdge = edgeIds[Math.floor(random() * edgeIds.length)];

      if (pick === 0) s.addBlock("stake", { x: random() * 100, y: random() * 100 });
      else if (pick === 1 && someBlock !== undefined) s.removeBlock(someBlock);
      else if (pick === 2) s.setBorrowAllocationBps("borrow", 1 + Math.floor(random() * 10_000));
      else if (pick === 3 && someEdge !== undefined) {
        s.setEdgeAllocationBps(someEdge, 1 + Math.floor(random() * 10_000));
      } else if (pick === 4 && someBlock !== undefined && otherBlock !== undefined) {
        s.connect(someBlock, otherBlock);
      } else if (pick === 5 && someEdge !== undefined) s.disconnect(someEdge);
      else if (pick === 6) s.undo();
      else s.redo();

      const doc = store.getState().doc;
      for (const e of doc.edges) {
        expect(Number.isInteger(e.allocationBps)).toBe(true);
        expect(e.allocationBps).toBeGreaterThanOrEqual(1);
        expect(e.allocationBps).toBeLessThanOrEqual(FULL_ALLOCATION_BPS);
      }
      const ids = doc.blocks.map((b) => b.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(doc.edges.some((e) => e.source === e.target)).toBe(false);
      expect(doc.blocks.every((b) => !b.id.includes(":"))).toBe(true);
      // No single action can make the document cyclic — connectRejection asks core.
      expect(() => topologicalOrder(doc)).not.toThrow();

      // A doc core would accept must survive the transport byte-for-byte.
      if (validateGraph(doc).ok) {
        const round = decodeShareGraph(tokenOf(doc));
        expect(round.ok).toBe(true);
        expect(round.ok && round.graph).toEqual(doc);
      }
    }
  });
});
