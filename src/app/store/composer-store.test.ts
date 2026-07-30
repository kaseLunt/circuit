import { describe, expect, it, vi } from "vitest";
import {
  MAX_EDGES,
  topologicalOrder,
  validateGraph,
  type Block,
  type BlockType,
  type Edge,
  type StrategyGraph,
} from "../../core/graph";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import { provenanceTrailText, valueOf, type Provenanced } from "../../core/provenance";
import { simulate } from "../../core/risk";
import type { SimulationResult } from "../../lib/strategy/types";
import {
  SHARE_VERSION,
  decodeShareGraph,
  encodeShareGraph,
  isAllowedParamValue,
} from "../../lib/share/encode";
import { FLAGSHIP_TEMPLATE_ID, STRATEGY_TEMPLATES } from "../../lib/strategy/templates";
import { FULL_ALLOCATION_BPS } from "../../lib/strategy/types";
import {
  connectRejection,
  createComposerStore,
  edgeAllocationOriginKey,
  overAllocatedSourceIds,
  readBorrowAllocationBps,
  readInputAmount,
  readOutgoingAllocationBps,
  selectGraph,
  selectRedoLabel,
  selectUndoLabel,
  type BlockPosition,
  type ComposerStore,
  type ComposerStoreApi,
  type DocumentActions,
} from "./composer-store";

/**
 * `addBlock` answers null when the write was REFUSED — the T26 run lock is the only refusal
 * there is. Every beat that needs the minted id adds to an unlocked store, so a null here is a
 * broken test rather than a state worth branching on; the lock's own beats assert the null.
 */
function addedBlock(store: ComposerStoreApi, type: BlockType, at: BlockPosition): string {
  const id = store.getState().addBlock(type, at);
  if (id === null) throw new Error(`addBlock refused a ${type} block`);
  return id;
}

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
    expect(readBorrowAllocationBps(store.getState(), "borrow")).toEqual({
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
    const id = addedBlock(store, "lend", { x: 0, y: 0 });
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
      const id = addedBlock(store, type, { x: 0, y: 0 });
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
    const input = addedBlock(store, "input", { x: 0, y: 0 });
    const stake = addedBlock(store, "stake", { x: 1, y: 0 });
    const wrap = addedBlock(store, "wrap", { x: 2, y: 0 });
    const lend = addedBlock(store, "lend", { x: 3, y: 0 });

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
    const orphanWrap = addedBlock(store, "unwrap", { x: 4, y: 0 });
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
    const lend = addedBlock(store, "lend", { x: 0, y: 0 });
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
        addedBlock(store, "stake", { x: 0, y: 0 }),
        addedBlock(store, "stake", { x: 0, y: 0 }),
        addedBlock(store, "lend", { x: 0, y: 0 }),
        addedBlock(store, "borrow", { x: 0, y: 0 }),
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
    expect(viaDraft.getState().hydrateLocalDraft(null)).toEqual({
      ok: false,
      failure: null,
      refusal: null,
    });
    expect(viaDraft.getState().hydrateLocalDraft("")).toEqual({
      ok: false,
      failure: null,
      refusal: null,
    });
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

    expect(readInputAmount(store.getState(), "in")).toEqual({ kind: "entered", value: "10" });
    expect(readInputAmount(store.getState(), "borrow")).toBeNull();
    expect(readInputAmount(store.getState(), "nope")).toBeNull();
    expect(readBorrowAllocationBps(store.getState(), "borrow")).toEqual({
      kind: "entered",
      value: 7000,
    });
    expect(readBorrowAllocationBps(store.getState(), "in")).toBeNull();

    // A numeric transported amount is read losslessly rather than coerced to a float.
    const numeric = seeded(flagshipGraph(100_000));
    expect(readInputAmount(numeric.getState(), "in")).toEqual({
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

      expectCoherentOrigins(store.getState(), `step ${i} (action ${pick})`);
    }
  });
});

/**
 * The generic form of the id-aliasing defect, checkable after ANY action.
 *
 * A `Configured` wrapper does not merely say "an author chose this" — it names the exact
 * constant, so it is a claim that can be checked against that constant's value. Every
 * corruption of this class produced the same signature: a stamp reading
 * `configured FULL_ALLOCATION_BPS` sitting on a 6000- or 5000-bps value. This asserts the
 * claim rather than the mechanism, so it catches the next door as well as the two known
 * ones — it fails on the unfixed `connect` within the randomized walk above.
 */
const CONSTANT_VALUES: Readonly<Record<string, unknown>> = {
  FULL_ALLOCATION_BPS: 10_000,
  DEFAULT_BORROW_ALLOCATION_BPS: 5_000,
  DEFAULT_INPUT_ETH: "10",
};

/**
 * A walk shaped to REACH the aliasing sequence, because the general property test above
 * rarely does: the corruption needs an id to be minted, given a non-default allocation,
 * disconnected, and then minted again for a different edge — four specific actions in
 * order. Weighted toward connect/disconnect/re-allocate/undo so the sequence actually
 * occurs, and verified to fail against the unfixed `connect`.
 */
function expectCoherentOrigins(state: ComposerStore, where: string): void {
  const check = (wrapped: Provenanced<unknown> | null): void => {
    if (wrapped === null || wrapped.kind !== "configured") return;
    expect(Object.keys(CONSTANT_VALUES), `${where}: unknown constant ${wrapped.name}`).toContain(
      wrapped.name,
    );
    // The value MUST be the constant's. Anything else means this stamp was written for a
    // different quantity and drifted onto this one.
    expect(wrapped.value, `${where}: ${wrapped.name} cites ${String(wrapped.value)}`).toEqual(
      CONSTANT_VALUES[wrapped.name],
    );
  };

  for (const block of state.doc.blocks) {
    check(readInputAmount(state, block.id));
    check(readBorrowAllocationBps(state, block.id));
    for (const leg of readOutgoingAllocationBps(state, block.id)?.inputs ?? []) check(leg);
  }
}

describe("composer store — outgoing allocation reaches the display provenanced", () => {
  it("says nothing about a block that routes nothing out", () => {
    const store = seeded();
    const sink = store.getState().doc.blocks.find((b) => b.type === "borrow");
    expect(sink).not.toBeUndefined();
    const outgoing = store
      .getState()
      .doc.edges.filter((e) => e.source === (sink?.id ?? ""));
    if (outgoing.length === 0) {
      expect(readOutgoingAllocationBps(store.getState(), sink?.id ?? "")).toBeNull();
    }
    // An id that is not in the document at all is an absence, never a zero.
    expect(readOutgoingAllocationBps(store.getState(), "nope")).toBeNull();
  });

  it("derives the sum over the entered edge allocations, naming the derivation", () => {
    const store = seeded();
    const doc = store.getState().doc;
    const source = doc.edges[0]?.source ?? "";
    const expected = doc.edges
      .filter((e) => e.source === source)
      .reduce((sum, e) => sum + e.allocationBps, 0);

    const derivedSum = readOutgoingAllocationBps(store.getState(), source);
    expect(derivedSum).not.toBeNull();
    expect(derivedSum?.kind).toBe("derived");
    expect(derivedSum?.value).toBe(expected);
    expect(derivedSum?.expression).toContain(source);
    // Its inputs are the user's own numbers: nothing here can launder one into Observed.
    for (const input of derivedSum?.inputs ?? []) {
      expect(input.kind).toBe("entered");
    }
  });

  it("agrees with overAllocatedSourceIds on every source in the document", () => {
    const store = seeded();
    const first = store.getState().doc.blocks.find((b) => b.type === "input");
    const targets = store
      .getState()
      .doc.blocks.filter((b) => b.type === "lend")
      .map((b) => b.id);
    // Force one source over 100% by splitting it two ways at full allocation each.
    for (const target of targets) store.getState().connect(first?.id ?? "", target);

    const over = new Set(overAllocatedSourceIds(store.getState().doc));
    for (const block of store.getState().doc.blocks) {
      const sum = readOutgoingAllocationBps(store.getState(), block.id);
      const isOver = sum !== null && sum.value > FULL_ALLOCATION_BPS;
      expect(isOver).toBe(over.has(block.id));
    }
  });

  it("follows the document rather than caching it", () => {
    const store = seeded();
    const edge = store.getState().doc.edges[0];
    expect(edge).not.toBeUndefined();
    const source = edge?.source ?? "";
    store.getState().setEdgeAllocationBps(edge?.id ?? "", 3_333);
    expect(readOutgoingAllocationBps(store.getState(), source)?.value).toBe(
      store
        .getState()
        .doc.edges.filter((e) => e.source === source)
        .reduce((sum, e) => sum + e.allocationBps, 0),
    );
  });
});


describe("param origin — Configured until the user touches it (SPEC §5)", () => {
  function flagship(): ComposerStoreApi {
    const store = createComposerStore();
    expect(store.getState().loadTemplate(FLAGSHIP_TEMPLATE_ID)).toBe(true);
    return store;
  }

  it("cites the named constant for a template's untouched allocation, not the user", () => {
    // The defect this exists to prevent: the document holds 5000 the moment the template
    // loads, so wrapping it as `Entered` claims the user chose a number they have never
    // seen a control for.
    const allocation = readBorrowAllocationBps(flagship().getState(), "borrow");
    expect(allocation).toEqual({
      kind: "configured",
      value: 5_000,
      name: "DEFAULT_BORROW_ALLOCATION_BPS",
      definedAt: "src/lib/strategy/templates.ts",
    });
  });

  it("cites the input amount's own constant too", () => {
    expect(readInputAmount(flagship().getState(), "in")).toEqual({
      kind: "configured",
      value: "10",
      name: "DEFAULT_INPUT_ETH",
      definedAt: "src/lib/strategy/templates.ts",
    });
  });

  it("becomes entered after ONE slider move, and stays that way", () => {
    const store = flagship();
    expect(store.getState().setBorrowAllocationBps("borrow", 7000)).toEqual({ ok: true });
    expect(readBorrowAllocationBps(store.getState(), "borrow")).toEqual({
      kind: "entered",
      value: 7000,
    });
  });

  it("does NOT revert origin when undo restores the default VALUE", () => {
    // Value equality is not origin. The user did enter this number; undoing the edit puts
    // the number back, not the ignorance of it. Re-claiming `Configured` here would cite a
    // constant for a figure the user has demonstrably chosen.
    const store = flagship();
    store.getState().setBorrowAllocationBps("borrow", 7000);
    store.getState().undo();

    const doc = store.getState().doc.blocks.find((b) => b.id === "borrow")!;
    expect(doc.params["allocationBps"]).toBe(5_000);
    expect(readBorrowAllocationBps(store.getState(), "borrow")).toEqual({
      kind: "entered",
      value: 5_000,
    });
  });

  it("treats a shared link's numbers as entered — a human chose them", () => {
    const store = seeded(flagshipGraph());
    expect(readBorrowAllocationBps(store.getState(), "borrow")?.kind).toBe("entered");
    expect(readInputAmount(store.getState(), "in")?.kind).toBe("entered");
  });

  it("keeps origin OUT of the document, so share bytes and fixture identity are untouched", () => {
    const template = flagship();
    const edited = flagship();
    edited.getState().setBorrowAllocationBps("borrow", 7000);
    edited.getState().setBorrowAllocationBps("borrow", 5000);

    // Same bytes, different origin: the document cannot carry the distinction, which is
    // precisely why it is tracked beside it.
    expect(edited.getState().doc).toEqual(template.getState().doc);
    expect(readBorrowAllocationBps(edited.getState(), "borrow")?.kind).toBe("entered");
    expect(readBorrowAllocationBps(template.getState(), "borrow")?.kind).toBe("configured");
    for (const block of template.getState().doc.blocks) {
      expect(Object.keys(block.params)).not.toContain("origin");
    }
  });

  it("cites each edge leg's own origin in the outgoing sum", () => {
    const store = flagship();
    const source = store.getState().doc.edges[0]!;
    const sum = readOutgoingAllocationBps(store.getState(), source.source);
    expect(sum?.inputs.every((i) => i.kind === "configured")).toBe(true);

    store.getState().setEdgeAllocationBps(source.id, 6000);
    const afterEdit = readOutgoingAllocationBps(store.getState(), source.source);
    expect(afterEdit?.inputs.every((i) => i.kind === "entered")).toBe(true);
  });

  it("carries the origin into the derivation tree, so the tooltip and the math agree", () => {
    // The finding's other half: a Configured display over an Entered derivation is one
    // number telling two stories.
    const store = flagship();
    const untouched = simulate(
      store.getState().doc,
      fixtureSnapshot(),
      store.getState().paramOrigins,
    );
    expect(trailOf(untouched)).toContain("configured DEFAULT_BORROW_ALLOCATION_BPS");

    store.getState().setBorrowAllocationBps("borrow", 7000);
    const edited = simulate(store.getState().doc, fixtureSnapshot(), store.getState().paramOrigins);
    expect(trailOf(edited)).not.toContain("configured DEFAULT_BORROW_ALLOCATION_BPS");
  });

  it("defaults to entered for a caller that tracks no origins — the live path is unchanged", () => {
    const store = flagship();
    const withOrigins = simulate(store.getState().doc, fixtureSnapshot(), store.getState().paramOrigins);
    const without = simulate(store.getState().doc, fixtureSnapshot());
    expect(trailOf(without)).not.toContain("configured DEFAULT_BORROW_ALLOCATION_BPS");
    // Same numbers either way: origin changes the citation, never the arithmetic.
    expect(valueOf(without.minHealthFactor)).toEqual(valueOf(withOrigins.minHealthFactor));
  });
});

/** Every provenance line behind the health factor, flattened. */
function trailOf(result: SimulationResult): string {
  return provenanceTrailText(result.minHealthFactor).join(" | ");
}


/** Needs a wrap (stake1 emits eETH, supply1 wants weETH) AND carries a partial allocation
 *  the user owns. The inbound edge id is deliberately the one `allocateEdgeId` would hand
 *  the generated outbound edge, which is the aliasing case. */
function partialAndUnwrapped(): StrategyGraph {
  return {
    blocks: [
      { id: "in", type: "input", params: { asset: "ETH", amount: "10" } },
      { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
      { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    ],
    edges: [
      { id: "e0", source: "in", target: "stake1", allocationBps: FULL_ALLOCATION_BPS },
      { id: "e:supply1", source: "stake1", target: "supply1", allocationBps: 6_000 },
    ],
  };
}

describe("param origin — the wrap pass preserves lineage, not just novelty", () => {
  function optimized(): ComposerStoreApi {
    const store = seeded(partialAndUnwrapped());
    expect(store.getState().insertRequiredWraps()).toEqual({ inserted: 1 });
    return store;
  }

  it("keeps a user's partial allocation ENTERED after a wrap lands in front of it", () => {
    // Inserting a wrap does not change whose number 60% is. The inbound replacement carries
    // that exact allocation, so it inherits that edge's origin rather than being treated as
    // something this pass invented.
    const store = optimized();
    const inbound = readOutgoingAllocationBps(store.getState(), "stake1");
    expect(inbound?.value).toBe(6_000);
    expect(inbound?.inputs.map((i) => i.kind)).toEqual(["entered"]);
  });

  it("agrees with the derivation tree about that same 60%", () => {
    // `core/plan.ts` wraps a partial edge allocation as `entered` in its own tree. If the
    // display said "configured", one number would carry two contradictory citations.
    const store = optimized();
    const result = simulate(store.getState().doc, fixtureSnapshot(), store.getState().paramOrigins);
    expect(result.isValid).toBe(true);
    const supplied = result.blockValues["supply1"]?.outputAmountWei;
    if (supplied === undefined || supplied === null) throw new Error("expected a supply value");
    const trail = provenanceTrailText(supplied).join(" | ");
    expect(trail).toContain("floor(producerOutput × 6000 / 10^4)");
    expect(trail).not.toContain("FULL_ALLOCATION_BPS");
  });

  it("cites the configured constant for the generated outbound edge only", () => {
    const store = optimized();
    const outbound = readOutgoingAllocationBps(store.getState(), "wrap1");
    expect(outbound?.value).toBe(FULL_ALLOCATION_BPS);
    expect(outbound?.inputs).toEqual([
      {
        kind: "configured",
        value: FULL_ALLOCATION_BPS,
        name: "FULL_ALLOCATION_BPS",
        definedAt: "src/lib/strategy/types.ts",
      },
    ]);
  });

  it("never gives a generated edge an id the undo stack can restore underneath it", () => {
    // `allocateEdgeId` derives from the target, so the outbound edge wants `e:supply1` —
    // the id the replaced edge already holds on the undo stack. Origins deliberately do not
    // unwind, so reusing it would leave a "configured 100%" stamp sitting on the key undo
    // refills with the user's entered 60%.
    const store = optimized();
    const ids = store.getState().doc.edges.map((e) => e.id);
    expect(ids).not.toContain("e:supply1");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("restores value AND origin coherently when the insert is undone", () => {
    const store = optimized();
    store.getState().undo();

    const restored = store.getState().doc.edges.find((e) => e.source === "stake1");
    expect(restored?.id).toBe("e:supply1");
    expect(restored?.allocationBps).toBe(6_000);
    // The user's number, still theirs — not a constant that does not even hold this value.
    expect(readOutgoingAllocationBps(store.getState(), "stake1")?.inputs).toEqual([
      { kind: "entered", value: 6_000 },
    ]);
  });

  it("never mints an edge id a MULTI-LEVEL undo can restore underneath it", () => {
    /**
     * The reachable-history repro. Two branches so the document stays single-producer and
     * valid; `e:supply1-2` is already taken in the live document, and `e:supply1` is taken
     * only by a document two undos back.
     *
     * Reserving against the current doc plus the immediately replaced ids is NOT enough:
     * `e:supply1` is free at insert time, so the generated outbound edge claims it and
     * stamps the configured constant on that key. Undo the insertion, undo the disconnect,
     * and the user's entered 5000 comes back under a stamp that says "configured
     * FULL_ALLOCATION_BPS" — a named 10000-bps constant citing a 5000-bps value.
     */
    const twoBranches: StrategyGraph = {
      blocks: [
        { id: "in", type: "input", params: { asset: "ETH", amount: "10" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
        { id: "stake2", type: "stake", params: { protocol: "etherfi" } },
        { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
        { id: "supply2", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
      ],
      edges: [
        { id: "e0", source: "in", target: "stake1", allocationBps: 5_000 },
        { id: "e1", source: "in", target: "stake2", allocationBps: 5_000 },
        { id: "e:supply1-2", source: "stake1", target: "supply1", allocationBps: 5_000 },
        { id: "e:supply1", source: "stake2", target: "supply2", allocationBps: 5_000 },
      ],
    };

    const store = seeded(twoBranches);
    const historic = store.getState().doc.edges.map((e) => e.id);
    store.getState().disconnect("e:supply1");
    expect(store.getState().insertRequiredWraps()).toEqual({ inserted: 1 });

    // The generated edge aliased nothing any reachable document holds.
    const generated = store
      .getState()
      .doc.edges.map((e) => e.id)
      .filter((id) => !historic.includes(id));
    expect(generated).not.toContain("e:supply1");
    for (const id of Object.keys(store.getState().paramOrigins)) {
      expect(id).not.toBe(edgeAllocationOriginKey("e:supply1"));
    }

    store.getState().undo(); // the wrap insertion
    store.getState().undo(); // the disconnect

    const restored = store.getState().doc.edges.find((e) => e.id === "e:supply1");
    expect(restored?.allocationBps).toBe(5_000);
    // Value AND origin coherent: the user's number, still attributed to the user.
    expect(readOutgoingAllocationBps(store.getState(), "stake2")?.inputs).toEqual([
      { kind: "entered", value: 5_000 },
    ]);
  });

  it("closes the same hole in connect() — reconnecting must not reuse a historical id", () => {
    /**
     * Codex's second repro, and the reason the reservation rule belongs to every id-minting
     * door rather than to the wrap pass alone: `connect` also stamps a configured origin on
     * the id it mints. Disconnect an edge and reconnect the same endpoints — the live
     * document says `e:supply1` is free, the undo stack does not.
     *
     * This also covers PASTE, which creates every one of its edges through `connect`.
     */
    const store = seeded(partialAndUnwrapped());
    expect(store.getState().doc.edges.some((e) => e.id === "e:supply1")).toBe(true);

    store.getState().disconnect("e:supply1");
    expect(store.getState().connect("stake1", "supply1").ok).toBe(true);

    // The reconnected edge is a NEW edge carrying the store's default, so it gets its own
    // id and its own key rather than moving into the departed edge's.
    const reconnected = store.getState().doc.edges.find((e) => e.source === "stake1");
    expect(reconnected?.id).not.toBe("e:supply1");
    expect(reconnected?.allocationBps).toBe(FULL_ALLOCATION_BPS);
    expect(store.getState().paramOrigins[edgeAllocationOriginKey("e:supply1")]).toBeUndefined();

    store.getState().undo(); // the reconnect
    store.getState().undo(); // the disconnect

    const restored = store.getState().doc.edges.find((e) => e.id === "e:supply1");
    expect(restored?.allocationBps).toBe(6_000);
    expect(readOutgoingAllocationBps(store.getState(), "stake1")?.inputs).toEqual([
      { kind: "entered", value: 6_000 },
    ]);
  });

  it("inherits a CONFIGURED origin as configured — inheritance runs both ways", () => {
    const store = createComposerStore();
    const input = addedBlock(store, "input", { x: 0, y: 0 });
    const stake = addedBlock(store, "stake", { x: 1, y: 0 });
    const lend = addedBlock(store, "lend", { x: 2, y: 0 });
    store.getState().setBlockParam(input, "amount", "10");
    store.getState().setBlockParam(stake, "protocol", "etherfi");
    store.getState().setBlockParam(lend, "asset", "weETH");
    expect(store.getState().connect(input, stake).ok).toBe(true);
    expect(store.getState().connect(stake, lend).ok).toBe(true);
    // `connect` stamps the store's full-allocation default: the user chose to connect, not
    // to allocate.
    expect(store.getState().insertRequiredWraps()).toEqual({ inserted: 1 });

    const inbound = readOutgoingAllocationBps(store.getState(), stake);
    expect(inbound?.inputs.map((i) => i.kind)).toEqual(["configured"]);
  });
});

describe("param origin — the aliasing class stays closed at every id-minting door", () => {
  /**
   * A random walk almost never reaches this: the corruption needs FIVE specific actions in
   * order on the same target (mint an id, give it a non-default allocation, disconnect it,
   * mint again, then unwind past the reuse). So the sweep is deterministic — it drives that
   * shape at every door that mints an id, then UNWINDS THE WHOLE HISTORY, asserting origin
   * coherence at every level.
   *
   * Unwinding completely is the part that generalises: `paramOrigins` does not travel with
   * undo, so every document the stack can produce is a document a stale stamp could land
   * on. Checking one level deep is what let this class survive two rounds of fixes.
   */
  function driveAndUnwind(store: ComposerStoreApi, label: string): void {
    expectCoherentOrigins(store.getState(), `${label}: before unwinding`);
    for (let depth = 0; selectUndoLabel(store.getState()) !== null && depth < 100; depth += 1) {
      store.getState().undo();
      expectCoherentOrigins(store.getState(), `${label}: ${depth + 1} undo(s) deep`);
    }
    // And forward again: redo restores documents too.
    for (let depth = 0; selectRedoLabel(store.getState()) !== null && depth < 100; depth += 1) {
      store.getState().redo();
      expectCoherentOrigins(store.getState(), `${label}: redo ${depth + 1}`);
    }
  }

  it("survives disconnect → reconnect → unwind at connect()", () => {
    const store = seeded(partialAndUnwrapped());
    store.getState().disconnect("e:supply1");
    expect(store.getState().connect("stake1", "supply1").ok).toBe(true);
    store.getState().setEdgeAllocationBps(
      store.getState().doc.edges.find((e) => e.source === "stake1")!.id,
      4_200,
    );
    driveAndUnwind(store, "connect");
  });

  it("survives mint → re-allocate → disconnect → mint again → unwind", () => {
    // The full five-action shape, on one target, at the connect door.
    const store = seeded(partialAndUnwrapped());
    store.getState().disconnect("e:supply1");
    expect(store.getState().connect("stake1", "supply1").ok).toBe(true);
    const first = store.getState().doc.edges.find((e) => e.source === "stake1")!.id;
    store.getState().setEdgeAllocationBps(first, 6_000);
    store.getState().disconnect(first);
    expect(store.getState().connect("stake1", "supply1").ok).toBe(true);
    driveAndUnwind(store, "remint");
  });

  it("survives the wrap pass, whose ids are minted by a different door", () => {
    const store = seeded(partialAndUnwrapped());
    expect(store.getState().insertRequiredWraps()).toEqual({ inserted: 1 });
    driveAndUnwind(store, "wrap pass");
  });

  it("survives a template arrival followed by edits and a full unwind", () => {
    const store = createComposerStore();
    expect(store.getState().loadTemplate(FLAGSHIP_TEMPLATE_ID)).toBe(true);
    store.getState().setBorrowAllocationBps("borrow", 7_000);
    store.getState().setBlockParam("in", "amount", "3.5");
    const edge = store.getState().doc.edges[0]!;
    store.getState().setEdgeAllocationBps(edge.id, 8_000);
    store.getState().disconnect(edge.id);
    driveAndUnwind(store, "template");
  });
});

/**
 * T26's write lock, at the boundary that enforces it (Codex round-3 finding 2).
 *
 * The claim under test is not "the palette honours the lock" — that was the claim that failed
 * review, because the template rows, Clear canvas and every canvas gesture each carried their
 * own opinion about it. What is asserted here is the STRUCTURE: every document-mutating action
 * refuses on its own, so a control that forgets the lock cannot change the document.
 *
 * The sentence is arbitrary on purpose. The store is handed one and never mints, edits or
 * interprets it; that `RUN_LOCK_REASON` is the sentence the UI hands over is proven where the
 * hand-over happens (`src/components/composer/composer.test.tsx`, `step-status.test.ts`).
 */
const HELD_BY_A_RUN = "a run holds the document";

/**
 * Every DOCUMENT write, as an attempt and the refusal it must answer with.
 *
 * Keyed on `DocumentActions`, so a new document action is a COMPILE ERROR here until this
 * suite attempts it under the lock — the test-side half of the totality `lockGuarded` enforces
 * in the store. A refusal nobody attempts is exactly the shape this finding was about.
 */
const LOCKED_WRITES: {
  readonly [K in keyof DocumentActions]: (store: ComposerStoreApi) => void;
} = {
  addBlock: (s) => {
    // Null, never a fabricated id: a caller handed an id would go on to configure it.
    expect(s.getState().addBlock("stake", { x: 0, y: 0 })).toBeNull();
  },
  removeBlock: (s) => s.getState().removeBlock("borrow"),
  setBlockParam: (s) => {
    expect(s.getState().setBlockParam("in", "amount", "999")).toEqual({
      ok: false,
      reason: HELD_BY_A_RUN,
    });
  },
  setBorrowAllocationBps: (s) => {
    expect(s.getState().setBorrowAllocationBps("borrow", 1234)).toEqual({
      ok: false,
      reason: HELD_BY_A_RUN,
    });
  },
  setEdgeAllocationBps: (s) => {
    expect(s.getState().setEdgeAllocationBps(edgeTo(s.getState().doc, "wrap1").id, 4000)).toEqual({
      ok: false,
      reason: HELD_BY_A_RUN,
    });
  },
  connect: (s) => {
    // The lock is not a property of the graph, so the refusal carries the holder's own
    // sentence rather than copy the canvas restates.
    expect(s.getState().connect("supply2", "borrow")).toEqual({
      ok: false,
      rejection: { code: "document-locked", reason: HELD_BY_A_RUN },
    });
  },
  disconnect: (s) => s.getState().disconnect(edgeTo(s.getState().doc, "wrap1").id),
  insertRequiredWraps: (s) => {
    expect(s.getState().insertRequiredWraps()).toEqual({ inserted: 0 });
  },
  beginEdit: (s) => s.getState().beginEdit("locked gesture"),
  endEdit: (s) => s.getState().endEdit(),
  loadTemplate: (s) => {
    expect(s.getState().loadTemplate(FLAGSHIP_TEMPLATE_ID)).toBe(false);
  },
  loadFromShare: (s) => {
    expect(s.getState().loadFromShare(tokenOf(flagshipGraph(20, 5000)))).toEqual({
      ok: false,
      failure: null,
      refusal: HELD_BY_A_RUN,
    });
  },
  hydrateLocalDraft: (s) => {
    expect(s.getState().hydrateLocalDraft(tokenOf(flagshipGraph(20, 5000)))).toEqual({
      ok: false,
      failure: null,
      refusal: HELD_BY_A_RUN,
    });
  },
  clear: (s) => s.getState().clear(),
  undo: (s) => s.getState().undo(),
  redo: (s) => s.getState().redo(),
  moveBlock: (s) => s.getState().moveBlock("borrow", { x: 999, y: 999 }),
};

/** The actions the lock leaves alone, named so the classification above is total. */
const VIEW_ACTIONS: readonly string[] = ["setSelection", "armOverride", "setWriteLock"];

describe("composer store — T26 write lock (one boundary, no control can forget)", () => {
  it("refuses every document write, and the document is untouched afterwards", () => {
    const store = seeded();
    // Something in every stack, so a refused undo/redo has somewhere to go wrong.
    expect(store.getState().setBorrowAllocationBps("borrow", 6000)).toEqual({ ok: true });
    store.getState().undo();
    store.getState().setSelection(["borrow"]);
    store.getState().setWriteLock(HELD_BY_A_RUN);

    const before = store.getState();
    for (const attempt of Object.values(LOCKED_WRITES)) attempt(store);
    const after = store.getState();

    // Reference identity, not deep equality: a refused write must not even rebuild the doc.
    expect(after.doc).toBe(before.doc);
    expect(after.rev).toBe(before.rev);
    expect(after.past).toBe(before.past);
    expect(after.future).toBe(before.future);
    expect(after.view).toBe(before.view);
    expect(after.paramOrigins).toBe(before.paramOrigins);
    expect(after.loadedFrom).toBe(before.loadedFrom);
    expect(after.lastLoadProblem).toBe(before.lastLoadProblem);
    // A refused `beginEdit` leaves no half-open gesture to suppress the next history entry.
    expect(after.pendingEdit).toBeNull();
    expect(after.writeLock).toBe(HELD_BY_A_RUN);
  });

  it("classifies EVERY action: a document write is guarded, anything else is named", () => {
    const store = createComposerStore();
    const dispatched = Object.entries(store.getState())
      .filter(([, value]) => typeof value === "function")
      .map(([key]) => key);
    // A new action fails this until it is either attempted under the lock above or named a
    // view action — the same decision `lockGuarded` forces on the store side.
    expect(dispatched.sort()).toEqual([...Object.keys(LOCKED_WRITES), ...VIEW_ACTIONS].sort());
  });

  it("keeps reads and selection live — a frozen document is not a hidden one", () => {
    const store = seeded();
    store.getState().setWriteLock(HELD_BY_A_RUN);

    store.getState().setSelection(["borrow", "supply1"]);
    expect(store.getState().selectedBlockIds).toEqual(["borrow", "supply1"]);
    store.getState().armOverride();
    expect(store.getState().overrideGateArmed).toBe(true);

    // Every provenanced reader still answers, over the frozen document.
    const amount = readInputAmount(store.getState(), "in");
    const allocation = readBorrowAllocationBps(store.getState(), "borrow");
    expect(amount === null ? null : valueOf(amount)).toBe("10");
    expect(allocation === null ? null : valueOf(allocation)).toBe(7000);
    expect(readOutgoingAllocationBps(store.getState(), "stake1")).not.toBeNull();
    expect(selectGraph(store.getState())).toBe(store.getState().doc);
    expect(overAllocatedSourceIds(store.getState().doc)).toEqual([]);
    expect(connectRejection(store.getState().doc, "in", "in")).toEqual({ code: "self-loop" });
  });

  it("lifts on release: the same writes land once the run reaches a terminal state", () => {
    const store = seeded();
    store.getState().setWriteLock(HELD_BY_A_RUN);
    expect(store.getState().setBorrowAllocationBps("borrow", 5500).ok).toBe(false);

    // What `runLocksDocument` reports at a terminal phase, handed over as null.
    store.getState().setWriteLock(null);
    expect(store.getState().writeLock).toBeNull();
    expect(store.getState().setBorrowAllocationBps("borrow", 5500)).toEqual({ ok: true });
    expect(paramsOf(store.getState().doc, "borrow")["allocationBps"]).toBe(5500);
    expect(addedBlock(store, "lend", { x: 0, y: 0 })).toBe("supply3");
    expect(store.getState().loadTemplate(FLAGSHIP_TEMPLATE_ID)).toBe(true);
  });

  it("closes an open gesture as the lock engages, so undo recording survives the run", () => {
    const store = seeded();
    store.getState().beginEdit("set borrow allocation");
    expect(store.getState().setBorrowAllocationBps("borrow", 6000)).toEqual({ ok: true });
    const depth = store.getState().past.length;

    store.getState().setWriteLock(HELD_BY_A_RUN);
    // The gesture is closed WITH its history entry: a `pendingEdit` left standing across a run
    // silently stops the store pushing to `past` for the rest of the session.
    expect(store.getState().pendingEdit).toBeNull();
    expect(store.getState().past.length).toBe(depth + 1);
    expect(selectUndoLabel(store.getState())).toBe("set borrow allocation");

    store.getState().setWriteLock(null);
    expect(store.getState().setBorrowAllocationBps("borrow", 6100)).toEqual({ ok: true });
    expect(store.getState().past.length).toBe(depth + 2);
    store.getState().undo();
    expect(paramsOf(store.getState().doc, "borrow")["allocationBps"]).toBe(6000);
  });

  it("is idempotent, and a re-lock after a release refuses again", () => {
    const store = seeded();
    const initial = store.getState();
    // Setting the lock it already holds is not a state change (zustand compares by reference).
    store.getState().setWriteLock(null);
    expect(store.getState()).toBe(initial);
    store.getState().setWriteLock(HELD_BY_A_RUN);
    store.getState().setWriteLock(HELD_BY_A_RUN);
    expect(store.getState().writeLock).toBe(HELD_BY_A_RUN);
    store.getState().setWriteLock(null);
    store.getState().setWriteLock("held again");
    expect(store.getState().setBlockParam("in", "amount", "3")).toEqual({
      ok: false,
      reason: "held again",
    });
  });
});
