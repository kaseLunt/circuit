"use client";

/**
 * The React Flow host. The store's document IS the picture: nodes and edges are derived
 * from `doc` plus the `view` coordinate map on every render, and every mutation goes back
 * through a store action. React Flow holds no second copy of the graph, so there is no
 * state to reconcile and no path by which the canvas and the document can disagree.
 *
 * This file owns the ONE doc→view-model mapping. `core/graph.ts` speaks in `wrap`/
 * `unwrap`; `lib/strategy/types.ts` — the contract the block family is written against —
 * speaks in one `auto-wrap` family with a direction flag. Both vocabularies meet here and
 * nowhere else, which is what keeps the block components free of core's block union and
 * the store free of the view's.
 *
 * Four wiring decisions carry the interaction contract:
 *
 * 1. `isValidConnection` is the SAME `connectRejection` the `connect` action runs, so the
 *    drag affordance and the drop verdict are one predicate. That also makes `onConnect`
 *    unreachable for a refused pair — React Flow never calls it — so the reason for a
 *    refusal is recovered from `onConnectEnd`'s connection state instead.
 * 2. A drag opens `beginEdit`/`endEdit`. `moveBlock` deliberately does not bump `rev`, so
 *    the gesture leaves the document untouched and `endEdit` closes it with no history
 *    entry — while `pendingEdit` being non-null is what suppresses value-change flashes
 *    for the duration.
 * 3. A multi-block delete and a paste are wrapped in the same gesture, so each costs ONE
 *    undo rather than one per block.
 * 4. Selection has ONE writer: React Flow's own `select` node changes. The modifier-click
 *    path never reaches `useOnSelectionChange`, so reading selection from that hook lost
 *    every Shift/Meta-click silently.
 *
 * `dist/base.css` only: `dist/style.css` is the default look, and ./canvas.css restyles
 * the chrome from tokens.
 */

import "@xyflow/react/dist/base.css";
import "./canvas.css";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useNodesInitialized,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { Info, Maximize, Minus, Plus } from "lucide-react";
import { outgoingBps } from "../../core/allocation";
import {
  validateGraph,
  type Block,
  type BlockType as CoreBlockType,
  type Edge as CoreEdge,
  type StrategyGraph,
} from "../../core/graph";
import { expectedInputAssetOf, outputAssetOf } from "../../core/route-optimizer";
import { valueOf, type Derived, type Provenanced } from "../../core/provenance";
import {
  connectRejection,
  overAllocatedSourceIds,
  readBorrowAllocationBps,
  readInputAmount,
  readOutgoingAllocationBps,
  type BlockPosition,
  type ComposerState,
  type ParamReadState,
  type ComposerStoreApi,
  type ConnectRejection,
  type LoadSource,
} from "../../app/store/composer-store";
import { useComposerStore, useComposerStoreApi } from "../../app/store/composer-provider";
import type { BorrowLimitVerdict } from "../../core/borrow-limit";
import { layoutGraph } from "../../lib/strategy/layout";
import { getTemplate } from "../../lib/strategy/templates";
import {
  FULL_ALLOCATION_BPS,
  type AssetType,
  type BaseBlockData,
  type BlockData,
  type BlockView,
  type LendProtocol,
  type SimulationResult,
  type StakeProtocol,
  type StrategyBlock,
} from "../../lib/strategy/types";
import { Button } from "../ui/button";
import {
  BLOCK_COMPONENTS,
  BORROW_STEP_BPS,
  BlockRuntimeProvider,
  STAKE_PROTOCOLS,
  type BlockRuntime,
  type RenderableBlockType,
} from "./blocks";
import { CanvasEmptyState } from "./canvas-empty-state";
import { FlowEdge, type AllocationEdge } from "./flow-edge";
import { SelectionActionBar } from "./selection-action-bar";
import { NOTICE_DURATION_MS } from "../shared/notice";
import { cn } from "../../lib/utils";

/** How long a refused-drop notice stays on screen — the composer's one dwell time. */
export const REJECTION_NOTICE_MS = NOTICE_DURATION_MS;

/** --motion-slow, in the numeric form React Flow's viewport helpers take. */
export const FIT_VIEW_DURATION_MS = 240;

/** Offset that makes a pasted copy visibly a copy rather than an occlusion. */
export const PASTE_OFFSET_PX = 40;

/**
 * One declarative sentence per rejection code — no alarm theatre, no "invalid connection".
 * Each says what is true and, where the user can act, what to do next.
 *
 * `unknown-block` is not in the treatment's list because it is not reachable by dragging
 * between two drawn blocks; it exists because the store's union has an arm for a stale id,
 * and a `Record` keyed on the union is what makes adding a code without copy a type error.
 *
 * `document-locked` is deliberately EXCLUDED: that refusal carries the run's own sentence
 * (`RUN_LOCK_REASON`, minted where the lock is held), and a copy of it here would be a second
 * definition of one sentence. `connectRejectionMessage` is the reader that honours both.
 */
export const CONNECT_REJECTION_MESSAGES: Readonly<
  Record<Exclude<ConnectRejection["code"], "document-locked">, string>
> = {
  "self-loop": "A block can't feed itself.",
  "duplicate-edge": "These blocks are already connected.",
  "would-create-cycle": "That connection would create a loop — strategies flow one way.",
  "target-already-has-producer": "This block already has an input. Disconnect it first.",
  "input-cannot-consume": "Input blocks are sources — they don't accept connections.",
  "edge-limit": "Edge limit reached for this strategy.",
  "unknown-block": "That block is no longer on the canvas.",
};

/** The sentence a refusal states, from the table or from the refusal itself (T26). */
export function connectRejectionMessage(rejection: ConnectRejection): string {
  return rejection.code === "document-locked"
    ? rejection.reason
    : CONNECT_REJECTION_MESSAGES[rejection.code];
}

/**
 * core/graph.ts's block union, mapped onto the component that draws it. `wrap` and
 * `unwrap` are ONE renderable family — the direction rides `AutoWrapBlockData.isWrap` —
 * because they differ by a flag and a title, not by a control. Keyed on core's union and
 * valued in the registry's, so adding a block type to either side is a compile error here
 * before it is a blank rectangle on the canvas.
 */
export const NODE_TYPE_FOR = {
  input: "input",
  stake: "stake",
  wrap: "auto-wrap",
  unwrap: "auto-wrap",
  lend: "lend",
  borrow: "borrow",
} satisfies Record<CoreBlockType, RenderableBlockType>;

/**
 * View-model members `lib/strategy/types.ts` requires that a freshly added block's
 * document does not hold. `addBlock` writes only STRUCTURAL params, so a new stake block
 * has no protocol, a new borrow block no allocation and a new wrap block no pair — by
 * design, so the block renders unconfigured until the user or a connection supplies one.
 *
 * Every block gates its display on `isConfigured` or on a provenanced reader, so none of
 * these values reaches the screen: they exist so a control has a resting position and so
 * the union member typechecks. Modelling "unset" in the view model itself belongs to
 * lib/strategy/types.ts.
 */
const UNSET_ASSET: AssetType = "ETH";
const UNSET_STAKE_PROTOCOL: StakeProtocol = "etherfi";

/** core/graph.ts admits exactly one lend market; a document holding another fails
 *  validateGraph and the block says so. This is a read of the schema, not a default. */
const LEND_PROTOCOL: LendProtocol = "aave-v3";

const EDGE_TYPES: EdgeTypes = { allocation: FlowEdge };

interface NodeSize {
  readonly width: number;
  readonly height: number;
}

export interface ClipboardSnapshot {
  readonly blocks: readonly Block[];
  readonly edges: readonly { source: string; target: string; allocationBps: number }[];
  readonly positions: Readonly<Record<string, BlockView>>;
  readonly droppedInput: boolean;
}

/**
 * Module-level so a copy survives re-render and unmount, exactly like a system clipboard.
 * `buildClipboard` is its only writer and refuses to mint an empty snapshot, so non-null
 * means there is something to paste.
 */
let clipboard: ClipboardSnapshot | null = null;

function isCoreBlockType(value: string): value is CoreBlockType {
  return Object.hasOwn(NODE_TYPE_FOR, value);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * React Flow's drag-time predicate, built from the store's own refusal function. Exported
 * so a test can assert the two never disagree without driving a pointer.
 *
 * The run lock is part of the predicate rather than a check after the drop (T26, the palette's
 * own rule): refusing a connection the user has already dragged across the canvas is a worse
 * refusal than never letting the drag begin. The store refuses it too — that is the backstop,
 * not the affordance.
 */
export function makeIsValidConnection(
  doc: StrategyGraph,
  writeLockReason: string | null,
): (candidate: Connection | Edge) => boolean {
  if (writeLockReason !== null) return () => false;
  return (candidate) => connectRejection(doc, candidate.source, candidate.target) === null;
}

/**
 * Why a drop was refused, recovered from the END of the gesture.
 *
 * `onConnect` cannot answer this: React Flow only calls it when `isValidConnection`
 * already said yes, and that predicate IS `connectRejection` — so by construction
 * `onConnect` never sees a refusal. The connection state carries the two endpoints, which
 * is everything the store's own refusal function needs.
 *
 * A release over empty canvas is not a refusal and reports nothing.
 */
export interface ConnectionEnd {
  readonly isValid: boolean | null;
  readonly fromNode: { readonly id: string } | null;
  readonly toNode: { readonly id: string } | null;
}

export function rejectionFromConnectionEnd(
  doc: StrategyGraph,
  state: ConnectionEnd,
): ConnectRejection | null {
  if (state.isValid === true) return null;
  const from = state.fromNode;
  const to = state.toNode;
  if (from === null || to === null) return null;
  return connectRejection(doc, from.id, to.id);
}

/**
 * core's per-block PARAMETER errors, keyed by block id.
 *
 * Only `validateBlockParams` prefixes an error with `block <id>: `; the structural errors
 * about the same block ("must have exactly one producer", "is not reachable from the
 * input", "over-allocates outgoing flow") do not, and they are deliberately not folded in
 * here — an unconnected block is not an invalid block, and rendering it destructive would
 * paint every freshly dropped block red.
 */
export function blockParamErrors(doc: StrategyGraph): Readonly<Record<string, string>> {
  const validation = validateGraph(doc);
  if (validation.ok) return {};
  const byBlock: Record<string, string> = {};
  for (const error of validation.errors) {
    for (const block of doc.blocks) {
      const prefix = `block ${block.id}: `;
      if (error.startsWith(prefix) && byBlock[block.id] === undefined) {
        byBlock[block.id] = error.slice(prefix.length);
      }
    }
  }
  return byBlock;
}

type BaseFields = Pick<BaseBlockData, "label" | "isConfigured" | "isValid" | "errorMessage">;

/**
 * A block the user has not finished configuring is UNCONFIGURED, not invalid: core's
 * parameter error for an unset param is the expected reading of an empty control, and
 * every block in the family renders that as its own designed state.
 */
function baseFields(label: string, isConfigured: boolean, paramError: string | undefined): BaseFields {
  const failing = isConfigured ? paramError : undefined;
  if (failing === undefined) return { label, isConfigured, isValid: true };
  return { label, isConfigured, isValid: false, errorMessage: failing };
}

/**
 * One document block, projected onto the exact `BlockData` member its component reads.
 *
 * Assets and staking flow come from core's own `outputAssetOf` / `expectedInputAssetOf`,
 * so the canvas restates no asset table; entered quantities come from the store's
 * provenanced readers, so no number is re-derived from `params` at the display boundary.
 */
export function blockDataOf(
  state: ParamReadState,
  block: Block,
  paramError: string | undefined,
): BlockData {
  switch (block.type) {
    case "input": {
      const entered = readInputAmount(state, block.id);
      const amount = entered === null ? "" : valueOf(entered);
      const isConfigured = amount.trim().length > 0;
      return {
        ...baseFields("Input Capital", isConfigured, paramError),
        type: "input",
        asset: outputAssetOf(block) ?? UNSET_ASSET,
        amount,
      };
    }
    case "stake": {
      const raw = block.params["protocol"];
      const protocol = STAKE_PROTOCOLS.find((option) => option.value === raw)?.value;
      return {
        ...baseFields("Stake", protocol !== undefined, paramError),
        type: "stake",
        protocol: protocol ?? UNSET_STAKE_PROTOCOL,
        inputAsset: expectedInputAssetOf(block) ?? UNSET_ASSET,
        outputAsset: outputAssetOf(block) ?? UNSET_ASSET,
      };
    }
    case "wrap":
    case "unwrap": {
      const fromAsset = expectedInputAssetOf(block);
      const toAsset = outputAssetOf(block);
      const isConfigured = fromAsset !== null && toAsset !== null;
      return {
        ...baseFields(block.type === "wrap" ? "Wrap" : "Unwrap", isConfigured, paramError),
        type: "auto-wrap",
        fromAsset: fromAsset ?? UNSET_ASSET,
        toAsset: toAsset ?? UNSET_ASSET,
        isWrap: block.type === "wrap",
      };
    }
    case "lend": {
      const asset = expectedInputAssetOf(block);
      return {
        ...baseFields("Supply", asset !== null, paramError),
        type: "lend",
        protocol: LEND_PROTOCOL,
        asset,
      };
    }
    case "borrow": {
      const allocation = readBorrowAllocationBps(state, block.id);
      return {
        ...baseFields("Borrow", allocation !== null, paramError),
        type: "borrow",
        protocol: LEND_PROTOCOL,
        asset: outputAssetOf(block) ?? UNSET_ASSET,
        // A control position, never a rendered figure: the borrow block prints the
        // allocation through the store's provenanced reader, which is null until the
        // user chooses one, and the slider rests at its own minimum until then.
        allocationBps: allocation === null ? BORROW_STEP_BPS : valueOf(allocation),
      };
    }
  }
}

/**
 * What the canvas CALLS each block, keyed by id.
 *
 * `blockDataOf` already decides every block's title, so the allocation popover reads it
 * from here rather than printing `source`/`target` — those are store keys, and "Out of
 * supply1" beside a block labelled Supply is the document leaking through the one control
 * where a share of money is edited.
 */
export function blockLabelsOf(
  state: ParamReadState,
  paramErrors: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    state.doc.blocks.map((b) => [b.id, blockDataOf(state, b, paramErrors[b.id]).label]),
  );
}

/**
 * The edge view-model. Split out of the component for the same reason `blockDataOf` is:
 * the doc→view mapping is what this file claims, and asserting it needs no layout engine.
 */
export function allocationEdgesOf(
  docEdges: readonly CoreEdge[],
  labels: Readonly<Record<string, string>>,
  selectedEdgeIds: ReadonlySet<string>,
  /** T26: the run's write-lock sentence, carried to the edge so its two write controls state
   *  it. Passed through the view model rather than read from a context, so the edge's refusal
   *  is provable without mounting React Flow. */
  writeLockReason: string | null,
): AllocationEdge[] {
  return docEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "allocation",
    selected: selectedEdgeIds.has(e.id),
    data: {
      allocationBps: e.allocationBps,
      sourceOutgoingBps: outgoingBps(docEdges, e.source),
      writeLockReason,
      // Unreachable: an edge's endpoints are document blocks, so `labels` is total over
      // them. The id is a worse name than the title but a truer one than a guess, and
      // dropping the edge would hide a connection that exists.
      sourceLabel: labels[e.source] ?? e.source,
      targetLabel: labels[e.target] ?? e.target,
    },
  }));
}

/** Where the multi-selection toolbar anchors: the bottom-centre of the selection's box,
 *  in screen space. Unmeasured means unknown — no geometry, no bar. */
export function selectionBarPosition(
  nodes: readonly Pick<Node, "id" | "position" | "measured">[],
  selected: ReadonlySet<string>,
  viewport: Viewport,
): { readonly x: number; readonly y: number } | null {
  const chosen = nodes.filter((n) => selected.has(n.id));
  if (chosen.length < 2) return null;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of chosen) {
    const width = node.measured?.width;
    const height = node.measured?.height;
    // An approximated node box put the old bar in the wrong place at every zoom level.
    if (width === undefined || height === undefined) return null;
    minX = Math.min(minX, node.position.x);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }
  return {
    x: ((minX + maxX) / 2) * viewport.zoom + viewport.x,
    y: maxY * viewport.zoom + viewport.y,
  };
}

/**
 * The copyable half of a selection. A strategy has exactly one input block
 * (core/graph.ts), so a duplicated input is a document that can never validate —
 * excluding it is honest, copying it is not.
 *
 * `null` means there is nothing to copy, and the caller must NOT store it: overwriting a
 * good clipboard with an empty snapshot destroys a copy the user still expects to paste.
 */
export function buildClipboard(
  state: Pick<ComposerState, "doc" | "selectedBlockIds" | "view">,
): ClipboardSnapshot | null {
  const chosen = new Set(state.selectedBlockIds);
  if (chosen.size === 0) return null;
  const copied = state.doc.blocks.filter((b) => chosen.has(b.id) && b.type !== "input");
  if (copied.length === 0) return null;

  const droppedInput = state.doc.blocks.some((b) => chosen.has(b.id) && b.type === "input");
  const ids = new Set(copied.map((b) => b.id));
  const positions: Record<string, BlockView> = {};
  for (const block of copied) {
    const at = state.view[block.id];
    if (at !== undefined) positions[block.id] = at;
  }
  return {
    blocks: copied,
    edges: state.doc.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, allocationBps: e.allocationBps })),
    positions,
    droppedInput,
  };
}

/** Replays a snapshot into the document as ONE edit gesture — a paste costs one undo,
 *  never one per block. Returns the ids it created. */
export function pasteClipboard(
  api: ComposerStoreApi,
  snapshot: ClipboardSnapshot,
): readonly string[] {
  api.getState().beginEdit("paste blocks");
  const idMap = new Map<string, string>();
  for (const block of snapshot.blocks) {
    const at = snapshot.positions[block.id];
    if (at === undefined) continue;
    const id = api
      .getState()
      .addBlock(block.type, { x: at.x + PASTE_OFFSET_PX, y: at.y + PASTE_OFFSET_PX });
    // A refused add ends the paste (the run lock refuses every add): half a paste is a
    // document nobody asked for, and there is no id to hang the rest of the replay on.
    if (id === null) break;
    idMap.set(block.id, id);
    for (const [key, value] of Object.entries(block.params)) {
      // Borrow allocation has its own action because it is debt-as-a-fraction-of-
      // collateral, not a transportable block param.
      if (block.type === "borrow" && key === "allocationBps" && typeof value === "number") {
        api.getState().setBorrowAllocationBps(id, value);
        continue;
      }
      api.getState().setBlockParam(id, key, value);
    }
  }
  for (const edge of snapshot.edges) {
    const source = idMap.get(edge.source);
    const target = idMap.get(edge.target);
    if (source === undefined || target === undefined) continue;
    if (!api.getState().connect(source, target).ok) continue;
    if (edge.allocationBps === FULL_ALLOCATION_BPS) continue;
    const created = api
      .getState()
      .doc.edges.find((x) => x.source === source && x.target === target);
    if (created !== undefined) api.getState().setEdgeAllocationBps(created.id, edge.allocationBps);
  }
  const created = [...idMap.values()];
  // Selection follows what was pasted, so a paste that created nothing (a refused write, or a
  // snapshot with no placed block) leaves the user's selection alone rather than clearing it.
  if (created.length > 0) api.getState().setSelection(created);
  api.getState().endEdit();
  return created;
}

/**
 * Removes the current selection as ONE edit gesture: deleting four blocks costs one
 * Ctrl+Z, not four. Returns the ids it removed.
 *
 * What the DOCUMENT says was removed, not what was asked for: a refused write (the run lock)
 * must never be announced as a deletion, and reading the answer off the document is what makes
 * that structural rather than a second copy of the lock rule.
 */
export function deleteSelectedBlocks(api: ComposerStoreApi): readonly string[] {
  const ids = api.getState().selectedBlockIds;
  if (ids.length === 0) return [];
  api.getState().beginEdit("delete blocks");
  for (const id of ids) api.getState().removeBlock(id);
  api.getState().endEdit();
  const remaining = new Set(api.getState().doc.blocks.map((b) => b.id));
  return ids.filter((id) => !remaining.has(id));
}

/** What a load says out loud. `blank` is reachable only through `clear`, because the
 *  initial blank state is never announced — nothing arrived. */
export function loadAnnouncement(from: LoadSource): string {
  switch (from.kind) {
    case "blank":
      return "Canvas cleared.";
    case "template": {
      const template = getTemplate(from.templateId);
      return template === undefined ? "Strategy loaded." : `Loaded ${template.name}.`;
    }
    case "share-url":
      return "Loaded a shared strategy.";
    case "local-draft":
      return "Draft restored.";
  }
}

/** A fit explains what arrived; it never performs — and under reduced motion it does not
 *  move at all. Both fit paths ask here, so neither can forget. */
function fitDurationMs(): number {
  const reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduced ? 0 : FIT_VIEW_DURATION_MS;
}

/**
 * The legibility floor for an ARRIVAL fit — a formal amendment to treatment §3, which
 * specified the fit but not a floor.
 *
 * Derived, not chosen: block body copy is `text-xs` (12px), and below roughly 9px effective
 * a number stops being readable, so 9/12 = 0.75 is where a fit stops explaining the graph
 * and starts presenting a diagram of one. The nine-block flagship free-fits to ~0.32, which
 * put every rate, health factor and amount in SPEC §3's opening frame under 4px — steps 1
 * and 2 ask the reader to SEE that the numbers are sourced.
 *
 * Applied to arrivals ONLY (mount, and a template/share load). The "Fit strategy to view"
 * button stays unfloored: that one is the user asking to see the whole graph, and answering
 * a direct request with a partial view would be the control refusing its own job.
 */
const ARRIVAL_FIT_MIN_ZOOM = 0.75;

/** Breathing room around an arrival fit, in screen px. */
const ARRIVAL_FIT_PADDING_PX = 24;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;

/**
 * Where an arrival puts the viewport — pure, so the anchoring rule is a unit test rather
 * than a screenshot someone has to remember to take.
 *
 * Centring is right when the graph FITS. It is wrong when it does not: with the legibility
 * floor applied, the nine-block flagship is far wider than the field (it free-fits to ~0.26,
 * a third of the floor), and centring a graph that overflows clips BOTH ends — which put the
 * Input Capital block, the entry point of the whole story, entirely off the left edge of
 * SPEC §3's opening frame. Measured: `in` at x −361..−180 against a field starting at 256.
 *
 * So when the graph cannot fit legibly, the fit anchors the HEAD instead. You cannot show
 * thirteen steps legibly at once; you can show the reader where the strategy STARTS, at a
 * size where the sourced numbers are readable, and let them pan. Each axis decides
 * independently — a graph that fits vertically still centres vertically.
 */
export function arrivalViewport(
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  field: { readonly width: number; readonly height: number },
  padding: number = ARRIVAL_FIT_PADDING_PX,
): Viewport {
  const usableWidth = Math.max(field.width - padding * 2, 1);
  const usableHeight = Math.max(field.height - padding * 2, 1);
  const natural = Math.min(usableWidth / bounds.width, usableHeight / bounds.height);
  const zoom = Math.min(MAX_ZOOM, Math.max(ARRIVAL_FIT_MIN_ZOOM, Math.max(natural, MIN_ZOOM)));

  const scaledWidth = bounds.width * zoom;
  const scaledHeight = bounds.height * zoom;
  return {
    zoom,
    x:
      scaledWidth <= usableWidth
        ? (field.width - scaledWidth) / 2 - bounds.x * zoom
        : padding - bounds.x * zoom,
    y:
      scaledHeight <= usableHeight
        ? (field.height - scaledHeight) / 2 - bounds.y * zoom
        : padding - bounds.y * zoom,
  };
}

/**
 * The refusal strip.
 *
 * Persistently mounted with its text swapped, never created together with its content: a
 * region that arrives with its message is the classic pattern assistive technology fails
 * to announce. It is `aria-hidden` and the sentence is spoken through the canvas's single
 * polite region instead — one live region per container, and this container is the canvas.
 */
export function ConnectionRejectionNotice({ rejection }: { rejection: ConnectRejection | null }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-6 left-1/2 z-30 -translate-x-1/2"
    >
      <div
        className={cn(
          "transition-fast flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground shadow-overlay",
          rejection === null ? "opacity-0" : "opacity-100",
        )}
      >
        <Info aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span>{rejection === null ? "" : connectRejectionMessage(rejection)}</span>
      </div>
    </div>
  );
}

export interface StrategyCanvasProps {
  /**
   * The block-pinned simulation, or null before one resolves. Required rather than
   * defaulted: the canvas observes nothing and derives nothing, so a host that has no
   * simulation must say so rather than let this file invent an empty one.
   *
   * STALE-WHILE-REVALIDATE, per SourcedValue's `pending` contract: hold the last resolved
   * result while a refresh is in flight and pass `null` only for a settled failure. A null
   * round-trip on every poll re-skeletons and re-fades every slot on the canvas at once.
   */
  simulation: SimulationResult | null;
  simulationPending: boolean;
  /** The block currently executing (P3). Null outside an execution. */
  executingBlockId?: string | null;
  /**
   * SPEC §3 step 4's client-side borrow verdict, derived by the host beside the simulation
   * (`useBorrowLimit`). Passed in rather than computed here for the same reason the
   * simulation is: the canvas observes nothing and derives nothing.
   */
  borrowLimit?: BorrowLimitVerdict | null;
  /** T26: the run's write-lock sentence, or null. Reads are never locked. */
  writeLockReason?: string | null;
  /**
   * Filled by the canvas with a resolver for "the middle of what the user is looking at",
   * in flow coordinates. The shell's keyboard-add path needs a position at the moment of
   * the keystroke and only the canvas knows the live viewport — but the canvas owns its
   * `ReactFlowProvider`, so a host outside it cannot ask `useReactFlow`.
   *
   * A ref rather than a callback prop because the resolver is invoked inside an event
   * handler and never during render: nothing re-renders when the viewport moves, which is
   * the whole point — panning must not re-render the composer.
   */
  dropPositionRef?: RefObject<(() => BlockPosition) | null>;
}

/**
 * Where a block lands when the canvas has not measured yet — the flow origin, which is
 * where an unpanned viewport already looks. A coordinate, not a quantity: a block must be
 * placed somewhere to exist at all, and no money rule is in play.
 */
export const CANVAS_ORIGIN: BlockPosition = { x: 0, y: 0 };

/**
 * The whole money seam between the simulation and the block family, in one place.
 *
 * A null simulation means there is NO RESULT AT ALL, which is a different fact from a
 * result whose quantity did not resolve — so the three fields go absent together and none
 * is substituted with an empty or a zero. Nothing is minted here: the wrappers arrive
 * already provenanced from `core/risk.ts`, and this adapter observes nothing.
 *
 * Exported because it is the one part of the runtime memo a component render cannot
 * interrogate, and because it is the seam taste finding S-1 was about.
 */
export function runtimeRiskFields(
  simulation: SimulationResult | null,
): Pick<
  BlockRuntime,
  "blockValues" | "minHealthFactor" | "liquidationRatioWad" | "liquidationPair"
> {
  if (simulation === null) {
    return {
      blockValues: {},
      minHealthFactor: null,
      liquidationRatioWad: null,
      liquidationPair: null,
    };
  }
  return {
    blockValues: simulation.blockValues,
    minHealthFactor: simulation.minHealthFactor,
    liquidationRatioWad: simulation.liquidationRatioWad,
    // Carried beside the ratio, never re-derived from a block's own params: the pair is a
    // fact about the POSITION at the minimum-HF checkpoint, which is not something any one
    // block knows.
    liquidationPair: simulation.liquidationPair,
  };
}

function CanvasInner({
  simulation,
  simulationPending,
  executingBlockId = null,
  borrowLimit = null,
  writeLockReason = null,
  dropPositionRef,
}: StrategyCanvasProps) {
  const api = useComposerStoreApi();
  const fieldRef = useRef<HTMLDivElement>(null);
  // `getNodesBounds` from the hook, not the standalone export: the module-level one warns
  // that it cannot see the flow's node lookup, and a console warning is not something this
  // app ships.
  const {
    fitView,
    getNodes,
    getNodesBounds,
    screenToFlowPosition,
    setViewport,
    zoomIn,
    zoomOut,
  } = useReactFlow();
  const viewport = useViewport();

  const {
    doc,
    rev,
    view,
    paramOrigins,
    selectedBlockIds,
    pendingEdit,
    loadedFrom,
    lastLoadProblem,
  } = useComposerStore(
      useShallow((state) => ({
        doc: state.doc,
        rev: state.rev,
        paramOrigins: state.paramOrigins,
        view: state.view,
        selectedBlockIds: state.selectedBlockIds,
        pendingEdit: state.pendingEdit === null ? null : state.pendingEdit.label,
        loadedFrom: state.loadedFrom,
        lastLoadProblem: state.lastLoadProblem,
      })),
    );

  /**
   * One region, mounted from the first paint, with a monotonic nonce. The nonce is what
   * makes a repeat reach assistive technology: deleting two blocks in a row sets the same
   * string twice, React bails out of the identical state, and the text node never changes
   * — so the second deletion is silent unless the node itself is remounted.
   */
  const [announcement, setAnnouncement] = useState({ nonce: 0, message: "" });
  const announce = useCallback((message: string) => {
    setAnnouncement((previous) => ({ nonce: previous.nonce + 1, message }));
  }, []);

  const [rejection, setRejection] = useState<ConnectRejection | null>(null);
  useEffect(() => {
    if (rejection === null) return;
    const timer = setTimeout(() => setRejection(null), REJECTION_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [rejection]);

  const showRejection = useCallback(
    (refusal: ConnectRejection) => {
      setRejection(refusal);
      announce(connectRejectionMessage(refusal));
    },
    [announce],
  );

  /**
   * The canvas's ONE write dispatch (T26, Codex round-3 finding 2).
   *
   * Every route that would change the document goes through it: while a run holds the document
   * it states the lock in the canvas's own live region and dispatches nothing, and the store's
   * guard behind it refuses anyway — so a route that forgets this wrapper is harmless rather
   * than destructive. `run` returns the sentence to announce, or null when it says nothing.
   *
   * Reads are deliberately NOT routed here: pan, zoom, selection, copy and every disclosure
   * stay live while money moves (T26 — a frozen document is not a hidden one).
   */
  const write = useCallback(
    (run: () => string | null) => {
      if (writeLockReason !== null) {
        announce(writeLockReason);
        return;
      }
      const said = run();
      if (said !== null) announce(said);
    },
    [announce, writeLockReason],
  );

  // Render-time state adjustment, not an effect: an effect body that calls setState is a
  // cascading render the compiler refuses, and the load has already happened by the time
  // this renders — there is nothing to wait for.
  const [seenLoad, setSeenLoad] = useState(loadedFrom);
  if (seenLoad !== loadedFrom) {
    setSeenLoad(loadedFrom);
    // A load that FAILED does not also get to announce what is now on the canvas. A refused
    // share arrival lands on an empty document, and "Canvas cleared." beside "that strategy
    // could not be loaded" reports an action nobody took.
    if (lastLoadProblem === null) announce(loadAnnouncement(loadedFrom));
  }
  const [seenProblem, setSeenProblem] = useState(lastLoadProblem);
  if (seenProblem !== lastLoadProblem) {
    setSeenProblem(lastLoadProblem);
    if (lastLoadProblem !== null) announce("That strategy could not be loaded.");
  }

  const blocks = doc.blocks;
  const docEdges = doc.edges;
  const selected = useMemo(() => new Set(selectedBlockIds), [selectedBlockIds]);
  const blockIds = useMemo(() => new Set(blocks.map((b) => b.id)), [blocks]);
  const edgeIds = useMemo(() => new Set(docEdges.map((e) => e.id)), [docEdges]);

  /**
   * React Flow resets a node's measured size whenever the incoming node omits it, and the
   * nodes array is rebuilt on every drag frame. Carrying measurements forward is what
   * keeps a drag from re-measuring the whole canvas sixty times a second — and what lets
   * the action bar anchor to real geometry instead of guessed dimensions.
   *
   * It is state rather than a ref because it is READ during render, and a ref read in
   * render is a tear waiting to happen (and a lint error). Entries are pruned when their
   * block leaves the document, so a session of edits does not accumulate dead geometry.
   */
  const [measured, setMeasured] = useState<Readonly<Record<string, NodeSize>>>({});
  if (Object.keys(measured).some((id) => !blockIds.has(id))) {
    setMeasured(Object.fromEntries(Object.entries(measured).filter(([id]) => blockIds.has(id))));
  }

  /** Edge selection is view state — the document has no notion of it — so it lives here
   *  and is pruned the same way. */
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
  if ([...selectedEdgeIds].some((id) => !edgeIds.has(id))) {
    setSelectedEdgeIds(new Set([...selectedEdgeIds].filter((id) => edgeIds.has(id))));
  }

  /**
   * Never invent a coordinate. When every block has a view entry the map is used as-is;
   * when one is missing (a document that arrived without a layout pass) the deterministic
   * layout supplies the gaps and stored positions still win.
   */
  const positions = useMemo<Readonly<Record<string, BlockView>>>(() => {
    if (blocks.every((b) => view[b.id] !== undefined)) return view;
    return { ...layoutGraph(doc), ...view };
  }, [blocks, view, doc]);

  const paramErrors = useMemo(() => blockParamErrors(doc), [doc]);

  const nodes = useMemo<StrategyBlock[]>(
    () =>
      blocks.flatMap((b) => {
        const at = positions[b.id];
        // Unreachable: `positions` is total over doc.blocks. Skipping beats defaulting to
        // the origin, which would silently stack every unplaced block on one another.
        if (at === undefined) return [];
        const node: StrategyBlock = {
          id: b.id,
          type: NODE_TYPE_FOR[b.type],
          position: { x: at.x, y: at.y },
          selected: selected.has(b.id),
          data: blockDataOf({ doc, paramOrigins }, b, paramErrors[b.id]),
        };
        const size = measured[b.id];
        return [size === undefined ? node : { ...node, measured: size }];
      }),
    [blocks, doc, paramOrigins, positions, selected, paramErrors, measured],
  );

  // Memoised on the document — NOT derived from `nodes`, whose identity changes on every
  // drag frame — so a gesture never rebuilds every edge.
  const blockLabels = useMemo(
    () => blockLabelsOf({ doc, paramOrigins }, paramErrors),
    [doc, paramOrigins, paramErrors],
  );

  const edges = useMemo(
    () => allocationEdgesOf(docEdges, blockLabels, selectedEdgeIds, writeLockReason),
    [docEdges, blockLabels, selectedEdgeIds, writeLockReason],
  );

  /**
   * The badge set, keyed on its own contents rather than on `view`. `view` is rewritten on
   * every drag frame, and a runtime rebuilt sixty times a second re-renders every block
   * through context — the exact per-frame work the measured cache exists to avoid.
   * `moveBlock` preserves the flag, so this key is stable for the whole gesture.
   */
  const autoInsertedKey = useMemo(
    () =>
      doc.blocks
        .filter((b) => view[b.id]?.isAutoInserted === true)
        .map((b) => b.id)
        .join("|"),
    [doc, view],
  );
  const autoInsertedIds = useMemo(
    () => new Set(autoInsertedKey === "" ? [] : autoInsertedKey.split("|")),
    [autoInsertedKey],
  );

  /**
   * The money boundary, crossed once for the whole document. `composer-store.ts`'s readers
   * mint a fresh wrapper per call and are documented to be called inside one memo keyed on
   * `rev`; doing it here rather than per block per render is what keeps a provenanced
   * quantity from being re-minted sixty times a second during a drag.
   */
  const runtime = useMemo<BlockRuntime>(() => {
    const inputAmounts: Record<string, Provenanced<string>> = {};
    const borrowAllocations: Record<string, Provenanced<number>> = {};
    const outgoingAllocationBps: Record<string, Derived<number>> = {};
    const paramState = { doc, paramOrigins };
    for (const block of doc.blocks) {
      const amount = readInputAmount(paramState, block.id);
      if (amount !== null) inputAmounts[block.id] = amount;
      const allocation = readBorrowAllocationBps(paramState, block.id);
      if (allocation !== null) borrowAllocations[block.id] = allocation;
      const outgoing = readOutgoingAllocationBps(paramState, block.id);
      if (outgoing !== null) outgoingAllocationBps[block.id] = outgoing;
    }
    return {
      autoInsertedIds,
      overAllocatedIds: new Set(overAllocatedSourceIds(doc)),
      outgoingAllocationBps,
      inputAmounts,
      borrowAllocations,
      executingBlockId,
      borrowLimit,
      writeLockReason,
      ...runtimeRiskFields(simulation),
      pending: simulationPending,
      pendingEdit,
      docRev: rev,
      // T26: the lock is applied HERE, at the one place every block write goes through, so
      // no control can forget it and every refusal arrives in the store's own ActionResult
      // shape — which is what the typed-rejection strip already renders.
      setBlockParam: (id, key, value) =>
        writeLockReason === null
          ? api.getState().setBlockParam(id, key, value)
          : { ok: false, reason: writeLockReason },
      setBorrowAllocationBps: (id, bps) =>
        writeLockReason === null
          ? api.getState().setBorrowAllocationBps(id, bps)
          : { ok: false, reason: writeLockReason },
      beginEdit: (label) => api.getState().beginEdit(label),
      endEdit: () => api.getState().endEdit(),
    };
  }, [
    api,
    doc,
    paramOrigins,
    autoInsertedIds,
    rev,
    pendingEdit,
    simulation,
    simulationPending,
    executingBlockId,
    borrowLimit,
    writeLockReason,
  ]);

  const isValidConnection = useMemo(
    () => makeIsValidConnection(doc, writeLockReason),
    [doc, writeLockReason],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<StrategyBlock>[]) => {
      const sizes: Record<string, NodeSize> = {};
      const selections: { id: string; selected: boolean }[] = [];
      for (const change of changes) {
        if (change.type === "position") {
          if (change.position !== undefined) {
            api.getState().moveBlock(change.id, change.position);
          }
        } else if (change.type === "dimensions") {
          if (change.dimensions !== undefined) sizes[change.id] = change.dimensions;
        } else if (change.type === "select") {
          selections.push({ id: change.id, selected: change.selected });
        }
        // 'remove' is deliberately unhandled: deleteKeyCode is null and nothing calls
        // deleteElements, so deletion has exactly one path — the wrapper's handler, which
        // wraps a multi-block delete in ONE edit gesture.
      }

      if (Object.keys(sizes).length > 0) {
        setMeasured((previous) => {
          let changed = false;
          const next = { ...previous };
          for (const [id, size] of Object.entries(sizes)) {
            const current = previous[id];
            if (
              current === undefined ||
              current.width !== size.width ||
              current.height !== size.height
            ) {
              next[id] = size;
              changed = true;
            }
          }
          return changed ? next : previous;
        });
      }

      // The SINGLE selection writer. `useOnSelectionChange` cannot be it: a modifier-click
      // takes React Flow's early `addSelectedNodes` branch, which emits select changes and
      // mutates nothing the selection listener observes — so every Shift/Meta-click was
      // dropped on the floor while marquee and single-click appeared to work.
      if (selections.length > 0) {
        const next = new Set(api.getState().selectedBlockIds);
        for (const change of selections) {
          if (change.selected) next.add(change.id);
          else next.delete(change.id);
        }
        api.getState().setSelection([...next]);
      }
    },
    [api],
  );

  const onEdgesChange = useCallback((changes: EdgeChange<AllocationEdge>[]) => {
    const selections = changes.flatMap((change) =>
      change.type === "select" ? [{ id: change.id, selected: change.selected }] : [],
    );
    if (selections.length === 0) return;
    setSelectedEdgeIds((previous) => {
      const next = new Set(previous);
      for (const change of selections) {
        if (change.selected) next.add(change.id);
        else next.delete(change.id);
      }
      return next;
    });
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      write(() => {
        const result = api.getState().connect(connection.source, connection.target);
        if (result.ok) {
          setRejection(null);
          return `Connected ${connection.source} to ${connection.target}.`;
        }
        // The refusal announces itself, with the strip.
        showRejection(result.rejection);
        return null;
      });
    },
    [api, write, showRejection],
  );

  const onConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const refusal = rejectionFromConnectionEnd(api.getState().doc, state);
      if (refusal !== null) showRejection(refusal);
    },
    [api, showRejection],
  );

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      // The payload is core's vocabulary, because `addBlock` is: the sidebar palette is
      // built from core's BlockType and a wrap dropped from it is a `wrap` block, which
      // this canvas draws with the auto-wrap component.
      const raw = event.dataTransfer.getData("application/reactflow");
      if (!isCoreBlockType(raw)) return;
      write(() => {
        const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        return api.getState().addBlock(raw, position) === null ? null : `Added ${raw} block.`;
      });
    },
    [api, screenToFlowPosition, write],
  );

  const onPaneClick = useCallback(() => {
    api.getState().setSelection([]);
    setSelectedEdgeIds(new Set());
  }, [api]);

  const beginDragGesture = useCallback(() => {
    api.getState().beginEdit("move block");
  }, [api]);

  const endDragGesture = useCallback(() => {
    api.getState().endEdit();
  }, [api]);

  const handleDeleteSelected = useCallback(() => {
    write(() => {
      const removed = deleteSelectedBlocks(api);
      if (removed.length === 0) return null;
      return `Removed ${removed.length} ${removed.length === 1 ? "block" : "blocks"}.`;
    });
  }, [api, write]);

  const handleCopy = useCallback(() => {
    const state = api.getState();
    if (state.selectedBlockIds.length === 0) return;
    const snapshot = buildClipboard(state);
    if (snapshot === null) {
      announce("Input blocks can't be copied — a strategy has exactly one.");
      return;
    }
    clipboard = snapshot;
    const count = snapshot.blocks.length;
    announce(
      snapshot.droppedInput
        ? `Copied ${count} blocks; the input block was left out.`
        : `Copied ${count} ${count === 1 ? "block" : "blocks"}.`,
    );
  }, [api, announce]);

  const handlePaste = useCallback(() => {
    const snapshot = clipboard;
    if (snapshot === null) return;
    write(() => {
      const created = pasteClipboard(api, snapshot);
      if (created.length === 0) return null;
      return `Pasted ${created.length} ${created.length === 1 ? "block" : "blocks"}.`;
    });
  }, [api, write]);

  const handleDuplicate = useCallback(() => {
    handleCopy();
    // The clipboard is a synchronous module variable; nothing here needs a tick.
    handlePaste();
  }, [handleCopy, handlePaste]);

  /**
   * Scoped to the flow wrapper rather than `window`, so the composer never hijacks Ctrl+A
   * or Ctrl+C for the rest of the page — and every branch checks whether it has work to do
   * BEFORE calling preventDefault, so an empty selection leaves native copy alone.
   */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (isTypingTarget(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const state = api.getState();

      if (mod && key === "z" && !event.shiftKey) {
        event.preventDefault();
        write(() => {
          state.undo();
          return null;
        });
        return;
      }
      if (mod && (key === "y" || (key === "z" && event.shiftKey))) {
        event.preventDefault();
        write(() => {
          state.redo();
          return null;
        });
        return;
      }
      if (mod && key === "a") {
        if (state.doc.blocks.length === 0) return;
        event.preventDefault();
        state.setSelection(state.doc.blocks.map((b) => b.id));
        return;
      }
      if (mod && key === "c") {
        if (state.selectedBlockIds.length === 0) return;
        event.preventDefault();
        handleCopy();
        return;
      }
      if (mod && key === "v") {
        if (clipboard === null) return;
        event.preventDefault();
        handlePaste();
        return;
      }
      if (mod && key === "d") {
        if (state.selectedBlockIds.length === 0) return;
        event.preventDefault();
        handleDuplicate();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (state.selectedBlockIds.length === 0) return;
        event.preventDefault();
        handleDeleteSelected();
        return;
      }
      if (event.key === "Escape") {
        if (state.selectedBlockIds.length === 0) return;
        state.setSelection([]);
      }
    },
    [api, write, handleCopy, handlePaste, handleDuplicate, handleDeleteSelected],
  );

  /**
   * BOTH arrivals — the first paint and every later template/share load — go through the one
   * function, so the mount cannot centre while a load anchors. That is also why the
   * `fitView` prop is gone from `<ReactFlow>`: it solves its own viewport with its own rule,
   * and two rules for one moment is how the opening frame drifts from the reviewed one.
   *
   * The counter is what the effect depends on: a boolean "should refit" derived during render
   * is already false by the time effects run, since the render-time adjustment that set it
   * re-rendered first.
   */
  const [fit, setFit] = useState({ nonce: 0, from: loadedFrom });
  if (fit.from !== loadedFrom) {
    setFit((previous) => ({ nonce: previous.nonce + 1, from: loadedFrom }));
  }
  const fitNonce = fit.nonce;
  const nodesInitialized = useNodesInitialized();
  useEffect(() => {
    // Measured dimensions are what `getNodesBounds` needs; unmeasured nodes would solve a
    // viewport for a graph of zero-sized boxes.
    if (!nodesInitialized) return;
    const frame = requestAnimationFrame(() => {
      const rect = fieldRef.current?.getBoundingClientRect();
      const placed = getNodes();
      if (rect === undefined || placed.length === 0) return;
      const bounds = getNodesBounds(placed);
      if (bounds.width <= 0 || bounds.height <= 0) return;
      void setViewport(
        arrivalViewport(bounds, { width: rect.width, height: rect.height }),
        { duration: fitDurationMs() },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [fitNonce, nodesInitialized, getNodes, getNodesBounds, setViewport]);

  const barPosition = useMemo(
    () => selectionBarPosition(nodes, selected, viewport),
    [nodes, selected, viewport],
  );

  /**
   * The keyboard-add position, published to the host (treatment §4: "Enter adds at canvas
   * center" — drag-only is an a11y failure). The resolver reads the rect and the transform
   * at CALL time rather than closing over them, so a pan between keystrokes cannot make it
   * stale, and it is torn down on unmount so a host holding the ref cannot call into a
   * dead canvas.
   */
  useEffect(() => {
    if (dropPositionRef === undefined) return;
    dropPositionRef.current = () => {
      const rect = fieldRef.current?.getBoundingClientRect();
      if (rect === undefined) return CANVAS_ORIGIN;
      return screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    };
    const ref = dropPositionRef;
    return () => {
      ref.current = null;
    };
  }, [dropPositionRef, screenToFlowPosition]);

  return (
    // Every node component renders inside React Flow, so the runtime that carries the
    // provenanced quantities has to wrap it: a provider mounted beside the flow would be
    // invisible to the very components it exists for.
    <BlockRuntimeProvider value={runtime}>
      <div ref={fieldRef} className="relative h-full w-full bg-background">
        {/* One live region for the whole canvas, mounted before its first message. The
            keyed span is the remount that makes an identical repeat announce again. */}
        <p aria-live="polite" className="sr-only">
          <span key={announcement.nonce}>{announcement.message}</span>
        </p>

        <ReactFlow
          // React Flow's own wrapper already carries role="application" and hard-codes it
          // after the prop spread, so the name, the tab stop and the keyboard scope go ON
          // that element — a second application role wrapped around it would be two
          // application regions for one canvas.
          aria-label="Strategy canvas"
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="focus-ring"
          nodes={nodes}
          edges={edges}
          nodeTypes={BLOCK_COMPONENTS}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onNodeDragStart={beginDragGesture}
          onNodeDragStop={endDragGesture}
          onSelectionDragStart={beginDragGesture}
          onSelectionDragStop={endDragGesture}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onPaneClick={onPaneClick}
          // T26: while a run holds the document the two POINTER writes are deactivated at the
          // source — a drag that snaps back and a connection refused after the user crossed the
          // canvas are worse refusals than a gesture that never starts (the palette's rule).
          // Selection stays on: reads are never locked.
          nodesDraggable={writeLockReason === null}
          nodesConnectable={writeLockReason === null}
          elementsSelectable
          defaultEdgeOptions={{ type: "allocation" }}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          selectionKeyCode="Shift"
          // multiSelectionKeyCode is deliberately NOT set: overriding it to Shift removed
          // the platform default (Meta on macOS, Control elsewhere) and left the canvas
          // with no modifier-click multi-select at all.
          selectionMode={SelectionMode.Partial}
          // Deletion is owned by the wrapper handler above so there is exactly one
          // deletion path, and so a multi-block delete can be wrapped in one edit gesture.
          deleteKeyCode={null}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="hsl(var(--border))"
          />
          <Panel position="bottom-left">
            {/* No overflow clip: an outline is drawn outside the border box, so an
                overflow-hidden ancestor erases the focus ring of every button inside. */}
            <div
              role="group"
              aria-label="Canvas view"
              className="flex flex-col rounded-md border border-border bg-card"
            >
              <Button
                variant="ghost"
                size="icon"
                aria-label="Zoom in"
                className="rounded-b-none border-b border-border text-muted-foreground hover:text-foreground"
                onClick={() => void zoomIn()}
              >
                <Plus aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Zoom out"
                className="rounded-none border-b border-border text-muted-foreground hover:text-foreground"
                onClick={() => void zoomOut()}
              >
                <Minus aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Fit strategy to view"
                className="rounded-t-none text-muted-foreground hover:text-foreground"
                onClick={() => void fitView({ duration: fitDurationMs() })}
              >
                <Maximize aria-hidden="true" />
              </Button>
            </div>
          </Panel>
        </ReactFlow>

        {blocks.length === 0 ? <CanvasEmptyState writeLockReason={writeLockReason} /> : null}

        <SelectionActionBar
          count={selectedBlockIds.length}
          position={barPosition}
          onDuplicate={handleDuplicate}
          onDelete={handleDeleteSelected}
        />

        <ConnectionRejectionNotice rejection={rejection} />
      </div>
    </BlockRuntimeProvider>
  );
}

/**
 * Only the React Flow provider is mounted here. The composer store provider belongs to the
 * app shell, because the sidebar, the canvas and the simulation panel must share ONE
 * document — a provider nested here would hand the canvas a private second store.
 */
export function StrategyCanvas(props: StrategyCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
