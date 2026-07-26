/** @vitest-environment jsdom */
// Wiring-level only: no <ReactFlow> is mounted, because a canvas that needs a layout
// engine and a ResizeObserver to answer "does the affordance agree with the store" is
// answering a different question. What IS asserted here is everything the canvas claims
// in its own comments and cannot claim from a component render: the doc→view mapping, the
// refusal path, the clipboard rules, the one-undo gestures and the bar's geometry rule.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  CONNECT_REJECTION_MESSAGES,
  ConnectionRejectionNotice,
  NODE_TYPE_FOR,
  allocationEdgesOf,
  blockDataOf,
  blockLabelsOf,
  blockParamErrors,
  buildClipboard,
  deleteSelectedBlocks,
  loadAnnouncement,
  makeIsValidConnection,
  pasteClipboard,
  rejectionFromConnectionEnd,
  selectionBarPosition,
} from "./canvas";
import { CanvasEmptyState } from "./canvas-empty-state";
import { BLOCK_COMPONENTS } from "./blocks";
import { ComposerStoreProvider } from "../../app/store/composer-provider";
import { connectRejection, createComposerStore } from "../../app/store/composer-store";
import { FLAGSHIP_TEMPLATE_ID, STRATEGY_TEMPLATES } from "../../lib/strategy/templates";
import type { ConnectRejection } from "../../app/store/composer-store";
import type { StrategyGraph } from "../../core/graph";

afterEach(cleanup);

const ALL_CODES: readonly ConnectRejection["code"][] = [
  "unknown-block",
  "self-loop",
  "duplicate-edge",
  "edge-limit",
  "input-cannot-consume",
  "would-create-cycle",
  "target-already-has-producer",
];

function restaked() {
  const store = createComposerStore();
  expect(store.getState().loadTemplate("restake")).toBe(true);
  return store;
}

/** The 13-step loop — the only template carrying every block type and several edges. */
function flagship() {
  const store = createComposerStore();
  expect(store.getState().loadTemplate(FLAGSHIP_TEMPLATE_ID)).toBe(true);
  return store;
}

describe("connection rejection notice", () => {
  it("exists before its first message, so a refusal is a text change and not a mount", () => {
    const { container } = render(<ConnectionRejectionNotice rejection={null} />);
    // The strip stays mounted with its text swapped: a live element created together with
    // its content is the pattern assistive technology misses.
    expect(container.firstElementChild).not.toBeNull();
    expect(container.textContent).toBe("");
    expect(container.querySelector(".opacity-0")).not.toBeNull();
  });

  it("shows the sentence for the code it was given", () => {
    const { container } = render(
      <ConnectionRejectionNotice
        rejection={{ code: "target-already-has-producer", producerId: "supply1" }}
      />,
    );
    expect(container.textContent).toBe("This block already has an input. Disconnect it first.");
    expect(container.querySelector(".opacity-100")).not.toBeNull();
  });

  it("leaves announcing to the canvas's one live region", () => {
    const { container } = render(
      <ConnectionRejectionNotice rejection={{ code: "self-loop" }} />,
    );
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("carries one declarative sentence per code — every code, no exceptions", () => {
    // Totality rather than a byte-copy of the table: restating the strings here makes the
    // assertion a tautology that only fails when someone edits it in two places.
    const codes = Object.keys(CONNECT_REJECTION_MESSAGES);
    expect(codes.sort()).toEqual([...ALL_CODES].sort());
    for (const code of ALL_CODES) {
      const copy = CONNECT_REJECTION_MESSAGES[code];
      expect(copy.length).toBeGreaterThan(0);
      expect(copy.endsWith(".")).toBe(true);
    }
  });

  it("never blames the user's data: no rejection copy mentions an error or a failure", () => {
    for (const code of ALL_CODES) {
      const copy = CONNECT_REJECTION_MESSAGES[code].toLowerCase();
      expect(copy.includes("error")).toBe(false);
      expect(copy.includes("invalid")).toBe(false);
      expect(copy.includes("fail")).toBe(false);
    }
  });
});

describe("isValidConnection agrees with the store", () => {
  it("accepts exactly the pairs connectRejection accepts", () => {
    const store = restaked();
    // A loose block, so the graph has at least one connectable pair to disagree about.
    store.getState().addBlock("lend", { x: 640, y: 0 });

    const doc = store.getState().doc;
    const isValid = makeIsValidConnection(doc);
    const ids = doc.blocks.map((b) => b.id);
    const accepted: string[] = [];

    for (const source of ids) {
      for (const target of ids) {
        const allowed = connectRejection(doc, source, target) === null;
        expect(isValid({ source, target, sourceHandle: null, targetHandle: null })).toBe(allowed);
        if (allowed) accepted.push(`${source}->${target}`);
      }
    }

    expect(accepted.length).toBeGreaterThan(0);
    const lendId = doc.blocks.filter((b) => b.type === "lend").map((b) => b.id)[0];
    expect(lendId).not.toBeUndefined();
    expect(accepted).toContain(`stake1->${lendId ?? ""}`);
  });

  it("refuses a self-loop and a duplicate edge through the same predicate", () => {
    const doc = restaked().getState().doc;
    const isValid = makeIsValidConnection(doc);

    expect(isValid({ source: "in", target: "in", sourceHandle: null, targetHandle: null })).toBe(
      false,
    );
    expect(
      isValid({ source: "in", target: "stake1", sourceHandle: null, targetHandle: null }),
    ).toBe(false);
  });
});

describe("the refusal strip has a runtime trigger", () => {
  // `isValidConnection` IS `connectRejection`, so React Flow never calls onConnect for a
  // pair the store would refuse: without this path the strip is unreachable dead code.
  it("recovers the reason from the end of a refused gesture", () => {
    const doc = restaked().getState().doc;
    expect(
      rejectionFromConnectionEnd(doc, {
        isValid: false,
        fromNode: { id: "in" },
        toNode: { id: "stake1" },
      }),
    ).toEqual({ code: "duplicate-edge" });
  });

  it("reports nothing for a release over empty canvas", () => {
    const doc = restaked().getState().doc;
    expect(
      rejectionFromConnectionEnd(doc, { isValid: false, fromNode: { id: "in" }, toNode: null }),
    ).toBeNull();
  });

  it("reports nothing when the drop was permitted — onConnect owns that outcome", () => {
    const store = restaked();
    const lendId = store.getState().addBlock("lend", { x: 640, y: 0 });
    expect(
      rejectionFromConnectionEnd(store.getState().doc, {
        isValid: true,
        fromNode: { id: "stake1" },
        toNode: { id: lendId },
      }),
    ).toBeNull();
  });
});

describe("the doc → view-model mapping", () => {
  it("registers a component for every block type core can put in a document", () => {
    for (const nodeType of Object.values(NODE_TYPE_FOR)) {
      expect(Object.hasOwn(BLOCK_COMPONENTS, nodeType)).toBe(true);
    }
    // wrap and unwrap are ONE renderable family; the direction rides isWrap.
    expect(NODE_TYPE_FOR.wrap).toBe("auto-wrap");
    expect(NODE_TYPE_FOR.unwrap).toBe("auto-wrap");
  });

  it("folds core's wrap and unwrap into the auto-wrap family with a direction", () => {
    const doc: StrategyGraph = {
      blocks: [
        { id: "w1", type: "wrap", params: { from: "eETH", to: "weETH" } },
        { id: "u1", type: "unwrap", params: { from: "weETH", to: "eETH" } },
      ],
      edges: [],
    };
    const wrap = blockDataOf(doc, doc.blocks[0]!, undefined);
    const unwrap = blockDataOf(doc, doc.blocks[1]!, undefined);

    expect(wrap.type).toBe("auto-wrap");
    expect(unwrap.type).toBe("auto-wrap");
    expect(wrap.type === "auto-wrap" && wrap.isWrap).toBe(true);
    expect(unwrap.type === "auto-wrap" && unwrap.isWrap).toBe(false);
    expect(wrap.type === "auto-wrap" && wrap.fromAsset).toBe("eETH");
    expect(wrap.type === "auto-wrap" && wrap.toAsset).toBe("weETH");
    expect(wrap.isConfigured).toBe(true);
  });

  it("reads the amount the document holds, and calls an empty one unconfigured", () => {
    const store = restaked();
    const doc = store.getState().doc;
    const input = doc.blocks.find((b) => b.type === "input");
    expect(input).not.toBeUndefined();
    const configured = blockDataOf(doc, input!, undefined);
    expect(configured.isConfigured).toBe(true);
    expect(configured.type === "input" && configured.amount.length).toBeGreaterThan(0);

    const empty: StrategyGraph = {
      blocks: [{ id: "in", type: "input", params: { asset: "ETH" } }],
      edges: [],
    };
    const unset = blockDataOf(empty, empty.blocks[0]!, "input needs a positive amount");
    expect(unset.isConfigured).toBe(false);
    // Unconfigured is NOT invalid: core's complaint about an unset param is the expected
    // reading of an empty control, and the block renders that as its own state.
    expect(unset.isValid).toBe(true);
    expect(unset.errorMessage).toBeUndefined();
    expect(unset.type === "input" && unset.amount).toBe("");
  });

  it("surfaces core's own words once a configured block is actually refused", () => {
    const doc: StrategyGraph = {
      blocks: [{ id: "in", type: "input", params: { asset: "ETH", amount: "0" } }],
      edges: [],
    };
    const errors = blockParamErrors(doc);
    expect(errors["in"]).toBe("input needs a positive amount");
    const data = blockDataOf(doc, doc.blocks[0]!, errors["in"]);
    expect(data.isValid).toBe(false);
    expect(data.errorMessage).toBe("input needs a positive amount");
  });

  it("keeps a block's structural complaints out of its error state", () => {
    // "must have exactly one producer" is a fact about the GRAPH. Folding it in would
    // paint every freshly dropped block destructive before the user could connect it.
    const doc: StrategyGraph = {
      blocks: [
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
      ],
      edges: [],
    };
    expect(blockParamErrors(doc)["stake1"]).toBeUndefined();
    expect(blockDataOf(doc, doc.blocks[1]!, undefined).isValid).toBe(true);
  });

  it("never invents a borrow allocation the document does not hold", () => {
    const doc: StrategyGraph = {
      blocks: [{ id: "b1", type: "borrow", params: { protocol: "aave-v3", asset: "WETH" } }],
      edges: [],
    };
    const data = blockDataOf(doc, doc.blocks[0]!, undefined);
    expect(data.isConfigured).toBe(false);
    // The number on the node is the slider's resting position, and the block prints the
    // allocation from the store's provenanced reader — which is null until one is entered.
    expect(data.type === "borrow" && data.allocationBps).toBe(100);
  });

  it("hands every edge the names the canvas shows, never the store's ids", () => {
    const doc = flagship().getState().doc;
    const labels = blockLabelsOf(doc, blockParamErrors(doc));
    const edges = allocationEdgesOf(doc.edges, labels, new Set());

    expect(edges.length).toBeGreaterThan(0);
    const ids = new Set(doc.blocks.map((b) => b.id));
    for (const edge of edges) {
      // The popover prints these three ways — row, trigger name and dialog name — so an
      // id here reads as "Out of supply1" beside a block the canvas calls Supply.
      expect(edge.data?.sourceLabel).toBe(labels[edge.source]);
      expect(edge.data?.targetLabel).toBe(labels[edge.target]);
      expect(ids.has(edge.data?.sourceLabel ?? "")).toBe(false);
      expect(ids.has(edge.data?.targetLabel ?? "")).toBe(false);
    }
  });

  it("labels a block with the same title blockDataOf gives its component", () => {
    const doc = flagship().getState().doc;
    const labels = blockLabelsOf(doc, blockParamErrors(doc));

    expect(Object.keys(labels).sort()).toEqual(doc.blocks.map((b) => b.id).sort());
    for (const block of doc.blocks) {
      expect(labels[block.id]).toBe(blockDataOf(doc, block, undefined).label);
    }
    expect(Object.values(labels)).toContain("Supply");
  });
});

describe("the selection action bar anchors to real geometry", () => {
  const viewport = { x: 0, y: 0, zoom: 1 };

  it("draws nothing until at least two blocks are selected", () => {
    const nodes = [{ id: "a", position: { x: 0, y: 0 }, measured: { width: 240, height: 120 } }];
    expect(selectionBarPosition(nodes, new Set(["a"]), viewport)).toBeNull();
  });

  it("refuses to guess: no measurement, no bar", () => {
    const nodes = [
      { id: "a", position: { x: 0, y: 0 }, measured: { width: 240, height: 120 } },
      { id: "b", position: { x: 320, y: 0 }, measured: undefined },
    ];
    expect(selectionBarPosition(nodes, new Set(["a", "b"]), viewport)).toBeNull();
  });

  it("centres under the selection's box, in screen space", () => {
    const nodes = [
      { id: "a", position: { x: 0, y: 0 }, measured: { width: 240, height: 100 } },
      { id: "b", position: { x: 360, y: 40 }, measured: { width: 240, height: 100 } },
    ];
    expect(selectionBarPosition(nodes, new Set(["a", "b"]), { x: 10, y: 20, zoom: 0.5 })).toEqual({
      x: (0 + 600) / 2 / 2 + 10,
      y: 140 * 0.5 + 20,
    });
  });
});

describe("the clipboard", () => {
  it("excludes the input block — a strategy has exactly one", () => {
    const store = restaked();
    store.getState().setSelection(store.getState().doc.blocks.map((b) => b.id));
    const snapshot = buildClipboard(store.getState());
    expect(snapshot).not.toBeNull();
    expect(snapshot?.droppedInput).toBe(true);
    expect(snapshot?.blocks.some((b) => b.type === "input")).toBe(false);
  });

  it("refuses to mint an empty snapshot, so a good copy is never clobbered", () => {
    const store = restaked();
    const input = store.getState().doc.blocks.find((b) => b.type === "input");
    store.getState().setSelection([input?.id ?? ""]);
    expect(buildClipboard(store.getState())).toBeNull();
    store.getState().setSelection([]);
    expect(buildClipboard(store.getState())).toBeNull();
  });

  it("pastes as ONE undo entry, not one per block", () => {
    const store = restaked();
    store.getState().setSelection(store.getState().doc.blocks.map((b) => b.id));
    const snapshot = buildClipboard(store.getState());
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    const before = store.getState().doc.blocks.length;
    const history = store.getState().past.length;
    const created = pasteClipboard(store, snapshot);

    expect(created.length).toBe(snapshot.blocks.length);
    expect(store.getState().doc.blocks.length).toBe(before + created.length);
    expect(store.getState().past.length).toBe(history + 1);

    store.getState().undo();
    expect(store.getState().doc.blocks.length).toBe(before);
  });
});

describe("deleting a selection", () => {
  it("costs one undo however many blocks it removes", () => {
    const store = createComposerStore();
    expect(store.getState().loadTemplate(FLAGSHIP_TEMPLATE_ID)).toBe(true);
    const doomed = store.getState().doc.blocks.filter((b) => b.type !== "input").map((b) => b.id);
    expect(doomed.length).toBeGreaterThan(1);
    store.getState().setSelection(doomed);

    const before = store.getState().doc.blocks.length;
    const history = store.getState().past.length;
    expect(deleteSelectedBlocks(store).length).toBe(doomed.length);

    expect(store.getState().doc.blocks.length).toBe(before - doomed.length);
    expect(store.getState().past.length).toBe(history + 1);
    store.getState().undo();
    expect(store.getState().doc.blocks.length).toBe(before);
  });

  it("does nothing, and records nothing, with an empty selection", () => {
    const store = restaked();
    const history = store.getState().past.length;
    expect(deleteSelectedBlocks(store)).toEqual([]);
    expect(store.getState().past.length).toBe(history);
  });
});

describe("a drag is not a document edit", () => {
  it("moves a block without bumping rev — the risk projection's memo must not invalidate", () => {
    const store = restaked();
    const id = store.getState().doc.blocks[0]?.id ?? "";
    const rev = store.getState().rev;
    const history = store.getState().past.length;

    store.getState().beginEdit("move block");
    store.getState().moveBlock(id, { x: 42, y: 84 });
    store.getState().endEdit();

    expect(store.getState().rev).toBe(rev);
    expect(store.getState().past.length).toBe(history);
    expect(store.getState().view[id]).toMatchObject({ x: 42, y: 84 });
  });
});

describe("load announcements", () => {
  it("names the template it opened", () => {
    expect(loadAnnouncement({ kind: "template", templateId: FLAGSHIP_TEMPLATE_ID })).toContain(
      "Leveraged Restake Loop",
    );
  });

  it("says something for every arrival, including a cleared canvas", () => {
    for (const from of [
      { kind: "blank" } as const,
      { kind: "share-url" } as const,
      { kind: "local-draft" } as const,
      { kind: "template", templateId: "no-such-template" } as const,
    ]) {
      expect(loadAnnouncement(from).length).toBeGreaterThan(0);
    }
    expect(loadAnnouncement({ kind: "blank" })).toContain("cleared");
  });
});

describe("empty state template cards", () => {
  it("loads each template into the document", () => {
    for (const [index, template] of STRATEGY_TEMPLATES.entries()) {
      const store = createComposerStore();
      render(
        <ComposerStoreProvider store={store}>
          <CanvasEmptyState />
        </ComposerStoreProvider>,
      );
      const card = screen.getAllByRole("button")[index];
      expect(card).not.toBeUndefined();
      // `continue`, not `return`: a `return` here would exit the whole test having
      // asserted nothing about the templates after the missing one.
      if (card === undefined) continue;
      fireEvent.click(card);

      const state = store.getState();
      expect(state.loadedFrom).toEqual({ kind: "template", templateId: template.id });
      expect(state.doc.blocks.map((b) => b.id)).toEqual(template.graph().blocks.map((b) => b.id));
      // Positions are recomputed, never transported: every loaded block has a coordinate.
      for (const block of state.doc.blocks) {
        expect(state.view[block.id]).not.toBeUndefined();
      }
      cleanup();
    }
  });

  it("opens the flagship from its own card", () => {
    const store = createComposerStore();
    render(
      <ComposerStoreProvider store={store}>
        <CanvasEmptyState />
      </ComposerStoreProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Leveraged Restake Loop/ }));
    expect(store.getState().loadedFrom).toEqual({
      kind: "template",
      templateId: FLAGSHIP_TEMPLATE_ID,
    });
  });

  it("quotes no yield anywhere on the cards", () => {
    const store = createComposerStore();
    const { container } = render(
      <ComposerStoreProvider store={store}>
        <CanvasEmptyState />
      </ComposerStoreProvider>,
    );
    const text = container.textContent ?? "";
    expect(text.includes("%")).toBe(false);
    expect(text.toUpperCase().includes("APY")).toBe(false);
    expect(text.toUpperCase().includes("APR")).toBe(false);
  });

  it("rings the card the user perceives, not the button inside it", () => {
    const store = createComposerStore();
    render(
      <ComposerStoreProvider store={store}>
        <CanvasEmptyState />
      </ComposerStoreProvider>,
    );
    for (const card of screen.getAllByRole("button")) {
      // The wrapper carries the border, the surface and the hover, and the button covers
      // only its top: a ring on the button alone outlines part of what looks like the
      // control. One gesture, one ring — so the button keeps its outline off.
      const frame = card.parentElement;
      expect(frame?.className).toContain("focus-ring-within");
      expect(frame?.className).toContain("border-border");
      expect(card.className).toContain("outline-none");
      expect(card.className).not.toContain("focus-ring");
    }
  });

  it("describes each card with its summary instead of folding it into the name", () => {
    const store = createComposerStore();
    render(
      <ComposerStoreProvider store={store}>
        <CanvasEmptyState />
      </ComposerStoreProvider>,
    );
    const cards = screen.getAllByRole("button");
    for (const [index, template] of STRATEGY_TEMPLATES.entries()) {
      const summary = document.getElementById(`template-summary-${template.id}`);
      expect(summary?.textContent).toBe(template.summary);
      // Outside the button: a described element that is also a descendant is read twice —
      // once as part of the accessible name and once as the description.
      const card = cards[index];
      expect(card?.getAttribute("aria-describedby")).toBe(`template-summary-${template.id}`);
      expect(card?.contains(summary)).toBe(false);
      expect(card?.textContent).not.toContain(template.summary);
    }
  });
});
