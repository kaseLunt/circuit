/**
 * Shared fixture graphs and the SPEC §2 canonical step enumeration (W05 R4).
 *
 * `flagshipGraph` / `chainOf` are lifted out of `src/core/plan.test.ts:31-59` with
 * their bodies unchanged — same block ids, same `e${i}` edge ids, same defaults.
 * The extraction is deliberately NOT an opportunity to "standardize" the edge-id
 * scheme: `plan.test.ts` is W03 evidence, and a behaviour-free refactor is only
 * provably behaviour-free if the fixture it moves is the same fixture.
 *
 * This file must never build its graphs by calling `src/lib/strategy/templates.ts`:
 * it is the pin that proves the shipped template still emits the canonical graph,
 * and importing the template would make that pin assert `x === x`.
 */
import type { Block, StrategyGraph } from "../../src/core/graph";
import type { AmountAttribution } from "../../src/core/plan";
import { FULL_ALLOCATION_BPS } from "../../src/lib/strategy/types";

/**
 * W05 R6: the fixture's full-allocation value is the LANDED bps contract, not a
 * re-typed literal. The extracted body used `10_000`; this both-directions compile
 * pin fails the build if `src/lib/strategy/types.ts` ever moves, so "the extraction
 * changed nothing" stays a checked claim rather than a memory.
 */
type ExtractedLiteralAllocationBps = 10_000;
export const FIXTURE_BPS_MATCHES_CORE: ExtractedLiteralAllocationBps extends typeof FULL_ALLOCATION_BPS
  ? typeof FULL_ALLOCATION_BPS extends ExtractedLiteralAllocationBps
    ? true
    : never
  : never = true;

export const WAD_WEI = 10n ** 18n;

function linearEdges(chain: readonly string[]): StrategyGraph["edges"] {
  return chain.slice(0, -1).map((source, i) => ({
    id: `e${i}`,
    source,
    target: chain[i + 1]!,
    allocationBps: FULL_ALLOCATION_BPS,
  }));
}

/**
 * The borrow allocation W03's fork evidence executed against — the point every pinned
 * plan number, every `EXPECTED_BORROW_WEI` and every anvil assertion in
 * `tests/fork/flagship-plan.test.ts` is proven at.
 *
 * Named, not typed twice: the shipped template's default moved to 5000 for the SPEC §3
 * demo script (it must OPEN safe and cross into warning on the step-3 drag), and the
 * moment those two numbers diverged, the fixture's value stopped being "the default" and
 * became a specific claim about what has been executed on a fork. A claim like that gets
 * a name, so the identity gate can say which one it means.
 */
export const FORK_PROVEN_BORROW_BPS = 7000;

/** SPEC §2 Leveraged Restake Loop — the canonical 13-step fixture graph. */
export function flagshipGraph(
  amount: string | number = "10",
  allocationBps: number = FORK_PROVEN_BORROW_BPS,
): StrategyGraph {
  const blocks: Block[] = [
    { id: "in", type: "input", params: { asset: "ETH", amount } },
    { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
    { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
    { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    { id: "borrow", type: "borrow", params: { protocol: "aave-v3", asset: "WETH", allocationBps } },
    { id: "unwrap", type: "unwrap", params: { from: "WETH", to: "ETH" } },
    { id: "stake2", type: "stake", params: { protocol: "etherfi" } },
    { id: "wrap2", type: "wrap", params: { from: "eETH", to: "weETH" } },
    { id: "supply2", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
  ];
  const chain = ["in", "stake1", "wrap1", "supply1", "borrow", "unwrap", "stake2", "wrap2", "supply2"];
  return { blocks, edges: linearEdges(chain) };
}

/**
 * The carry's borrow allocation, fork-proven — and, unlike the flagship's, the SAME value the
 * shipped template defaults to.
 *
 * The flagship carries two numbers one slider apart because its demo script needs the composer
 * to OPEN safe and cross into warning on the step-3 drag. The carry has no such beat: its whole
 * point is that it rests in the amber band on arrival, so the honest default and the proven
 * point are the same point, and `templates.test.ts` pins that they have not drifted apart. The
 * value is the owner's ratified 6000 bps (2026-07-30); the constraint it satisfies is recorded
 * at its definition site in `src/lib/strategy/templates.ts`.
 */
export const FORK_PROVEN_CARRY_BPS = 6000;

/**
 * The W09 USDC carry: supply weETH, borrow USDC against it. FIVE blocks, six steps, and NO
 * `set-emode` — no recorded category admits a USDC borrow, so the plan runs at the reserve
 * regime by selection rather than by exception.
 *
 * The block ids are the same CONTRACT the flagship's are: `core/plan.ts` derives every
 * `TransactionStep.id` from them, so renaming one silently renames plan steps.
 */
export function carryGraph(
  amount: string | number = "10",
  allocationBps: number = FORK_PROVEN_CARRY_BPS,
): StrategyGraph {
  const blocks: Block[] = [
    { id: "in", type: "input", params: { asset: "ETH", amount } },
    { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
    { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
    { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    { id: "borrow", type: "borrow", params: { protocol: "aave-v3", asset: "USDC", allocationBps } },
  ];
  return { blocks, edges: linearEdges(["in", "stake1", "wrap1", "supply1", "borrow"]) };
}

/**
 * Loop AND carry in one document — the mixed shape the owner ratified on 2026-07-30 as
 * PLANNED, not refused.
 *
 * It is protocol-legal (both borrows validate at category 0), so refusing it would refuse
 * something the chain accepts. What it forfeits is the §5.2 composition and the single-pair
 * liquidation ratio, both of which require exactly one borrow — and those unavailable states
 * are the correct outputs, pinned as such rather than left as holes.
 */
export function mixedLoopAndCarryGraph(
  amount: string | number = "10",
  loopBps: number = 3000,
  carryBps: number = 2000,
): StrategyGraph {
  const blocks: Block[] = [
    { id: "in", type: "input", params: { asset: "ETH", amount } },
    { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
    { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
    { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    {
      id: "borrow",
      type: "borrow",
      params: { protocol: "aave-v3", asset: "WETH", allocationBps: loopBps },
    },
    { id: "unwrap", type: "unwrap", params: { from: "WETH", to: "ETH" } },
    { id: "stake2", type: "stake", params: { protocol: "etherfi" } },
    { id: "wrap2", type: "wrap", params: { from: "eETH", to: "weETH" } },
    { id: "supply2", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    {
      id: "carry",
      type: "borrow",
      params: { protocol: "aave-v3", asset: "USDC", allocationBps: carryBps },
    },
  ];
  return {
    blocks,
    edges: linearEdges([
      "in",
      "stake1",
      "wrap1",
      "supply1",
      "borrow",
      "unwrap",
      "stake2",
      "wrap2",
      "supply2",
      "carry",
    ]),
  };
}

export function chainOf(blocks: Block[]): StrategyGraph {
  return { blocks, edges: linearEdges(blocks.map((b) => b.id)) };
}

// ————————————————————————— pinned expectations —————————————————————————

// Derivation chain for E = 10 ETH, b = 7000 bps, computed independently from the
// committed reads log (floor at every division; matrix §7 share model):
//   s1  = floor(E·S0/P0)                            = 9092267716600505494
//   b1  = floor(s1·(P0+E)/(S0+s1))                  = 9999999999999999999
//   w1  = floor(b1·(S0+s1)/(P0+E))                  = 9092267716600505493
//   collateralBase = floor(w1·priceWeETH/1e18)      = 1923866861999
//   borrowBase     = floor(collateralBase·7000/1e4) = 1346706803399
//   borrowWei      = floor(borrowBase·1e18/priceWETH) = 6999999999994802135
export const EXPECTED_BORROW_WEI = 6999999999994802135n;

/**
 * The five execution targets the flagship touches. Symbolic, not addresses: the
 * enumeration is a claim about WHICH contract each step calls, and every address is
 * resolved by the consuming suite from the committed reads log, so no table can
 * launder a hand-typed address into an assertion.
 */
export type StepTarget = "LP" | "eETH" | "weETH" | "WETH" | "pool";

export interface StepRow {
  readonly index: number;
  readonly id: string;
  readonly blockId: string;
  readonly to: StepTarget;
  readonly functionName: string;
  readonly signature: string;
  readonly valueSpec: "none" | "amount";
  readonly amount:
    | { readonly kind: "literal"; readonly wei: bigint }
    | { readonly kind: "none" }
    | { readonly kind: "derived" }
    | {
        readonly kind: "step-output";
        readonly producer: string;
        readonly attribution: AmountAttribution;
      };
}

/**
 * The carry's enumerated execution steps (W09), in canonical order.
 *
 * Six, and the ABSENCES are the content: no `setUserEMode` (no category admits the pair) and
 * no approve targeting USDC (the borrow only ever moves USDC pool → actor, so no allowance
 * exists to grant). Both are asserted as absences in `plan.test.ts` rather than left implied
 * by the length.
 */
export const CANONICAL_CARRY_STEPS: readonly StepRow[] = [
  { index: 1, id: "stake1:deposit", blockId: "stake1", to: "LP", functionName: "deposit", signature: "function deposit()", valueSpec: "amount", amount: { kind: "literal", wei: 10n * WAD_WEI } },
  { index: 2, id: "wrap1:approve", blockId: "wrap1", to: "eETH", functionName: "approve", signature: "function approve(address,uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "stake1:deposit", attribution: "share-delta" } },
  { index: 3, id: "wrap1:wrap", blockId: "wrap1", to: "weETH", functionName: "wrap", signature: "function wrap(uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "stake1:deposit", attribution: "share-delta" } },
  { index: 4, id: "supply1:approve", blockId: "supply1", to: "weETH", functionName: "approve", signature: "function approve(address,uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "wrap1:wrap", attribution: "transfer-event" } },
  { index: 5, id: "supply1:supply", blockId: "supply1", to: "pool", functionName: "supply", signature: "function supply(address,uint256,address,uint16)", valueSpec: "none", amount: { kind: "step-output", producer: "wrap1:wrap", attribution: "transfer-event" } },
  { index: 6, id: "borrow:borrow", blockId: "borrow", to: "pool", functionName: "borrow", signature: "function borrow(address,uint256,uint256,uint16,address)", valueSpec: "none", amount: { kind: "derived" } },
];

/** SPEC §2's enumerated execution steps, in canonical order. */
export const CANONICAL_STEPS: readonly StepRow[] = [
  { index: 1, id: "stake1:deposit", blockId: "stake1", to: "LP", functionName: "deposit", signature: "function deposit()", valueSpec: "amount", amount: { kind: "literal", wei: 10n * WAD_WEI } },
  { index: 2, id: "wrap1:approve", blockId: "wrap1", to: "eETH", functionName: "approve", signature: "function approve(address,uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "stake1:deposit", attribution: "share-delta" } },
  { index: 3, id: "wrap1:wrap", blockId: "wrap1", to: "weETH", functionName: "wrap", signature: "function wrap(uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "stake1:deposit", attribution: "share-delta" } },
  { index: 4, id: "supply1:set-emode", blockId: "supply1", to: "pool", functionName: "setUserEMode", signature: "function setUserEMode(uint8)", valueSpec: "none", amount: { kind: "none" } },
  { index: 5, id: "supply1:approve", blockId: "supply1", to: "weETH", functionName: "approve", signature: "function approve(address,uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "wrap1:wrap", attribution: "transfer-event" } },
  { index: 6, id: "supply1:supply", blockId: "supply1", to: "pool", functionName: "supply", signature: "function supply(address,uint256,address,uint16)", valueSpec: "none", amount: { kind: "step-output", producer: "wrap1:wrap", attribution: "transfer-event" } },
  { index: 7, id: "borrow:borrow", blockId: "borrow", to: "pool", functionName: "borrow", signature: "function borrow(address,uint256,uint256,uint16,address)", valueSpec: "none", amount: { kind: "derived" } },
  { index: 8, id: "unwrap:withdraw", blockId: "unwrap", to: "WETH", functionName: "withdraw", signature: "function withdraw(uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "borrow:borrow", attribution: "transfer-event" } },
  { index: 9, id: "stake2:deposit", blockId: "stake2", to: "LP", functionName: "deposit", signature: "function deposit()", valueSpec: "amount", amount: { kind: "step-output", producer: "unwrap:withdraw", attribution: "withdraw-argument" } },
  { index: 10, id: "wrap2:approve", blockId: "wrap2", to: "eETH", functionName: "approve", signature: "function approve(address,uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "stake2:deposit", attribution: "share-delta" } },
  { index: 11, id: "wrap2:wrap", blockId: "wrap2", to: "weETH", functionName: "wrap", signature: "function wrap(uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "stake2:deposit", attribution: "share-delta" } },
  { index: 12, id: "supply2:approve", blockId: "supply2", to: "weETH", functionName: "approve", signature: "function approve(address,uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "wrap2:wrap", attribution: "transfer-event" } },
  { index: 13, id: "supply2:supply", blockId: "supply2", to: "pool", functionName: "supply", signature: "function supply(address,uint256,address,uint16)", valueSpec: "none", amount: { kind: "step-output", producer: "wrap2:wrap", attribution: "transfer-event" } },
];
