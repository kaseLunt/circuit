/**
 * Composer block-graph schema (React Flow view model) — SPEC §2 blocks.
 *
 * This is the *authored document*: user configuration only. localStorage and the
 * share URL carry it verbatim, so it holds no live-read quantity — rates, LTVs,
 * quotes and computed flows are stale the instant they are written, and §5.1
 * requires every displayed number to arrive block-pinned and provenanced from the
 * rates layer instead.
 *
 * It is NOT the execution schema. `core/graph.ts` owns the validated StrategyGraph
 * that plan and calldata derive from; this module is its view-model mirror, so
 * allocation is carried in the same integer bps units core validates and the asset
 * and protocol vocabularies stay assignable to core's. Contract addresses never
 * appear here: the share URL is untrusted input (§5.6), so execution targets are
 * resolved at plan time from the block-pinned ChainSnapshot, never from graph data.
 *
 * No template contract and no authored risk label live here. A template is prose
 * plus a `graph()` in ./templates.ts, and risk is core's `RiskState` derived once
 * from a block-pinned health factor — an editorial `riskLevel` beside it is a
 * second scale that can disagree with the number on screen, the same defect
 * `SimulationResult` below is written to avoid.
 */
import type { Node, Edge } from "@xyflow/react";
import type { HealthFactor } from "../../core/health-factor";
import type { Provenanced } from "../../core/provenance";

export type BlockType = "input" | "stake" | "lend" | "borrow" | "swap" | "auto-wrap";

export type AssetType =
  | "ETH"
  | "WETH"
  | "stETH"
  | "wstETH"
  | "eETH"
  | "weETH"
  | "USDC"
  | "DAI";

export type StakeProtocol = "lido" | "etherfi";

export type LendProtocol = "aave-v3";

/** 100% of a source's output, in the integer bps units core/graph.ts validates. */
export const FULL_ALLOCATION_BPS = 10_000;

export interface BaseBlockData {
  label: string;
  isConfigured: boolean;
  isValid: boolean;
  errorMessage?: string;
  /** Placed by the route optimizer rather than the user (§2 auto-wrap). */
  isAutoInserted?: boolean;
  // Required by React Flow 12's Node<T extends Record<string, unknown>> bound.
  [key: string]: unknown;
}

export interface InputBlockData extends BaseBlockData {
  type: "input";
  asset: AssetType;
  /**
   * Decimal token string as typed, parsed to wei at plan time — the form
   * core/graph.ts already accepts. Never a float: 18-decimal amounts do not
   * survive IEEE-754, and unparseable input must invalidate the block rather
   * than coerce to a number.
   */
  amount: string;
}

export interface StakeBlockData extends BaseBlockData {
  type: "stake";
  protocol: StakeProtocol;
  inputAsset: AssetType;
  outputAsset: AssetType;
}

/**
 * Canonical auto-wrap block (§2 Wrap), reconciling the two divergent old
 * definitions. Only three data fields were ever read: fromAsset, toAsset, and
 * wrapStep.isWrap — flattened here to `isWrap`, which also removes the view
 * layer's dependency on the optimizer's WrapStep type. The rest of WrapStep was
 * a wrapper address plus a method name: addresses never ride a shareable
 * document (§5.6), and both target and method are resolved at plan time from the
 * block-pinned ChainSnapshot. `isWrap` selects between core/graph.ts's "wrap"
 * and "unwrap" block types when the graph is adapted for execution.
 */
export interface AutoWrapBlockData extends BaseBlockData {
  type: "auto-wrap";
  fromAsset: AssetType;
  toAsset: AssetType;
  isWrap: boolean;
}

export interface LendBlockData extends BaseBlockData {
  type: "lend";
  protocol: LendProtocol;
  /**
   * Collateral asset SYMBOL resolved from the incoming edge; null while
   * unconnected. Never an address, and never a reserve risk parameter: LTV and
   * liquidation threshold are Observed bps on core/plan.ts ReserveSnapshot, with
   * e-mode resolution, and would rehydrate stale if persisted on the node.
   */
  asset: AssetType | null;
}

export interface BorrowBlockData extends BaseBlockData {
  type: "borrow";
  /** core/graph.ts requires a borrow protocol param; without it no graph validates. */
  protocol: LendProtocol;
  asset: AssetType;
  /**
   * Debt opened as a fraction of collateral value at open (SPEC §5.2 `b`), in the
   * integer bps core/plan.ts reads as the borrow block's allocationBps. No
   * rate-mode field exists anywhere in the schema: v3.2 removed stable borrowing
   * and core/plan.ts pins interestRateMode = 2.
   */
  allocationBps: number;
}

export interface SwapBlockData extends BaseBlockData {
  type: "swap";
  fromAsset: AssetType;
  toAsset: AssetType;
  /** User-chosen tolerance in bps. Output is quote-driven and never stored here. */
  slippageBps: number;
}

export type BlockData =
  | InputBlockData
  | StakeBlockData
  | AutoWrapBlockData
  | LendBlockData
  | BorrowBlockData
  | SwapBlockData;

export type StrategyBlock = Node<BlockData, BlockType>;

export interface StrategyEdgeData {
  asset?: AssetType;
  label?: string;
  /**
   * Share of the source's output routed along this edge: an integer in
   * [1, FULL_ALLOCATION_BPS], so it crosses to core/graph.ts Edge.allocationBps
   * unconverted. A percent float would either fail validateGraph or round at the
   * conversion site, making that site a second source of truth for §5.2's `b`.
   */
  allocationBps: number;
  [key: string]: unknown;
}

export type StrategyEdge = Edge<StrategyEdgeData>;

/**
 * Where one block sits on the canvas, as produced by the deterministic layout
 * pass in ./layout.ts.
 *
 * View state, never money and never transported: the share payload carries blocks
 * and edges only, so positions are recomputed on load rather than trusted from an
 * untrusted document (§5.6) — which is what keeps NaN/±Infinity/absurd-extent
 * coordinates out of the canvas entirely. Nothing rate-, risk- or selection-
 * bearing belongs here: selection lives in the composer store, and every number on
 * screen is a read.
 */
export interface BlockView {
  readonly x: number;
  readonly y: number;
  /**
   * Set when the route optimizer placed this block rather than the user (§2
   * auto-wrap). The canvas's "Auto" badge reads this and nothing else; it is view
   * state because the graph itself must stay identical whether a wrap was typed
   * or inserted.
   */
  readonly isAutoInserted?: boolean;
}

export interface Strategy {
  id: string;
  name: string;
  description?: string;
  blocks: StrategyBlock[];
  edges: StrategyEdge[];
  /** Epoch ms — a Date does not survive the JSON round trip through
   * localStorage and the share URL. */
  createdAt: number;
  updatedAt: number;
}

export interface YieldSource {
  protocol: string;
  type: "supply" | "borrow" | "stake";
  /** Rate as a WAD APY (core/rates.ts rayAprToApyWad), with its provenance. */
  apyWad: Provenanced<bigint>;
  /**
   * Signed weight this source's rate carries in the §5.2 net-APY composition, in
   * integer bps: collateral-side sources carry (1 + b) — FULL_ALLOCATION_BPS plus
   * the borrow block's allocationBps — and the debt source carries −b, so the
   * weights sum to FULL_ALLOCATION_BPS. A multi-leg collateral rate splits its
   * (1 + b) across legs in proportion to each leg's WAD rate, preserving the sum.
   *
   * The predecessor's field (`weight`, commented only "Contribution to total")
   * declared no unit and its sole consumer is a rewrite, so no conversion from it
   * is claimed: this is a new contract. Not a 0–1 fraction, not a percent, and
   * never re-normalized by the display layer.
   */
  weightBps: number;
}

/**
 * Provisional home for the simulation contract: it belongs in core/simulation.ts
 * (P2) since it is finance math. Every quantity is core's representation so the
 * display layer can only render it through core/format.ts. No stored risk
 * classification exists — a consumer calls core's riskState(minHealthFactor),
 * so there is exactly one risk derivation and no scale that can drift from it.
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
  /** Minimum HF across the plan — the gating quantity borrow blocks show (§5.4). */
  minHealthFactor: HealthFactor;
  finalHealthFactor: HealthFactor;
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
  inputAsset: AssetType | null;
  inputAmountWei: Provenanced<bigint> | null;
  inputValueBase: Provenanced<bigint> | null;
  outputAsset: AssetType | null;
  outputAmountWei: Provenanced<bigint> | null;
  outputValueBase: Provenanced<bigint> | null;
  gasCostBase: Provenanced<bigint> | null;
  apyWad: Provenanced<bigint> | null;
}

export interface SavedSystem {
  id: string;
  name: string;
  description?: string;
  /** Positions relative to the first block. */
  blocks: StrategyBlock[];
  edges: StrategyEdge[];
  blockCount: number;
  createdAt: number;
  updatedAt: number;
}
