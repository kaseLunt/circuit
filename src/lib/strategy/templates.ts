/**
 * Strategy templates (SPEC §2 flagship, §3 step 1). Pure: no React, no fetch, no
 * formatting, no rates.
 *
 * A template is PROSE + STRUCTURE and nothing else. The predecessor put
 * `estimatedApy: "3-4%"` on every card and `apy: 3.2` / `supplyApy: 0.5` /
 * `maxLtv: 77` on every block — including three different liquidation thresholds
 * for the same Aave market — so a template rendered fabricated numbers the moment
 * rates moved. SPEC §3.2 requires every number on screen to be live-sourced, which
 * makes a rate on a template a bug by construction, not a stale value.
 *
 * The only numbers a template may carry are allocation basis points and the input
 * amount (a decimal STRING). Rates, prices, LTVs and risk are read from the
 * block-pinned ChainSnapshot and derived in core/.
 *
 * Metadata prose carries no digit at all (asserted in templates.test.ts). That is
 * blunt on purpose: an "Aave v3 Core" in a summary is harmless, but a rule with an
 * exemption is a rule an APY claim can be smuggled through. Protocol identity
 * already lives in block params (`protocol: "aave-v3"`), where it is structure.
 *
 * The output is core/graph.ts's `StrategyGraph` verbatim, because the composer
 * store's document IS that type. View concerns are deliberately absent — positions
 * come from the deterministic layout pass, and validity is derived by
 * `validateGraph`, never stored (a persisted `isConfigured: true` was how the
 * predecessor's blocks claimed to be configured while holding stale data).
 *
 * CALLER CONTRACT: the builders below return an UNVALIDATED graph. Every caller
 * that turns one into store state — `loadTemplate` included — MUST run
 * `validateGraph` first and render the rejection, exactly as the share-URL and
 * localStorage paths do (SPEC §5.6). These functions take open parameters, so "it
 * came from a template" stops being a trust argument the moment a caller wires a
 * form field to one.
 */
import type { Block, Edge, StrategyGraph } from "../../core/graph";
import { FULL_ALLOCATION_BPS } from "./types";

/**
 * A template as the composer consumes it: prose plus a graph, and nothing else.
 *
 * There is deliberately no `riskLevel` and no `tags`. An editorial risk label
 * beside the derived `RiskState` is a second scale that can disagree with the
 * health factor on screen — the same defect `SimulationResult` is written to
 * avoid — and a tag list was card decoration with no consumer.
 *
 * `graph()` returns a fresh `StrategyGraph` per call, so a caller that mutates a
 * loaded document cannot corrupt the template for the next load.
 */
export interface StrategyTemplate {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  graph(): StrategyGraph;
}

/**
 * `Configured` in SPEC §5's taxonomy — a named author's default with a definition
 * site, NOT a value any user entered. It becomes `Entered` only once the user has
 * seen and kept it in the amount field. Downstream, `plan.ts` wraps the parsed
 * amount as `entered(inputWei)` at the calldata boundary, so any card or inspector
 * rendering this before first edit must label it a default rather than user input.
 *
 * Decimal STRING: `parseInputAmount` rejects fractional `number` amounts as
 * float-lossy, and a string keeps the document JSON-safe for the share URL and
 * localStorage.
 */
const DEFAULT_INPUT_ETH = "10";

/**
 * `Configured`, with the same caveat as DEFAULT_INPUT_ETH: debt opened as a
 * fraction of collateral value at open (SPEC §5.2 `b`). This is NOT an edge's flow
 * allocation and NOT a claim about the reserve's LTV ceiling — that ceiling is
 * Observed on the snapshot and resolved per e-mode regime. Both quantities are
 * called "allocation"; conflating them (as the predecessor's single `flowPercent`
 * did) produces wrong leverage that still typechecks.
 */
const DEFAULT_BORROW_ALLOCATION_BPS = 7000;

/** The template SPEC §3 step 1 opens the composer with. */
export const FLAGSHIP_TEMPLATE_ID = "leveraged-restake-loop";

/**
 * Chain the given block ids in order, each edge carrying the full output.
 *
 * A validated graph is single-producer — every non-input block has exactly one
 * incoming edge — so sequential `e${i}` ids are collision-free and deterministic.
 * The style is not free: the flagship template must be BYTE-IDENTICAL to the
 * canonical plan fixture (tests/helpers/graphs.ts linearEdges), which mints
 * `e${i}` — fixture identity is the headline W05 pin, so the template follows the
 * fixture, never the reverse. No `Date.now()`, no counters, no randomness: ids
 * must be stable across sessions because share URLs, plan snapshots and
 * Playwright step assertions all key off them.
 */
function chainEdges(ids: readonly string[]): Edge[] {
  const edges: Edge[] = [];
  for (let i = 0; i < ids.length - 1; i += 1) {
    edges.push({ id: `e${i}`, source: ids[i]!, target: ids[i + 1]!, allocationBps: FULL_ALLOCATION_BPS });
  }
  return edges;
}

function chainOf(blocks: readonly Block[]): StrategyGraph {
  return { blocks: [...blocks], edges: chainEdges(blocks.map((b) => b.id)) };
}

/** Input → EtherFi stake. One step; the honest "what is this thing" template. */
export function restake(amountEth: string = DEFAULT_INPUT_ETH): StrategyGraph {
  return chainOf([
    { id: "in", type: "input", params: { asset: "ETH", amount: amountEth } },
    { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
  ]);
}

/**
 * Input → stake → wrap → supply. No debt, so the health factor renders the no-debt
 * sentinel rather than a fabricated number.
 */
export function restakeAndSupply(amountEth: string = DEFAULT_INPUT_ETH): StrategyGraph {
  return chainOf([
    { id: "in", type: "input", params: { asset: "ETH", amount: amountEth } },
    { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
    { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
    { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
  ]);
}

/**
 * SPEC §2 "Leveraged Restake Loop" — the finite expanded DAG, not a cycle. The one
 * closed iteration is explicit duplicated nodes, so plan.ts receives a graph an
 * ordinary topological sort orders and no cycle-unrolling semantics exist anywhere.
 *
 * The block ids below are a CONTRACT, not cosmetics: core/plan.ts derives every
 * `TransactionStep.id` from them (`${blockId}:supply`, …), so these ids are what
 * the §2 13-step enumeration, the plan snapshots, the fork gate and the Playwright
 * step assertions all pin. Renaming one silently renames plan steps.
 *
 * Both parameters stay open so a caller can author the demo's starting position
 * without a second template — which is exactly why the module header's caller
 * contract exists: an open parameter means an unvalidated graph.
 */
export function leveragedRestakeLoop(
  amountEth: string = DEFAULT_INPUT_ETH,
  borrowAllocationBps: number = DEFAULT_BORROW_ALLOCATION_BPS,
): StrategyGraph {
  return chainOf([
    { id: "in", type: "input", params: { asset: "ETH", amount: amountEth } },
    { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
    { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
    { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    {
      id: "borrow",
      type: "borrow",
      params: { protocol: "aave-v3", asset: "WETH", allocationBps: borrowAllocationBps },
    },
    { id: "unwrap", type: "unwrap", params: { from: "WETH", to: "ETH" } },
    { id: "stake2", type: "stake", params: { protocol: "etherfi" } },
    { id: "wrap2", type: "wrap", params: { from: "eETH", to: "weETH" } },
    { id: "supply2", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
  ]);
}

export const STRATEGY_TEMPLATES: readonly StrategyTemplate[] = [
  {
    id: "restake",
    name: "Restake",
    summary: "Stake ETH with EtherFi and hold the liquid receipt token.",
    graph: () => restake(),
  },
  {
    id: "restake-supply",
    name: "Restake and supply",
    summary: "Stake ETH, wrap the receipt into weETH, and supply it to Aave as collateral.",
    graph: () => restakeAndSupply(),
  },
  {
    id: FLAGSHIP_TEMPLATE_ID,
    name: "Leveraged Restake Loop",
    summary:
      "One closed iteration: supply weETH, borrow WETH against it, unwrap to ETH and stake again.",
    graph: () => leveragedRestakeLoop(),
  },
];

/**
 * Unknown ids return `undefined` rather than a default template: an unrecognized id
 * is a designed error state, and silently substituting a different strategy is the
 * same class of defect as substituting a different asset's rate.
 *
 * `Array.find` over the roster, deliberately not a `Record` lookup: an id arriving
 * from a URL or localStorage cannot reach `Object.prototype` keys here.
 */
export function getTemplate(id: string): StrategyTemplate | undefined {
  return STRATEGY_TEMPLATES.find((t) => t.id === id);
}
