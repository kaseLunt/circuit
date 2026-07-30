/**
 * Wrap/unwrap route optimization (SPEC §2 block table). Pure — no fetch, no I/O,
 * no React, no contract addresses.
 *
 * graph.ts owns structure (ids, DAG, single-producer, reachability, per-block
 * params) and its boundary note explicitly defers *asset flow across an edge* to
 * a later gate. This module is the composer's half of that gate: it answers "does
 * the producer hand the consumer the token it expects, and if not, which wrapper
 * conversion closes the gap", and rewrites the graph to insert the block that
 * closes it. plan.ts re-derives flow on the final graph before any calldata is
 * built, so this module is a convenience for the canvas and never the authority.
 *
 * It runs on IN-PROGRESS graphs (a half-wired canvas), so it must not assume
 * validateGraph has passed: dangling edge endpoints and unconfigured params are
 * skipped here and reported by graph.ts, never silently defaulted to ETH.
 *
 * A wrap block carries only `{ from, to }`. Wrapper contracts and function names
 * live in plan.ts, resolved from the block-pinned ChainSnapshot, so nothing here
 * can hand-type an address or a method the token does not implement.
 *
 * ── Three gates, deliberately not collapsed ──────────────────────────────────
 *   1. graph.ts — schema and structure. `stake(lido)`, `lend(wstETH)` and
 *      `wrap(stETH→wstETH)` are all schema-VALID: W03 kept Lido and wstETH
 *      representable so the composer can express those lanes.
 *   2. this module — asset flow. It routes anything schema-valid, INCLUDING the
 *      Lido/wstETH lane. It must not pre-filter to the P1 execution set:
 *      narrowing here would silently delete blocks a user placed on purpose.
 *   3. plan.ts — the P1 execution phase gate. Anything outside the EtherFi
 *      flagship returns a typed `unsupported-in-phase` error naming the block.
 *
 * A graph can therefore be route-clean AND plan-rejected at the same time. That
 * is correct layering, not a bug — but the canvas MUST render layer 3's typed
 * state honestly ("stake with Lido is not executable in this phase", naming each
 * block), never as a generic failure and never by hiding the blocks this module
 * just routed. route-optimizer.test.ts pins all three layers on the
 * stake(lido) → lend(wstETH) lane so the split cannot rot into a false clean.
 *
 * ── One-hop invariant ────────────────────────────────────────────────────────
 * v1's wrapper set is three DISJOINT pairs: nothing composes, because the
 * conversions that would chain them (ETH→eETH, ETH→stETH) are stake blocks, not
 * wraps. Formally, `WRAP_PAIRS.unwrapped` and `WRAP_PAIRS.wrapped` are disjoint,
 * so the relation is a perfect matching and any two hops land back where they
 * started. A route is therefore at most one block long, which is why insertion
 * needs no step index, no forward reference, and no chain bookkeeping. That
 * invariant is pinned by `WRAP_PAIRS_DO_NOT_COMPOSE` below (build breaks) and by
 * the composition test in route-optimizer.test.ts (suite breaks) — so a future
 * composing pair cannot silently make single-hop routing incomplete.
 */
import type { Asset, Block, Edge, StakeProtocol, StrategyGraph } from "./graph";

/**
 * Keyed by graph.ts's `Asset` union, so a new member there is a compile error
 * here. The predecessor's hand-listed set failed OPEN: a new asset would have
 * read as "not an asset", making incompatibilities silently vanish rather than
 * being reported. Same anti-drift technique as STAKE_FLOW below.
 */
const ASSET_MEMBERS: Readonly<Record<Asset, true>> = {
  ETH: true,
  eETH: true,
  weETH: true,
  stETH: true,
  wstETH: true,
  WETH: true,
  USDC: true,
};

function isAsset(v: string | number | undefined): v is Asset {
  return typeof v === "string" && Object.hasOwn(ASSET_MEMBERS, v);
}

/** Every asset graph.ts declares. Derived, so it cannot drift from the union. */
export const ASSETS: readonly Asset[] = Object.keys(ASSET_MEMBERS).filter(isAsset);

function asAsset(v: string | number | undefined): Asset | null {
  return isAsset(v) ? v : null;
}

interface StakeFlow {
  readonly input: Asset;
  readonly output: Asset;
}

/**
 * Staking conversions, keyed by graph.ts's StakeProtocol union so adding a
 * protocol is a compile error rather than a fallback. These are NOT wrapper
 * pairs: a stake is a protocol choice the user makes, so the optimizer reads
 * them to understand flow but never auto-inserts one.
 */
const STAKE_FLOW: Readonly<Record<StakeProtocol, StakeFlow>> = {
  etherfi: { input: "ETH", output: "eETH" },
  lido: { input: "ETH", output: "stETH" },
};

function stakeFlow(b: Block): StakeFlow | null {
  const protocol = b.params["protocol"];
  if (typeof protocol !== "string") return null;
  for (const [id, flow] of Object.entries(STAKE_FLOW)) {
    if (id === protocol) return flow;
  }
  return null;
}

export interface WrapPair {
  readonly unwrapped: Asset;
  readonly wrapped: Asset;
}

/**
 * The v1 wrapper conversions (SPEC §2). Mirrors graph.ts's private
 * WRAP_PAIRS/UNWRAP_PAIRS; route-optimizer.test.ts asserts every block this
 * module can emit passes validateGraph, so the two cannot drift apart unnoticed.
 *
 * Declared `as const` so the literal asset types survive for the compile pin
 * below. Adding a pair whose `wrapped` asset is another pair's `unwrapped` asset
 * (e.g. a hypothetical ETH→eETH wrap) makes routes composable and breaks the
 * build here — deliberately, because optimizeRoute inserts exactly one block.
 */
export const WRAP_PAIRS = [
  { unwrapped: "eETH", wrapped: "weETH" },
  { unwrapped: "stETH", wrapped: "wstETH" },
  { unwrapped: "ETH", wrapped: "WETH" },
] as const satisfies readonly WrapPair[];

type UnwrappedAsset = (typeof WRAP_PAIRS)[number]["unwrapped"];
type WrappedAsset = (typeof WRAP_PAIRS)[number]["wrapped"];

/**
 * Compile-level pin for the one-hop invariant: the unwrapped and wrapped sides of
 * WRAP_PAIRS must stay disjoint. If they ever overlap, the annotation resolves to
 * `never`, this initializer stops compiling, and whoever added the pair has to
 * grow optimizeRoute into a chain — with the linked-reference bookkeeping and its
 * failing-first test — instead of quietly breaking single-hop routing.
 */
export const WRAP_PAIRS_DO_NOT_COMPOSE: [Extract<UnwrappedAsset, WrappedAsset>] extends [never]
  ? true
  : never = true;

export interface WrapStep {
  readonly from: Asset;
  readonly to: Asset;
  readonly direction: "wrap" | "unwrap";
}

/** The single conversion turning `from` into `to`, or null if no pair covers it. */
function wrapConversion(from: Asset, to: Asset): WrapStep | null {
  for (const pair of WRAP_PAIRS) {
    if (pair.unwrapped === from && pair.wrapped === to) return { from, to, direction: "wrap" };
    if (pair.wrapped === from && pair.unwrapped === to) return { from, to, direction: "unwrap" };
  }
  return null;
}

/**
 * The wrapper conversions that turn `from` into `to`:
 *   `[]`     — nothing needed; the producer already hands over `to`.
 *   `[step]` — exactly one conversion closes the gap.
 *   `null`   — NO wrapper conversion closes it: this pairing is UNROUTABLE.
 *
 * The empty-vs-null distinction is the predecessor's contract restored
 * (route-optimizer.ts:206 returned `[]` for `from === to`, meaning "no steps
 * needed"). Collapsing same-asset into `null` would hand callers the exact
 * sentinel validateRoute turns into an `unroutable-edge` error — reporting "these
 * two tokens can never meet" about a pair that already matches. The result is
 * never longer than one step; see the one-hop invariant in the module header.
 */
export function findWrapStep(from: Asset, to: Asset): readonly WrapStep[] | null {
  if (from === to) return [];
  const step = wrapConversion(from, to);
  return step === null ? null : [step];
}

/**
 * The token a block hands downstream, or null when it has none (a lend supply
 * produces an aToken position, not a routable token) or is not yet configured.
 */
export function outputAssetOf(b: Block): Asset | null {
  switch (b.type) {
    case "input":
      return asAsset(b.params["asset"]);
    case "stake": {
      const flow = stakeFlow(b);
      return flow === null ? null : flow.output;
    }
    case "wrap":
    case "unwrap":
      return asAsset(b.params["to"]);
    case "borrow":
      return asAsset(b.params["asset"]);
    case "lend":
      return null;
  }
}

/**
 * The token a block expects from its producer, or null when the edge is not a
 * token transfer (an input has no producer; a borrow's edge is a collateral
 * dependency on its lend block) or the block is not yet configured.
 */
export function expectedInputAssetOf(b: Block): Asset | null {
  switch (b.type) {
    case "input":
    case "borrow":
      return null;
    case "stake": {
      const flow = stakeFlow(b);
      return flow === null ? null : flow.input;
    }
    case "wrap":
    case "unwrap":
      return asAsset(b.params["from"]);
    case "lend":
      return asAsset(b.params["asset"]);
  }
}

export interface RouteIncompatibility {
  readonly edgeId: string;
  readonly sourceBlockId: string;
  readonly targetBlockId: string;
  readonly sourceOutput: Asset;
  readonly targetExpects: Asset;
  /**
   * null means NO wrapper conversion closes the gap — the edge cannot be routed.
   * The predecessor omitted these rows entirely, which left validateRoute's
   * error branch unreachable and let impossible routes validate clean
   * (TRANSPLANT.md route-optimizer, L298-323 + L551-559).
   */
  readonly wrapStep: WrapStep | null;
}

/** Every edge whose producer output does not match its consumer's expectation. */
export function analyzeRouteCompatibility(graph: StrategyGraph): readonly RouteIncompatibility[] {
  const blockById = new Map(graph.blocks.map((b) => [b.id, b] as const));
  const found: RouteIncompatibility[] = [];

  for (const edge of graph.edges) {
    const source = blockById.get(edge.source);
    const target = blockById.get(edge.target);
    // Dangling endpoints are graph.ts's error to report, not this module's.
    if (source === undefined || target === undefined) continue;

    const sourceOutput = outputAssetOf(source);
    const targetExpects = expectedInputAssetOf(target);
    // Not a token transfer, or an unconfigured block: no claim either way.
    if (sourceOutput === null || targetExpects === null) continue;
    if (sourceOutput === targetExpects) continue;

    found.push({
      edgeId: edge.id,
      sourceBlockId: source.id,
      targetBlockId: target.id,
      sourceOutput,
      targetExpects,
      wrapStep: wrapConversion(sourceOutput, targetExpects),
    });
  }

  return found;
}

export interface OptimizedRoute {
  readonly graph: StrategyGraph;
  /**
   * Ids of the blocks this pass inserted — the canvas's handle for the "Auto"
   * badge and for undoing an insertion. This is the only bookkeeping the old
   * store actually consumed (`autoInsertedBlockIds`); the old `insertedWrapSteps`
   * record was consumed nowhere and carried the dangling `beforeBlockId` defect
   * at route-optimizer.ts:440-442, so it is deleted rather than resurrected
   * (TRANSPLANT.md L76, delete arm). If the store later needs the replaced edge
   * id or a producer/consumer link, add it back as a typed record WITH a test
   * that fails without it — do not reconstruct it by parsing block-id strings.
   */
  readonly autoInsertedBlockIds: readonly string[];
  /**
   * The edges this pass SYNTHESISED, each naming the edge it descends from — the typed
   * record the note above invited, added because the store now needs lineage and must not
   * recover it by parsing id suffixes.
   *
   * The distinction is provenance-bearing, which is why it is a field and not a convention:
   * the INBOUND replacement carries the replaced edge's own `allocationBps` (a partial
   * allocation the user set stays that user's number), while the OUTBOUND one is a
   * genuinely generated full-allocation edge nobody chose. Marking both as the store's
   * configured constant would display a user's entered 60% as a configured 100% default.
   */
  readonly insertedEdges: readonly InsertedEdge[];
}

export interface InsertedEdge {
  readonly id: string;
  /** The edge this one replaced; gone from `graph`, still reachable through undo. */
  readonly replacedEdgeId: string;
  /** True for the inbound leg, which inherits the replaced edge's allocation AND origin. */
  readonly carriesReplacedAllocation: boolean;
}

/** A wrap block passes on everything it receives. */
const FULL_ALLOCATION_BPS = 10_000;

type RoutableIncompatibility = RouteIncompatibility & { readonly wrapStep: WrapStep };

function isRoutable(i: RouteIncompatibility): i is RoutableIncompatibility {
  return i.wrapStep !== null;
}

/**
 * Insert the wrap/unwrap block each routable incompatibility needs, rewiring the
 * edge through it. Unroutable edges are left untouched for validateRoute to
 * report. Deterministic: ids derive from the replaced edge id, so re-running is
 * idempotent and the result is snapshot-testable (SPEC §8).
 *
 * Exactly one block per edge, never a chain — see the one-hop invariant in the
 * module header. Adding a composing wrap pair breaks WRAP_PAIRS_DO_NOT_COMPOSE
 * above; whoever does that must grow this loop into a chain in the same commit.
 *
 * The source→wrap edge inherits the original allocation and the wrap→target edge
 * carries 100%, so the fraction of the source's output reaching the target is
 * unchanged and the source's outgoing-allocation total is untouched.
 */
export function optimizeRoute(graph: StrategyGraph): OptimizedRoute {
  const routable = analyzeRouteCompatibility(graph).filter(isRoutable);
  if (routable.length === 0) return { graph, autoInsertedBlockIds: [], insertedEdges: [] };

  const byEdgeId = new Map(routable.map((i) => [i.edgeId, i] as const));
  const usedBlockIds = new Set(graph.blocks.map((b) => b.id));
  const usedEdgeIds = new Set(graph.edges.map((e) => e.id));

  const blocks: Block[] = [...graph.blocks];
  const edges: Edge[] = [];
  const autoInsertedBlockIds: string[] = [];
  const insertedEdges: InsertedEdge[] = [];

  for (const edge of graph.edges) {
    const incompat = byEdgeId.get(edge.id);
    if (incompat === undefined) {
      edges.push(edge);
      continue;
    }

    const step = incompat.wrapStep;
    const blockId = `auto-wrap:${edge.id}`;
    const inEdgeId = `${edge.id}:in`;
    const outEdgeId = `${edge.id}:out`;

    // An in-progress graph has not necessarily passed graph.ts's uniqueness
    // check, so refuse loudly rather than emit a graph that fails it later.
    if (usedBlockIds.has(blockId)) {
      throw new RangeError(`route optimizer id '${blockId}' collides with an existing block`);
    }
    if (usedEdgeIds.has(inEdgeId) || usedEdgeIds.has(outEdgeId)) {
      throw new RangeError(`route optimizer edge ids for '${edge.id}' collide with existing edges`);
    }
    usedBlockIds.add(blockId);
    usedEdgeIds.add(inEdgeId);
    usedEdgeIds.add(outEdgeId);

    blocks.push({ id: blockId, type: step.direction, params: { from: step.from, to: step.to } });
    edges.push({
      id: inEdgeId,
      source: edge.source,
      target: blockId,
      allocationBps: edge.allocationBps,
    });
    edges.push({
      id: outEdgeId,
      source: blockId,
      target: edge.target,
      allocationBps: FULL_ALLOCATION_BPS,
    });
    autoInsertedBlockIds.push(blockId);
    insertedEdges.push(
      { id: inEdgeId, replacedEdgeId: edge.id, carriesReplacedAllocation: true },
      { id: outEdgeId, replacedEdgeId: edge.id, carriesReplacedAllocation: false },
    );
  }

  return { graph: { blocks, edges }, autoInsertedBlockIds, insertedEdges };
}

export interface UnroutableEdge {
  readonly kind: "unroutable-edge";
  readonly edgeId: string;
  readonly sourceBlockId: string;
  readonly targetBlockId: string;
  readonly from: Asset;
  readonly to: Asset;
  readonly detail: string;
}

export interface RouteValidation {
  readonly ok: boolean;
  readonly errors: readonly UnroutableEdge[];
}

/**
 * The asset-flow gate, run AFTER graph.ts's structural gate. Structure
 * (reachability, single-producer, referential integrity) is validateGraph's
 * authority and is deliberately not re-checked here. Executability is plan.ts's
 * authority: an `ok: true` here means "the tokens line up", never "this plan can
 * be built in the current phase".
 */
export function validateRoute(graph: StrategyGraph): RouteValidation {
  const errors = analyzeRouteCompatibility(graph)
    .filter((i) => i.wrapStep === null)
    .map((i): UnroutableEdge => ({
      kind: "unroutable-edge",
      edgeId: i.edgeId,
      sourceBlockId: i.sourceBlockId,
      targetBlockId: i.targetBlockId,
      from: i.sourceOutput,
      to: i.targetExpects,
      detail: `no wrapper conversion turns ${i.sourceOutput} into ${i.targetExpects}`,
    }));
  return { ok: errors.length === 0, errors };
}
