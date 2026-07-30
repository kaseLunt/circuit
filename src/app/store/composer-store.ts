/**
 * Composer document store (design §2, §4a-4c, §6, §7; W05 rulings R2/R6/R7/R9).
 *
 * Framework-free on purpose: this module imports no React and no react-query, so vitest
 * drives every action without a DOM and the share encoder, the window-level keyboard
 * handler and React Flow's callbacks can read and write it through `getState()` outside a
 * hook. The React binding ("use client") owns the lazy singleton — a module-level
 * singleton is per-process, not per-request, so no server component may import one.
 *
 * The money truth in state is literally `core/graph.ts`'s StrategyGraph. Rates, prices,
 * LTVs and health factors are NOT state: they are derived from (doc, ChainSnapshot), and
 * the snapshot stays in react-query where its lifecycle belongs. The store holds only
 * `Entered` user input — an amount string and integer bps — plus view scaffolding.
 *
 * THREE ENTRY POINTS, ONE GATE (R2): a share URL, a localStorage draft and a template all
 * pass `core/graph.ts`'s `validateGraph` before a graph becomes `doc`. The first two go
 * through `decodeShareGraph`, whose second gate IS `validateGraph`; the third calls it
 * directly, because a template builder takes open parameters and "it came from a
 * template" stops being a trust argument the moment a caller supplies one.
 *
 * ONE PARAMETER WHITELIST, TWO WRITE PATHS (R7): `setBlockParam` admits exactly the keys
 * and value domains `lib/share/encode.ts` transports. Without the value half, a
 * whitelisted key (`asset`) carrying an address cleared the UI write path and landed in
 * `doc`, in undo history and in the next share link.
 *
 * ONE WRITE BOUNDARY, HELD BY THE STORE (T26; Codex round-3 finding 2): while an execution
 * holds the document, EVERY action that could change it refuses, and each refuses in its own
 * return shape. The lock is not a prop the controls promise to honour — it lives here, behind
 * `lockGuarded`, so a control that forgets it is harmless. Reads and selection stay live.
 */
import { createStore, type Mutate, type StoreApi } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { outgoingBps } from "../../core/allocation";
import {
  MAX_EDGES,
  topologicalOrder,
  validateGraph,
  type Asset,
  type Block,
  type BlockType,
  type Edge,
  type StrategyGraph,
} from "../../core/graph";
import {
  derived,
  paramOriginKey,
  wrapParam,
  type ConfiguredOrigin,
  type Derived,
  type ParamOrigins,
  type Provenanced,
} from "../../core/provenance";
import {
  WRAP_PAIRS,
  optimizeRoute,
  outputAssetOf,
  type InsertedEdge,
  type OptimizedRoute,
} from "../../core/route-optimizer";
import {
  MIN_ALLOCATION_BPS,
  decodeShareGraph,
  isAllowedParamKey,
  isAllowedParamValue,
  type DecodeFailure,
} from "../../lib/share/encode";
import { layoutGraph } from "../../lib/strategy/layout";
import { getTemplate } from "../../lib/strategy/templates";
import { FULL_ALLOCATION_BPS, type BlockView } from "../../lib/strategy/types";

const HISTORY_LIMIT = 50;

const EMPTY_GRAPH: StrategyGraph = { blocks: [], edges: [] };

// —————————————————— param origins (SPEC §5: Configured vs Entered) ——————————————————

/**
 * The three author defaults a document can arrive carrying, each naming the constant a
 * tooltip will cite. They are declared here rather than imported as values because what is
 * recorded is the CITATION, not the number — the store must not re-import a default and
 * thereby gain a second opinion about what the document says.
 */
const CONFIGURED_INPUT_AMOUNT: ConfiguredOrigin = {
  name: "DEFAULT_INPUT_ETH",
  definedAt: "src/lib/strategy/templates.ts",
};
const CONFIGURED_BORROW_ALLOCATION: ConfiguredOrigin = {
  name: "DEFAULT_BORROW_ALLOCATION_BPS",
  definedAt: "src/lib/strategy/templates.ts",
};
const CONFIGURED_EDGE_ALLOCATION: ConfiguredOrigin = {
  name: "FULL_ALLOCATION_BPS",
  definedAt: "src/lib/strategy/types.ts",
};

export const inputAmountOriginKey = (blockId: string): string =>
  paramOriginKey("block", blockId, "amount");
export const borrowAllocationOriginKey = (blockId: string): string =>
  paramOriginKey("block", blockId, "allocationBps");
export const edgeAllocationOriginKey = (edgeId: string): string =>
  paramOriginKey("edge", edgeId, "allocationBps");

/**
 * Every user-editable param a TEMPLATE arrives carrying, stamped with the constant it came
 * from. A share URL or a restored draft gets none of this: those numbers were chosen by a
 * person, which is exactly what an absent origin means.
 */
function templateParamOrigins(graph: StrategyGraph): ParamOrigins {
  const origins: Record<string, ConfiguredOrigin> = {};
  for (const block of graph.blocks) {
    if (block.type === "input" && block.params["amount"] !== undefined) {
      origins[inputAmountOriginKey(block.id)] = CONFIGURED_INPUT_AMOUNT;
    }
    if (block.type === "borrow" && block.params["allocationBps"] !== undefined) {
      origins[borrowAllocationOriginKey(block.id)] = CONFIGURED_BORROW_ALLOCATION;
    }
  }
  for (const edge of graph.edges) {
    origins[edgeAllocationOriginKey(edge.id)] = CONFIGURED_EDGE_ALLOCATION;
  }
  return origins;
}

/**
 * A user edit RETIRES an origin: the value is now theirs. Returning the same object when
 * there was nothing to retire matters — zustand compares by reference, and a fresh map on
 * every keystroke would re-render every consumer subscribed to origins.
 *
 * Deliberately NOT undone by `undo`. Origin is a fact about what the user did, and dragging
 * the slider back to 5000 does not un-drag it — value equality is not origin. This is why
 * origins live outside the history stacks rather than inside `HistoryEntry`.
 */
function retireOrigin(origins: ParamOrigins, key: string): ParamOrigins {
  if (!(key in origins)) return origins;
  const next = { ...origins };
  delete next[key];
  return next;
}

function withEdgeOrigins(origins: ParamOrigins, edgeIds: readonly string[]): ParamOrigins {
  if (edgeIds.length === 0) return origins;
  const next = { ...origins };
  for (const id of edgeIds) next[edgeAllocationOriginKey(id)] = CONFIGURED_EDGE_ALLOCATION;
  return next;
}

/**
 * Origins for the wrap pass, decided per edge by LINEAGE rather than by "it is new".
 *
 * Inserting a wrap does not change whose number the allocation is. The inbound replacement
 * carries the replaced edge's own `allocationBps` — a 60% the user dragged is still theirs
 * after a wrap lands in front of it — so it inherits that edge's origin verbatim: entered
 * stays entered, a template's configured constant stays configured. Only the outbound leg
 * is genuinely this pass's invention, and only it cites the full-allocation constant.
 *
 * Getting this wrong is not cosmetic: `core/plan.ts` wraps a partial edge allocation as
 * `entered` in its own derivation tree, so stamping the inbound edge configured would put
 * the block's tooltip and the health factor's provenance trail in direct contradiction
 * about the same number.
 */
function withInsertedEdgeOrigins(
  origins: ParamOrigins,
  inserted: readonly InsertedEdge[],
): ParamOrigins {
  if (inserted.length === 0) return origins;
  const next = { ...origins };
  for (const edge of inserted) {
    const key = edgeAllocationOriginKey(edge.id);
    if (!edge.carriesReplacedAllocation) {
      next[key] = CONFIGURED_EDGE_ALLOCATION;
      continue;
    }
    const inheritedFrom = origins[edgeAllocationOriginKey(edge.replacedEdgeId)];
    // Absent means the replaced edge was the user's; the heir must be absent too, not
    // whatever a previous occupant of this id left behind.
    if (inheritedFrom === undefined) delete next[key];
    else next[key] = inheritedFrom;
  }
  return next;
}

/** A drop/drag coordinate. Narrower than `BlockView` so a caller placing a block never
 *  has to claim anything about auto-insertion — that flag is the store's to set. */
export interface BlockPosition {
  readonly x: number;
  readonly y: number;
}

export type LoadSource =
  | { readonly kind: "blank" }
  | { readonly kind: "template"; readonly templateId: string }
  | { readonly kind: "share-url" }
  | { readonly kind: "local-draft" };

interface HistoryEntry {
  /** Names the action, so the undo affordance can say what it will revert (§7). */
  readonly label: string;
  readonly doc: StrategyGraph;
}

export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type ConnectRejection =
  | { readonly code: "unknown-block" }
  | { readonly code: "self-loop" }
  | { readonly code: "duplicate-edge" }
  | { readonly code: "edge-limit" }
  | { readonly code: "input-cannot-consume" }
  | { readonly code: "would-create-cycle" }
  | { readonly code: "target-already-has-producer"; readonly producerId: string }
  /**
   * The document is held by a run (T26). Unlike every other code this is not a property of
   * the graph — `connectRejection` cannot see it and does not answer it — so it carries the
   * holder's own sentence instead of copy the canvas restates (§10.10: one definition).
   */
  | { readonly code: "document-locked"; readonly reason: string };

export type ConnectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: ConnectRejection };

/**
 * `failure: null` means there was nothing to load (an ABSENT draft) — silence, not an
 * error state. A non-null failure means a payload WAS present and was rejected, which the
 * canvas must say out loud. `loadFromShare` never returns a null failure.
 *
 * `refusal` is the other axis: the payload was never examined at all because the store refused
 * to load anything (the T26 run lock). A verdict about the payload and a refusal to consider
 * one are different facts, so they are different fields rather than one overloaded null.
 */
export type LoadResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failure: DecodeFailure | null;
      readonly refusal: string | null;
    };

export interface ComposerState {
  readonly doc: StrategyGraph;
  /** Monotonic; the memo key for every derived computation (paired with snapshot.block). */
  readonly rev: number;

  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
  /** Open gesture (slider drag, amount typing). Collapses to ONE history entry on commit. */
  readonly pendingEdit: { readonly label: string; readonly base: StrategyGraph } | null;

  /** Canvas-only, keyed by block id: coordinates plus the auto-wrap badge. Never
   *  money-bearing, never transported, never undoable (§7). */
  readonly view: Readonly<Record<string, BlockView>>;
  /**
   * SPEC §5 provenance for user-editable params, BESIDE the document rather than inside it:
   * the doc is transported, hashed and compared byte-for-byte, and origin is a fact about
   * the session, not about the graph. Absent key ⇒ the user entered it.
   */
  readonly paramOrigins: ParamOrigins;
  readonly selectedBlockIds: readonly string[];

  readonly loadedFrom: LoadSource;
  /** SPEC §3.4 "Simulate anyway": explicit one-shot override of the client-side risk
   *  gate. Armed only by the user, disarmed by ANY graph mutation. */
  readonly overrideGateArmed: boolean;
  /** Why the last load failed; drives the designed error state, never a silent blank canvas. */
  readonly lastLoadProblem: DecodeFailure | null;
  /**
   * T26's write lock: the sentence every document write refuses with while an execution holds
   * the document, or null outside a run. Held state rather than a prop threaded through the
   * tree, because the store is where the refusal has to happen — see `lockGuarded`. Exposed so
   * a control that dispatched a refused write can render WHY without being told separately.
   */
  readonly writeLock: string | null;
}

/**
 * Every action that can change the DOCUMENT — the ones the run lock refuses.
 *
 * Membership here is a contract, not a comment: `lockGuarded` returns a complete
 * `DocumentActions` written as an explicit object literal, so a new document action is a
 * compile error until it is wrapped, and an action that genuinely is not a document write has
 * to be declared in `ViewActions` deliberately. That is the difference between "one write seam
 * no control can forget" as a claim and as a structure (Codex round-3 finding 2).
 */
export interface DocumentActions {
  /** The id of the block added, or null when the write was refused — never a fabricated id. */
  addBlock(type: BlockType, at: BlockPosition): string | null;
  removeBlock(id: string): void;
  setBlockParam(id: string, key: string, value: string | number): ActionResult;
  setBorrowAllocationBps(id: string, bps: number): ActionResult;
  setEdgeAllocationBps(edgeId: string, bps: number): ActionResult;
  connect(source: string, target: string): ConnectResult;
  disconnect(edgeId: string): void;
  insertRequiredWraps(): { readonly inserted: number };

  beginEdit(label: string): void;
  endEdit(): void;

  loadTemplate(templateId: string): boolean;
  loadFromShare(encoded: string): LoadResult;
  hydrateLocalDraft(raw: string | null): LoadResult;
  clear(): void;

  undo(): void;
  redo(): void;

  /** View state, but a canvas gesture all the same: a run freezes the picture it is
   *  executing, so a drag is refused with everything else (T26). */
  moveBlock(id: string, at: BlockPosition): void;
}

/**
 * The actions the lock leaves alone. None of them can change `doc`, and T26 is explicit that
 * reads stay live at full legibility while a run holds the document — inspection is exactly
 * what matters at the moment money moves.
 */
export interface ViewActions {
  setSelection(ids: readonly string[]): void;
  /** SPEC §3.4's one-shot override. Not a document write; any graph mutation disarms it. */
  armOverride(): void;
  /**
   * The ONE composition point that hands the store the lock. Called by the composer host from
   * the execution driver's own machine state (`runLocksDocument` → `RUN_LOCK_REASON`), because
   * the store cannot see a run and must not invent an opinion about one.
   */
  setWriteLock(reason: string | null): void;
}

export type ComposerActions = DocumentActions & ViewActions;

export type ComposerStore = ComposerState & ComposerActions;
export type ComposerStoreApi = Mutate<
  StoreApi<ComposerStore>,
  [["zustand/subscribeWithSelector", never]]
>;

/**
 * Params whose value is FORCED by a single-member union in core/graph.ts (input asset is
 * ETH; lend/borrow protocol is aave-v3; the only borrowable asset is WETH). Nothing is
 * invented: where core admits more than one value — stake protocol, lend collateral
 * asset, borrow allocation — the param is left unset and the block renders unconfigured
 * until the user or a connection supplies it.
 */
const STRUCTURAL_PARAMS: Readonly<Record<BlockType, Readonly<Record<string, string>>>> = {
  input: { asset: "ETH" },
  stake: {},
  wrap: {},
  unwrap: {},
  lend: { protocol: "aave-v3" },
  borrow: { protocol: "aave-v3", asset: "WETH" },
};

/** Colon-free by construction: `TransactionStep.id` is `${blockId}:supply`, and stable
 *  ids are what make plan snapshots and share URLs pinnable (§6). */
const ID_PREFIX: Readonly<Record<BlockType, string>> = {
  input: "in",
  stake: "stake",
  wrap: "wrap",
  unwrap: "unwrap",
  lend: "supply",
  borrow: "borrow",
};

function allocateBlockId(type: BlockType, used: ReadonlySet<string>): string {
  const prefix = ID_PREFIX[type];
  let n = 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/** Single-producer flow makes the target id a collision-free edge id; the suffix arm only
 *  fires when a decoded payload already claimed that id for some other edge. */
function allocateEdgeId(target: string, used: ReadonlySet<string>): string {
  const base = `e:${target}`;
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Edge flow allocation. Block params go through the codec's table instead (R6/R7). */
function isAllocationBps(value: number): boolean {
  return (
    Number.isInteger(value) && value >= MIN_ALLOCATION_BPS && value <= FULL_ALLOCATION_BPS
  );
}

const BPS_RANGE_REASON = `allocation must be a whole basis-point value in [${MIN_ALLOCATION_BPS}, ${FULL_ALLOCATION_BPS}]`;

function viewEntry(at: BlockPosition, isAutoInserted: boolean): BlockView {
  return { x: at.x, y: at.y, isAutoInserted };
}

/**
 * The old store kept `history: HistoryEntry[]` plus a `historyIndex` pointing INTO it
 * while the live doc lived outside it — the source of its off-by-one and its dead ternary.
 * Here the live doc is never inside a stack: past / present / future, three disjoint things.
 */
function commitDoc(
  state: ComposerState,
  next: StrategyGraph,
  label: string,
): Partial<ComposerState> {
  const base = {
    doc: next,
    rev: state.rev + 1,
    future: [] as readonly HistoryEntry[],
    // Any graph mutation disarms "Simulate anyway" (SPEC §3.4: the override is one-shot,
    // and re-arming must be an explicit user act after the edit that provoked it).
    overrideGateArmed: false,
  };
  // Inside an open gesture the pre-gesture doc is already captured; push nothing.
  if (state.pendingEdit !== null) return base;
  return { ...base, past: [...state.past, { label, doc: state.doc }].slice(-HISTORY_LIMIT) };
}

/** A load is a new document, not an edit: history resets rather than letting undo walk
 *  backwards into whatever the user had before opening a stranger's link. */
function loadedState(
  state: ComposerState,
  graph: StrategyGraph,
  from: LoadSource,
): Partial<ComposerState> {
  return {
    doc: graph,
    rev: state.rev + 1,
    past: [],
    future: [],
    pendingEdit: null,
    // Positions are never transported, so they are recomputed deterministically. A wrap
    // that arrived in the payload is indistinguishable from a user-placed one and
    // deliberately carries no "Auto" badge.
    view: layoutGraph(graph),
    // A template arrives carrying the author's defaults; a share URL or a restored draft
    // carries numbers a person chose. Decided here, in the one helper every load goes
    // through, so no arrival path can forget to say which it is.
    paramOrigins: from.kind === "template" ? templateParamOrigins(graph) : {},
    selectedBlockIds: [],
    loadedFrom: from,
    overrideGateArmed: false,
    lastLoadProblem: null,
  };
}

/**
 * A UI affordance, not a second validator: it exists so React Flow can refuse an
 * impossible drop with an inline reason instead of letting the user build a graph that
 * `validateGraph` will reject later. `validateGraph` remains the sole authority and runs
 * before any plan/simulate. Acyclicity is answered by core's OWN topological sort, so
 * there is no duplicated cycle detection to drift.
 *
 * CHECK ORDER is load-bearing. Identity and capacity first, then the impossibilities the
 * user cannot resolve by editing something else, and the single-producer rule LAST. The
 * cycle probe therefore answers even when the target already has a producer — with the
 * probe behind that check it was unreachable for every target of in-degree 1, i.e. for
 * every block in a well-formed document. "Disconnect the existing producer" is the wrong
 * advice when the resulting edge would still close a loop.
 *
 * Deliberately no asset-flow check: graph.ts assigns asset semantics to plan.ts, and the
 * route optimizer inserts the missing wrap rather than blocking the drop.
 */
export function connectRejection(
  g: StrategyGraph,
  source: string,
  target: string,
): ConnectRejection | null {
  const ids = new Set(g.blocks.map((b) => b.id));
  if (!ids.has(source) || !ids.has(target)) return { code: "unknown-block" };
  if (source === target) return { code: "self-loop" };
  if (g.edges.some((e) => e.source === source && e.target === target)) {
    return { code: "duplicate-edge" };
  }
  if (g.edges.length >= MAX_EDGES) return { code: "edge-limit" };

  const targetBlock = g.blocks.find((b) => b.id === target);
  if (targetBlock !== undefined && targetBlock.type === "input") {
    return { code: "input-cannot-consume" };
  }

  // Every endpoint is a known block (checked above) and the store never holds a dangling
  // edge, so the only thing this throw reports is a cycle.
  const probe: StrategyGraph = {
    blocks: g.blocks,
    edges: [...g.edges, { id: "probe", source, target, allocationBps: FULL_ALLOCATION_BPS }],
  };
  try {
    topologicalOrder(probe);
  } catch {
    return { code: "would-create-cycle" };
  }

  const existingProducer = g.edges.find((e) => e.target === target);
  if (existingProducer !== undefined) {
    return { code: "target-already-has-producer", producerId: existingProducer.source };
  }
  return null;
}

/**
 * Auto-configure-on-connect, in the honest form: STRUCTURAL params only. The predecessor
 * used this hook to write `apy: getDefaultApy(...)`, `maxLtv` and `isConfigured: true`
 * into the graph — a chain-read value laundered into a shareable document.
 */
function inferredParams(target: Block, produced: Asset): Readonly<Record<string, string>> | null {
  switch (target.type) {
    case "wrap":
    case "unwrap": {
      if (target.params["from"] !== undefined || target.params["to"] !== undefined) return null;
      const pair = WRAP_PAIRS.find((p) =>
        target.type === "wrap" ? p.unwrapped === produced : p.wrapped === produced,
      );
      if (pair === undefined) return null;
      return target.type === "wrap"
        ? { from: pair.unwrapped, to: pair.wrapped }
        : { from: pair.wrapped, to: pair.unwrapped };
    }
    case "lend":
      if (target.params["asset"] !== undefined) return null;
      // Echo what the producer hands over; graph.ts says whether it is supported
      // collateral, so an unsupported one surfaces as an error rather than being dropped.
      return { asset: produced };
    case "input":
    case "stake":
    case "borrow":
      return null;
  }
}

function withInferredStructure(
  blocks: readonly Block[],
  sourceId: string,
  targetId: string,
): readonly Block[] {
  const source = blocks.find((b) => b.id === sourceId);
  const target = blocks.find((b) => b.id === targetId);
  if (source === undefined || target === undefined) return blocks;
  const produced = outputAssetOf(source);
  if (produced === null) return blocks;
  const inferred = inferredParams(target, produced);
  if (inferred === null) return blocks;
  // The inference path is a write path too: it goes through the same whitelist, and fails
  // closed, so no route ever puts a value in `params` that the transport would refuse.
  const accepted = Object.entries(inferred).every(([key, value]) =>
    isAllowedParamValue(target.type, key, value),
  );
  if (!accepted) return blocks;
  return blocks.map((b) => (b.id === targetId ? { ...b, params: { ...b.params, ...inferred } } : b));
}

/**
 * The route optimizer mints ids containing ':' (`auto-wrap:${edgeId}`). Those are legal
 * inside core, but a block id with a colon makes `${blockId}:supply` step ids ambiguous
 * and cannot ride the share transport at all — so an optimized doc would silently become
 * unshareable and undraftable. Renaming the inserted blocks into the store's deterministic
 * colon-free scheme (and giving their new edges the store's `e:${target}` scheme) keeps the
 * optimizer the authority on WHAT to insert while the store stays the authority on ids.
 *
 * Consequence, handled by the caller (R9): `OptimizedRoute.autoInsertedBlockIds` no longer
 * names the blocks in `doc`, so the "Auto" badge is carried by `view[id].isAutoInserted`
 * over the CANONICAL ids returned here.
 */
/**
 * Every edge id any REACHABLE document holds — the current one, every entry in both history
 * stacks, and an open gesture's base.
 *
 * `paramOrigins` deliberately does not unwind with undo (origin is a fact about what the
 * user did, and undoing an edit does not un-do the doing). That makes an edge id a durable
 * key across time, so minting a fresh edge under an id some restorable document also uses
 * lets a stamp written now land on a different edge later. Reserving against the immediate
 * predecessor is not enough: disconnect an edge, insert a wrap, then undo twice, and the
 * colliding document is two steps back.
 *
 * The walk is over a bounded history (`HISTORY_LIMIT`), so completeness is cheaper than an
 * argument about which stack survives this particular transition — and an argument like
 * that is exactly what went wrong the first time. Over-reserving costs one id suffix;
 * under-reserving corrupts provenance.
 */
function reservedEdgeIds(state: ComposerState): ReadonlySet<string> {
  const ids = new Set<string>();
  const collect = (graph: StrategyGraph): void => {
    for (const edge of graph.edges) ids.add(edge.id);
  };
  collect(state.doc);
  for (const entry of state.past) collect(entry.doc);
  for (const entry of state.future) collect(entry.doc);
  if (state.pendingEdit !== null) collect(state.pendingEdit.base);
  return ids;
}

function canonicalizeInserted(
  route: OptimizedRoute,
  usedBlockIds: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): {
  readonly graph: StrategyGraph;
  readonly insertedBlockIds: readonly string[];
  readonly insertedEdges: readonly InsertedEdge[];
} {
  const inserted = new Set(route.autoInsertedBlockIds);
  const blockIds = new Set(usedBlockIds);
  const rename = new Map<string, string>();
  for (const b of route.graph.blocks) {
    if (!inserted.has(b.id)) continue;
    const id = allocateBlockId(b.type, blockIds);
    blockIds.add(id);
    rename.set(b.id, id);
  }

  const renamed = (id: string): string => {
    const next = rename.get(id);
    return next === undefined ? id : next;
  };
  const touched = (source: string, target: string): boolean =>
    rename.has(source) || rename.has(target);

  const blocks = route.graph.blocks.map((b) => (rename.has(b.id) ? { ...b, id: renamed(b.id) } : b));
  const edgeIds = new Set([
    ...route.graph.edges.filter((e) => !touched(e.source, e.target)).map((e) => e.id),
    /**
     * `allocateEdgeId` derives an id from the target block, so the outbound replacement
     * (`wrap1 → supply1`) naturally wants `e:supply1` — exactly the id the edge it replaced
     * would have had if `connect` created it. Two reservations keep that id from being
     * handed out twice with two different meanings:
     *
     * 1. the ids this pass REPLACED, which this function owns unconditionally, and
     * 2. `reserved` — every id any document the caller can still reach holds (see
     *    `reservedEdgeIds`), which is what makes multi-level undo safe.
     */
    ...route.insertedEdges.map((e) => e.replacedEdgeId),
    ...reserved,
  ]);
  const edgeRename = new Map<string, string>();
  const edges = route.graph.edges.map((e) => {
    if (!touched(e.source, e.target)) return e;
    const target = renamed(e.target);
    const id = allocateEdgeId(target, edgeIds);
    edgeIds.add(id);
    edgeRename.set(e.id, id);
    return { id, source: renamed(e.source), target, allocationBps: e.allocationBps };
  });

  return {
    graph: { blocks, edges },
    insertedBlockIds: [...rename.values()],
    // Lineage survives the rename: the store needs to know which of these carries a user's
    // number and which one this pass invented.
    insertedEdges: route.insertedEdges.map((e) => ({
      ...e,
      id: edgeRename.get(e.id) ?? e.id,
    })),
  };
}

const INITIAL_STATE: ComposerState = {
  doc: EMPTY_GRAPH,
  rev: 0,
  past: [],
  future: [],
  pendingEdit: null,
  view: {},
  paramOrigins: {},
  selectedBlockIds: [],
  loadedFrom: { kind: "blank" },
  overrideGateArmed: false,
  lastLoadProblem: null,
  writeLock: null,
};

/**
 * The write boundary (T26, Codex round-3 finding 2).
 *
 * The lock used to live in the CONTROLS: the palette honoured it, the template rows and Clear
 * canvas did not, and the canvas's connect / drop / delete / paste / undo / drag handlers each
 * carried their own opinion — so "one write seam no control can forget" was a claim about
 * diligence. Here it is a property of the store: every document-mutating dispatch passes
 * through this one function, and a control that forgets the lock is HARMLESS rather than
 * destructive, because the action it dispatches refuses.
 *
 * Each refusal is expressed in that action's OWN return shape, so the refusal is a value the
 * caller can render rather than a silence it has to infer. Where the shape carries no room for
 * a reason (the void actions), the sentence is readable from `writeLock` in state — which is
 * the same string, from the same holder, and not a second copy of it.
 */
function lockGuarded(
  actions: DocumentActions,
  heldBy: () => string | null,
): DocumentActions {
  function guard<A extends readonly unknown[], R>(
    write: (...args: A) => R,
    refuse: (reason: string) => R,
  ): (...args: A) => R {
    return (...args: A) => {
      const reason = heldBy();
      return reason === null ? write(...args) : refuse(reason);
    };
  }
  /** The refusal of an action whose shape has nowhere to say why; `writeLock` says it. */
  const silence = (): void => undefined;
  return {
    addBlock: guard(actions.addBlock, () => null),
    removeBlock: guard(actions.removeBlock, silence),
    setBlockParam: guard(actions.setBlockParam, (reason) => ({ ok: false, reason })),
    setBorrowAllocationBps: guard(actions.setBorrowAllocationBps, (reason) => ({
      ok: false,
      reason,
    })),
    setEdgeAllocationBps: guard(actions.setEdgeAllocationBps, (reason) => ({
      ok: false,
      reason,
    })),
    connect: guard(actions.connect, (reason) => ({
      ok: false,
      rejection: { code: "document-locked", reason },
    })),
    disconnect: guard(actions.disconnect, silence),
    // The count is the truth — nothing was inserted. No UI dispatches this action today; the
    // one that does will read `writeLock` for the sentence, as every void refusal above does.
    insertRequiredWraps: guard(actions.insertRequiredWraps, () => ({ inserted: 0 })),
    beginEdit: guard(actions.beginEdit, silence),
    endEdit: guard(actions.endEdit, silence),
    loadTemplate: guard(actions.loadTemplate, () => false),
    loadFromShare: guard(actions.loadFromShare, (reason) => ({
      ok: false,
      failure: null,
      refusal: reason,
    })),
    hydrateLocalDraft: guard(actions.hydrateLocalDraft, (reason) => ({
      ok: false,
      failure: null,
      refusal: reason,
    })),
    clear: guard(actions.clear, silence),
    undo: guard(actions.undo, silence),
    redo: guard(actions.redo, silence),
    moveBlock: guard(actions.moveBlock, silence),
  };
}

export function createComposerStore(): ComposerStoreApi {
  return createStore<ComposerStore>()(
    subscribeWithSelector((set, get) => {
      /**
       * The unguarded document actions. Nothing outside this factory ever holds them: they are
       * handed straight to `lockGuarded`, and what the store exposes is the guarded set.
       */
      const documentActions: DocumentActions = {
        addBlock: (type, at) => {
          const state = get();
          const id = allocateBlockId(type, new Set(state.doc.blocks.map((b) => b.id)));
          const block: Block = { id, type, params: { ...STRUCTURAL_PARAMS[type] } };
          set({
            ...commitDoc(
              state,
              { blocks: [...state.doc.blocks, block], edges: state.doc.edges },
              `add ${type} block`,
            ),
            view: { ...state.view, [id]: viewEntry(at, false) },
          });
          return id;
        },

        removeBlock: (id) => {
          const state = get();
          if (!state.doc.blocks.some((b) => b.id === id)) return;
          const blocks = state.doc.blocks.filter((b) => b.id !== id);
          const edges = state.doc.edges.filter((e) => e.source !== id && e.target !== id);
          set({
            ...commitDoc(state, { blocks, edges }, "remove block"),
            // The view entry is deliberately kept: it is keyed by id and costs nothing, and
            // keeping it means undoing a delete puts the block back where it was.
            selectedBlockIds: state.selectedBlockIds.filter((s) => s !== id),
          });
        },

        /**
         * The UI half of the ONE parameter whitelist (R7). Key and value are both checked
         * against `lib/share/encode.ts`'s table, so the composer cannot author a document
         * the transport would refuse — and no address can reach `doc`, undo history or the
         * next share link through a whitelisted key.
         */
        setBlockParam: (id, key, value) => {
          const state = get();
          const block = state.doc.blocks.find((b) => b.id === id);
          if (block === undefined) return { ok: false, reason: `no block ${id}` };
          if (!isAllowedParamKey(block.type, key)) {
            return { ok: false, reason: `'${key}' is not a parameter of a ${block.type} block` };
          }
          if (!isAllowedParamValue(block.type, key, value)) {
            return {
              ok: false,
              reason: `value for '${key}' is not an accepted ${block.type} parameter value`,
            };
          }
          if (block.params[key] === value) return { ok: true };
          const blocks = state.doc.blocks.map((b) =>
            b.id === id ? { ...b, params: { ...b.params, [key]: value } } : b,
          );
          set({
            ...commitDoc(state, { blocks, edges: state.doc.edges }, `set ${key}`),
            // The value is the user's now, whatever it was before.
            paramOrigins: retireOrigin(state.paramOrigins, paramOriginKey("block", id, key)),
          });
          return { ok: true };
        },

        /**
         * SPEC §3.3/§3.4. `allocationBps` on a BORROW block is debt opened as a fraction of
         * collateral value at open (the `b` in the §5.2 net-APY equation) — deliberately NOT
         * the same quantity as an edge's `allocationBps` (flow routing).
         *
         * Deliberately NOT clamped to the LTV ceiling: §3.4 requires the over-limit value to
         * be representable so the block can render the rejection math and "Simulate anyway"
         * can run it. Gating is a derived concern, not a store-level clamp.
         */
        setBorrowAllocationBps: (id, bps) => {
          if (!isAllowedParamValue("borrow", "allocationBps", bps)) {
            return { ok: false, reason: BPS_RANGE_REASON };
          }
          const state = get();
          const block = state.doc.blocks.find((b) => b.id === id);
          if (block === undefined || block.type !== "borrow") {
            return { ok: false, reason: `block ${id} is not a borrow block` };
          }
          if (block.params["allocationBps"] === bps) return { ok: true };
          const blocks = state.doc.blocks.map((b) =>
            b.id === id ? { ...b, params: { ...b.params, allocationBps: bps } } : b,
          );
          set({
            ...commitDoc(state, { blocks, edges: state.doc.edges }, "set borrow allocation"),
            paramOrigins: retireOrigin(state.paramOrigins, borrowAllocationOriginKey(id)),
          });
          return { ok: true };
        },

        /**
         * Sibling edges are NEVER silently rewritten. The predecessor redistributed
         * `100 - clamped` across siblings in one-decimal floats, destroying user intent and
         * producing non-integer percentages that splitAmount/validateGraph now reject
         * outright. Over-allocation is surfaced on the source block via
         * `overAllocatedSourceIds` and the user resolves it.
         */
        setEdgeAllocationBps: (edgeId, bps) => {
          if (!isAllocationBps(bps)) return { ok: false, reason: BPS_RANGE_REASON };
          const state = get();
          const edge = state.doc.edges.find((e) => e.id === edgeId);
          if (edge === undefined) return { ok: false, reason: `no edge ${edgeId}` };
          if (edge.allocationBps === bps) return { ok: true };
          const edges = state.doc.edges.map((e) => (e.id === edgeId ? { ...e, allocationBps: bps } : e));
          set({
            ...commitDoc(state, { blocks: state.doc.blocks, edges }, "set edge allocation"),
            paramOrigins: retireOrigin(state.paramOrigins, edgeAllocationOriginKey(edgeId)),
          });
          return { ok: true };
        },

        connect: (source, target) => {
          const state = get();
          const rejection = connectRejection(state.doc, source, target);
          if (rejection !== null) return { ok: false, rejection };
          // Reserved against every REACHABLE document, not just the live one — the same
          // completeness rule the wrap pass uses, and for the same reason: this action stamps
          // a configured origin on the id it mints, `paramOrigins` does not unwind with undo,
          // and so reusing an id some restorable document also holds would leave that stamp
          // sitting on a different edge. Disconnect an edge and reconnect the same endpoints
          // and the live document alone says the id is free; the undo stack disagrees.
          const id = allocateEdgeId(target, reservedEdgeIds(state));
          const edges: Edge[] = [
            ...state.doc.edges,
            { id, source, target, allocationBps: FULL_ALLOCATION_BPS },
          ];
          const blocks = withInferredStructure(state.doc.blocks, source, target);
          const added = edges.filter((e) => !state.doc.edges.some((prev) => prev.id === e.id));
          set({
            ...commitDoc(state, { blocks, edges }, "connect blocks"),
            // The user chose to connect; they did not choose the allocation. It is the
            // store's FULL_ALLOCATION_BPS default until they open the popover.
            paramOrigins: withEdgeOrigins(
              state.paramOrigins,
              added.map((e) => e.id),
            ),
          });
          return { ok: true };
        },

        disconnect: (edgeId) => {
          const state = get();
          if (!state.doc.edges.some((e) => e.id === edgeId)) return;
          set(
            commitDoc(
              state,
              { blocks: state.doc.blocks, edges: state.doc.edges.filter((e) => e.id !== edgeId) },
              "disconnect blocks",
            ),
          );
        },

        /**
         * Pure route-optimizer pass, ONE history entry. A no-op run pushes nothing, so
         * clicking "Auto" twice does not cost two undos. `optimizeRoute` throws on an id
         * collision; that is deliberately not caught — colon-bearing block ids are
         * unreachable from every write path, so a collision is a real invariant violation.
         *
         * The canvas is laid out in ONE generation afterwards (R9): an insertion changes the
         * graph's shape, and copying coordinates for the inserted blocks only would drop a
         * new block on top of a user-dragged one. The "Auto" badge rides `view`, keyed by the
         * canonical ids, and survives every later layout because it is merged forward here.
         */
        insertRequiredWraps: () => {
          const state = get();
          const route = optimizeRoute(state.doc);
          if (route.autoInsertedBlockIds.length === 0) return { inserted: 0 };
          const canonical = canonicalizeInserted(
            route,
            new Set(state.doc.blocks.map((b) => b.id)),
            reservedEdgeIds(state),
          );
          const inserted = new Set(canonical.insertedBlockIds);
          const positions = layoutGraph(canonical.graph);
          const view: Record<string, BlockView> = {};
          for (const b of canonical.graph.blocks) {
            const at = positions[b.id];
            const previous = state.view[b.id];
            // No coordinate is ever invented: if the layout pass omits a block, its previous
            // position stands, and if it has none the canvas asks for one.
            const base = at === undefined ? previous : at;
            if (base === undefined) continue;
            const wasAuto = previous !== undefined && previous.isAutoInserted === true;
            view[b.id] = viewEntry(base, inserted.has(b.id) || wasAuto);
          }
          set({
            ...commitDoc(state, canonical.graph, "insert required wraps"),
            view,
            paramOrigins: withInsertedEdgeOrigins(state.paramOrigins, canonical.insertedEdges),
          });
          return { inserted: canonical.insertedBlockIds.length };
        },

        beginEdit: (label) => {
          if (get().pendingEdit !== null) return;
          set({ pendingEdit: { label, base: get().doc } });
        },

        endEdit: () => {
          const { pendingEdit, doc, past } = get();
          if (pendingEdit === null) return;
          if (pendingEdit.base === doc) {
            // Identity compare: nothing actually moved, so the gesture leaves no trace.
            set({ pendingEdit: null });
            return;
          }
          set({
            pendingEdit: null,
            past: [...past, { label: pendingEdit.label, doc: pendingEdit.base }].slice(-HISTORY_LIMIT),
            future: [],
          });
        },

        /**
         * R2: a template graph is validated like any other document. The builders take open
         * parameters, so "it came from a template" is not a trust argument. `false` means
         * nothing was loaded — either the id is unknown (silence) or the graph was refused,
         * in which case `lastLoadProblem` names core's own errors.
         */
        loadTemplate: (templateId) => {
          const template = getTemplate(templateId);
          if (template === undefined) return false;
          const graph = template.graph();
          const structural = validateGraph(graph);
          if (!structural.ok) {
            set({ lastLoadProblem: { code: "graph-invalid", errors: structural.errors } });
            return false;
          }
          set(loadedState(get(), graph, { kind: "template", templateId }));
          return true;
        },

        loadFromShare: (encoded) => {
          const decoded = decodeShareGraph(encoded);
          if (!decoded.ok) {
            // Designed failure state: the canvas says why the link was rejected. Never a
            // blank canvas, never a partially-applied graph.
            set({ lastLoadProblem: decoded.failure });
            return { ok: false, failure: decoded.failure, refusal: null };
          }
          set(loadedState(get(), decoded.graph, { kind: "share-url" }));
          return { ok: true };
        },

        /**
         * localStorage is user-writable, so a draft goes through the SAME gates as a
         * stranger's link — one decode-and-validate pipeline, two transports. This is why
         * there is no `persist` middleware: it would rehydrate an unvalidated graph.
         */
        hydrateLocalDraft: (raw) => {
          if (raw === null || raw.length === 0) return { ok: false, failure: null, refusal: null };
          const decoded = decodeShareGraph(raw);
          if (!decoded.ok) {
            set({ lastLoadProblem: decoded.failure });
            return { ok: false, failure: decoded.failure, refusal: null };
          }
          set(loadedState(get(), decoded.graph, { kind: "local-draft" }));
          return { ok: true };
        },

        clear: () => {
          const state = get();
          if (state.doc.blocks.length === 0 && state.doc.edges.length === 0) return;
          set({
            ...commitDoc(state, EMPTY_GRAPH, "clear canvas"),
            selectedBlockIds: [],
            // The document is no longer the template it was loaded from; claiming otherwise
            // would make the provenance chip lie. View entries survive so undo restores
            // positions along with the blocks.
            loadedFrom: { kind: "blank" },
            paramOrigins: {},
          });
        },

        undo: () => {
          const { past, future, doc, rev, pendingEdit } = get();
          if (pendingEdit !== null && pendingEdit.base !== doc) {
            // Ctrl+Z landing mid-drag: the open gesture IS the newest change and its
            // pre-gesture doc was never pushed. Popping `past` here would revert both the
            // gesture and the edit before it — two things for one keystroke.
            set({
              doc: pendingEdit.base,
              rev: rev + 1,
              pendingEdit: null,
              future: [{ label: pendingEdit.label, doc }, ...future],
              overrideGateArmed: false,
            });
            return;
          }
          const entry = past[past.length - 1];
          if (entry === undefined) {
            if (pendingEdit !== null) set({ pendingEdit: null });
            return;
          }
          set({
            doc: entry.doc,
            rev: rev + 1,
            past: past.slice(0, -1),
            future: [{ label: entry.label, doc }, ...future],
            pendingEdit: null,
            overrideGateArmed: false,
          });
        },

        redo: () => {
          const { past, future, doc, rev } = get();
          const entry = future[0];
          if (entry === undefined) return;
          set({
            doc: entry.doc,
            rev: rev + 1,
            past: [...past, { label: entry.label, doc }].slice(-HISTORY_LIMIT),
            future: future.slice(1),
            pendingEdit: null,
            overrideGateArmed: false,
          });
        },

        moveBlock: (id, at) => {
          const state = get();
          if (!state.doc.blocks.some((b) => b.id === id)) return;
          const previous = state.view[id];
          // View state: no history entry, no `rev` bump — a drag must not invalidate the
          // risk projection's memo (§7 out-of-scope list). The badge is not a position and
          // survives the move.
          set({
            view: {
              ...state.view,
              [id]: viewEntry(at, previous !== undefined && previous.isAutoInserted === true),
            },
          });
        },
      };

      return {
        ...INITIAL_STATE,
        // EVERY document write, through one boundary. Spread after the state so the store's
        // action surface is the guarded set and the unguarded one is unreachable from outside.
        ...lockGuarded(documentActions, () => get().writeLock),

        setSelection: (ids) => {
          const state = get();
          const known = new Set(state.doc.blocks.map((b) => b.id));
          const next = [...new Set(ids)].filter((id) => known.has(id));
          const current = state.selectedBlockIds;
          if (current.length === next.length && next.every((id, i) => current[i] === id)) return;
          set({ selectedBlockIds: next });
        },

        armOverride: () => {
          set({ overrideGateArmed: true });
        },

        setWriteLock: (reason) => {
          const state = get();
          if (state.writeLock === reason) return;
          // Engaging the lock CLOSES an open gesture instead of freezing it half-open. The
          // pre-gesture document is already captured, and a `pendingEdit` left standing across
          // a run suppresses the history entry of the first edit after the lock lifts — the
          // same silent end to undo recording `flow-edge.tsx`'s cleanup exists to prevent.
          // The unguarded action, deliberately: this is the transition INTO the lock.
          if (reason !== null && state.pendingEdit !== null) documentActions.endEdit();
          set({ writeLock: reason });
        },
      };
    }),
  );
}

// ————————————————————————— selectors (§6: only ones with call sites) —————————————————————————

export const selectGraph = (s: ComposerState): StrategyGraph => s.doc;

/** §7's required mitigation: the affordance names what it will revert
 *  ("Undo: set borrow allocation"), so a graph edit is never silently reverted. */
export function selectUndoLabel(s: ComposerState): string | null {
  const entry = s.past[s.past.length - 1];
  return entry === undefined ? null : entry.label;
}

export function selectRedoLabel(s: ComposerState): string | null {
  const entry = s.future[0];
  return entry === undefined ? null : entry.label;
}

/** SPEC §2: over-allocation is detected and surfaced ON THE SOURCE BLOCK. The store
 *  permits the state (siblings are never silently rewritten), so it must also expose it. */
export function overAllocatedSourceIds(doc: StrategyGraph): readonly string[] {
  return [...new Set(doc.edges.map((e) => e.source))].filter(
    (id) => outgoingBps(doc.edges, id) > FULL_ALLOCATION_BPS,
  );
}

/**
 * Display readers, not selectors, deliberately: a selector minting a fresh `Entered`
 * object on every call re-fires every subscriber under zustand v5's reference equality.
 * The binding calls these inside a `useMemo` keyed on `rev`.
 *
 * They exist so the display boundary receives `Provenanced<T>` rather than a bare number —
 * a store value is `Entered`, and nothing here can launder one into `Observed`.
 */
/** What a provenanced param reader needs: the document, and how its params got there. */
export type ParamReadState = Pick<ComposerState, "doc" | "paramOrigins">;

export function readInputAmount(
  state: ParamReadState,
  blockId: string,
): Provenanced<string> | null {
  const block = state.doc.blocks.find((b) => b.id === blockId);
  if (block === undefined || block.type !== "input") return null;
  const origin = state.paramOrigins[inputAmountOriginKey(blockId)];
  const raw = block.params["amount"];
  if (typeof raw === "string") return wrapParam(raw, origin);
  // A transported amount may arrive as a bounded number; String() is lossless for it.
  if (typeof raw === "number") return wrapParam(String(raw), origin);
  return null;
}

export function readBorrowAllocationBps(
  state: ParamReadState,
  blockId: string,
): Provenanced<number> | null {
  const block = state.doc.blocks.find((b) => b.id === blockId);
  if (block === undefined || block.type !== "borrow") return null;
  const raw = block.params["allocationBps"];
  if (typeof raw !== "number") return null;
  return wrapParam(raw, state.paramOrigins[borrowAllocationOriginKey(blockId)]);
}

/**
 * The total a source routes out, as a DERIVED quantity over the entered edge allocations
 * it sums — the digits behind `overAllocatedSourceIds`' verdict. The two are deliberately
 * separate: one authority answers "is it over" and one answers "by how much", so the
 * display cannot re-derive the second and disagree with the first.
 *
 * The math is `core/allocation.ts`'s `outgoingBps` and nothing else; this reader only
 * wraps its result in the provenance the display boundary requires. `null` means the
 * block sends nothing out — an absence, never a zero.
 */
export function readOutgoingAllocationBps(
  state: ParamReadState,
  blockId: string,
): Derived<number> | null {
  const outgoing = state.doc.edges.filter((e) => e.source === blockId);
  if (outgoing.length === 0) return null;
  return derived(
    outgoingBps(state.doc.edges, blockId),
    `sum of outgoing edge allocationBps out of ${blockId}`,
    // Each leg cites its OWN origin: a sum over one default and one dragged value must not
    // claim the user entered both.
    outgoing.map((e) =>
      wrapParam(e.allocationBps, state.paramOrigins[edgeAllocationOriginKey(e.id)]),
    ),
  );
}
