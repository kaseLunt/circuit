/**
 * Strategy graph schema and structural validation (SPEC §5.6). Pure.
 *
 * A graph arriving from the untrusted share-URL passes zod shape validation
 * first (elsewhere), then THIS module's structural validation before any plan is
 * built: unique ids, edge referential integrity, DAG acyclicity, per-source
 * allocation conservation, bounded size, single-producer flow, reachability, and
 * per-block parameter/enum checks. Calldata is only ever derived from a graph
 * that passed both gates.
 *
 * Boundary note: *asset-flow* compatibility across edges (does producer output
 * feed a consumer that accepts it, and where must a wrap be inserted) is NOT
 * validated here — an edge is not always an asset transfer (e.g. supply→borrow
 * is a dependency, not a token flow). Asset flow is computed and validated in
 * `plan.ts`, where each block's token semantics and the route optimizer live.
 */

export type BlockType = "input" | "stake" | "wrap" | "unwrap" | "lend" | "borrow";
export type Asset = "ETH" | "eETH" | "weETH" | "stETH" | "wstETH" | "WETH";
export type StakeProtocol = "etherfi" | "lido";
export type LendProtocol = "aave-v3";

export interface Block {
  readonly id: string;
  readonly type: BlockType;
  readonly params: Readonly<Record<string, string | number>>;
}

export interface Edge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** Fraction of the source's output routed along this edge, in bps. */
  readonly allocationBps: number;
}

export interface StrategyGraph {
  readonly blocks: readonly Block[];
  readonly edges: readonly Edge[];
}

export const MAX_BLOCKS = 64;
export const MAX_EDGES = 128;

const STAKE_PROTOCOLS = new Set<string>(["etherfi", "lido"]);
const LEND_PROTOCOLS = new Set<string>(["aave-v3"]);
/** Supported collateral assets for a lend block on the pinned Core market. */
const LEND_ASSETS = new Set<string>(["weETH", "wstETH", "WETH"]);
/** Borrowable assets in v1 (matrix: WETH is borrowable, weETH is collateral-only). */
const BORROW_ASSETS = new Set<string>(["WETH"]);
/** Valid wrap/unwrap conversions (matrix §7). */
const WRAP_PAIRS = new Set<string>(["eETH>weETH", "stETH>wstETH", "ETH>WETH"]);
const UNWRAP_PAIRS = new Set<string>(["weETH>eETH", "wstETH>stETH", "WETH>ETH"]);

/** Max plausible ETH input — a finite upper bound so absurd/overflowing amounts
 * (e.g. a 100-digit string parsing to Infinity) are rejected, not accepted. */
const MAX_INPUT_ETH = 1_000_000_000; // 1e9 ETH

function isPositiveAmount(v: unknown): boolean {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= MAX_INPUT_ETH;
}

/** Per-block parameter/semantic checks (SPEC §5.6). Pushes into `errors`. */
function validateBlockParams(b: Block, errors: string[]): void {
  const p = b.params;
  const need = (key: string): string | number | undefined => p[key];
  switch (b.type) {
    case "input":
      if (need("asset") !== "ETH") errors.push(`block ${b.id}: input asset must be ETH`);
      if (!isPositiveAmount(need("amount"))) errors.push(`block ${b.id}: input needs a positive amount`);
      break;
    case "stake":
      if (!STAKE_PROTOCOLS.has(String(need("protocol")))) {
        errors.push(`block ${b.id}: unsupported stake protocol '${need("protocol")}'`);
      }
      break;
    case "wrap":
      if (!WRAP_PAIRS.has(`${need("from")}>${need("to")}`)) {
        errors.push(`block ${b.id}: unsupported wrap ${need("from")}→${need("to")}`);
      }
      break;
    case "unwrap":
      if (!UNWRAP_PAIRS.has(`${need("from")}>${need("to")}`)) {
        errors.push(`block ${b.id}: unsupported unwrap ${need("from")}→${need("to")}`);
      }
      break;
    case "lend":
      if (!LEND_PROTOCOLS.has(String(need("protocol")))) {
        errors.push(`block ${b.id}: lend protocol must be aave-v3`);
      }
      if (!LEND_ASSETS.has(String(need("asset")))) {
        errors.push(`block ${b.id}: unsupported lend asset '${need("asset")}'`);
      }
      break;
    case "borrow":
      if (!LEND_PROTOCOLS.has(String(need("protocol")))) {
        errors.push(`block ${b.id}: borrow protocol must be aave-v3`);
      }
      if (!BORROW_ASSETS.has(String(need("asset")))) {
        errors.push(`block ${b.id}: unsupported/collateral-only borrow asset '${need("asset")}'`);
      }
      const bps = need("allocationBps");
      if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 1 || bps > 10_000) {
        errors.push(`block ${b.id}: borrow allocationBps must be an integer in [1,10000]`);
      }
      break;
  }
}

export interface GraphValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

function ok(): GraphValidation {
  return { ok: true, errors: [] };
}

/** Full structural validation. Returns every error found (not fail-fast). */
export function validateGraph(g: StrategyGraph): GraphValidation {
  const errors: string[] = [];

  if (g.blocks.length === 0) errors.push("graph has no blocks");
  if (g.blocks.length > MAX_BLOCKS) errors.push(`too many blocks (${g.blocks.length} > ${MAX_BLOCKS})`);
  if (g.edges.length > MAX_EDGES) errors.push(`too many edges (${g.edges.length} > ${MAX_EDGES})`);

  // Unique block ids.
  const blockIds = new Set<string>();
  for (const b of g.blocks) {
    if (blockIds.has(b.id)) errors.push(`duplicate block id: ${b.id}`);
    blockIds.add(b.id);
  }

  // Unique edge ids + referential integrity + no self-loops.
  const edgeIds = new Set<string>();
  for (const e of g.edges) {
    if (edgeIds.has(e.id)) errors.push(`duplicate edge id: ${e.id}`);
    edgeIds.add(e.id);
    if (!blockIds.has(e.source)) errors.push(`edge ${e.id} source ${e.source} is not a block`);
    if (!blockIds.has(e.target)) errors.push(`edge ${e.id} target ${e.target} is not a block`);
    if (e.source === e.target) errors.push(`edge ${e.id} is a self-loop`);
    // Positive integer bps in [1,10000] — aligns with splitAmount, which rejects
    // zero/fractional allocations (they cannot be represented as bigint shares).
    if (!Number.isInteger(e.allocationBps) || e.allocationBps < 1 || e.allocationBps > 10_000) {
      errors.push(`edge ${e.id} allocationBps ${e.allocationBps} must be an integer in [1,10000]`);
    }
  }

  // Per-source allocation conservation: outgoing allocation must not exceed 100%.
  const outBySource = new Map<string, number>();
  for (const e of g.edges) {
    outBySource.set(e.source, (outBySource.get(e.source) ?? 0) + e.allocationBps);
  }
  for (const [source, total] of outBySource) {
    if (total > 10_000) errors.push(`block ${source} over-allocates outgoing flow: ${total} bps`);
  }

  // Acyclicity (Kahn): if any node remains with in-degree > 0, there is a cycle.
  if (!errors.some((e) => e.includes("is not a block"))) {
    if (hasCycle(g)) errors.push("graph is not acyclic");
  }

  // Exactly one input block, and inputs have no incoming edges.
  const inputs = g.blocks.filter((b) => b.type === "input");
  if (inputs.length !== 1) errors.push(`expected exactly one input block, found ${inputs.length}`);

  // Single-producer flow (SPEC §5.6): every non-input block has exactly one
  // incoming edge; the input has none. This gives plan.ts an unambiguous
  // step-output(producerStepId) for each consuming block.
  const inDegree = new Map<string, number>();
  for (const b of g.blocks) inDegree.set(b.id, 0);
  for (const e of g.edges) {
    if (blockIds.has(e.target)) inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }
  for (const b of g.blocks) {
    const deg = inDegree.get(b.id) ?? 0;
    if (b.type === "input" && deg !== 0) errors.push(`input block ${b.id} must have no incoming edges`);
    if (b.type !== "input" && deg !== 1) {
      errors.push(`block ${b.id} must have exactly one producer (has ${deg})`);
    }
  }

  // Reachability: every block reachable from the single input (no islands).
  if (inputs.length === 1 && !errors.some((e) => e.includes("is not a block"))) {
    const reached = reachableFrom(g, inputs[0]!.id);
    for (const b of g.blocks) {
      if (!reached.has(b.id)) errors.push(`block ${b.id} is not reachable from the input`);
    }
  }

  // Per-block parameter/semantic validation.
  for (const b of g.blocks) validateBlockParams(b, errors);

  return errors.length === 0 ? ok() : { ok: false, errors };
}

/** Block ids reachable from `startId` following edges forward. */
function reachableFrom(g: StrategyGraph, startId: string): Set<string> {
  const adj = new Map<string, string[]>();
  for (const b of g.blocks) adj.set(b.id, []);
  for (const e of g.edges) adj.get(e.source)?.push(e.target);
  const seen = new Set<string>([startId]);
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const next of adj.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** Kahn's algorithm cycle detection over the block graph. */
function hasCycle(g: StrategyGraph): boolean {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const b of g.blocks) {
    indeg.set(b.id, 0);
    adj.set(b.id, []);
  }
  for (const e of g.edges) {
    adj.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return visited !== g.blocks.length;
}

/** Topological order of block ids; throws if the graph has a cycle. */
export function topologicalOrder(g: StrategyGraph): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const b of g.blocks) {
    indeg.set(b.id, 0);
    adj.set(b.id, []);
  }
  for (const e of g.edges) {
    adj.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== g.blocks.length) throw new Error("graph is not acyclic");
  return order;
}
