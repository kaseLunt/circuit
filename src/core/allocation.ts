/**
 * Edge-allocation flow math (SPEC §2 canvas allocation). Pure, integer.
 *
 * An amount entering a block is split across its outgoing edges by their
 * allocation bps. Splitting is floor-per-edge with the remainder assigned to the
 * last edge, so the parts sum EXACTLY to the input (no wei created or lost) —
 * the invariant the property tests assert.
 */
import type { Edge } from "./graph";

/** Sum of outgoing allocation bps for a source (for over-allocation checks). */
export function outgoingBps(edges: readonly Edge[], sourceId: string): number {
  return edges
    .filter((e) => e.source === sourceId)
    .reduce((sum, e) => sum + e.allocationBps, 0);
}

/**
 * Split `amount` across `edges` (all sharing one source) by allocation bps.
 * Returns `[edgeId, amount]` pairs. Floor each share; the final edge absorbs the
 * rounding remainder so the split is conservative and exactly summing.
 *
 * `edges` must total ≤ 10000 bps (validated upstream). If they total < 10000,
 * the unallocated portion is intentionally dropped (retained by the source),
 * so the returned amounts sum to `floor(amount * totalBps / 10000)`, not `amount`.
 */
export function splitAmount(
  amount: bigint,
  edges: readonly Edge[],
): Array<{ readonly edgeId: string; readonly amount: bigint }> {
  if (amount < 0n) throw new RangeError("amount must be non-negative");
  const totalBps = edges.reduce((s, e) => s + e.allocationBps, 0);
  if (totalBps > 10_000) throw new RangeError(`allocation exceeds 100%: ${totalBps} bps`);
  if (edges.length === 0) return [];

  const allocated = (amount * BigInt(totalBps)) / 10_000n; // total that actually flows out
  const out: Array<{ edgeId: string; amount: bigint }> = [];
  let assigned = 0n;
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i]!;
    if (i === edges.length - 1) {
      out.push({ edgeId: e.id, amount: allocated - assigned });
    } else {
      const share = totalBps === 0 ? 0n : (allocated * BigInt(e.allocationBps)) / BigInt(totalBps);
      out.push({ edgeId: e.id, amount: share });
      assigned += share;
    }
  }
  return out;
}
