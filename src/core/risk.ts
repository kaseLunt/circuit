/**
 * Block-pinned simulation of a strategy document (SPEC §5.2/§5.4). Pure.
 *
 * This is the last finance-core module: a validated document plus a block-pinned
 * `ChainSnapshot` in, the `SimulationResult` the canvas and the simulation panel consume
 * out. It answers "what does this graph do to my risk and my yield, at this block,
 * client-side" — SPEC §3 step 3's real-time drag.
 *
 * It derives nothing it can delegate. Flows come from `core/plan.ts` (`plan.flows`), the
 * health factor from `core/health-factor.ts`, the rates from `core/rates.ts`, the effective
 * liquidation threshold from `plan.ts`'s recorded matrix §3 rule. Re-deriving any of them
 * here would create a second, unproven source of truth beside the one the fork gate proved —
 * and would let the canvas's numbers drift from the calldata's numbers.
 *
 * PURE and TOTAL: no fetch, no I/O, no React, no `Date.now`, no float. It never throws for
 * user-reachable input; a graph that fails structural validation, the P1 phase gate,
 * asset flow or the recorded v3.7 constraint matrix returns `isValid: false` with every
 * quantity in its explicit unavailable state — never a partial reading.
 *
 * It mints only `Derived`. Every `Observed` it cites was minted by `server/chain/` at the
 * pinned block and is passed through as a derivation input; nothing here launders a literal
 * into an observation (lint enforces the shape ban on top of that).
 *
 * THE ONE CROSS-BLOCK QUANTITY. SPEC §5.1's staking rate is a TRAILING rate: a rate of change
 * has two endpoints, so it is two exchange-rate reads at two blocks. It therefore mints
 * through `derivedOverWindow` rather than `derived`, and so does every composition that
 * contains it — gross APY, net APY, and the staking yield source all legitimately span the
 * window's two blocks and say so. Everything else in this module is single-block.
 *
 * AND IT IS AN APR, NOT AN APY. The window's growth is annualized linearly, with no
 * compounding assumed (ruling Q3), so every rate leaves here inside a `ProvenancedRate`
 * carrying its `kind`. No renderer appends a unit blind: the suffix is read from the figure.
 *
 * §5.2's composition is complete-or-nothing: if the window did not resolve, or a rate leg is
 * missing, or the graph has no borrow block to supply `b`, then `grossApyWad`, `netApyWad`
 * AND `yieldSources` go to their unavailable states together. A two-of-three composition
 * would render as the whole composition, which is the defect. The health factor, liquidation
 * ratio, leverage and per-block amounts never depend on any of it.
 *
 * NOTE (D-007): money-math. The checkpoint-walk minimum HF, the two-sided post-action borrow
 * rate, the ETH/eETH base valuation and the trailing-window crossing are the review's focus
 * points.
 */
import { WAD } from "./format";
import {
  computeHealthFactor,
  hfWadValue,
  liquidationRatioWad,
  usdBase,
  type CollateralEntry,
  type HealthFactor,
} from "./health-factor";
import type { Asset, StrategyGraph } from "./graph";
import {
  buildPlan,
  effectiveLiquidationThresholdBps,
  effectiveLtvBps,
  inCollateralBitmap,
  type ChainSnapshot,
  type EModeCategorySnapshot,
  type PlanError,
  type PlanSuccess,
  type ReserveKey,
  type ReserveSnapshot,
} from "./plan";
import {
  derived,
  derivedOverWindow,
  entered,
  type AnyProvenanced,
  type Observed,
  type ParamOrigins,
  type Provenanced,
} from "./provenance";
import {
  aTokenBalance,
  accruedLiquidityIndexRay,
  accruedVariableBorrowIndexRay,
  currentRatesRay,
  mulWad,
  netApyWad,
  rayAprToApyWad,
  rayDivCeil,
  rayDivFloor,
  trailingAprWad,
  vTokenBalance,
} from "./rates";

// ————————————————————————— contract —————————————————————————

/**
 * What KIND of rate a figure is — and it is in the type because it was not, and a trailing
 * APR shipped inside fields and labels that said APY.
 *
 * They are different claims. An APY states what one year of COMPOUNDING at the current rate
 * would produce; an APR states an annualized rate of change with no compounding assumed.
 * SPEC §5.1's staking rate is a trailing seven-day exchange-rate delta annualized linearly —
 * an APR — and `core/rates.ts` deliberately proves no conversion for it (ruling Q3). Labelling
 * it "APY" claimed a compounding the math never did.
 *
 * Carrying the kind beside the value means no renderer can append a unit blind: the suffix
 * is READ from the figure rather than assumed by the slot it lands in.
 */
export type RateKind = "apr" | "apy";

/** A rate, its provenance, and what kind of rate it is. */
export interface ProvenancedRate {
  readonly kind: RateKind;
  readonly wad: Provenanced<bigint>;
}

/** How a rate of this kind is named on screen. One place decides, everywhere agrees. */
export function rateKindLabel(kind: RateKind): string {
  return kind === "apr" ? "APR" : "APY";
}

export interface YieldSource {
  protocol: string;
  type: "supply" | "borrow" | "stake";
  /** The leg's rate, WAD, with its provenance AND its kind — never a bare "APY". */
  rate: ProvenancedRate;
  /**
   * Signed weight this source's rate carries in the §5.2 net-APY composition, in
   * integer bps: collateral-side sources carry (1 + b) — FULL_ALLOCATION_BPS plus
   * the borrow block's allocationBps — and the debt source carries −b, so the
   * weights sum to FULL_ALLOCATION_BPS. A multi-leg collateral rate splits its
   * (1 + b) across legs in proportion to each leg's WAD rate, preserving the sum.
   *
   * Not a 0–1 fraction, not a percent, and never re-normalized by the display layer.
   */
  weightBps: number;
}

/**
 * Every quantity is core's representation so the display layer can only render it through
 * core/format.ts. No stored risk classification exists — a consumer calls
 * `riskState(valueOf(minHealthFactor))`, so there is exactly one risk derivation and no
 * scale that can drift from it.
 */
export interface SimulationResult {
  isValid: boolean;
  errorMessage?: string;
  /** Collateral-side APY, staking ∘ supply compounded (§5.2 r_coll), WAD. */
  grossApyWad: Provenanced<bigint> | null;
  /** (1+b)·(1+r_coll) − b·(1+r_debt) − 1 (§5.2), WAD, current-rate run-rate. */
  netApyWad: Provenanced<bigint> | null;
  /** Equity entering the strategy (§5.2 E), wei. */
  initialAmountWei: Provenanced<bigint> | null;
  /** Oracle base-currency (8-dec) units — §5.3 bans a non-oracle USD here. */
  gasCostBase: Provenanced<bigint> | null;
  /**
   * Minimum HF across the plan — the gating quantity borrow blocks show (§5.4).
   * Provenanced at the derivation site (here); the union's `unknown` branch carries the
   * reason, so this is never null. `BlockRuntime.minHealthFactor` keeps its `| null`,
   * where null means "no simulation at all" — a different fact.
   */
  minHealthFactor: Provenanced<HealthFactor>;
  finalHealthFactor: Provenanced<HealthFactor>;
  /** Collateral/debt oracle ratio at liquidation, WAD. A correlated pair has no
   * honest USD liquidation price (§5.4). */
  liquidationRatioWad: Provenanced<bigint> | null;
  /** Collateral exposure ÷ equity after the closed iteration, WAD. */
  leverageWad: Provenanced<bigint> | null;
  /**
   * Populated only when every leg's rate resolved: a missing rate makes
   * netApyWad null and this list empty, never a partial breakdown that reads as
   * a complete one.
   */
  yieldSources: readonly YieldSource[];
  blockValues: Readonly<Record<string, ComputedBlockValue>>;
}

export interface ComputedBlockValue {
  inputAsset: Asset | null;
  inputAmountWei: Provenanced<bigint> | null;
  inputValueBase: Provenanced<bigint> | null;
  outputAsset: Asset | null;
  outputAmountWei: Provenanced<bigint> | null;
  outputValueBase: Provenanced<bigint> | null;
  gasCostBase: Provenanced<bigint> | null;
  /**
   * The rate this block earns or pays, with its kind. `null` when the block earns no rate
   * (a conversion) or its source did not resolve.
   */
  rate: ProvenancedRate | null;
}

/** One supply standing in the ledger, with everything a citation about it needs. */
export interface SupplyLeg {
  readonly blockId: string;
  readonly reserve: ReserveKey;
  readonly amountWei: bigint;
  readonly amountProv: Provenanced<bigint>;
  /** Oracle base-currency value of this leg, or null when the reserve has no usable price. */
  readonly baseProv: Provenanced<bigint> | null;
  /** Effective liquidation threshold under the plan's e-mode category (matrix §3). */
  readonly ltBps: number;
  /** Whichever LT observation that rule selected, plus the bitmap and index that decided it. */
  readonly ltInputs: readonly AnyProvenanced[];
  /**
   * Effective LTV under the SAME category (matrix §3, `ValidationLogic.getUserReserveLtv`).
   * Carried beside `ltBps` because the two answer different questions and SPEC §3 step 4
   * requires both to be quoted from the ACTIVE configuration: LTV is the ceiling Aave's own
   * borrow validation compares against, LT is where the position liquidates. Quoting one
   * where the other belongs is the correctness bug that step names.
   */
  readonly ltvBps: number;
  /** Whichever LTV observation that rule selected, plus the bitmaps that decided it. */
  readonly ltvInputs: readonly AnyProvenanced[];
  readonly priceBase: Observed<bigint>;
}

/** One borrow standing in the ledger. */
export interface DebtLeg {
  readonly blockId: string;
  readonly reserve: ReserveKey;
  readonly amountWei: bigint;
  readonly amountProv: Provenanced<bigint>;
  readonly baseProv: Provenanced<bigint> | null;
  readonly priceBase: Observed<bigint>;
}

export interface RiskCheckpoint {
  /** The block whose step produced this state. */
  readonly blockId: string;
  /** Which plan step class moved risk here. */
  readonly cause: "supply" | "borrow";
  /**
   * Collateral entries as `core/health-factor.ts` consumes them, at this point. `null` when
   * any leg has no oracle value — which is what makes the health factor `unknown` rather
   * than quietly smaller.
   */
  readonly collateral: readonly CollateralEntry[] | null;
  /** Total debt in oracle base-currency (8-dec) units at this point; null for the same reason. */
  readonly totalDebtBase: bigint | null;
  /** `computeHealthFactor(collateral, totalDebtBase)` — nothing else. */
  readonly healthFactor: HealthFactor;
  /** Collateral wei on the single correlated collateral reserve, or null if the
   *  position is not a single correlated pair. */
  readonly collateralWei: bigint | null;
  readonly debtWei: bigint | null;
  /** The legs standing at this point, in walk order — the one source the entries, the
   *  correlated-pair wei and every provenance citation above are read from. */
  readonly supplies: readonly SupplyLeg[];
  readonly debts: readonly DebtLeg[];
}

export interface RiskLedger {
  readonly ok: boolean;
  /** In plan (topological) order; empty when the plan did not build. */
  readonly checkpoints: readonly RiskCheckpoint[];
  /** The gating checkpoint: the smallest HF across the ledger (§5.4). Null iff there
   *  are no checkpoints. `unknown` at any checkpoint dominates. */
  readonly min: RiskCheckpoint | null;
  readonly final: RiskCheckpoint | null;
  /** Present iff `ok` is false — the same PlanError list `buildPlan` returned. */
  readonly errors: readonly PlanError[];
}

// ————————————————————————— base valuation (§2.2) —————————————————————————

interface PriceFeed {
  readonly key: ReserveKey;
  /**
   * The oracle-stack semantics, folded into every expression this feed produces so the
   * tooltip STATES the denomination rather than hiding it (ruling Q4).
   */
  readonly semantics: string;
}

/**
 * Asset → the oracle price that values it, all four from the pinned snapshot (§5.3 bans a
 * non-oracle USD in the risk path). ETH and eETH are money claims and are spelled out:
 * ETH ≡ WETH by wrap and the matrix records that feed's own description as "ETH / USD";
 * eETH ≡ ETH 1:1 is the denomination Aave's own weETH source already assumes, its
 * description being "Capped weETH / eETH(ETH) / USD". The two assets with no reserve on
 * this market have no price here — a `null` badge, never a proxy.
 */
const PRICE_FEED: Readonly<Record<Asset, PriceFeed | null>> = {
  weETH: {
    key: "weETH",
    semantics: "priced by Oracle.getAssetPrice(weETH), the market's own capped weETH feed",
  },
  WETH: {
    key: "WETH",
    semantics: "priced by Oracle.getAssetPrice(WETH), the ETH/USD feed",
  },
  ETH: {
    key: "WETH",
    semantics:
      "priced by Oracle.getAssetPrice(WETH) — ETH ≡ WETH by wrap, and the matrix records that feed as OracleSource(WETH).description = \"ETH / USD\"",
  },
  eETH: {
    key: "WETH",
    semantics:
      "priced by Oracle.getAssetPrice(WETH) — eETH ≡ ETH 1:1, the denomination Aave's own weETH source (\"Capped weETH / eETH(ETH) / USD\") already assumes",
  },
  stETH: null,
  wstETH: null,
};

interface Valuation {
  readonly base: bigint | null;
  readonly price: Observed<bigint> | null;
  /** The formula, when there is one; otherwise the refusal, which is its own explanation. */
  readonly expression: string;
  /** The oracle-stack semantics this valuation rests on (ruling Q4). */
  readonly note?: string;
}

function valueInBase(amountWei: bigint, asset: Asset, snapshot: ChainSnapshot): Valuation {
  const feed = PRICE_FEED[asset];
  if (feed === null) {
    return {
      base: null,
      price: null,
      expression: `no oracle price for ${asset} in the pinned read set`,
    };
  }
  const reserve = snapshot.reserves[feed.key];
  // `usdBase` is the 18-decimal form; anything else is outside the recorded matrix and
  // refuses rather than silently applying the wrong scale.
  if (reserve.decimals.value !== 18) {
    return {
      base: null,
      price: reserve.priceBase,
      expression: "base valuation for a non-18-decimal reserve is outside the recorded matrix",
    };
  }
  if (reserve.priceBase.value <= 0n) {
    return {
      base: null,
      price: reserve.priceBase,
      expression: `the feed that values ${asset} returned no usable price`,
    };
  }
  return {
    base: usdBase(amountWei, reserve.priceBase.value),
    price: reserve.priceBase,
    expression: "floor(amountWei × priceBase / 1e18)",
    note: `AaveOracle base currency (8-dec), ${feed.semantics}`,
  };
}

function baseValueProv(
  amount: Provenanced<bigint>,
  asset: Asset,
  snapshot: ChainSnapshot,
): Provenanced<bigint> | null {
  const valuation = valueInBase(amount.value, asset, snapshot);
  if (valuation.base === null || valuation.price === null) return null;
  return derived(valuation.base, valuation.expression, [amount, valuation.price], valuation.note);
}

// ————————————————————————— the ledger (§2.3) —————————————————————————

/**
 * The LT observation `effectiveLiquidationThresholdBps` actually selected, plus the bitmap
 * and reserve index that decided it — so the tooltip shows WHY 9500 and not 8000 rather
 * than asserting a number (SPEC §3 step 4: quoting the wrong regime is a correctness bug).
 */
function ltInputsOf(
  reserve: ReserveSnapshot,
  cat: EModeCategorySnapshot | null,
): readonly AnyProvenanced[] {
  if (cat === null) return [reserve.liquidationThresholdBps];
  return [
    inCollateralBitmap(reserve, cat)
      ? cat.liquidationThresholdBps
      : reserve.liquidationThresholdBps,
    cat.collateralBitmap,
    reserve.reserveIndex,
  ];
}

/**
 * The LTV observation `effectiveLtvBps` actually selected, plus the bitmaps and reserve index
 * that decided it. Note the asymmetry with `ltInputsOf`: LTV depends on the LTV-ZERO bitmap
 * and on `isIsolated` as well as on collateral membership, so a citation that listed only the
 * collateral bitmap would show the wrong reason for a zeroed LTV.
 */
function ltvInputsOf(
  reserve: ReserveSnapshot,
  cat: EModeCategorySnapshot | null,
): readonly AnyProvenanced[] {
  if (cat === null) return [reserve.ltvBps];
  if (inCollateralBitmap(reserve, cat)) {
    return [cat.ltvBps, cat.collateralBitmap, cat.ltvZeroBitmap, reserve.reserveIndex];
  }
  return [reserve.ltvBps, cat.collateralBitmap, cat.isIsolated, reserve.reserveIndex];
}

function collateralEntriesOf(
  supplies: readonly SupplyLeg[],
): readonly CollateralEntry[] | null {
  const entries: CollateralEntry[] = [];
  for (const leg of supplies) {
    if (leg.baseProv === null) return null;
    entries.push({ base: leg.baseProv.value, ltBps: leg.ltBps });
  }
  return entries;
}

function totalDebtBaseOf(debts: readonly DebtLeg[]): bigint | null {
  let total = 0n;
  for (const leg of debts) {
    if (leg.baseProv === null) return null;
    total += leg.baseProv.value;
  }
  return total;
}

/**
 * The correlated-pair wei, defined only when the position is exactly one collateral reserve
 * against exactly one debt reserve — the only shape §5.4's liquidation RATIO describes.
 */
function correlatedPairOf(
  supplies: readonly SupplyLeg[],
  debts: readonly DebtLeg[],
): { readonly collateralWei: bigint; readonly debtWei: bigint } | null {
  const collateralReserves = new Set(supplies.map((s) => s.reserve));
  const debtReserves = new Set(debts.map((d) => d.reserve));
  if (collateralReserves.size !== 1 || debtReserves.size !== 1) return null;
  let collateralWei = 0n;
  for (const leg of supplies) collateralWei += leg.amountWei;
  let debtWei = 0n;
  for (const leg of debts) debtWei += leg.amountWei;
  return { collateralWei, debtWei };
}

function checkpointOf(
  blockId: string,
  cause: "supply" | "borrow",
  supplies: readonly SupplyLeg[],
  debts: readonly DebtLeg[],
): RiskCheckpoint {
  const collateral = collateralEntriesOf(supplies);
  const totalDebtBase = totalDebtBaseOf(debts);
  const pair = correlatedPairOf(supplies, debts);
  return {
    blockId,
    cause,
    collateral,
    totalDebtBase,
    healthFactor: computeHealthFactor(collateral, totalDebtBase),
    collateralWei: pair === null ? null : pair.collateralWei,
    debtWei: pair === null ? null : pair.debtWei,
    supplies: [...supplies],
    debts: [...debts],
  };
}

/**
 * The gating checkpoint. `unknown` DOMINATES: a missing input must never be read as the
 * safe end of a comparison, so the first unknown checkpoint is the minimum (§5.4). Ties go
 * to the earliest checkpoint, which keeps the selection a function of the document.
 */
function minCheckpointOf(checkpoints: readonly RiskCheckpoint[]): RiskCheckpoint | null {
  let best: RiskCheckpoint | null = null;
  let bestWad: bigint | null = null;
  for (const cp of checkpoints) {
    const wad = hfWadValue(cp.healthFactor);
    if (wad === null) return cp;
    if (bestWad === null || wad < bestWad) {
      best = cp;
      bestWad = wad;
    }
  }
  return best;
}

/**
 * Walk the plan's flows and record a checkpoint after every risk-changing step.
 *
 * v1 refuses a wallet with an existing Aave footprint (plan.ts's `existing-footprint`
 * constraint), so the pre-execution position is provably empty and this walk starts from
 * zero rather than from an unread prior balance. The plan emits `setUserEMode` before the
 * first supply, so ONE category governs every entry — there is no mid-plan threshold switch
 * in v1.
 *
 * Non-null assertions below are `plan.ts`'s own contract: a `lend` flow always carries an
 * input amount, an input asset and a reserve, and a `borrow` flow always carries an output
 * amount and a reserve. A null there would be a plan.ts bug, not a user-reachable state.
 */
function ledgerFrom(plan: PlanSuccess, snapshot: ChainSnapshot): RiskLedger {
  const targetCategory =
    plan.targetEModeCategoryId === null
      ? null
      : (snapshot.eModeCategories.find((c) => c.id === plan.targetEModeCategoryId) ?? null);

  const supplies: SupplyLeg[] = [];
  const debts: DebtLeg[] = [];
  const checkpoints: RiskCheckpoint[] = [];

  for (const flow of plan.flows) {
    if (flow.type === "lend") {
      const key = flow.reserve!;
      const reserve = snapshot.reserves[key];
      const amount = flow.inputWei!;
      supplies.push({
        blockId: flow.blockId,
        reserve: key,
        amountWei: amount.value,
        amountProv: amount,
        baseProv: baseValueProv(amount, flow.inputAsset!, snapshot),
        ltBps: effectiveLiquidationThresholdBps(reserve, targetCategory),
        ltInputs: ltInputsOf(reserve, targetCategory),
        ltvBps: effectiveLtvBps(reserve, targetCategory),
        ltvInputs: ltvInputsOf(reserve, targetCategory),
        priceBase: reserve.priceBase,
      });
      checkpoints.push(checkpointOf(flow.blockId, "supply", supplies, debts));
    } else if (flow.type === "borrow") {
      const key = flow.reserve!;
      const reserve = snapshot.reserves[key];
      const amount = flow.outputWei!;
      debts.push({
        blockId: flow.blockId,
        reserve: key,
        amountWei: amount.value,
        amountProv: amount,
        baseProv: baseValueProv(amount, flow.outputAsset!, snapshot),
        priceBase: reserve.priceBase,
      });
      checkpoints.push(checkpointOf(flow.blockId, "borrow", supplies, debts));
    }
  }

  return {
    ok: true,
    checkpoints,
    min: minCheckpointOf(checkpoints),
    final: checkpoints.length === 0 ? null : checkpoints[checkpoints.length - 1]!,
    errors: [],
  };
}

/**
 * The per-step risk ledger `simulate` walks. Exported for the fork suite's step-by-step
 * `getUserAccountData` cross-check (§5.4) and for tests — a single collapsed result cannot
 * express "the health factor after step 7".
 */
export function riskLedger(graph: StrategyGraph, snapshot: ChainSnapshot): RiskLedger {
  const plan = buildPlan(graph, snapshot);
  if (!plan.ok) {
    return { ok: false, checkpoints: [], min: null, final: null, errors: plan.errors };
  }
  return ledgerFrom(plan, snapshot);
}

// ————————————————————————— provenance minting —————————————————————————

function healthFactorInputsOf(cp: RiskCheckpoint): readonly AnyProvenanced[] {
  const inputs: AnyProvenanced[] = [];
  for (const leg of cp.supplies) inputs.push(leg.amountProv, leg.priceBase, ...leg.ltInputs);
  for (const leg of cp.debts) inputs.push(leg.amountProv, leg.priceBase);
  return inputs;
}

function mintHealthFactor(cp: RiskCheckpoint | null, role: string): Provenanced<HealthFactor> {
  if (cp === null) {
    // A graph with no lend and no borrow opens no position at all. That is `no-debt`, and
    // it is a reading rather than a refusal — there is genuinely nothing to liquidate.
    return derived<HealthFactor>(
      { status: "no-debt" },
      "no risk-changing step in this strategy",
      [],
      "it opens no Aave position",
    );
  }
  return derived(
    cp.healthFactor,
    `computeHealthFactor(Σ collateral base·lt, totalDebtBase) after step ${cp.blockId}`,
    healthFactorInputsOf(cp),
    role,
  );
}

// ————————————————————————— rate legs (§2.6) —————————————————————————

/**
 * The pre-conditions of the math below — `currentRatesRay`'s, the index accrual's and the
 * scaled-debt division's — tested rather than caught: a `try` around money math is a silent
 * fallback wearing a guard's clothes. Any of them failing means the rate has no honest
 * value, so the leg goes null and the slot renders its unavailable state.
 */
function ratesComputable(
  reserve: ReserveSnapshot,
  takenWei: bigint,
  blockTimestamp: bigint,
): boolean {
  const strategy = reserve.rateStrategy.value;
  const reserveFactor = reserve.reserveFactorBps.value;
  return (
    strategy.optimalUsageRatio > 0 &&
    strategy.optimalUsageRatio < 10_000 &&
    strategy.baseVariableBorrowRate >= 0 &&
    strategy.variableRateSlope1 >= 0 &&
    strategy.variableRateSlope2 >= 0 &&
    reserveFactor >= 0 &&
    reserveFactor <= 10_000 &&
    reserve.deficit.value >= 0n &&
    takenWei <= reserve.virtualUnderlyingBalance.value &&
    // The accrual and the scaled-debt division below.
    reserve.variableBorrowRateRay.value >= 0n &&
    reserve.variableBorrowIndexRay.value > 0n &&
    reserve.variableDebtScaledTotalSupply.value >= 0n &&
    reserve.lastUpdateTimestamp.value <= blockTimestamp
  );
}

/**
 * The debt total Aave itself feeds the rate model, at the index it feeds it AT.
 *
 * `ReserveLogic.updateInterestRatesAndVirtualBalance` reads
 * `nextScaledVariableDebt.rayMulCeil(nextVariableBorrowIndex)`: `updateState` has already
 * accrued the index to the current block, and the scaled total already carries whatever this
 * action minted. So an action's rate is computed over debt that has accrued since
 * `lastUpdateTimestamp`, not over the debt the previous rate was written at.
 *
 * Reconstructing at the STORED index is a DIFFERENT quantity — it is what the recorded rates
 * were written at, which is exactly what makes the zero-delta baseline reproduce them
 * byte-exactly, and it is asserted in that role in `risk.test.ts`. Using it here understates
 * utilization by the whole accrual since the last update, and therefore understates every
 * post-action rate.
 *
 * No new accrual math: the index comes from `core/rates.ts`'s fork-proven
 * `accruedVariableBorrowIndexRay`, and the mint uses the v3.7 directional rounding
 * (`rayDivCeil`, `ScaledBalanceTokenBase._mintScaled`) already paired with that same index
 * by `plan.ts`'s borrow-cap check.
 */
function postActionDebtOf(
  reserve: ReserveSnapshot,
  borrowedWei: bigint,
  blockTimestamp: bigint,
): bigint {
  const nextIndex = accruedVariableBorrowIndexRay(
    reserve.variableBorrowRateRay.value,
    reserve.variableBorrowIndexRay.value,
    reserve.lastUpdateTimestamp.value,
    blockTimestamp,
  );
  const nextScaled =
    reserve.variableDebtScaledTotalSupply.value + rayDivCeil(borrowedWei, nextIndex);
  return vTokenBalance(nextScaled, nextIndex);
}

function rateInputsOf(reserve: ReserveSnapshot): readonly AnyProvenanced[] {
  return [
    reserve.rateStrategy,
    reserve.reserveFactorBps,
    reserve.deficit,
    reserve.variableDebtScaledTotalSupply,
    reserve.variableBorrowIndexRay,
    // The index is accrued to the snapshot's block from these two before the debt total is
    // reconstructed, so both are genuine inputs to the rate.
    reserve.variableBorrowRateRay,
    reserve.lastUpdateTimestamp,
    reserve.virtualUnderlyingBalance,
  ];
}

function supplyApyOf(
  reserve: ReserveSnapshot,
  addedWei: bigint,
  amountInputs: readonly AnyProvenanced[],
  blockTimestamp: bigint,
): ProvenancedRate | null {
  if (!ratesComputable(reserve, 0n, blockTimestamp)) return null;
  const post = currentRatesRay({
    strategy: reserve.rateStrategy.value,
    reserveFactorBps: reserve.reserveFactorBps.value,
    // A supply mints no debt, but the index still accrues before the rate is set.
    totalDebtWei: postActionDebtOf(reserve, 0n, blockTimestamp),
    virtualUnderlyingBalance: reserve.virtualUnderlyingBalance.value,
    liquidityAddedWei: addedWei,
    liquidityTakenWei: 0n,
    deficitWei: reserve.deficit.value,
  });
  const wad = derived(
    rayAprToApyWad(post.liquidityRateRay),
    "rayAprToApyWad(currentRatesRay(post-action).liquidityRate)",
    [...rateInputsOf(reserve), ...amountInputs],
    "Aave third-order compounding over one year, at the utilization this plan's own supply leaves behind, over debt accrued to this block",
  );
  // An APY: rayAprToApyWad compounds the APR over a year, which is what makes it one.
  return { kind: "apy", wad };
}

function borrowApyOf(
  reserve: ReserveSnapshot,
  borrowedWei: bigint,
  amountInputs: readonly AnyProvenanced[],
  blockTimestamp: bigint,
): ProvenancedRate | null {
  if (!ratesComputable(reserve, borrowedWei, blockTimestamp)) return null;
  const post = currentRatesRay({
    strategy: reserve.rateStrategy.value,
    reserveFactorBps: reserve.reserveFactorBps.value,
    // BOTH legs of the borrow move utilization, and both must be applied: the borrow MINTS
    // debt (into the total below, at the accrued index and with the protocol's ceiling
    // rounding) and DRAINS the virtual balance, so the protocol computes
    // (D+X)/((V−X)+(D+X)). Passing only `liquidityTakenWei` would model D/(V−X+D) and
    // understate the rate — `updateInterestRatesAndVirtualBalance` reads the debt total
    // AFTER the mint.
    totalDebtWei: postActionDebtOf(reserve, borrowedWei, blockTimestamp),
    virtualUnderlyingBalance: reserve.virtualUnderlyingBalance.value,
    liquidityAddedWei: 0n,
    liquidityTakenWei: borrowedWei,
    deficitWei: reserve.deficit.value,
  });
  const wad = derived(
    rayAprToApyWad(post.variableBorrowRateRay),
    "rayAprToApyWad(currentRatesRay(post-action).variableBorrowRate)",
    [...rateInputsOf(reserve), ...amountInputs],
    "Aave third-order compounding over one year; the borrow both mints debt at the accrued index and drains the virtual balance",
  );
  return { kind: "apy", wad };
}

const RESERVE_KEYS = ["weETH", "WETH"] as const;

interface ReserveRates {
  readonly supplyApy: ProvenancedRate | null;
  readonly borrowApy: ProvenancedRate | null;
}

function reserveRatesOf(
  plan: PlanSuccess,
  snapshot: ChainSnapshot,
): Readonly<Record<ReserveKey, ReserveRates>> {
  const added: Record<ReserveKey, bigint> = { weETH: 0n, WETH: 0n };
  const taken: Record<ReserveKey, bigint> = { weETH: 0n, WETH: 0n };
  const suppliedBy: Record<ReserveKey, AnyProvenanced[]> = { weETH: [], WETH: [] };
  const borrowedBy: Record<ReserveKey, AnyProvenanced[]> = { weETH: [], WETH: [] };

  for (const flow of plan.flows) {
    if (flow.type === "lend") {
      const amount = flow.inputWei!;
      added[flow.reserve!] += amount.value;
      suppliedBy[flow.reserve!].push(amount);
    } else if (flow.type === "borrow") {
      const amount = flow.outputWei!;
      taken[flow.reserve!] += amount.value;
      borrowedBy[flow.reserve!].push(amount);
    }
  }

  const rates: Record<ReserveKey, ReserveRates> = {
    weETH: { supplyApy: null, borrowApy: null },
    WETH: { supplyApy: null, borrowApy: null },
  };
  for (const key of RESERVE_KEYS) {
    const reserve = snapshot.reserves[key];
    rates[key] = {
      supplyApy:
        suppliedBy[key].length === 0
          ? null
          : supplyApyOf(reserve, added[key], suppliedBy[key], snapshot.blockTimestamp),
      borrowApy:
        borrowedBy[key].length === 0
          ? null
          : borrowApyOf(reserve, taken[key], borrowedBy[key], snapshot.blockTimestamp),
    };
  }
  return rates;
}

// ————————————————————————— per-block values (§2.9) —————————————————————————

/**
 * The collateral position a supply creates — not "nothing". Computed with the identical
 * index/rounding pair `plan.ts` already uses for its supply-cap check, so the canvas and the
 * cap validator agree by construction. `plan.ts`'s `outputAssetOf(lend) === null` stays
 * untouched: that governs asset flow BETWEEN blocks and must keep saying a supply has no
 * consumable token output.
 *
 * The index accrual cannot throw here: `buildPlan` computes the same accrued index for both
 * reserves before any constraint check, so a snapshot that would break it never reaches a
 * successful plan.
 */
function collateralPositionOf(
  reserve: ReserveSnapshot,
  amount: Provenanced<bigint>,
  snapshot: ChainSnapshot,
): Provenanced<bigint> {
  const index = accruedLiquidityIndexRay(
    reserve.liquidityRateRay.value,
    reserve.liquidityIndexRay.value,
    reserve.lastUpdateTimestamp.value,
    snapshot.blockTimestamp,
  );
  const balance = aTokenBalance(rayDivFloor(amount.value, index), index);
  return derived(
    balance,
    "aTokenBalance(rayDivFloor(amountWei, accruedLiquidityIndex), accruedLiquidityIndex)",
    [
      amount,
      reserve.liquidityRateRay,
      reserve.liquidityIndexRay,
      reserve.lastUpdateTimestamp,
    ],
    "the collateral position this supply creates",
  );
}

function blockValuesOf(
  plan: PlanSuccess,
  snapshot: ChainSnapshot,
  rates: Readonly<Record<ReserveKey, ReserveRates>>,
  stakingApy: ProvenancedRate | null,
): Readonly<Record<string, ComputedBlockValue>> {
  const values: Record<string, ComputedBlockValue> = {};
  for (const flow of plan.flows) {
    const isLend = flow.type === "lend";
    // A supply's renderable output is the collateral position it opens.
    const outputAsset = isLend ? flow.inputAsset : flow.outputAsset;
    const outputAmountWei = isLend
      ? collateralPositionOf(snapshot.reserves[flow.reserve!], flow.inputWei!, snapshot)
      : flow.outputWei;
    values[flow.blockId] = {
      inputAsset: flow.inputAsset,
      inputAmountWei: flow.inputWei,
      inputValueBase:
        flow.inputWei === null || flow.inputAsset === null
          ? null
          : baseValueProv(flow.inputWei, flow.inputAsset, snapshot),
      outputAsset,
      outputAmountWei,
      outputValueBase:
        outputAmountWei === null || outputAsset === null
          ? null
          : baseValueProv(outputAmountWei, outputAsset, snapshot),
      // Gas needs estimateGas/feeHistory against a provider, which arrives with the sandbox
      // session in P3a. Until then every gas slot renders its authored unavailable state
      // rather than a quoted-looking zero.
      gasCostBase: null,
      rate:
        flow.type === "stake"
          ? stakingApy
          : isLend
            ? rates[flow.reserve!].supplyApy
            : flow.type === "borrow"
              ? rates[flow.reserve!].borrowApy
              : // A conversion earns no rate.
                null,
    };
  }
  return values;
}

// ————————————————————————— derived headline quantities —————————————————————————

/**
 * Evaluated AT THE MINIMUM-HF CHECKPOINT — the same position the displayed min HF describes
 * and the one the borrow block's sentence sits beside. At the final checkpoint the ratio is
 * far more forgiving, and showing that next to the min HF would be two surfaces disagreeing.
 *
 * Unqualified USD liquidation prices for a correlated pair stay banned (§5.4): no such field
 * exists here, so none can be rendered.
 */
function liquidationRatioOf(min: RiskCheckpoint | null): Provenanced<bigint> | null {
  if (min === null) return null;
  const { collateralWei, debtWei } = min;
  // Non-null exactly when the position is a single correlated pair, which also makes both
  // leg lists non-empty and gives every supply the same effective threshold.
  if (collateralWei === null || debtWei === null) return null;
  if (collateralWei <= 0n || debtWei <= 0n) return null;
  const first = min.supplies[0]!;
  if (first.ltBps <= 0 || first.ltBps > 10_000) return null;
  return derived(
    liquidationRatioWad(collateralWei, debtWei, first.ltBps),
    "debtWei × 1e4 × WAD / (collateralWei × ltBps), ceiling",
    [
      ...min.supplies.map((s) => s.amountProv),
      ...min.debts.map((d) => d.amountProv),
      ...first.ltInputs,
    ],
    "the collateral/debt oracle ratio at HF = 1, at the minimum-HF step",
  );
}

/**
 * Realized leverage, not algebraic: `(1 + b)` would ignore the exchange-rate and rounding
 * path the position actually took. Equity is the entered ETH valued by the ETH/USD feed.
 */
function leverageOf(
  final: RiskCheckpoint | null,
  initialAmountWei: Provenanced<bigint> | null,
  snapshot: ChainSnapshot,
): Provenanced<bigint> | null {
  if (initialAmountWei === null) return null;
  if (final === null || final.collateral === null || final.collateral.length === 0) return null;
  const equity = valueInBase(initialAmountWei.value, "ETH", snapshot);
  if (equity.base === null || equity.base === 0n || equity.price === null) return null;
  let exposure = 0n;
  for (const entry of final.collateral) exposure += entry.base;
  return derived(
    (exposure * WAD) / equity.base,
    "floor(Σ collateralBase × WAD / equityBase)",
    [
      ...final.supplies.map((s) => s.baseProv).filter((p): p is Provenanced<bigint> => p !== null),
      initialAmountWei,
      equity.price,
    ],
    `collateral exposure ÷ equity after the closed iteration; equity ${PRICE_FEED.ETH!.semantics}`,
  );
}

// ————————————————————————— the §5.2 composition —————————————————————————

/**
 * 100% of a source's output, in the integer bps `core/graph.ts` validates. Restated here
 * rather than imported from `lib/strategy/types.ts`: the dependency runs one way, and a
 * `core/` module must not reach into the view model for a unit.
 */
const FULL_ALLOCATION_BPS = 10_000;

/**
 * Why this crossing is correct, in the words the tooltip will carry. Authored once so every
 * quantity that inherits the window says the same thing.
 */
const WINDOW_REASON =
  "an instantaneous exchange rate is not an APR (SPEC §5.1); the window's endpoints are two reads at two blocks";

/**
 * The trailing staking APR (SPEC §5.1), used DIRECTLY as the one-year appreciation factor and
 * labelled an APR (ruling Q3).
 *
 * `trailingAprWad` annualizes the window's growth linearly. §5.1 and §5.2 both name the
 * quantity an APR, and `core/rates.ts` proves no `(1+g)^(365/7) − 1` conversion — inventing
 * one here would be new, unproven math dressed as a formatting choice.
 *
 * Pre-conditions are tested rather than caught: `trailingAprWad` throws on a non-positive
 * endpoint or span, and a missing endpoint must surface as an unavailable slot, never as a
 * default.
 */
function stakingAprOf(snapshot: ChainSnapshot): ProvenancedRate | null {
  const window = snapshot.etherfi.rateWindow;
  if (window === null) return null;
  if (window.rateNow.value <= 0n) return null;
  if (window.rateBefore.value <= 0n) return null;
  if (window.secondsElapsed.value <= 0n) return null;
  // An APR, and the type says so: the window's growth is annualized LINEARLY, with no
  // compounding assumed or applied (ruling Q3). Nothing downstream may call it an APY.
  const wad = derivedOverWindow(
    trailingAprWad(window.rateNow.value, window.rateBefore.value, window.secondsElapsed.value),
    "(rateNow − rateBefore)/rateBefore × SECONDS_PER_YEAR/secondsElapsed",
    [window.rateNow, window.rateBefore, window.secondsElapsed],
    WINDOW_REASON,
    "trailing staking APR",
  );
  return { kind: "apr", wad };
}

/** The three rate legs §5.2 composes, present only when ALL of them are. */
interface CompositionLegs {
  readonly bBps: number;
  readonly stake: ProvenancedRate;
  readonly supply: ProvenancedRate;
  readonly debt: ProvenancedRate;
}

/**
 * §5.2 describes ONE closed iteration of a single correlated pair, so the composition is
 * defined only for that shape: one borrow block supplying `b`, one collateral reserve, one
 * debt reserve, and a rate for each of the three legs. Anything else — a missing window, a
 * second borrow, a rate that did not resolve — returns null and takes the whole family with
 * it, rather than publishing a partial composition that reads as a complete one.
 */
function compositionLegsOf(
  graph: StrategyGraph,
  plan: PlanSuccess,
  rates: Readonly<Record<ReserveKey, ReserveRates>>,
  stakingApy: ProvenancedRate | null,
): CompositionLegs | null {
  if (stakingApy === null) return null;
  const borrowBlocks = graph.blocks.filter((b) => b.type === "borrow");
  if (borrowBlocks.length !== 1) return null;
  const bBps = borrowBlocks[0]!.params["allocationBps"];
  if (typeof bBps !== "number") return null;

  const collateralReserves = new Set(
    plan.flows.filter((f) => f.type === "lend").map((f) => f.reserve!),
  );
  const debtReserves = new Set(
    plan.flows.filter((f) => f.type === "borrow").map((f) => f.reserve!),
  );
  if (collateralReserves.size !== 1 || debtReserves.size !== 1) return null;

  const supply = rates[[...collateralReserves][0]!].supplyApy;
  const debt = rates[[...debtReserves][0]!].borrowApy;
  if (supply === null || debt === null) return null;
  return { bBps, stake: stakingApy, supply, debt };
}

/**
 * Collateral-side APY: staking and supply compound on the SAME collateral, so they multiply
 * rather than add.
 *
 * `derivedOverWindow`, not `derived`: the staking leg's observations span two blocks, so any
 * composition containing it does too. `derived` would throw here, and rightly — the honest
 * move is to declare the crossing, not to hide it.
 */
function grossApyOf(legs: CompositionLegs): Provenanced<bigint> {
  return derivedOverWindow(
    mulWad(WAD + legs.stake.wad.value, WAD + legs.supply.wad.value) - WAD,
    "(1 + r_stake)(1 + r_supply) − 1",
    [legs.stake.wad, legs.supply.wad],
    WINDOW_REASON,
    "§5.2 r_coll, staking and supply compounding on one collateral",
  );
}

function netApyOf(legs: CompositionLegs, gross: Provenanced<bigint>): Provenanced<bigint> {
  const bWad = (BigInt(legs.bBps) * WAD) / BigInt(FULL_ALLOCATION_BPS);
  return derivedOverWindow(
    netApyWad(bWad, legs.stake.wad.value, legs.supply.wad.value, legs.debt.wad.value),
    "(1 + b)(1 + r_coll) − b(1 + r_debt) − 1",
    [entered(legs.bBps), gross, legs.debt.wad],
    WINDOW_REASON,
    "§5.2, current-rate run-rate over one iteration; incentives and points excluded by construction",
  );
}

/**
 * The §5.2 exposure weights, in the integer bps the contract fixes: the collateral legs share
 * `(1 + b)` and the debt leg carries `−b`, so the three sum to FULL_ALLOCATION_BPS.
 *
 * The collateral share splits in proportion to each leg's rate, with the remainder landing on
 * the supply leg so the sum is exact rather than approximately right.
 *
 * The `else` branch covers a zero collateral rate AND a NEGATIVE staking rate — a real
 * slashing reading, not a missing one, which must not be nulled away. With no positive rate
 * to apportion, an even split states "both legs apply to the whole collateral" without
 * inventing a preference. The invariant holds in both branches.
 */
function yieldWeights(
  bBps: number,
  rStake: bigint,
  rSupply: bigint,
): { readonly stake: number; readonly supply: number; readonly borrow: number } {
  const collateralBps = FULL_ALLOCATION_BPS + bBps;
  const totalCollateralRate = rStake + rSupply;
  const stake =
    totalCollateralRate > 0n && rStake >= 0n && rSupply >= 0n
      ? Number((BigInt(collateralBps) * rStake) / totalCollateralRate)
      : Math.ceil(collateralBps / 2);
  return { stake, supply: collateralBps - stake, borrow: -bBps };
}

/** Canonical order: the collateral legs in the order they compound, then the debt leg. */
function yieldSourcesOf(legs: CompositionLegs): readonly YieldSource[] {
  const weights = yieldWeights(legs.bBps, legs.stake.wad.value, legs.supply.wad.value);
  return [
    { protocol: "etherfi", type: "stake", rate: legs.stake, weightBps: weights.stake },
    { protocol: "aave-v3", type: "supply", rate: legs.supply, weightBps: weights.supply },
    { protocol: "aave-v3", type: "borrow", rate: legs.debt, weightBps: weights.borrow },
  ];
}

// ————————————————————————— failure semantics (§5) —————————————————————————

/**
 * One sentence, deterministic, carrying no id the user cannot see. The full `PlanError[]`
 * stays available through `riskLedger(...).errors` for per-block surfacing; this is the
 * summary the panel's `InlineError` renders.
 */
function errorMessageOf(errors: readonly PlanError[]): string {
  const first = errors[0];
  if (first === undefined) return "this strategy did not simulate";
  if (first.kind === "graph-invalid") {
    const message = first.messages[0];
    return message === undefined ? "the strategy graph did not validate" : message;
  }
  return first.detail;
}

/**
 * A refusal is a COMPLETE refusal: no partial state, no zero substituted for a missing read,
 * no list shorter than the truth. The zero-input `Derived` on the two health factors is
 * reserved for exactly this case and is honest because the derivation genuinely consumed
 * nothing — the tooltip reads `derived: no plan: <reason>` and implies no observation.
 */
function refusal(errors: readonly PlanError[]): SimulationResult {
  const message = errorMessageOf(errors);
  const unknown = (): Provenanced<HealthFactor> =>
    derived<HealthFactor>({ status: "unknown", reason: message }, "no plan", [], message);
  return {
    isValid: false,
    errorMessage: message,
    grossApyWad: null,
    netApyWad: null,
    initialAmountWei: null,
    gasCostBase: null,
    minHealthFactor: unknown(),
    finalHealthFactor: unknown(),
    liquidationRatioWad: null,
    leverageWad: null,
    yieldSources: [],
    blockValues: {},
  };
}

// ————————————————————————— entry point —————————————————————————

/**
 * Block-pinned simulation of a strategy document (SPEC §5.2/§5.4).
 *
 * The document is validated INSIDE this call (via `buildPlan` → `validateGraph`); callers
 * are not trusted to have validated it, so "validated strategy document" is a post-condition
 * of a successful result rather than a pre-condition of the call.
 */
export function simulate(
  graph: StrategyGraph,
  snapshot: ChainSnapshot,
  /** How each user param reached the document — see `buildPlan`. Empty ⇒ all entered. */
  origins: ParamOrigins = {},
): SimulationResult {
  const plan = buildPlan(graph, snapshot, origins);
  if (!plan.ok) return refusal(plan.errors);

  const ledger = ledgerFrom(plan, snapshot);
  const rates = reserveRatesOf(plan, snapshot);

  // §5.2, complete or nothing: the three legs are resolved together, and if any one of them
  // is missing the gross APY, the net APY and the whole breakdown are unavailable together.
  const stakingApy = stakingAprOf(snapshot);
  const legs = compositionLegsOf(graph, plan, rates, stakingApy);
  const grossApyWad = legs === null ? null : grossApyOf(legs);
  const netApyWad = legs === null || grossApyWad === null ? null : netApyOf(legs, grossApyWad);
  const yieldSources = legs === null ? [] : yieldSourcesOf(legs);

  const inputFlow = plan.flows.find((f) => f.type === "input");
  const initialAmountWei = inputFlow === undefined ? null : inputFlow.outputWei;

  return {
    isValid: true,
    grossApyWad,
    netApyWad,
    initialAmountWei,
    gasCostBase: null,
    minHealthFactor: mintHealthFactor(ledger.min, "the minimum across the plan"),
    finalHealthFactor: mintHealthFactor(ledger.final, "after the last risk-changing step"),
    liquidationRatioWad: liquidationRatioOf(ledger.min),
    leverageWad: leverageOf(ledger.final, initialAmountWei, snapshot),
    yieldSources,
    blockValues: blockValuesOf(plan, snapshot, rates, stakingApy),
  };
}
