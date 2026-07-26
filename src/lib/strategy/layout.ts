/**
 * Deterministic canvas layout for a strategy graph. Pure and dependency-free: the
 * only imports are types, which erase at build time, so this module executes no
 * foreign code and can never reach a chain read, a store or React.
 *
 * POSITIONS ARE COMPUTED, NEVER TRANSPORTED. The share payload carries blocks and
 * edges only (SPEC §5.6), so no stranger's link can inject NaN, ±Infinity, 1e308
 * or an absurd canvas extent; rehydrating a shared graph runs this pass instead.
 * The price is that layout fidelity is not shareable in v1 — the right trade for a
 * document whose acceptance criterion is "the identical graph".
 *
 * The drawing is layered left to right: a block's COLUMN is its longest path from
 * a root, so a consumer always sits right of every producer even when a shortcut
 * edge skips a layer, and its ROW is its order of appearance inside that column.
 * Both are functions of the document alone — no measurement, no randomness, no
 * clock — so two sessions, two machines and a test place the same graph
 * identically, which is what makes a layout assertion a real pin.
 *
 * TOTAL BY CONSTRUCTION: every block gets a coordinate, including blocks that a
 * cycle or a dangling edge leaves unranked (they are appended as a final column).
 * Callers gate documents through `validateGraph` before they become state, so such
 * inputs are not expected here — but a layout pass that threw, or returned a hole,
 * would turn a designed error state into a blank canvas.
 */
import type { StrategyGraph } from "../../core/graph";
import type { BlockView } from "./types";

/** Horizontal distance between adjacent layers, in canvas units. */
export const COLUMN_GAP = 320;

/** Vertical distance between siblings sharing a layer, in canvas units. */
export const ROW_GAP = 140;

/**
 * Longest-path column per block id, computed with Kahn's algorithm so a block is
 * ranked only after every producer is. Blocks left unranked (a cycle has no
 * in-degree-zero entry point) are appended one column past everything ranked.
 */
function columnsOf(graph: StrategyGraph): Map<string, number> {
  const ids = new Set(graph.blocks.map((b) => b.id));
  const consumers = new Map<string, string[]>();
  const producerCount = new Map<string, number>();
  for (const b of graph.blocks) {
    consumers.set(b.id, []);
    producerCount.set(b.id, 0);
  }
  for (const e of graph.edges) {
    // An edge to nowhere is ignored rather than fatal: this is a drawing, not a gate.
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    consumers.get(e.source)!.push(e.target);
    producerCount.set(e.target, producerCount.get(e.target)! + 1);
  }

  const column = new Map<string, number>();
  const queue: string[] = [];
  for (const b of graph.blocks) {
    if (producerCount.get(b.id) === 0) {
      column.set(b.id, 0);
      queue.push(b.id);
    }
  }
  const settled = new Set<string>(queue);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const depth = column.get(id)!;
    for (const next of consumers.get(id)!) {
      const known = column.get(next);
      if (known === undefined || known < depth + 1) column.set(next, depth + 1);
      const remaining = producerCount.get(next)! - 1;
      producerCount.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
        settled.add(next);
      }
    }
  }

  // Only DEQUEUED blocks are ranked. A cycle member can receive a tentative
  // column during relaxation without ever settling; counting that tentative
  // value as ranked would scatter the cycle across columns and inflate the
  // final column. Everything unsettled shares one column after the ranked ones.
  const ranked = [...settled].map((id) => column.get(id)!);
  const unrankedColumn = ranked.length === 0 ? 0 : Math.max(...ranked) + 1;
  for (const b of graph.blocks) {
    if (!settled.has(b.id)) column.set(b.id, unrankedColumn);
  }
  return column;
}

/**
 * A coordinate for every block, keyed by block id.
 *
 * `autoInsertedBlockIds` marks the blocks the route optimizer placed, so the
 * canvas's "Auto" badge reads view state instead of re-deriving intent from a
 * block id. Re-laying out the whole graph after an insertion (rather than
 * positioning only the new blocks) is what keeps an inserted wrap from landing on
 * top of an existing block.
 */
export function layoutGraph(
  graph: StrategyGraph,
  autoInsertedBlockIds: Iterable<string> = [],
): Record<string, BlockView> {
  const column = columnsOf(graph);
  const autoInserted = new Set(autoInsertedBlockIds);
  const usedRows = new Map<number, number>();
  const placed = new Map<string, BlockView>();
  for (const b of graph.blocks) {
    const col = column.get(b.id)!;
    const previousRow = usedRows.get(col);
    const row = previousRow === undefined ? 0 : previousRow + 1;
    usedRows.set(col, row);
    placed.set(b.id, {
      x: col * COLUMN_GAP,
      y: row * ROW_GAP,
      isAutoInserted: autoInserted.has(b.id),
    });
  }
  // fromEntries, not `record[id] = …`: a block id of "__proto__" survives the
  // transport charset, and a plain assignment would hit Object.prototype's setter
  // instead of creating an own property.
  return Object.fromEntries(placed);
}
