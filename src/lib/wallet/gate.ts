/**
 * The live-mode gate: every decision the wallet seam makes, as pure functions over readings.
 *
 * Doctrine D10 — decisions live in covered pure code; the connector glue
 * (`wallet-provider.tsx`) is mechanical thread-through of what is decided HERE. Nothing in
 * this module opens a connection, reads a chain, or touches React: it takes readings and
 * returns a verdict, so every refusal in SPEC §3 step 7 is unit-provable rather than
 * click-provable.
 *
 * The verdicts are refusals, never repairs. A missing reading refuses (SPEC §5: a missing
 * source renders an explicit unavailable state) — there is no permissive default anywhere
 * below, and no numeric fallback: the one bound this module applies,
 * `LIVE_SIMULATION_MAX_AGE_MS`, is imported from `tolerance.ts` where it is named and
 * justified.
 */
import { getAddress, type Address, type Hex } from "viem";
import type { PlanSuccess } from "../../core/plan";
import { LIVE_SIMULATION_MAX_AGE_MS } from "../execution/tolerance";
import type { WalletSeamReadings, WalletSession } from "./types";

/**
 * Ethereum mainnet. SPEC §2 pins the protocol target to Aave v3 Ethereum Core and §2's cut
 * list ends with "multi-chain (v1 is Ethereum mainnet only)", so this is a product fact with
 * a definition site rather than a configurable. Live execute refuses any other chain BEFORE
 * a signature is requested (treatment §1.2): the plan's calldata addresses are mainnet
 * addresses, and the same bytes on another chain reach whatever happens to live there.
 */
export const LIVE_CHAIN_ID = 1;

/**
 * The ONE plan property the `eth_getCode` check gates on.
 *
 * WHY, from this repo's own fork receipt (`tests/fork/flagship-plan.test.ts:327-333`):
 * WETH9's `withdraw` sends ETH with a 2300-gas stipend, and mainnet EIP-7702 delegations on
 * well-known EOAs run out of gas inside that stipend. The fork suite had to route around it;
 * the session service mints code-free actors for the same reason
 * (`src/server/sandbox/fork-session.ts`). A plan with no WETH withdrawal has no stipend send,
 * so a code-bearing wallet is not refused for it — the gate is about the mechanism, not
 * about disliking contract wallets.
 */
export function planRequiresCodeFreeActor(plan: PlanSuccess): boolean {
  // The WETH9 mechanism by SHAPE, not by name alone: `withdraw(uint256)` — one argument,
  // the contract pushing ETH back with a 2300-gas stipend. Aave Pool's
  // `withdraw(address,uint256,address)` shares the name, transfers ERC-20, and has no
  // stipend send — a code-bearing wallet is fine for it, so it must not trip this gate.
  return plan.steps.some(
    (step) => step.functionName === "withdraw" && step.args.length === 1,
  );
}

/** Refusals the connect seam produces — each renders through the T27 designed-stop card. */
export type LiveConnectRefusal =
  | { readonly kind: "wrong-chain"; readonly chainId: number; readonly expected: number }
  | { readonly kind: "code-bearing-wallet" }
  | { readonly kind: "code-unknown"; readonly reason: string }
  | { readonly kind: "existing-footprint" }
  | { readonly kind: "footprint-unknown"; readonly reason: string };

/** Refusals the Execute gate adds on top of the connect refusals (SPEC §3 step 7). */
export type LiveExecuteRefusal =
  | LiveConnectRefusal
  | { readonly kind: "not-connected" }
  | { readonly kind: "no-fresh-simulation" }
  | {
      readonly kind: "stale-simulation";
      readonly ageMs: number;
      readonly maxAgeMs: number;
    }
  | {
      readonly kind: "simulation-address-drift";
      readonly simulatedFor: Address;
      readonly connected: Address;
    }
  /**
   * The document moved since the gating simulation ran: the standing's plan hash no longer
   * matches the hash of the plan the document derives NOW. A drifted simulation is not a
   * stale one — it is about a different question — so this is its own refusal kind, checked
   * BEFORE the staleness clock is even consulted (Codex D-011 F3: simulate plan A, edit
   * allocation, execute plan B inside the freshness window is exactly the hole this closes).
   * `current` is null when the current document produces no plan over the pinned capture at
   * all — which is drift stated at its most severe, not a pass.
   */
  | {
      readonly kind: "plan-drift";
      readonly simulated: Hex;
      readonly current: Hex | null;
    }
  /**
   * The block-pinned capture the standing simulated against is no longer the capture in
   * hand. Same doctrine as `plan-drift`: a simulation against another block's state answers
   * a different question, whatever the clock says.
   */
  | {
      readonly kind: "snapshot-drift";
      readonly simulatedAt: LiveSnapshotIdentity;
      readonly current: LiveSnapshotIdentity | null;
    };

/** The block identity a live capture is pinned to — number AND hash, so a reorg cannot
 *  impersonate the block the simulation priced against. */
export interface LiveSnapshotIdentity {
  readonly block: bigint;
  readonly blockHash: Hex;
}

function sameSnapshotIdentity(a: LiveSnapshotIdentity, b: LiveSnapshotIdentity): boolean {
  return a.block === b.block && a.blockHash.toLowerCase() === b.blockHash.toLowerCase();
}

/**
 * The connect-time seam checks, in the order their evidence arrives.
 *
 * Chain first — it is the only refusal that is a mistake rather than a scope boundary, and
 * the other two readings are meaningless against the wrong chain's state. Then the code
 * check (plan-conditional, above), then the SPEC §2 footprint predicate, which live v1
 * refuses outright: merging a planned strategy into an existing position, and eMode
 * transitions on live positions, are P5 problems and pretending otherwise would ship wrong
 * risk numbers.
 */
export function liveConnectRefusalOf(
  session: WalletSession,
  readings: WalletSeamReadings,
  plan: PlanSuccess,
): LiveConnectRefusal | null {
  if (session.chainId !== LIVE_CHAIN_ID) {
    return { kind: "wrong-chain", chainId: session.chainId, expected: LIVE_CHAIN_ID };
  }
  if (planRequiresCodeFreeActor(plan)) {
    if (readings.code.status === "code-bearing") return { kind: "code-bearing-wallet" };
    if (readings.code.status === "unknown") {
      return { kind: "code-unknown", reason: readings.code.reason };
    }
  }
  if (readings.footprint.status === "occupied") return { kind: "existing-footprint" };
  if (readings.footprint.status === "unknown") {
    return { kind: "footprint-unknown", reason: readings.footprint.reason };
  }
  return null;
}

/** What Execute needs to know about the simulation standing behind it. */
export interface LiveSimulationStanding {
  /**
   * The address the gating simulation's snapshot was captured FOR. Compared by identity to
   * the connected address: a simulation against a different wallet's balances is not a
   * fresh simulation against THIS wallet's balances (SPEC §3 step 7), it is a different
   * question that happens to have an answer.
   */
  readonly simulatedFor: Address;
  /** Monotonic reading at `plan-ready` — enforcement never reads wall time (D9). */
  readonly simulatedAtMonotonicMs: number;
  /**
   * `planHashOf` over the steps the gating simulation ran — computed by the COMPOSER, which
   * owns the plan, and carried here as an opaque fingerprint. The gate only compares; it
   * never hashes, so the wallet module's one value-route into `lib/execution` stays the
   * tolerance constant and nothing else (Codex D-011 F5 seam ruling).
   */
  readonly planHash: Hex;
  /** The capture the simulation priced against, by block number AND hash. */
  readonly snapshot: LiveSnapshotIdentity;
}

export interface LiveExecuteGateInputs {
  readonly session: WalletSession | null;
  readonly readings: WalletSeamReadings;
  readonly plan: PlanSuccess;
  readonly simulation: LiveSimulationStanding | null;
  /**
   * `planHashOf` over the plan the CURRENT document derives from the pinned live capture —
   * recomputed by the composer on every document change, null when the current document no
   * longer plans over that capture. Compared against `simulation.planHash`: inequality is
   * the F3 plan-drift refusal.
   */
  readonly currentPlanHash: Hex | null;
  /** The capture currently in hand, null when none is. */
  readonly currentSnapshot: LiveSnapshotIdentity | null;
  /** Monotonic reading now (D9). */
  readonly nowMonotonicMs: number;
}

/**
 * The complete Execute gate for live mode. Returns the FIRST refusal, or null when the
 * button may commit — and the caller renders `aria-disabled` plus this refusal's reason
 * rather than `disabled` (T25/T33: disabled states always explain why).
 */
export function liveExecuteRefusalOf(inputs: LiveExecuteGateInputs): LiveExecuteRefusal | null {
  const session = inputs.session;
  if (session === null) return { kind: "not-connected" };
  const connect = liveConnectRefusalOf(session, inputs.readings, inputs.plan);
  if (connect !== null) return connect;
  const standing = inputs.simulation;
  if (standing === null) return { kind: "no-fresh-simulation" };
  const connected = getAddress(session.address);
  const simulatedFor = getAddress(standing.simulatedFor);
  if (simulatedFor !== connected) {
    return { kind: "simulation-address-drift", simulatedFor, connected };
  }
  // Drift BEFORE staleness (Codex D-011 F3): a simulation about a different document or a
  // different pinned block is not "old", it is about a different question, and reporting it
  // as merely stale would invite a re-press of Execute rather than a re-simulation.
  if (
    inputs.currentSnapshot === null ||
    !sameSnapshotIdentity(standing.snapshot, inputs.currentSnapshot)
  ) {
    return {
      kind: "snapshot-drift",
      simulatedAt: standing.snapshot,
      current: inputs.currentSnapshot,
    };
  }
  if (inputs.currentPlanHash === null || inputs.currentPlanHash !== standing.planHash) {
    return { kind: "plan-drift", simulated: standing.planHash, current: inputs.currentPlanHash };
  }
  const ageMs = inputs.nowMonotonicMs - standing.simulatedAtMonotonicMs;
  if (ageMs > LIVE_SIMULATION_MAX_AGE_MS) {
    return { kind: "stale-simulation", ageMs, maxAgeMs: LIVE_SIMULATION_MAX_AGE_MS };
  }
  return null;
}

/**
 * Which refusals a fresh simulation against the connected wallet can CLEAR — the decision
 * behind the composer's "Simulate against this wallet" control (D10: the control renders
 * what is decided here). Connect-level refusals are scope boundaries or mistakes a
 * simulation cannot answer (wrong chain, code-bearing wallet, existing footprint, unread
 * seams), so offering the button against them would promise something the product refuses
 * to deliver.
 */
export function simulationCanClear(refusal: LiveExecuteRefusal): boolean {
  switch (refusal.kind) {
    case "no-fresh-simulation":
    case "stale-simulation":
    case "simulation-address-drift":
    case "plan-drift":
    case "snapshot-drift":
      return true;
    case "not-connected":
    case "wrong-chain":
    case "code-bearing-wallet":
    case "code-unknown":
    case "existing-footprint":
    case "footprint-unknown":
      return false;
  }
}

/**
 * Did the wallet actually DEPART the pinned identity?
 *
 * `accountsChanged` fires for re-permissioning and for tab focus in some wallets, and a
 * halt that fires on a non-change would be a self-inflicted stop card. So the comparison is
 * on the checksummed address and the chain id, and only a real departure halts. The halt
 * itself is the machine's (`wallet-changed`, `machine.ts` WALLET_HALTABLE); this predicate
 * is the decision that precedes it.
 *
 * Losing the account entirely (disconnect mid-run) IS a departure: the plan's calldata
 * embeds `onBehalfOf` for the pinned address, so nothing further may be signed.
 */
export function walletDeparted(
  pinned: WalletSession,
  next: { readonly address: Address; readonly chainId: number } | null,
): boolean {
  if (next === null) return true;
  if (next.chainId !== pinned.chainId) return true;
  return getAddress(next.address) !== getAddress(pinned.address);
}
