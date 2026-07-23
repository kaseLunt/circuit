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
 * Returns `[edgeId, amount]` pairs. Each share is floored; the rounding
 * remainder is assigned to the edge with the LARGEST allocation, ties broken by
 * the lexicographically smallest edge id — a fully order-independent recipient,
 * so reordering equal-allocation edges never changes where the dust lands.
 *
 * Zero-allocation edges are rejected (a 0-bps edge has no place in a plan).
 * `edges` must total ≤ 10000 bps (validated upstream). If they total < 10000,
 * the unallocated portion is intentionally retained by the source, so the parts
 * sum to `floor(amount · totalBps / 10000)`, not `amount`.
 */
export function splitAmount(
  amount: bigint,
  edges: readonly Edge[],
): Array<{ readonly edgeId: string; readonly amount: bigint }> {
  if (amount < 0n) throw new RangeError("amount must be non-negative");
  if (edges.length === 0) return [];
  if (edges.some((e) => e.allocationBps <= 0)) {
    throw new RangeError("zero/negative-allocation edge is not permitted in a split");
  }
  const totalBps = edges.reduce((s, e) => s + e.allocationBps, 0);
  if (totalBps > 10_000) throw new RangeError(`allocation exceeds 100%: ${totalBps} bps`);

  const allocated = (amount * BigInt(totalBps)) / 10_000n; // total that flows out
  const out = edges.map((e) => ({
    edgeId: e.id,
    amount: (allocated * BigInt(e.allocationBps)) / BigInt(totalBps),
  }));

  // Assign the remainder to the largest-allocation edge (deterministic).
  const assigned = out.reduce((s, o) => s + o.amount, 0n);
  const remainder = allocated - assigned;
  if (remainder > 0n) {
    let maxIdx = 0;
    for (let i = 1; i < edges.length; i += 1) {
      const cur = edges[i]!;
      const best = edges[maxIdx]!;
      // Larger allocation wins; equal allocation breaks by smallest edge id.
      if (cur.allocationBps > best.allocationBps) maxIdx = i;
      else if (cur.allocationBps === best.allocationBps && cur.id < best.id) maxIdx = i;
    }
    out[maxIdx] = { edgeId: out[maxIdx]!.edgeId, amount: out[maxIdx]!.amount + remainder };
  }
  return out;
}
