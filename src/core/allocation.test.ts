import { describe, it, expect } from "vitest";
import { outgoingBps, splitAmount } from "./allocation";
import type { Edge } from "./graph";
import { WAD } from "./format";

const edge = (id: string, source: string, allocationBps: number): Edge => ({
  id,
  source,
  target: `${id}-t`,
  allocationBps,
});

describe("outgoingBps", () => {
  it("sums outgoing allocation for a source", () => {
    const edges = [edge("a", "s", 6000), edge("b", "s", 4000), edge("c", "other", 5000)];
    expect(outgoingBps(edges, "s")).toBe(10_000);
  });
});

describe("splitAmount", () => {
  it("full single edge receives the whole amount", () => {
    const out = splitAmount(WAD, [edge("a", "s", 10_000)]);
    expect(out).toEqual([{ edgeId: "a", amount: WAD }]);
  });

  it("split parts sum exactly to the allocated total (no wei lost)", () => {
    // 1e18 across 60/40 → parts sum to full amount
    const out = splitAmount(WAD, [edge("a", "s", 6000), edge("b", "s", 4000)]);
    const total = out.reduce((s, o) => s + o.amount, 0n);
    expect(total).toBe(WAD);
    expect(out[0]!.amount).toBe((WAD * 6n) / 10n);
  });

  it("partial allocation drops the unrouted remainder (retained by source)", () => {
    // only 70% routed
    const out = splitAmount(WAD, [edge("a", "s", 7000)]);
    expect(out[0]!.amount).toBe((WAD * 7n) / 10n);
  });

  it("last edge absorbs the rounding remainder", () => {
    // an amount not divisible by three thirds
    const amt = 100n;
    const out = splitAmount(amt, [
      edge("a", "s", 3333),
      edge("b", "s", 3333),
      edge("c", "s", 3334),
    ]);
    const total = out.reduce((s, o) => s + o.amount, 0n);
    expect(total).toBe(amt); // exact
  });

  it("property: parts always sum to floor(amount*totalBps/1e4) across random splits", () => {
    const cases: Array<[bigint, number[]]> = [
      [1_000_000_000_000_000_001n, [5000, 5000]],
      [7n, [2500, 2500, 2500, 2500]],
      [999_999_999n, [1234, 8766]],
      [10n ** 30n, [1, 9999]],
    ];
    for (const [amt, splits] of cases) {
      const edges = splits.map((b, i) => edge(`e${i}`, "s", b));
      const total = splits.reduce((s, b) => s + b, 0);
      const out = splitAmount(amt, edges);
      const sum = out.reduce((s, o) => s + o.amount, 0n);
      expect(sum).toBe((amt * BigInt(total)) / 10_000n);
      expect(out.every((o) => o.amount >= 0n)).toBe(true);
    }
  });

  it("rejects negative amount and over-allocation", () => {
    expect(() => splitAmount(-1n, [])).toThrow(RangeError);
    expect(() => splitAmount(WAD, [edge("a", "s", 6000), edge("b", "s", 6000)])).toThrow(RangeError);
  });

  it("empty edges yields empty split", () => {
    expect(splitAmount(WAD, [])).toEqual([]);
  });
});
