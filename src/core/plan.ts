/**
 * Plan builder (SPEC §5.5/§5.7): validated graph + block-pinned ChainSnapshot →
 * TransactionStep[]. Pure — no fetch, no I/O; viem is used only for ABI
 * encoding, which is pure byte math.
 *
 * Boundary contract with graph.ts: structural validation (§5.6) runs here
 * first via validateGraph — calldata can only ever derive from a graph that
 * passed it. Asset-flow semantics, the P1 phase gate, the recorded v3.7
 * constraint set (docs/protocol-matrix.md §4), and amount provenance (§5.5)
 * all live in this module.
 *
 * P1 execution scope is the EtherFi flagship only (W03): input · stake(etherfi)
 * · wrap(eETH→weETH) · lend(aave-v3, weETH) · borrow(aave-v3, WETH) ·
 * unwrap(WETH→ETH). Everything else that is schema-valid returns a typed
 * `unsupported-in-phase` error naming the block.
 */
import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import {
  derived,
  entered,
  paramOriginKey,
  wrapParam,
  type AnyProvenanced,
  type Derived,
  type Observed,
  type Provenanced,
  type ParamOrigins,
} from "./provenance";
import {
  accruedLiquidityIndexRay,
  accruedVariableBorrowIndexRay,
  rayDivCeil,
  rayDivFloor,
  rayMulCeil,
  rayMulFloor,
  type RateStrategyBps,
} from "./rates";
import {
  topologicalOrder,
  validateGraph,
  type Asset,
  type Block,
  type Edge,
  type StrategyGraph,
} from "./graph";

// ————————————————————————— snapshot contract —————————————————————————

export interface ReserveSnapshot {
  readonly underlying: Address;
  readonly aToken: Address;
  readonly variableDebtToken: Address;
  /** Position in Pool.getReservesList — the bit index in e-mode bitmaps. */
  readonly reserveIndex: Observed<number>;
  readonly decimals: Observed<number>;
  readonly active: Observed<boolean>;
  readonly frozen: Observed<boolean>;
  readonly paused: Observed<boolean>;
  readonly borrowingEnabled: Observed<boolean>;
  readonly usageAsCollateralAllowed: Observed<boolean>;
  /**
   * Reserve-level LTV / liquidation threshold in bps. These are the FALLBACKS the protocol
   * applies when an active e-mode category does not supply them — see matrix §3: collateral
   * outside a non-isolated category's bitmap uses reserve LTV, and the liquidation threshold
   * is the reserve's whenever the reserve is not a collateral-bitmap member.
   */
  readonly ltvBps: Observed<number>;
  readonly liquidationThresholdBps: Observed<number>;
  /** Whole tokens; 0 means uncapped (v3.7 ValidationLogic). */
  readonly supplyCap: Observed<bigint>;
  readonly borrowCap: Observed<bigint>;
  readonly aTokenScaledTotalSupply: Observed<bigint>;
  readonly variableDebtScaledTotalSupply: Observed<bigint>;
  /** Scaled units, added into the v3.7 supply-cap sum. */
  readonly accruedToTreasury: Observed<bigint>;
  readonly liquidityRateRay: Observed<bigint>;
  readonly variableBorrowRateRay: Observed<bigint>;
  readonly liquidityIndexRay: Observed<bigint>;
  readonly variableBorrowIndexRay: Observed<bigint>;
  readonly lastUpdateTimestamp: Observed<bigint>;
  readonly virtualUnderlyingBalance: Observed<bigint>;
  /** AaveOracle price in BASE_CURRENCY units. */
  readonly priceBase: Observed<bigint>;
  /**
   * DefaultReserveInterestRateStrategyV2.getInterestRateDataBps, read as one struct off the
   * strategy address the data provider reports for this reserve (the address is READ, never
   * assumed). Feeds the §5.1 post-action rate recompute in core/risk.ts.
   */
  readonly rateStrategy: Observed<RateStrategyBps>;
  /** getReserveConfigurationData.reserveFactor (tuple index 4). */
  readonly reserveFactorBps: Observed<number>;
  /** getReserveDeficit — v3.7 feeds this as the strategy's `unbacked` param. */
  readonly deficit: Observed<bigint>;
}

export interface EModeCategorySnapshot {
  readonly id: number;
  readonly label: Observed<string>;
  readonly ltvBps: Observed<number>;
  readonly liquidationThresholdBps: Observed<number>;
  readonly collateralBitmap: Observed<bigint>;
  readonly borrowableBitmap: Observed<bigint>;
  readonly isIsolated: Observed<boolean>;
  readonly ltvZeroBitmap: Observed<bigint>;
}

export interface EtherFiSnapshot {
  readonly liquidityPool: Address;
  readonly eETH: Address;
  readonly weETH: Address;
  readonly totalPooledEther: Observed<bigint>;
  readonly totalShares: Observed<bigint>;
}

/**
 * `Provenanced`, not `Observed`, and the widening is the point (W05 P2). Everything else
 * on a `ChainSnapshot` is protocol state, which always comes from a read. The USER does
 * not: sandbox is the default experience and no wallet is connected, so there is no
 * address to call `getUserEMode` on. The honest wrapper for "a fresh actor with no Aave
 * position" is `Configured` — a named constant with a definition site — and typing these
 * `Observed` would have forced the sandbox to forge a chain read to satisfy the compiler.
 * The live path (`server/chain/snapshot.ts`) still mints `Observed` and is unaffected;
 * `Observed` is a `Provenanced`. Consumers read `.value` and are indifferent.
 */
export interface UserSnapshot {
  readonly address: Address;
  readonly eModeCategoryId: Provenanced<number>;
  /** SPEC §2 predicate: any Aave Core footprint — any aToken balance or debt. */
  readonly hasAaveFootprint: Provenanced<boolean>;
}

export interface ChainSnapshot {
  readonly block: bigint;
  readonly blockTimestamp: bigint;
  readonly pool: Address;
  readonly reserves: { readonly weETH: ReserveSnapshot; readonly WETH: ReserveSnapshot };
  readonly eModeCategories: readonly EModeCategorySnapshot[];
  readonly etherfi: EtherFiSnapshot;
  readonly user: UserSnapshot;
}

// ————————————————————————— step contract —————————————————————————

export type AmountAttribution =
  | "share-delta"
  | "return-value"
  | "withdraw-argument"
  | "transfer-event";

export type AmountSpec =
  /**
   * The figure the DOCUMENT holds, becoming calldata unchanged. `Provenanced`, not
   * `Entered`: SPEC §5.5's whitelist is about the attribution MECHANISM (only the input
   * step may carry a plan-time figure at all), not about how that figure got into the
   * document. A template's untouched amount is a `Configured` default and must keep saying
   * so all the way into the step list.
   */
  | { readonly kind: "literal"; readonly amount: Provenanced<bigint> }
  | {
      readonly kind: "step-output";
      readonly producerStepId: string;
      readonly attribution: AmountAttribution;
      readonly allocationBps: number;
    }
  | { readonly kind: "derived"; readonly amount: Derived<bigint> }
  | { readonly kind: "none" };

export type CallArg =
  | { readonly kind: "value"; readonly value: string | bigint | number | boolean }
  | { readonly kind: "amount" };

export interface TransactionStep {
  readonly id: string;
  readonly index: number;
  readonly blockId: string;
  readonly description: string;
  readonly to: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args: readonly CallArg[];
  readonly valueSpec: "none" | "amount";
  readonly amount: AmountSpec;
}

export type PlanConstraint =
  | "reserve-inactive"
  | "reserve-frozen"
  | "reserve-paused"
  | "borrowing-disabled"
  | "supply-cap"
  | "borrow-cap"
  | "insufficient-liquidity"
  | "emode-not-borrowable"
  | "emode-unknown-category"
  | "emode-active-category-rejects-plan"
  | "collateral-not-allowed"
  | "existing-footprint"
  | "oracle-price-unavailable"
  | "input-amount";

export type PlanError =
  | { readonly kind: "graph-invalid"; readonly messages: readonly string[] }
  | { readonly kind: "unsupported-in-phase"; readonly blockId: string; readonly detail: string }
  | { readonly kind: "asset-flow"; readonly blockId: string; readonly detail: string }
  | {
      readonly kind: "constraint";
      readonly blockId: string;
      readonly constraint: PlanConstraint;
      readonly detail: string;
    };

/** The two reserves the pinned Core market exposes to v1. */
export type ReserveKey = keyof ChainSnapshot["reserves"];

/**
 * What one block moved, as the SAME pass that derives the borrow amount already computed it.
 *
 * This is a RECORDING, not a second derivation: every amount and every wrapper below is the
 * object `buildPlan` put in scope for its own share-model arithmetic, handed out rather than
 * recomputed. `core/risk.ts` consumes it so the canvas's numbers and the calldata's numbers
 * are the same numbers — re-deriving the share model beside it would create exactly the
 * second source of truth the fork gate exists to rule out.
 */
export interface BlockFlow {
  readonly blockId: string;
  readonly type: Block["type"];
  /**
   * Asset consumed. `null` for `input` (nothing precedes it) and for `borrow`, whose producer
   * edge is a collateral dependency rather than a token flow.
   */
  readonly inputAsset: Asset | null;
  readonly inputWei: Provenanced<bigint> | null;
  /**
   * Token produced. `null` for `lend`: a supply has no consumable token output, which is what
   * `outputAssetOf` already states and what governs asset flow BETWEEN blocks.
   */
  readonly outputAsset: Asset | null;
  readonly outputWei: Provenanced<bigint> | null;
  /** The Aave reserve this block touches, for `lend`/`borrow`; null otherwise. */
  readonly reserve: ReserveKey | null;
}

export interface PlanSuccess {
  readonly ok: true;
  readonly steps: readonly TransactionStep[];
  readonly targetEModeCategoryId: number | null;
  /** Every block's predicted in/out amount with its provenance, in topological order. */
  readonly flows: readonly BlockFlow[];
}

export interface PlanFailure {
  readonly ok: false;
  readonly errors: readonly PlanError[];
}

export type PlanResult = PlanSuccess | PlanFailure;

// ————————————————————————— ABIs (deployed-revision fragments) —————————————————————————

const DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const satisfies Abi;

const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const satisfies Abi;

const WRAP_ABI = [
  {
    type: "function",
    name: "wrap",
    stateMutability: "nonpayable",
    inputs: [{ name: "_eETHAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const satisfies Abi;

const SET_USER_EMODE_ABI = [
  {
    type: "function",
    name: "setUserEMode",
    stateMutability: "nonpayable",
    inputs: [{ name: "categoryId", type: "uint8" }],
    outputs: [],
  },
] as const satisfies Abi;

const SUPPLY_ABI = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const BORROW_ABI = [
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const WITHDRAW_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const satisfies Abi;

// ————————————————————————— encoding —————————————————————————

export function encodeStep(
  step: TransactionStep,
  resolvedAmount?: bigint,
): { to: Address; data: Hex; value: bigint } {
  const spec = step.amount;
  if (spec.kind === "step-output") {
    if (resolvedAmount === undefined) {
      throw new Error(`step ${step.id}: a resolved attributed amount is required`);
    }
  } else if (resolvedAmount !== undefined) {
    throw new Error(`step ${step.id}: amount is fixed at plan time; a resolved amount is not accepted`);
  }
  const amountValue =
    spec.kind === "step-output"
      ? resolvedAmount!
      : spec.kind === "literal" || spec.kind === "derived"
        ? spec.amount.value
        : null;
  const injected = step.args.map((a) => {
    if (a.kind === "value") return a.value;
    if (amountValue === null) throw new Error(`step ${step.id}: amount slot without an amount`);
    return amountValue;
  });
  const data =
    injected.length === 0
      ? encodeFunctionData({ abi: step.abi, functionName: step.functionName })
      : encodeFunctionData({ abi: step.abi, functionName: step.functionName, args: injected });
  let value = 0n;
  if (step.valueSpec === "amount") {
    if (amountValue === null) throw new Error(`step ${step.id}: value slot without an amount`);
    value = amountValue;
  }
  return { to: step.to, data, value };
}

// ————————————————————————— input parsing —————————————————————————

const WAD_WEI = 10n ** 18n;

type ParsedInput = { readonly ok: true; readonly wei: bigint } | { readonly ok: false; readonly detail: string };

function parseInputAmount(raw: string | number | undefined): ParsedInput {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw <= 0) {
      return {
        ok: false,
        detail: "fractional number amounts lose precision as binary floats; pass a decimal string",
      };
    }
    return { ok: true, wei: BigInt(raw) * WAD_WEI };
  }
  if (typeof raw !== "string" || !/^\d+(\.\d+)?$/.test(raw)) {
    return { ok: false, detail: "amount must be a positive decimal string" };
  }
  const [whole, frac = ""] = raw.split(".");
  if (frac.length > 18) {
    return { ok: false, detail: "more than 18 decimal places cannot be represented in wei" };
  }
  const wei = BigInt(whole!) * WAD_WEI + BigInt(frac.padEnd(18, "0"));
  if (wei <= 0n) return { ok: false, detail: "amount must be positive" };
  return { ok: true, wei };
}

// ————————————————————————— P1 phase gate + flow semantics —————————————————————————

function unsupportedDetail(b: Block): string | null {
  switch (b.type) {
    case "input":
      return null;
    case "stake":
      return b.params["protocol"] === "etherfi"
        ? null
        : `stake protocol '${String(b.params["protocol"])}' is not executable in P1 (EtherFi flagship only)`;
    case "wrap":
      return b.params["from"] === "eETH" && b.params["to"] === "weETH"
        ? null
        : `wrap ${String(b.params["from"])}→${String(b.params["to"])} is not executable in P1 (EtherFi flagship only)`;
    case "unwrap":
      return b.params["from"] === "WETH" && b.params["to"] === "ETH"
        ? null
        : `unwrap ${String(b.params["from"])}→${String(b.params["to"])} is not executable in P1 (EtherFi flagship only)`;
    case "lend":
      return b.params["asset"] === "weETH"
        ? null
        : `lending ${String(b.params["asset"])} is not executable in P1 (EtherFi flagship only)`;
    case "borrow":
      // graph.ts already restricts borrow assets to the v1 set (WETH).
      return null;
  }
}

function outputAssetOf(b: Block): Asset | null {
  switch (b.type) {
    case "input":
      return "ETH";
    case "stake":
      return "eETH";
    case "wrap":
    case "unwrap":
      return b.params["to"] as Asset;
    case "borrow":
      return b.params["asset"] as Asset;
    case "lend":
      return null;
  }
}

function expectedInputAssetOf(b: Block): Asset | null {
  switch (b.type) {
    case "input":
    case "borrow":
      return null;
    case "stake":
      return "ETH";
    case "wrap":
    case "unwrap":
      return b.params["from"] as Asset;
    case "lend":
      return b.params["asset"] as Asset;
  }
}

// ————————————————————————— e-mode selection —————————————————————————

function bitSet(bitmap: bigint, index: number): boolean {
  return ((bitmap >> BigInt(index)) & 1n) === 1n;
}

/**
 * Effective LTV in bps for one reserve under a category, per matrix §3
 * (ValidationLogic.getUserReserveLtv, read verbatim). `null` category means no active e-mode.
 */
function effectiveLtvBps(
  reserve: ReserveSnapshot,
  cat: EModeCategorySnapshot | null,
): number {
  if (cat === null) return reserve.ltvBps.value;
  const i = reserve.reserveIndex.value;
  if (bitSet(cat.collateralBitmap.value, i)) {
    return bitSet(cat.ltvZeroBitmap.value, i) ? 0 : cat.ltvBps.value;
  }
  // Outside the collateral bitmap: only an ISOLATED category zeroes it; otherwise the
  // reserve's own LTV applies, so such a plan can still be perfectly valid.
  return cat.isIsolated.value ? 0 : reserve.ltvBps.value;
}

/**
 * Effective liquidation threshold in bps, per matrix §3
 * (GenericLogic.calculateUserAccountData). Note the asymmetry with LTV: this depends ONLY on
 * collateral-bitmap membership — not on the LTV-zero bitmap and not on `isolated`. A member of
 * both bitmaps therefore has LTV 0 but the full category threshold.
 */
export function effectiveLiquidationThresholdBps(
  reserve: ReserveSnapshot,
  cat: EModeCategorySnapshot | null,
): number {
  if (cat === null) return reserve.liquidationThresholdBps.value;
  return inCollateralBitmap(reserve, cat)
    ? cat.liquidationThresholdBps.value
    : reserve.liquidationThresholdBps.value;
}

/**
 * The membership test `effectiveLiquidationThresholdBps` branches on, exported so a caller
 * that must cite WHICH observation the branch selected reads the same predicate instead of
 * restating it. Comparing the two thresholds for equality would misattribute whenever the
 * category and the reserve happen to agree, which is why this is a predicate and not a
 * value comparison.
 */
export function inCollateralBitmap(
  reserve: ReserveSnapshot,
  cat: EModeCategorySnapshot,
): boolean {
  return bitSet(cat.collateralBitmap.value, reserve.reserveIndex.value);
}

function categoryAdmits(
  cat: EModeCategorySnapshot,
  collateralIndices: readonly number[],
  borrowIndices: readonly number[],
): boolean {
  return (
    collateralIndices.every((i) => bitSet(cat.collateralBitmap.value, i)) &&
    borrowIndices.every((i) => bitSet(cat.borrowableBitmap.value, i)) &&
    collateralIndices.every((i) => !bitSet(cat.ltvZeroBitmap.value, i))
  );
}

// ————————————————————————— buildPlan —————————————————————————

/**
 * `origins` carries how each user-editable param reached the document, so the provenance
 * TREE agrees with what the screen shows. Optional and defaulting to empty, which means
 * all-entered: every caller that does not track origins — the live path, the fork suite —
 * gets exactly the semantics it had before, because its params really do come from a human.
 * Without it, a template default would render `Configured` in its own tooltip while every
 * derivation that consumed it cited `entered by user` for the same number.
 */
export function buildPlan(
  graph: StrategyGraph,
  snapshot: ChainSnapshot,
  origins: ParamOrigins = {},
): PlanResult {
  const structural = validateGraph(graph);
  if (!structural.ok) {
    return { ok: false, errors: [{ kind: "graph-invalid", messages: structural.errors }] };
  }

  const order = topologicalOrder(graph);
  const blockById = new Map(graph.blocks.map((b) => [b.id, b] as const));
  const producerEdge = new Map<string, Edge>();
  for (const e of graph.edges) producerEdge.set(e.target, e);

  // Phase gate + input parse — everything schema-valid but outside the P1
  // execution matrix returns a typed error naming the block.
  const inputBlock = graph.blocks.find((b) => b.type === "input")!;
  const parsed = parseInputAmount(inputBlock.params["amount"] as string | number | undefined);
  const phaseErrors: PlanError[] = [];
  for (const b of graph.blocks) {
    const detail = unsupportedDetail(b);
    if (detail !== null) phaseErrors.push({ kind: "unsupported-in-phase", blockId: b.id, detail });
  }
  if (!parsed.ok) {
    return {
      ok: false,
      errors: [
        {
          kind: "constraint",
          blockId: inputBlock.id,
          constraint: "input-amount",
          detail: parsed.detail,
        },
        ...phaseErrors,
      ],
    };
  }
  if (phaseErrors.length > 0) return { ok: false, errors: phaseErrors };
  const inputWei = parsed.wei;

  // Asset flow (graph.ts boundary note): each consumer's single producer must
  // hand it the asset it expects; a borrow's producer is a lend dependency.
  const flowErrors: PlanError[] = [];
  for (const id of order) {
    const b = blockById.get(id)!;
    if (b.type === "input") continue;
    const producer = blockById.get(producerEdge.get(id)!.source)!;
    if (b.type === "borrow") {
      if (producer.type !== "lend") {
        flowErrors.push({
          kind: "asset-flow",
          blockId: b.id,
          detail: `borrow requires an aave-v3 lend producer (collateral), got '${producer.type}'`,
        });
      }
      continue;
    }
    const produced = outputAssetOf(producer);
    const expected = expectedInputAssetOf(b);
    if (produced === null) {
      flowErrors.push({
        kind: "asset-flow",
        blockId: b.id,
        detail: `producer ${producer.id} (${producer.type}) has no token output to consume`,
      });
    } else if (expected !== null && produced !== expected) {
      flowErrors.push({
        kind: "asset-flow",
        blockId: b.id,
        detail: `expects ${expected} but producer ${producer.id} outputs ${produced}`,
      });
    }
  }
  if (flowErrors.length > 0) return { ok: false, errors: flowErrors };

  // E-mode resolution (SPEC §5.4): set the ETH-correlated category for NEW
  // positions only, and only when a recorded category admits the exact
  // collateral/borrow pair. A wallet already parked in a category the snapshot
  // does not describe cannot be validated — explicit error, never a guess.
  const lendBlocks = order.map((id) => blockById.get(id)!).filter((b) => b.type === "lend");
  const borrowBlocks = order.map((id) => blockById.get(id)!).filter((b) => b.type === "borrow");
  const reserveOf = (asset: string): ReserveKey => {
    if (asset === "weETH" || asset === "WETH") return asset;
    throw new Error(`unreachable: asset ${asset} survived the phase gate`);
  };
  const collateralIndices = [...new Set(lendBlocks.map((b) => snapshot.reserves[reserveOf(String(b.params["asset"]))].reserveIndex.value))];
  const borrowIndices = [...new Set(borrowBlocks.map((b) => snapshot.reserves[reserveOf(String(b.params["asset"]))].reserveIndex.value))];

  const emodeErrors: PlanError[] = [];
  const currentCategoryId = snapshot.user.eModeCategoryId.value;
  let targetCategory: EModeCategorySnapshot | null = null;
  let emitEModeStep = false;
  if (borrowBlocks.length > 0) {
    if (currentCategoryId !== 0) {
      const current = snapshot.eModeCategories.find((c) => c.id === currentCategoryId);
      if (current === undefined) {
        emodeErrors.push({
          kind: "constraint",
          blockId: borrowBlocks[0]!.id,
          constraint: "emode-unknown-category",
          detail: `wallet is in e-mode category ${currentCategoryId}, which the snapshot does not describe`,
        });
      } else if (!borrowIndices.every((i) => bitSet(current.borrowableBitmap.value, i))) {
        // v1 never transitions a live category (P5), so the plan must run under it: an asset the
        // category cannot borrow is unreachable, not merely suboptimal.
        emodeErrors.push({
          kind: "constraint",
          blockId: borrowBlocks[0]!.id,
          constraint: "emode-active-category-rejects-plan",
          detail: `wallet is in e-mode category ${currentCategoryId} ("${current.label.value}"), whose borrowable set excludes this plan's borrow asset`,
        });
      } else if (
        lendBlocks.every(
          (b) => effectiveLtvBps(snapshot.reserves[reserveOf(String(b.params["asset"]))], current) === 0,
        )
      ) {
        // Every collateral gets zero effective LTV under this category (matrix §3), so there is
        // no borrowing power and the borrow would revert. Collateral merely OUTSIDE a
        // non-isolated category's bitmap is NOT zero — it falls back to the reserve LTV — so
        // this is deliberately an effective-LTV test, not a bitmap-membership test.
        emodeErrors.push({
          kind: "constraint",
          blockId: borrowBlocks[0]!.id,
          constraint: "emode-active-category-rejects-plan",
          detail: `wallet is in e-mode category ${currentCategoryId} ("${current.label.value}"), which assigns every supplied collateral an effective LTV of 0; the borrow would revert`,
        });
      } else {
        targetCategory = current;
      }
    } else {
      const admitting = snapshot.eModeCategories
        .filter((c) => categoryAdmits(c, collateralIndices, borrowIndices))
        .sort((a, b) => a.id - b.id);
      targetCategory = admitting[0] ?? null;
      emitEModeStep = targetCategory !== null;
    }
  }
  if (emodeErrors.length > 0) return { ok: false, errors: emodeErrors };

  // Oracle DENOMINATORS, validated before any arithmetic consumes them. The borrow converts
  // a base-currency amount back into token wei by DIVIDING by the asset's price, so a price
  // of zero is a refusal with a sentence — never a division by zero (which would throw
  // straight through `simulate`'s total contract) and never a defaulted number (SPEC §5).
  // Collateral prices are numerators and are not denominators anywhere in this module; a
  // missing one surfaces downstream as an explicit unknown rather than as a refusal.
  const priceErrors: PlanError[] = [];
  for (const b of borrowBlocks) {
    const key = reserveOf(String(b.params["asset"]));
    if (snapshot.reserves[key].priceBase.value <= 0n) {
      priceErrors.push({
        kind: "constraint",
        blockId: b.id,
        constraint: "oracle-price-unavailable",
        detail: `the oracle reports no usable price for ${key}, so the borrow amount cannot be denominated`,
      });
    }
  }
  if (priceErrors.length > 0) return { ok: false, errors: priceErrors };

  // Predicted flows (floor at every division; matrix §7 share model) — these
  // drive the borrow derivation and the cap validation. Execution amounts stay
  // step-output attributions; predictions never become calldata except for the
  // borrow, whose amount is Derived by contract (W03 §Amount-provenance).
  const predictedOut = new Map<string, bigint>();
  const provOut = new Map<string, Provenanced<bigint>>();
  let pooled = snapshot.etherfi.totalPooledEther.value;
  let shares = snapshot.etherfi.totalShares.value;
  const pooledObs = snapshot.etherfi.totalPooledEther;
  const sharesObs = snapshot.etherfi.totalShares;
  const supplies: Array<{ blockId: string; reserve: ReserveKey; amountWei: bigint; prov: Provenanced<bigint> }> = [];
  const borrowDerivations = new Map<string, Derived<bigint>>();
  // Recorded, never recomputed: each push below hands out the wrapper this loop just built
  // for its own arithmetic. Asset and reserve come from the landed flow semantics
  // (`expectedInputAssetOf` / `outputAssetOf`) rather than a second reading of the params.
  const flows: BlockFlow[] = [];
  const flowOf = (
    b: Block,
    amounts: { input: Provenanced<bigint> | null; output: Provenanced<bigint> | null },
  ): BlockFlow => ({
    blockId: b.id,
    type: b.type,
    inputAsset: expectedInputAssetOf(b),
    inputWei: amounts.input,
    outputAsset: outputAssetOf(b),
    outputWei: amounts.output,
    reserve:
      b.type === "lend" || b.type === "borrow" ? reserveOf(String(b.params["asset"])) : null,
  });

  for (const id of order) {
    const b = blockById.get(id)!;
    if (b.type === "input") {
      const prov = wrapParam(inputWei, origins[paramOriginKey("block", id, "amount")]);
      predictedOut.set(id, inputWei);
      provOut.set(id, prov);
      flows.push(flowOf(b, { input: null, output: prov }));
      continue;
    }
    const edge = producerEdge.get(id)!;
    const parentOut = predictedOut.get(edge.source);
    const parentProv = provOut.get(edge.source);
    const inflow = (): { wei: bigint; prov: Provenanced<bigint> } => {
      if (parentOut === undefined || parentProv === undefined) {
        throw new Error(`unreachable: producer ${edge.source} has no predicted output`);
      }
      if (edge.allocationBps === 10_000) return { wei: parentOut, prov: parentProv };
      const wei = (parentOut * BigInt(edge.allocationBps)) / 10_000n;
      return {
        wei,
        prov: derived(wei, `floor(producerOutput × ${edge.allocationBps} / 10^4)`, [
          parentProv,
          entered(edge.allocationBps),
        ]),
      };
    };
    switch (b.type) {
      case "stake": {
        const { wei, prov } = inflow();
        const minted = (wei * shares) / pooled;
        const mintedProv = derived(
          minted,
          "floor(amountWei × eETH.totalShares / LP.getTotalPooledEther) — shares minted, matrix §7",
          [prov, sharesObs, pooledObs],
        );
        pooled += wei;
        shares += minted;
        const out = (minted * pooled) / shares;
        const outProv = derived(
          out,
          "floor(sharesMinted × totalPooledEtherAfter / totalSharesAfter) — eETH balance",
          [mintedProv],
        );
        predictedOut.set(id, out);
        provOut.set(id, outProv);
        flows.push(flowOf(b, { input: prov, output: outProv }));
        break;
      }
      case "wrap": {
        const { wei, prov } = inflow();
        const out = (wei * shares) / pooled;
        const outProv = derived(
          out,
          "floor(eETHAmount × totalShares / totalPooledEther) — sharesForAmount, weETH minted",
          [prov],
        );
        predictedOut.set(id, out);
        provOut.set(id, outProv);
        flows.push(flowOf(b, { input: prov, output: outProv }));
        break;
      }
      case "unwrap": {
        const { wei, prov } = inflow();
        predictedOut.set(id, wei);
        provOut.set(id, prov);
        // WETH→ETH is 1:1, so the output IS the input — one wrapper, not a restatement.
        flows.push(flowOf(b, { input: prov, output: prov }));
        break;
      }
      case "lend": {
        const { wei, prov } = inflow();
        supplies.push({ blockId: id, reserve: reserveOf(String(b.params["asset"])), amountWei: wei, prov });
        flows.push(flowOf(b, { input: prov, output: null }));
        break;
      }
      case "borrow": {
        const borrowReserve = snapshot.reserves[reserveOf(String(b.params["asset"]))];
        const bBps = b.params["allocationBps"] as number;
        let collateralBase = 0n;
        const collateralInputs: AnyProvenanced[] = [];
        for (const s of supplies) {
          const r = snapshot.reserves[s.reserve];
          const unit = 10n ** BigInt(r.decimals.value);
          collateralBase += (s.amountWei * r.priceBase.value) / unit;
          collateralInputs.push(s.prov, r.priceBase);
        }
        const collateralProv = derived(
          collateralBase,
          "floor(suppliedWei × priceBase / 10^decimals), summed over supplies preceding the borrow",
          collateralInputs,
        );
        const borrowBase = (collateralBase * BigInt(bBps)) / 10_000n;
        const borrowBaseProv = derived(borrowBase, `floor(collateralBase × ${bBps} / 10^4)`, [
          collateralProv,
          wrapParam(bBps, origins[paramOriginKey("block", id, "allocationBps")]),
        ]);
        const unit = 10n ** BigInt(borrowReserve.decimals.value);
        const borrowWei = (borrowBase * unit) / borrowReserve.priceBase.value;
        const borrowProv = derived(borrowWei, "floor(borrowBase × 10^decimals / priceBase)", [
          borrowBaseProv,
          borrowReserve.priceBase,
        ]);
        borrowDerivations.set(id, borrowProv);
        predictedOut.set(id, borrowWei);
        provOut.set(id, borrowProv);
        flows.push(flowOf(b, { input: null, output: borrowProv }));
        break;
      }
    }
  }

  // Validation matrix — exactly the recorded v3.7 constraint set (matrix §4),
  // cumulative across the plan's own steps within the pinned block.
  const matrixErrors: PlanError[] = [];
  const touchesAave = lendBlocks.length > 0 || borrowBlocks.length > 0;
  const firstAaveBlock = order
    .map((id) => blockById.get(id)!)
    .find((b) => b.type === "lend" || b.type === "borrow");
  if (touchesAave && snapshot.user.hasAaveFootprint.value) {
    matrixErrors.push({
      kind: "constraint",
      blockId: firstAaveBlock!.id,
      constraint: "existing-footprint",
      detail:
        "wallet already has an Aave Core footprint (aToken balance or debt); merging into an existing position is out of scope (SPEC §2)",
    });
  }

  const nextIdx = new Map<ReserveKey, { liq: bigint; varBorrow: bigint }>();
  const deltas = new Map<ReserveKey, { scaledSupply: bigint; scaledDebt: bigint; virtual: bigint }>();
  for (const key of ["weETH", "WETH"] as const) {
    const r = snapshot.reserves[key];
    nextIdx.set(key, {
      liq: accruedLiquidityIndexRay(
        r.liquidityRateRay.value,
        r.liquidityIndexRay.value,
        r.lastUpdateTimestamp.value,
        snapshot.blockTimestamp,
      ),
      varBorrow: accruedVariableBorrowIndexRay(
        r.variableBorrowRateRay.value,
        r.variableBorrowIndexRay.value,
        r.lastUpdateTimestamp.value,
        snapshot.blockTimestamp,
      ),
    });
    deltas.set(key, { scaledSupply: 0n, scaledDebt: 0n, virtual: 0n });
  }

  const flagErrors = (r: ReserveSnapshot, blockId: string): boolean => {
    let bad = false;
    if (!r.active.value) {
      matrixErrors.push({ kind: "constraint", blockId, constraint: "reserve-inactive", detail: "reserve is not active" });
      bad = true;
    }
    if (r.frozen.value) {
      matrixErrors.push({ kind: "constraint", blockId, constraint: "reserve-frozen", detail: "reserve is frozen" });
      bad = true;
    }
    if (r.paused.value) {
      matrixErrors.push({ kind: "constraint", blockId, constraint: "reserve-paused", detail: "reserve is paused" });
      bad = true;
    }
    return bad;
  };

  for (const id of order) {
    const b = blockById.get(id)!;
    if (b.type === "lend") {
      const key = reserveOf(String(b.params["asset"]));
      const r = snapshot.reserves[key];
      const supply = supplies.find((s) => s.blockId === id)!;
      const d = deltas.get(key)!;
      const idx = nextIdx.get(key)!;
      flagErrors(r, id);
      if (borrowBlocks.length > 0 && !r.usageAsCollateralAllowed.value) {
        matrixErrors.push({
          kind: "constraint",
          blockId: id,
          constraint: "collateral-not-allowed",
          detail: `${key} cannot be used as collateral on this market`,
        });
      }
      const scaledAmount = rayDivFloor(supply.amountWei, idx.liq);
      if (r.supplyCap.value !== 0n) {
        const unit = 10n ** BigInt(r.decimals.value);
        const displayAfter = rayMulFloor(
          r.aTokenScaledTotalSupply.value + r.accruedToTreasury.value + d.scaledSupply + scaledAmount,
          idx.liq,
        );
        if (displayAfter > r.supplyCap.value * unit) {
          matrixErrors.push({
            kind: "constraint",
            blockId: id,
            constraint: "supply-cap",
            detail: `supplying ${supply.amountWei} wei ${key} exceeds the supply cap (${r.supplyCap.value} tokens, v3.7 scaled formula)`,
          });
        }
      }
      d.scaledSupply += scaledAmount;
      d.virtual += supply.amountWei;
    } else if (b.type === "borrow") {
      const key = reserveOf(String(b.params["asset"]));
      const r = snapshot.reserves[key];
      const d = deltas.get(key)!;
      const idx = nextIdx.get(key)!;
      const borrowWei = predictedOut.get(id)!;
      flagErrors(r, id);
      if (!r.borrowingEnabled.value) {
        matrixErrors.push({
          kind: "constraint",
          blockId: id,
          constraint: "borrowing-disabled",
          detail: `borrowing ${key} is disabled on this market`,
        });
      }
      if (targetCategory !== null && !bitSet(targetCategory.borrowableBitmap.value, r.reserveIndex.value)) {
        matrixErrors.push({
          kind: "constraint",
          blockId: id,
          constraint: "emode-not-borrowable",
          detail: `${key} is not borrowable inside e-mode category ${targetCategory.id}`,
        });
      }
      const amountScaled = rayDivCeil(borrowWei, idx.varBorrow);
      if (r.borrowCap.value !== 0n) {
        const unit = 10n ** BigInt(r.decimals.value);
        const totalDebtAfter = rayMulCeil(
          r.variableDebtScaledTotalSupply.value + d.scaledDebt + amountScaled,
          idx.varBorrow,
        );
        if (totalDebtAfter > r.borrowCap.value * unit) {
          matrixErrors.push({
            kind: "constraint",
            blockId: id,
            constraint: "borrow-cap",
            detail: `borrowing ${borrowWei} wei ${key} exceeds the borrow cap (${r.borrowCap.value} tokens, v3.7 scaled formula)`,
          });
        }
      }
      if (borrowWei > r.virtualUnderlyingBalance.value + d.virtual) {
        matrixErrors.push({
          kind: "constraint",
          blockId: id,
          constraint: "insufficient-liquidity",
          detail: `borrowing ${borrowWei} wei ${key} exceeds the reserve's virtual underlying balance`,
        });
      }
      d.scaledDebt += amountScaled;
      d.virtual -= borrowWei;
    }
  }
  if (matrixErrors.length > 0) return { ok: false, errors: matrixErrors };

  // Emission — canonical step order (SPEC §2): the e-mode step lands once,
  // immediately before the first supply's approval.
  const steps: TransactionStep[] = [];
  const finalStepId = new Map<string, string>();
  const attributionOf = new Map<string, AmountAttribution>();
  let emodePending = emitEModeStep;
  let index = 0;
  const push = (step: Omit<TransactionStep, "index">): void => {
    index += 1;
    steps.push({ ...step, index });
  };

  const flowByBlockId = new Map(flows.map((f) => [f.blockId, f] as const));

  const inflowSpecOf = (b: Block): AmountSpec => {
    const edge = producerEdge.get(b.id)!;
    const producer = blockById.get(edge.source)!;
    if (producer.type === "input") {
      // An input-funded amount is fixed at plan time, so it becomes calldata directly — and
      // it becomes the EXACT wrapper the prediction pass already recorded, not a second
      // computation of the same number wearing fresh provenance. `literal` is reserved for
      // the wrapper that genuinely is the user's entered figure; a partial allocation is
      // `floor(entered × bps / 1e4)`, which is a derivation and must say so.
      const recorded = flowByBlockId.get(b.id)!.inputWei!;
      // `configured` joins `entered` here: both are the document's own figure, arriving as
      // calldata unchanged. Only a `derived` inflow is a computation over it (a partial
      // allocation is `floor(entered × bps / 1e4)`), and only `observed` is impossible —
      // nothing on this path is read from a chain.
      if (recorded.kind === "entered" || recorded.kind === "configured") {
        return { kind: "literal", amount: recorded };
      }
      if (recorded.kind === "derived") return { kind: "derived", amount: recorded };
      throw new Error(
        `unreachable: input-funded flow for ${b.id} is ${recorded.kind}, not a document figure`,
      );
    }
    return {
      kind: "step-output",
      producerStepId: finalStepId.get(producer.id)!,
      attribution: attributionOf.get(producer.id)!,
      allocationBps: edge.allocationBps,
    };
  };

  for (const id of order) {
    const b = blockById.get(id)!;
    switch (b.type) {
      case "input":
        break;
      case "stake": {
        const spec = inflowSpecOf(b);
        push({
          id: `${id}:deposit`,
          blockId: id,
          description: "EtherFi LiquidityPool deposit (ETH→eETH)",
          to: snapshot.etherfi.liquidityPool,
          abi: DEPOSIT_ABI,
          functionName: "deposit",
          args: [],
          valueSpec: "amount",
          amount: spec,
        });
        finalStepId.set(id, `${id}:deposit`);
        attributionOf.set(id, "share-delta");
        break;
      }
      case "wrap": {
        const spec = inflowSpecOf(b);
        push({
          id: `${id}:approve`,
          blockId: id,
          description: "eETH approve → weETH (bound to the attributed eETH output)",
          to: snapshot.etherfi.eETH,
          abi: APPROVE_ABI,
          functionName: "approve",
          args: [{ kind: "value", value: snapshot.etherfi.weETH }, { kind: "amount" }],
          valueSpec: "none",
          amount: spec,
        });
        push({
          id: `${id}:wrap`,
          blockId: id,
          description: "weETH wrap (eETH→weETH)",
          to: snapshot.etherfi.weETH,
          abi: WRAP_ABI,
          functionName: "wrap",
          args: [{ kind: "amount" }],
          valueSpec: "none",
          amount: spec,
        });
        finalStepId.set(id, `${id}:wrap`);
        attributionOf.set(id, "transfer-event");
        break;
      }
      case "lend": {
        const key = reserveOf(String(b.params["asset"]));
        const r = snapshot.reserves[key];
        const spec = inflowSpecOf(b);
        if (emodePending) {
          push({
            id: `${id}:set-emode`,
            blockId: id,
            description: `Aave setUserEMode (${targetCategory!.label.value})`,
            to: snapshot.pool,
            abi: SET_USER_EMODE_ABI,
            functionName: "setUserEMode",
            args: [{ kind: "value", value: targetCategory!.id }],
            valueSpec: "none",
            amount: { kind: "none" },
          });
          emodePending = false;
        }
        push({
          id: `${id}:approve`,
          blockId: id,
          description: `${key} approve → Aave Pool (bound to the attributed output)`,
          to: r.underlying,
          abi: APPROVE_ABI,
          functionName: "approve",
          args: [{ kind: "value", value: snapshot.pool }, { kind: "amount" }],
          valueSpec: "none",
          amount: spec,
        });
        push({
          id: `${id}:supply`,
          blockId: id,
          description: `Aave supply ${key}`,
          to: snapshot.pool,
          abi: SUPPLY_ABI,
          functionName: "supply",
          args: [
            { kind: "value", value: r.underlying },
            { kind: "amount" },
            { kind: "value", value: snapshot.user.address },
            { kind: "value", value: 0 },
          ],
          valueSpec: "none",
          amount: spec,
        });
        finalStepId.set(id, `${id}:supply`);
        break;
      }
      case "borrow": {
        const key = reserveOf(String(b.params["asset"]));
        const r = snapshot.reserves[key];
        push({
          id: `${id}:borrow`,
          blockId: id,
          description: `Aave borrow ${key} (variable rate)`,
          to: snapshot.pool,
          abi: BORROW_ABI,
          functionName: "borrow",
          args: [
            { kind: "value", value: r.underlying },
            { kind: "amount" },
            // Aave v3.2+ removed stable borrowing; variable (2) is the only mode.
            { kind: "value", value: 2n },
            { kind: "value", value: 0 },
            { kind: "value", value: snapshot.user.address },
          ],
          valueSpec: "none",
          amount: { kind: "derived", amount: borrowDerivations.get(id)! },
        });
        finalStepId.set(id, `${id}:borrow`);
        attributionOf.set(id, "transfer-event");
        break;
      }
      case "unwrap": {
        const spec = inflowSpecOf(b);
        push({
          id: `${id}:withdraw`,
          blockId: id,
          description: "WETH withdraw (WETH→ETH); output is the withdraw argument",
          to: snapshot.reserves.WETH.underlying,
          abi: WITHDRAW_ABI,
          functionName: "withdraw",
          args: [{ kind: "amount" }],
          valueSpec: "none",
          amount: spec,
        });
        finalStepId.set(id, `${id}:withdraw`);
        attributionOf.set(id, "withdraw-argument");
        break;
      }
    }
  }

  return {
    ok: true,
    steps,
    targetEModeCategoryId: targetCategory === null ? null : targetCategory.id,
    flows,
  };
}
