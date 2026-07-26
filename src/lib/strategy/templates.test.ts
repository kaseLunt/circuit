import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { validateGraph, type StrategyGraph } from "../../core/graph";
import {
  buildPlan,
  type ChainSnapshot,
  type PlanResult,
  type TransactionStep,
} from "../../core/plan";
import { optimizeRoute, validateRoute } from "../../core/route-optimizer";
import { canonicalStepAddresses, fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import {
  CANONICAL_STEPS,
  EXPECTED_BORROW_WEI,
  FORK_PROVEN_BORROW_BPS,
  flagshipGraph,
} from "../../../tests/helpers/graphs";
import { createComposerStore } from "../../app/store/composer-store";
import { FULL_ALLOCATION_BPS } from "./types";
import {
  FLAGSHIP_TEMPLATE_ID,
  STRATEGY_TEMPLATES,
  getTemplate,
  leveragedRestakeLoop,
  restake,
  restakeAndSupply,
  type StrategyTemplate,
} from "./templates";

const snapshot: ChainSnapshot = fixtureSnapshot();
const stepAddresses = canonicalStepAddresses();

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function expectOk(result: PlanResult): asserts result is Extract<PlanResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`plan unexpectedly failed: ${JSON.stringify(result.errors, bigintJson, 2)}`);
  }
}

function selectorOfStep(step: TransactionStep): string {
  const item = step.abi.find((e) => e.type === "function" && e.name === step.functionName);
  if (!item || item.type !== "function") throw new Error(`abi item missing for ${step.id}`);
  return toFunctionSelector(item);
}

function planOf(template: StrategyTemplate): PlanResult {
  return buildPlan(template.graph(), snapshot);
}

interface NumericLeaf {
  readonly path: string;
  readonly key: string;
  readonly value: number;
}

/** Every `number` reachable in a JSON-serialized value, with its key and path. */
function numericLeaves(value: unknown, path = "$", key = ""): NumericLeaf[] {
  if (typeof value === "number") return [{ path, key, value }];
  if (Array.isArray(value)) {
    return value.flatMap((v: unknown, i) => numericLeaves(v, `${path}[${i}]`, key));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]: [string, unknown]) =>
      numericLeaves(v, `${path}.${k}`, k),
    );
  }
  return [];
}

function reparse(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
}

// ————————————————————————— the fixture-identity gate —————————————————————————

describe("flagship template is the SPEC §2 expanded DAG", () => {
  /**
   * The identity gate, restated rather than relaxed.
   *
   * The shipped template opens at 5000 bps so the SPEC §3 step-3 drag can cross the warning
   * threshold; the fork fixture stays at `FORK_PROVEN_BORROW_BPS`, the point W03's anvil run
   * actually executed. Weakening this to "equal except the borrow" would let the two drift in
   * ways nothing catches, so the claim is made stronger instead: the template is byte-identical
   * to the fork-proven graph in EVERY other respect, and ONE `setBorrowAllocationBps` — the same
   * store action the demo's slider calls — carries it exactly onto the proven point.
   */
  it("is byte-identical to the fork-proven fixture but for the borrow allocation", () => {
    const shipped = leveragedRestakeLoop();
    const proven = flagshipGraph();

    // Every block, every edge, every id, every other param — identical.
    expect(shipped.edges).toEqual(proven.edges);
    expect(shipped.blocks.map((b) => ({ ...b, params: { ...b.params, allocationBps: null } }))).toEqual(
      proven.blocks.map((b) => ({ ...b, params: { ...b.params, allocationBps: null } })),
    );

    // The one difference is the one the demo script asks for, and it is the borrow's.
    const borrowOf = (g: StrategyGraph) =>
      g.blocks.find((b) => b.type === "borrow")!.params["allocationBps"];
    expect(borrowOf(shipped)).toBe(5_000);
    expect(borrowOf(proven)).toBe(FORK_PROVEN_BORROW_BPS);
  });

  it("reaches the fork-proven graph in one slider move, byte-identically", () => {
    const store = createComposerStore();
    expect(store.getState().loadTemplate(FLAGSHIP_TEMPLATE_ID)).toBe(true);

    expect(store.getState().setBorrowAllocationBps("borrow", FORK_PROVEN_BORROW_BPS)).toEqual({
      ok: true,
    });

    // Not "close enough": the document the user is holding after one drag IS the graph the
    // fork suite proved, so every number W03 pinned is one slider move from the screen.
    expect(store.getState().doc).toEqual(flagshipGraph());
  });

  it("pins the block ids every TransactionStep id is derived from", () => {
    expect(leveragedRestakeLoop().blocks.map((b) => b.id)).toEqual([
      "in",
      "stake1",
      "wrap1",
      "supply1",
      "borrow",
      "unwrap",
      "stake2",
      "wrap2",
      "supply2",
    ]);
  });

  it("mints the canonical sequential edge ids the plan fixture pins", () => {
    const g = leveragedRestakeLoop();
    expect(g.edges.map((e) => e.id)).toEqual(
      g.edges.map((_, i) => `e${i}`),
    );
  });

  it("is deterministic and hands out a fresh document per call", () => {
    // No Date.now(), no counter, no randomness: share URLs and plan snapshots
    // depend on two sessions producing the same ids.
    expect(leveragedRestakeLoop()).toEqual(leveragedRestakeLoop());
    expect(leveragedRestakeLoop()).not.toBe(leveragedRestakeLoop());
  });
});

describe("template graph → validateGraph", () => {
  it("accepts every template structurally", () => {
    for (const t of STRATEGY_TEMPLATES) {
      const validation = validateGraph(t.graph());
      expect(validation.errors, t.id).toEqual([]);
      expect(validation.ok, t.id).toBe(true);
    }
  });

  it("ships route-clean graphs: no wrap the optimizer would have to insert", () => {
    for (const t of STRATEGY_TEMPLATES) {
      const graph = t.graph();
      expect(validateRoute(graph).errors, t.id).toEqual([]);
      const optimized = optimizeRoute(graph);
      expect(optimized.autoInsertedBlockIds, t.id).toEqual([]);
      expect(optimized.graph, t.id).toEqual(graph);
    }
  });

  it("survives the share-URL / localStorage JSON round trip unchanged", () => {
    // Also proves the document holds no bigint: JSON.stringify would throw.
    for (const t of STRATEGY_TEMPLATES) {
      const graph = t.graph();
      expect(reparse(graph), t.id).toEqual(graph);
    }
  });
});

// ————————————————————————— template → plan —————————————————————————

describe("flagship template → buildPlan: the 13 enumerated steps (SPEC §2)", () => {
  it("emits exactly the canonical step sequence", () => {
    const result = planOf(getTemplate(FLAGSHIP_TEMPLATE_ID)!);
    expectOk(result);
    expect(result.steps).toHaveLength(13);
    expect(result.targetEModeCategoryId).toBe(1);
    expect(result.steps.map((s) => s.id)).toEqual(CANONICAL_STEPS.map((r) => r.id));

    for (const row of CANONICAL_STEPS) {
      const step = result.steps[row.index - 1]!;
      expect(step.index, row.id).toBe(row.index);
      expect(step.id, row.id).toBe(row.id);
      expect(step.blockId, row.id).toBe(row.blockId);
      expect(step.to, row.id).toBe(stepAddresses[row.to]);
      expect(step.functionName, row.id).toBe(row.functionName);
      expect(step.valueSpec, row.id).toBe(row.valueSpec);
      expect(selectorOfStep(step), row.id).toBe(toFunctionSelector(row.signature));

      const amount = step.amount;
      if (row.amount.kind === "literal") {
        if (amount.kind !== "literal") throw new Error(`${row.id}: expected a literal amount`);
        expect(amount.amount.kind, row.id).toBe("entered");
        expect(amount.amount.value, row.id).toBe(row.amount.wei);
      } else if (row.amount.kind === "step-output") {
        if (amount.kind !== "step-output") throw new Error(`${row.id}: expected a step-output`);
        expect(amount.producerStepId, row.id).toBe(row.amount.producer);
        expect(amount.attribution, row.id).toBe(row.amount.attribution);
        expect(amount.allocationBps, row.id).toBe(FULL_ALLOCATION_BPS);
      } else {
        expect(amount.kind, row.id).toBe(row.amount.kind);
      }
    }
  });

  it("plans identically to the canonical fixture graph, step for step", () => {
    // The strongest form of the identity claim: same steps, same ids, same order,
    // same ABIs, same amount specs, same provenance trees.
    //
    // Taken AT the fork-proven allocation, not at the shipped default: this asserts the
    // template reproduces W03's evidence, and evidence is pinned to the b it was executed
    // at. The shipped default's own graph is gated by the identity test above.
    expect(buildPlan(leveragedRestakeLoop("10", FORK_PROVEN_BORROW_BPS), snapshot)).toEqual(
      buildPlan(flagshipGraph(), snapshot),
    );
  });

  it("derives the borrow amount to the pinned wei", () => {
    const result = buildPlan(leveragedRestakeLoop("10", FORK_PROVEN_BORROW_BPS), snapshot);
    expectOk(result);
    const borrow = result.steps.find((s) => s.id === "borrow:borrow")!;
    if (borrow.amount.kind !== "derived") throw new Error("borrow amount must be derived");
    // EXPECTED_BORROW_WEI is a fork-proven quantity: it belongs to b = FORK_PROVEN_BORROW_BPS
    // and to no other b.
    expect(borrow.amount.amount.value).toBe(EXPECTED_BORROW_WEI);
  });
});

describe("every template in the roster can be explained", () => {
  it("plans without error, and the step counts are the roster's shape", () => {
    const counts = STRATEGY_TEMPLATES.map((t) => {
      const result = planOf(t);
      if (!result.ok) {
        // The only failure a shipped template may have is a recorded phase gap.
        expect(
          result.errors.every((e) => e.kind === "unsupported-in-phase"),
          `${t.id}: ${JSON.stringify(result.errors, bigintJson)}`,
        ).toBe(true);
        return -1;
      }
      return result.steps.length;
    });
    expect(counts).toEqual([1, 5, 13]);
  });

  it("only the leveraged template touches debt or e-mode", () => {
    const restakeOnly = buildPlan(restake(), snapshot);
    const supplyOnly = buildPlan(restakeAndSupply(), snapshot);
    const levered = planOf(getTemplate(FLAGSHIP_TEMPLATE_ID)!);
    expectOk(restakeOnly);
    expectOk(supplyOnly);
    expectOk(levered);
    expect(restakeOnly.targetEModeCategoryId).toBeNull();
    expect(supplyOnly.targetEModeCategoryId).toBeNull();
    expect(levered.targetEModeCategoryId).toBe(1);
    expect(restakeOnly.steps.some((s) => s.functionName === "borrow")).toBe(false);
    expect(supplyOnly.steps.some((s) => s.functionName === "borrow")).toBe(false);
    expect(levered.steps.some((s) => s.functionName === "borrow")).toBe(true);
    expect(supplyOnly.steps.map((s) => s.functionName)).toEqual([
      "deposit",
      "approve",
      "wrap",
      "approve",
      "supply",
    ]);
  });

  it("exposes unique, URL-safe ids and resolves the flagship §3 step 1 opens with", () => {
    const ids = STRATEGY_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z][a-z0-9-]*$/.test(id))).toBe(true);
    expect(ids).toContain(FLAGSHIP_TEMPLATE_ID);
    // The roster resolves the SAME graph the exported builder does — the registry is a
    // lookup, not a second definition. (Its relationship to the fork-proven fixture is the
    // identity gate's business, above.)
    expect(getTemplate(FLAGSHIP_TEMPLATE_ID)!.graph()).toEqual(leveragedRestakeLoop());
  });

  it("returns undefined for an unknown id instead of substituting a strategy", () => {
    expect(getTemplate("etherfi-loop")).toBeUndefined();
    expect(getTemplate("stablecoin-yield")).toBeUndefined();
    expect(getTemplate("")).toBeUndefined();
    // Array.find, not a Record lookup: a hostile id cannot reach Object.prototype.
    expect(getTemplate("__proto__")).toBeUndefined();
    expect(getTemplate("constructor")).toBeUndefined();
  });
});

// ————————————————————————— no fabricated numbers (SPEC §3.2) —————————————————————————

describe("templates carry no hand-written rate, APY or USD claim", () => {
  it("keeps metadata prose digit-free", () => {
    for (const t of STRATEGY_TEMPLATES) {
      const prose = `${t.name} ${t.summary}`;
      // The executable form of "no estimatedApy: '3-4%'". Blunt on purpose: a rule
      // with an exemption is a rule a claim can be smuggled through. Protocol
      // versions live in block params, where they are structure, not prose.
      expect(prose, t.id).not.toMatch(/\d/);
      expect(prose, t.id).not.toMatch(/[%$]/);
    }
  });

  it("carries no numeric field beyond allocation basis points, and never blurs the two", () => {
    // `edge.allocationBps` (flow routing) and `borrow.params.allocationBps` (debt
    // over collateral at open, §5.2 `b`) share a NAME but are different quantities,
    // so asserting on the key alone cannot tell them apart. This asserts on the
    // PATH: every edge carries the full allocation, and the only other number in the
    // document sits under a block's params.
    for (const t of STRATEGY_TEMPLATES) {
      const leaves = numericLeaves(reparse(t.graph()));
      expect([...new Set(leaves.map((l) => l.key))].sort(), t.id).toEqual(["allocationBps"]);
      for (const leaf of leaves) {
        expect(Number.isInteger(leaf.value), leaf.path).toBe(true);
        expect(leaf.value >= 1 && leaf.value <= FULL_ALLOCATION_BPS, leaf.path).toBe(true);
        if (leaf.path.startsWith("$.edges")) {
          expect(leaf.value, leaf.path).toBe(FULL_ALLOCATION_BPS);
        } else {
          expect(leaf.path, leaf.path).toMatch(/^\$\.blocks\[\d+\]\.params\.allocationBps$/);
        }
      }
    }
  });

  it("has no rate-, price- or risk-shaped key anywhere in the serialized template", () => {
    for (const t of STRATEGY_TEMPLATES) {
      const json = JSON.stringify({ ...t, graph: t.graph() });
      expect(json, t.id).not.toMatch(
        /\bapy\b|\bapr\b|\bltv\b|liquidation|threshold|price|\busd\b|\btvl\b|estimated|riskLevel|isConfigured|isValid/i,
      );
    }
  });

  it("carries no address: execution targets come only from the snapshot (§5.6)", () => {
    for (const t of STRATEGY_TEMPLATES) {
      expect(JSON.stringify(t.graph()), t.id).not.toMatch(/0x[0-9a-fA-F]{6,}/);
    }
  });

  it("holds the input amount as an exact decimal string, never a float", () => {
    for (const t of STRATEGY_TEMPLATES) {
      const input = t.graph().blocks.find((b) => b.type === "input")!;
      expect(typeof input.params["amount"], t.id).toBe("string");
      expect(input.params["amount"], t.id).toBe("10");
      expect(input.params["asset"], t.id).toBe("ETH");
    }
  });
});

describe("template parameters are caller input, and core is the only gate", () => {
  it("carries an entered amount straight into calldata, exactly", () => {
    const result = buildPlan(leveragedRestakeLoop("1.5", 5_000), snapshot);
    expectOk(result);
    const deposit = result.steps[0]!;
    if (deposit.amount.kind !== "literal") throw new Error("expected a literal amount");
    expect(deposit.amount.amount.value).toBe(1_500_000_000_000_000_000n);
    const borrowBlock = leveragedRestakeLoop("1.5", 5_000).blocks.find((b) => b.type === "borrow")!;
    expect(borrowBlock.params["allocationBps"]).toBe(5_000);
  });

  it("does not clamp or default a bad parameter — core rejects it", () => {
    // No silent numeric fallback: an out-of-range allocation or a zero amount
    // produces an INVALID graph, never a quietly corrected one.
    const overAllocated = validateGraph(leveragedRestakeLoop("10", 10_001));
    const zeroAmount = validateGraph(leveragedRestakeLoop("0"));
    expect(overAllocated.ok).toBe(false);
    expect(zeroAmount.ok).toBe(false);
    expect(
      overAllocated.errors.some((e) => e.includes("allocationBps must be an integer in [1,10000]")),
    ).toBe(true);
    expect(zeroAmount.errors.some((e) => e.includes("positive amount"))).toBe(true);
  });

  it("rejects every hostile parameter shape a caller could forward from a form", () => {
    // The builders take OPEN parameters (module header caller contract), so the
    // parameterized-template path is an untrusted-input path the moment a caller
    // wires a field to it. Each of these must be REJECTED, never coerced.
    const badAmounts = ["", " 10", "10 ", "1e3", "-1", "0x10", "0.0", "1,5", "1e309", "NaN"];
    for (const amount of badAmounts) {
      expect(validateGraph(restake(amount)).ok, amount).toBe(false);
      expect(validateGraph(restakeAndSupply(amount)).ok, amount).toBe(false);
      expect(validateGraph(leveragedRestakeLoop(amount)).ok, amount).toBe(false);
    }
    const badBps = [0, -1, 10_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const bps of badBps) {
      expect(validateGraph(leveragedRestakeLoop("10", bps)).ok, String(bps)).toBe(false);
    }
  });

  it("an invalid parameterized template is refused by buildPlan, not silently planned", () => {
    // buildPlan runs validateGraph first; this pins that a hostile template graph can
    // never reach calldata, matching the share-URL and local-draft paths.
    const bad = buildPlan(leveragedRestakeLoop("0", 10_001), snapshot);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.errors.map((e) => e.kind)).toContain("graph-invalid");
  });
});
