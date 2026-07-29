/**
 * SPEC §3 step 4, the decision half: is the requested borrow past the limit, and what is the
 * math that says so?
 *
 * "The block rejects it CLIENT-SIDE, INLINE, showing the math with LTV/LT read from the
 * ACTIVE eMode configuration — never scripted copy (the in-eMode and outside-eMode regimes
 * differ; quoting the wrong one is a correctness bug)." So nothing here is authored: every
 * number below is read off the risk ledger's own legs, which read them off the block-pinned
 * `ChainSnapshot` through `effectiveLtvBps`/`effectiveLiquidationThresholdBps` — the same two
 * matrix §3 rules `buildPlan` and the health factor use. There is no second derivation.
 *
 * WHICH limit this is, precisely. Aave's `ValidationLogic.validateBorrow` compares the debt
 * the position would carry against the collateral its LTV admits; the liquidation threshold
 * is a different, LATER line (where the position becomes liquidatable) and is always at or
 * above LTV. This module refuses at the LTV line — the line the protocol itself refuses at —
 * and reports LT beside it because the user's question at that moment is "how far is this
 * from being liquidated", and answering with the wrong one of the two is the bug SPEC names.
 *
 * What this module deliberately does NOT do: predict which revert the chain would produce.
 * A decoded revert is chain evidence; `core/errors.ts` decodes what the chain returned, and
 * the "Simulate anyway" override exists so the user can go and get that evidence rather than
 * be handed our guess at it (SPEC §5.7: validation PRE-EMPTS predictable failures; the
 * residual reverts are decoded, not invented).
 */
import type { StrategyGraph } from "./graph";
import { buildPlan, type ChainSnapshot } from "./plan";
import { riskLedger, type RiskCheckpoint, type SupplyLeg } from "./risk";

/** Basis-point denominator — Aave's own `PERCENTAGE_FACTOR`. */
const BPS = 10_000n;
/** 100% of collateral value: the top of the allocation domain, and the search bound below. */
const FULL_ALLOCATION_BPS = Number(BPS);

/** The math the block renders. Every field is read, none is authored. */
export interface BorrowCeiling {
  /** The borrow block this verdict is about. */
  readonly blockId: string;
  /**
   * The active configuration's id, or null when no e-mode category governs the position.
   * Rendered so the copy can say WHICH regime it is quoting.
   */
  readonly categoryId: number | null;
  /** Effective LTV of the collateral under the active configuration, bps. */
  readonly ltvBps: number;
  /** Effective liquidation threshold of the same collateral, same configuration, bps. */
  readonly ltBps: number;
  /** Oracle base-currency value of the collateral standing at the borrow. */
  readonly collateralBase: bigint;
  /** Σ floor(collateral_i × ltv_i / 1e4) — what Aave's borrow validation compares against. */
  readonly ceilingBase: bigint;
  /** The debt the position would carry after this borrow, oracle base currency. */
  readonly debtBase: bigint;
  /** The largest borrow allocation the ceiling admits, in bps of collateral value. */
  readonly maxAllocationBps: number;
  /** What the document asks for, in the same units. */
  readonly requestedAllocationBps: number;
}

export type BorrowLimitVerdict =
  /** No borrow in this document — there is nothing to gate. */
  | { readonly status: "not-applicable" }
  /** Within the ceiling; the ceiling is carried so the block can show the headroom. */
  | { readonly status: "within"; readonly ceiling: BorrowCeiling }
  /** Past the ceiling. Simulate is gated until the user edits or explicitly overrides. */
  | { readonly status: "over-limit"; readonly ceiling: BorrowCeiling }
  /**
   * The inputs did not resolve — a missing oracle price, a plan that will not build, a
   * collateral leg with no base value. Renders as the explicit unavailable state and gates
   * (SPEC §5): an unevaluable limit is not a satisfied one.
   */
  | { readonly status: "unavailable"; readonly reason: string };

/** The mixed-LTV-safe ceiling: each leg contributes at ITS OWN effective LTV. */
function ceilingBaseOf(supplies: readonly SupplyLeg[]): bigint | null {
  let ceiling = 0n;
  for (const leg of supplies) {
    if (leg.baseProv === null) return null;
    ceiling += (leg.baseProv.value * BigInt(leg.ltvBps)) / BPS;
  }
  return ceiling;
}

function collateralBaseOf(supplies: readonly SupplyLeg[]): bigint | null {
  let total = 0n;
  for (const leg of supplies) {
    if (leg.baseProv === null) return null;
    total += leg.baseProv.value;
  }
  return total;
}

/**
 * The single LTV/LT pair to quote. With one collateral reserve — the flagship's shape and
 * the only shape v1 plans — the legs agree and the pair is exact. With more than one they
 * would not, so this refuses to quote a blended figure that belongs to no reserve; the
 * ceiling arithmetic above stays per-leg and correct either way.
 */
function quotedPairOf(
  supplies: readonly SupplyLeg[],
): { readonly ltvBps: number; readonly ltBps: number } | null {
  const first = supplies[0];
  if (first === undefined) return null;
  for (const leg of supplies) {
    if (leg.ltvBps !== first.ltvBps || leg.ltBps !== first.ltBps) return null;
  }
  return { ltvBps: first.ltvBps, ltBps: first.ltBps };
}

/**
 * The largest allocation the ceiling admits, DEFINED as the largest `b` whose derived debt
 * still fits — not as `ceilingBase × 1e4 / collateralBase`.
 *
 * The two are not the same number. `plan.ts` derives the debt as
 * `floor(collateralBase × b / 1e4)` and the ceiling is itself a floor, so dividing back out
 * understates the admissible `b` by one basis point whenever both floors bite. Reporting a
 * ceiling one step below the real one would refuse a borrow the protocol accepts — a
 * refusal the user could not act on, because editing to the quoted maximum would still be
 * "past the limit" by our own arithmetic. So the inverse is CHECKED against the same
 * flooring the plan uses, and the loop is bounded by the allocation domain's own top.
 */
function maxAllocationBpsOf(collateralBase: bigint, ceilingBase: bigint): number {
  let bps = Number((ceilingBase * BPS) / collateralBase);
  while (bps < FULL_ALLOCATION_BPS && (collateralBase * BigInt(bps + 1)) / BPS <= ceilingBase) {
    bps += 1;
  }
  return bps;
}

function requestedAllocationBpsOf(graph: StrategyGraph, blockId: string): number | null {
  const block = graph.blocks.find((candidate) => candidate.id === blockId);
  if (block === undefined) return null;
  const raw = block.params["allocationBps"];
  return typeof raw === "number" ? raw : null;
}

/**
 * The FIRST borrow checkpoint whose debt exceeds its ceiling decides — a plan is refused at
 * the earliest step the protocol would refuse it, not at the last. With one borrow (v1) the
 * distinction is moot; it is written this way so a second borrow cannot hide behind the first.
 */
export function borrowLimitVerdict(
  graph: StrategyGraph,
  snapshot: ChainSnapshot,
): BorrowLimitVerdict {
  const plan = buildPlan(graph, snapshot);
  if (!plan.ok) {
    return {
      status: "unavailable",
      reason: "the strategy does not plan, so no borrow ceiling can be computed",
    };
  }
  // The ACTIVE configuration, read from the plan's own e-mode selection — never assumed and
  // never a second selection rule (SPEC §3 step 4: quoting the wrong regime is a bug).
  const categoryId = plan.targetEModeCategoryId;
  const ledger = riskLedger(graph, snapshot);
  if (!ledger.ok) {
    return {
      status: "unavailable",
      reason: "the strategy does not plan, so no borrow ceiling can be computed",
    };
  }
  const borrows = ledger.checkpoints.filter((cp) => cp.cause === "borrow");
  if (borrows.length === 0) return { status: "not-applicable" };

  let firstWithin: BorrowCeiling | null = null;
  for (const checkpoint of borrows) {
    const built = ceilingFor(graph, checkpoint, categoryId);
    if (built.status !== "built") return built.verdict;
    if (built.ceiling.debtBase > built.ceiling.ceilingBase) {
      return { status: "over-limit", ceiling: built.ceiling };
    }
    if (firstWithin === null) firstWithin = built.ceiling;
  }
  if (firstWithin === null) {
    // Structurally unreachable while `borrows` is non-empty (every iteration either returns
    // or assigns). Kept as a refusal rather than a non-null assertion: if a future ledger
    // shape ever produced an empty walk here, refusing is right and asserting is not.
    return { status: "unavailable", reason: "no borrow checkpoint produced a ceiling" };
  }
  return { status: "within", ceiling: firstWithin };
}

type CeilingBuild =
  | { readonly status: "built"; readonly ceiling: BorrowCeiling }
  | { readonly status: "refused"; readonly verdict: BorrowLimitVerdict };

function ceilingFor(
  graph: StrategyGraph,
  checkpoint: RiskCheckpoint,
  categoryId: number | null,
): CeilingBuild {
  const pair = quotedPairOf(checkpoint.supplies);
  // Unreachable in v1 — weETH is the only lendable asset, so every collateral leg carries the
  // same effective pair. It is a refusal rather than an assumption because the moment a
  // second collateral asset lands, quoting one leg's LTV for the whole position would be a
  // wrong number on a money surface.
  if (pair === null) {
    return {
      status: "refused",
      verdict: {
        status: "unavailable",
        reason:
          "this borrow stands against collateral with more than one effective LTV/LT pair, so no single pair describes its limit",
      },
    };
  }
  const collateralBase = collateralBaseOf(checkpoint.supplies);
  const ceilingBase = ceilingBaseOf(checkpoint.supplies);
  const debtBase = checkpoint.totalDebtBase;
  if (collateralBase === null || ceilingBase === null || debtBase === null) {
    return {
      status: "refused",
      verdict: {
        status: "unavailable",
        reason: "a collateral or debt leg has no oracle value in the pinned read set",
      },
    };
  }
  if (collateralBase === 0n) {
    return {
      status: "refused",
      verdict: {
        status: "unavailable",
        reason: "the collateral standing at this borrow values to zero in the pinned read set",
      },
    };
  }
  const requestedAllocationBps = requestedAllocationBpsOf(graph, checkpoint.blockId);
  if (requestedAllocationBps === null) {
    return {
      status: "refused",
      verdict: { status: "unavailable", reason: "the borrow block carries no allocation" },
    };
  }
  return {
    status: "built",
    ceiling: {
      blockId: checkpoint.blockId,
      categoryId,
      ltvBps: pair.ltvBps,
      ltBps: pair.ltBps,
      collateralBase,
      ceilingBase,
      debtBase,
      maxAllocationBps: maxAllocationBpsOf(collateralBase, ceilingBase),
      requestedAllocationBps,
    },
  };
}
