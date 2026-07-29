/**
 * SPEC §3 step 4, the decision half: is the requested borrow past the limit, and what is the
 * math that says so?
 *
 * "The block rejects it CLIENT-SIDE, INLINE, showing the math with LTV/LT read from the
 * ACTIVE eMode configuration — never scripted copy (the in-eMode and outside-eMode regimes
 * differ; quoting the wrong one is a correctness bug)." So nothing here is authored: every
 * number below is read off the risk ledger's own legs, which read them off the block-pinned
 * `ChainSnapshot` through `effectiveLtvBps`/`effectiveLiquidationThresholdBps` — the same two
 * matrix §3 rules `buildPlan` and the health factor use. There is no second derivation of the
 * LTV/LT pair.
 *
 * WHICH limit this is, precisely. Aave v3.7 validates a borrow in
 * `BorrowLogic.executeBorrow` → `ValidationLogic.validateHFAndLtv` (aave-dao/aave-v3-origin,
 * BorrowLogic.sol:95-103): the debt is MINTED first, then the post-mint account data is
 * checked — LTV non-zero, HF ≥ 1, and finally
 * `userCollateralInBaseCurrency >= userDebtInBaseCurrency.percentDivCeil(currentLtv)`
 * (ValidationLogic.sol:381-384, Errors.CollateralCannotCoverNewBorrow). The liquidation
 * threshold is a different, LATER line (where the position becomes liquidatable) and is
 * always at or above LTV. This module refuses at the LTV line — the line the protocol itself
 * refuses at — and reports LT beside it because the user's question at that moment is "how
 * far is this from being liquidated", and answering with the wrong one of the two is the bug
 * SPEC names.
 *
 * THE ROUNDING CHAIN IS THE PROTOCOL'S, not a floor-everything approximation. The four legs,
 * each cited to the deployed revision's source (aave-dao/aave-v3-origin @ main, matrix §2):
 *
 *  1. Debt mint: `amountScaled = amount.getVTokenMintScaledAmount(nextVariableBorrowIndex)`
 *     = rayDivCeil (BorrowLogic.sol:53, TokenMath.sol:80-85).
 *  2. Debt read-back: `scaledBalanceOf(user).getVTokenBalance(getNormalizedDebt())`
 *     = rayMulCeil (GenericLogic.sol:225-227, TokenMath.sol:108-113).
 *  3. Debt base conversion: `MathUtils.mulDivCeil(userTotalDebt, assetPrice, assetUnit)`
 *     (GenericLogic.sol:229) — upward, so the protocol never under-accounts debt.
 *  4. Collateral: aToken mint floors (`rayDivFloor`, TokenMath.sol:24-29), the balance read
 *     floors (`rayMulFloor`, TokenMath.sol:66-70), and the base conversion floors
 *     (GenericLogic.sol:248-256) — downward, so it never over-accounts collateral.
 *
 * Every rounding primitive is `core/rates.ts`'s fork-proven port — nothing is re-derived
 * here. A floor-rounded debt (the pre-remediation shape) admitted borrows the pool rejects:
 * at the pinned fixture, allocation 9300 floored to debtBase 1 wei UNDER the ceiling while
 * the protocol's ceil-chained debt lands 1 base-unit OVER it. The regression test pins both
 * sides of that boundary.
 *
 * What this module deliberately does NOT do: predict which revert the chain would produce.
 * A decoded revert is chain evidence; `core/errors.ts` decodes what the chain returned, and
 * the "Simulate anyway" override exists so the user can go and get that evidence rather than
 * be handed our guess at it (SPEC §5.7: validation PRE-EMPTS predictable failures; the
 * residual reverts are decoded, not invented).
 */
import type { StrategyGraph } from "./graph";
import { buildPlan, type ChainSnapshot, type ReserveSnapshot } from "./plan";
import {
  accruedLiquidityIndexRay,
  accruedVariableBorrowIndexRay,
  aTokenBalance,
  mulDivCeil,
  rayDivCeil,
  rayDivFloor,
  vTokenBalance,
} from "./rates";
import { riskLedger, type DebtLeg, type RiskCheckpoint, type SupplyLeg } from "./risk";

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
  /**
   * Collateral in oracle base currency as GenericLogic values it: the floor-rounded aToken
   * mint/balance round-trip at the accrued liquidity index, then floor(balance × price /
   * assetUnit) per reserve (GenericLogic.sol:242-257).
   */
  readonly collateralBase: bigint;
  /**
   * floor(collateralBase × ltv / 1e4) — the exact integer boundary of Aave's own check.
   * The protocol compares `collateral >= debt.percentDivCeil(ltv)` (ValidationLogic.sol:382);
   * for integer debt that inequality holds iff `debt <= floor(collateral × ltv / 1e4)`, so
   * the two forms refuse identically. (`quotedPairOf` refuses multi-pair collateral, so
   * `currentLtv` — GenericLogic's collateral-weighted average — equals the single pair here.)
   */
  readonly ceilingBase: bigint;
  /**
   * The debt the position would carry after this borrow, valued the way validateHFAndLtv
   * reads it: ceil-scaled mint, ceil balance read-back, ceil base conversion (chain above).
   */
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

/**
 * One reserve's valuation context: the accrued indexes `Pool.updateState` would hold at the
 * pinned block (the same accrual `risk.ts`'s rate walk and `plan.ts`'s cap checks use), plus
 * the oracle price and asset unit the base conversions divide by.
 */
interface ReserveValuation {
  readonly unit: bigint;
  readonly priceBase: bigint;
  readonly liquidityIndexRay: bigint;
  readonly variableBorrowIndexRay: bigint;
}

/**
 * The accrual's own preconditions, checked rather than caught: a `try` around money math is
 * a silent fallback wearing a guard's clothes (the `ratesComputable` doctrine). A snapshot
 * that cannot be accrued produces no honest ceiling, so the verdict goes `unavailable`.
 */
function reserveValuationOf(
  reserve: ReserveSnapshot,
  blockTimestamp: bigint,
): ReserveValuation | null {
  if (
    reserve.priceBase.value <= 0n ||
    reserve.liquidityIndexRay.value <= 0n ||
    reserve.variableBorrowIndexRay.value <= 0n ||
    reserve.liquidityRateRay.value < 0n ||
    reserve.variableBorrowRateRay.value < 0n ||
    reserve.lastUpdateTimestamp.value > blockTimestamp
  ) {
    return null;
  }
  return {
    unit: 10n ** BigInt(reserve.decimals.value),
    priceBase: reserve.priceBase.value,
    liquidityIndexRay: accruedLiquidityIndexRay(
      reserve.liquidityRateRay.value,
      reserve.liquidityIndexRay.value,
      reserve.lastUpdateTimestamp.value,
      blockTimestamp,
    ),
    variableBorrowIndexRay: accruedVariableBorrowIndexRay(
      reserve.variableBorrowRateRay.value,
      reserve.variableBorrowIndexRay.value,
      reserve.lastUpdateTimestamp.value,
      blockTimestamp,
    ),
  };
}

type ValuationByReserve = ReadonlyMap<string, ReserveValuation>;

/**
 * GenericLogic._getUserBalanceInBaseCurrency over the legs standing at the checkpoint,
 * grouped by reserve exactly as the protocol reads them: each supply mints
 * `rayDivFloor(amount, index)` scaled units (TokenMath.getATokenMintScaledAmount), the
 * SUMMED scaled balance reads back through `rayMulFloor` (getATokenBalance), and the base
 * conversion floors once per reserve.
 */
function protocolCollateralBaseOf(
  supplies: readonly SupplyLeg[],
  valuations: ValuationByReserve,
): bigint | null {
  const scaledByReserve = new Map<string, bigint>();
  for (const leg of supplies) {
    if (leg.baseProv === null) return null;
    const valuation = valuations.get(leg.reserve);
    if (valuation === undefined) return null;
    // A first leg starts its reserve's scaled sum at zero — initialization, not a fallback.
    const prior = scaledByReserve.get(leg.reserve);
    scaledByReserve.set(
      leg.reserve,
      (prior === undefined ? 0n : prior) + rayDivFloor(leg.amountWei, valuation.liquidityIndexRay),
    );
  }
  let total = 0n;
  for (const [reserve, scaled] of scaledByReserve) {
    const valuation = valuations.get(reserve)!;
    const balance = aTokenBalance(scaled, valuation.liquidityIndexRay);
    total += (balance * valuation.priceBase) / valuation.unit;
  }
  return total;
}

/** One debt reserve's amounts, as (blockId, amountWei) pairs so a candidate can substitute. */
interface DebtAmount {
  readonly reserve: string;
  readonly amountWei: bigint;
}

/**
 * GenericLogic._getUserDebtInBaseCurrency over the debt standing at the checkpoint: each
 * borrow mints `rayDivCeil(amount, index)` scaled units (getVTokenMintScaledAmount,
 * BorrowLogic.sol:53), the summed scaled debt reads back through `rayMulCeil`
 * (getVTokenBalance), and the base conversion is `mulDivCeil(debt, price, unit)`
 * (GenericLogic.sol:229) — every leg of the chain rounds AGAINST the borrower, which is the
 * direction that makes "within" here imply "accepted" there.
 */
function protocolDebtBaseOf(
  debts: readonly DebtAmount[],
  valuations: ValuationByReserve,
): bigint | null {
  const scaledByReserve = new Map<string, bigint>();
  for (const leg of debts) {
    const valuation = valuations.get(leg.reserve);
    if (valuation === undefined) return null;
    // A first leg starts its reserve's scaled sum at zero — initialization, not a fallback.
    const prior = scaledByReserve.get(leg.reserve);
    scaledByReserve.set(
      leg.reserve,
      (prior === undefined ? 0n : prior) + rayDivCeil(leg.amountWei, valuation.variableBorrowIndexRay),
    );
  }
  let total = 0n;
  for (const [reserve, scaled] of scaledByReserve) {
    const valuation = valuations.get(reserve)!;
    const debtWei = vTokenBalance(scaled, valuation.variableBorrowIndexRay);
    total += mulDivCeil(debtWei, valuation.priceBase, valuation.unit);
  }
  return total;
}

/**
 * The single LTV/LT pair to quote. With one collateral reserve — the flagship's shape and
 * the only shape v1 plans — the legs agree and the pair is exact. With more than one they
 * would not, so this refuses to quote a blended figure that belongs to no reserve. The
 * refusal also keeps `ceilingBase` honest: GenericLogic's `currentLtv` is the
 * collateral-weighted average, which only provably equals a quoted pair when there is
 * exactly one pair to quote.
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
 * The plan's OWN collateral figure — the one `plan.ts` derives the borrow amount from
 * (`floor(suppliedWei × priceBase / 10^decimals)` summed over supplies preceding the
 * borrow, plan.ts's borrow arm). Distinct from `protocolCollateralBaseOf` on purpose: the
 * allocation→amount derivation must reproduce the plan's arithmetic exactly, or
 * `maxAllocationBps` would be a claim about a different plan.
 */
function planCollateralBaseOf(
  supplies: readonly SupplyLeg[],
  valuations: ValuationByReserve,
): bigint | null {
  let total = 0n;
  for (const leg of supplies) {
    const valuation = valuations.get(leg.reserve);
    if (valuation === undefined) return null;
    total += (leg.amountWei * valuation.priceBase) / valuation.unit;
  }
  return total;
}

/**
 * The largest allocation the ceiling admits, DEFINED as the largest `b` whose derived debt
 * still fits — not as `ceilingBase × 1e4 / collateralBase`.
 *
 * The candidate walk reproduces the WHOLE chain the real verdict runs: `plan.ts`'s
 * allocation→wei derivation (`floor(collateralBase × b / 1e4)` to base, floored back to
 * wei), then the protocol's ceil-rounded mint/read-back/base-conversion above. Because the
 * protocol chain rounds up where the old floor-everything model rounded down, dividing the
 * ceiling back out can OVERSTATE the admissible `b` — the corrected fixture boundary sits
 * one bp below the raw quotient — so the definition is CHECKED by search rather than
 * inverted algebraically. Every leg of the chain is monotone in `b`, which is what makes
 * the acceptance predicate one-crossing and the binary search sound.
 */
function maxAllocationBpsOf(
  checkpoint: RiskCheckpoint,
  borrowLeg: DebtLeg,
  valuations: ValuationByReserve,
  ceilingBase: bigint,
): number | null {
  const planCollateralBase = planCollateralBaseOf(checkpoint.supplies, valuations);
  if (planCollateralBase === null) return null;
  const borrowValuation = valuations.get(borrowLeg.reserve);
  if (borrowValuation === undefined) return null;
  const otherDebts: DebtAmount[] = checkpoint.debts
    .filter((leg) => leg !== borrowLeg)
    .map((leg) => ({ reserve: leg.reserve, amountWei: leg.amountWei }));

  const admits = (bps: number): boolean => {
    const borrowBase = (planCollateralBase * BigInt(bps)) / BPS;
    const borrowWei = (borrowBase * borrowValuation.unit) / borrowValuation.priceBase;
    const debtBase = protocolDebtBaseOf(
      [...otherDebts, { reserve: borrowLeg.reserve, amountWei: borrowWei }],
      valuations,
    );
    return debtBase !== null && debtBase <= ceilingBase;
  };

  if (!admits(0)) return 0;
  let low = 0;
  let high = FULL_ALLOCATION_BPS;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (admits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
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
    const built = ceilingFor(graph, checkpoint, categoryId, snapshot);
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

function refusal(reason: string): CeilingBuild {
  return { status: "refused", verdict: { status: "unavailable", reason } };
}

function ceilingFor(
  graph: StrategyGraph,
  checkpoint: RiskCheckpoint,
  categoryId: number | null,
  snapshot: ChainSnapshot,
): CeilingBuild {
  const pair = quotedPairOf(checkpoint.supplies);
  // Unreachable in v1 — weETH is the only lendable asset, so every collateral leg carries the
  // same effective pair. It is a refusal rather than an assumption because the moment a
  // second collateral asset lands, quoting one leg's LTV for the whole position would be a
  // wrong number on a money surface.
  if (pair === null) {
    return refusal(
      "this borrow stands against collateral with more than one effective LTV/LT pair, so no single pair describes its limit",
    );
  }
  // A leg with no oracle value in the pinned read set values to nothing honest; refuse
  // before any arithmetic runs (SPEC §5 — the missing source is stated, never defaulted).
  if (
    checkpoint.supplies.some((leg) => leg.baseProv === null) ||
    checkpoint.debts.some((leg) => leg.baseProv === null)
  ) {
    return refusal("a collateral or debt leg has no oracle value in the pinned read set");
  }
  const valuations = new Map<string, ReserveValuation>();
  for (const leg of [...checkpoint.supplies, ...checkpoint.debts]) {
    if (valuations.has(leg.reserve)) continue;
    const valuation = reserveValuationOf(snapshot.reserves[leg.reserve], snapshot.blockTimestamp);
    if (valuation === null) {
      return refusal(
        "a reserve's index state cannot be accrued to the pinned block, so the protocol's debt valuation cannot be reproduced",
      );
    }
    valuations.set(leg.reserve, valuation);
  }
  const collateralBase = protocolCollateralBaseOf(checkpoint.supplies, valuations);
  if (collateralBase === null) {
    return refusal("a collateral or debt leg has no oracle value in the pinned read set");
  }
  if (collateralBase === 0n) {
    return refusal("the collateral standing at this borrow values to zero in the pinned read set");
  }
  const debtBase = protocolDebtBaseOf(
    checkpoint.debts.map((leg) => ({ reserve: leg.reserve, amountWei: leg.amountWei })),
    valuations,
  );
  if (debtBase === null) {
    return refusal("a collateral or debt leg has no oracle value in the pinned read set");
  }
  const borrowLeg = checkpoint.debts.find((leg) => leg.blockId === checkpoint.blockId);
  if (borrowLeg === undefined) {
    return refusal("the borrow checkpoint carries no debt leg for its own block");
  }
  const ceilingBase = (collateralBase * BigInt(pair.ltvBps)) / BPS;
  const maxAllocationBps = maxAllocationBpsOf(checkpoint, borrowLeg, valuations, ceilingBase);
  if (maxAllocationBps === null) {
    return refusal("a collateral or debt leg has no oracle value in the pinned read set");
  }
  const requestedAllocationBps = requestedAllocationBpsOf(graph, checkpoint.blockId);
  if (requestedAllocationBps === null) {
    return refusal("the borrow block carries no allocation");
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
      maxAllocationBps,
      requestedAllocationBps,
    },
  };
}
