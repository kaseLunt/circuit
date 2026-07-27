/**
 * The sandbox execute path — SPEC §6's "server builds everything" contract as code
 * (P3 treatment §5.2). The client never sends calldata, addresses, or amounts: `plan`
 * takes the share-codec document token through the SAME two-gate pipeline SPEC §5.6
 * fixed (zod shape, then `validateGraph` inside `buildPlan`), captures the session
 * fork's snapshot with the session actor, and records the server's OWN `planHash`;
 * `executeStep` takes `(sessionKey, planHash, stepIndex)` and nothing else — that
 * natural key is also what makes it idempotent under retry (A4).
 *
 * Every amount resolution, encode, and measurement goes through
 * `src/lib/execution/attribution.ts` — the module the fork gate proves by identity.
 * A parallel resolver here would be treatment §10.10, a blocking finding; this module
 * only ORCHESTRATES: sequence, gates, tolerance comparison, and the session record.
 *
 * Dispatch discipline (Codex round 1, findings 1/2): planning holds the same session
 * mutex as execution, so a plan can never replace the one an in-flight step belongs to;
 * and every step records a DISPATCH INTENT (pre-nonce, retained beforeShares, hash once
 * known) and charges the tx budget BEFORE the transaction leaves — so a lost response,
 * a failed poll, or a receipt timeout classifies as `reconcile-required`, never as
 * "nothing happened". Retries then RESUME discovery against the fork's own history
 * (receipt by hash, or nonce comparison when even the hash was lost) and never send.
 * All of that classification lives HERE, in covered pure orchestration — the fork layer
 * stays thin I/O (Codex coverage ruling).
 *
 * Refusal kinds are a closed set, each renderable by the tx-UX grammar (T-series):
 * mechanical refusals (capacity, busy, expiry, rate, cap, out-of-order, plan-changed)
 * take T27's designed-stop card; `halted` takes the T17/T18 achromatic stop with its
 * evidence pair; `failed` takes T21's decoded-revert card. The server never emits a
 * state the UX grammar cannot render.
 */
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import {
  buildPlan,
  type AmountSpec,
  type CallArg,
  type ChainSnapshot,
  type PlanError,
  type PlanSuccess,
  type TransactionStep,
} from "../../core/plan";
import type { StrategyGraph } from "../../core/graph";
import { riskLedger } from "../../core/risk";
import { decodeRevert } from "../../core/errors";
import { valueOf } from "../../core/provenance";
import { HF_NO_DEBT } from "../../core/health-factor";
import {
  encodeResolvedStep,
  measureShareDelta,
  outputTokenOf,
  producesShareDelta,
  receiptMinter,
  resolveStepAmount,
  transferValueTo,
  type AttributionContext,
  type AttributionReads,
  type ConfirmedReceipt,
  type ExecutedStepRecord,
  type RawReceipt,
  type ShareDeltaMeasurement,
} from "../../lib/execution/attribution";
import {
  SANDBOX_HF_REL_POW,
  SANDBOX_OUTPUT_TOLERANCE,
  relWithin,
  toleranceWeiFor,
  withinOutputTolerance,
} from "../../lib/execution/tolerance";
import { decodeShareGraph, type DecodeFailure } from "../../lib/share/encode";
import {
  receiptFactsViewOf,
  type ApprovalFacts,
  type AttributedStepResult,
  type ConsumedApprovalFacts,
  type DispatchIntent,
  type FailureEvidence,
  type HaltEvidence,
  type HaltedStepResult,
  type OutputAttribution,
  type OutputMechanism,
  type ReceiptFactsView,
  type RecordedPlan,
  type RiskExpectation,
  type RiskReading,
  type Session,
  type SessionFork,
  type SessionRegistry,
  type SessionTombstone,
  type SettledStepResult,
  type StepEntry,
} from "./session-registry";

/** Thrown by a `SandboxChain` when a step's transaction mined with status 0. */
export class SandboxTxRevertedError extends Error {
  constructor(readonly txHash: Hex) {
    super(`transaction reverted: ${txHash}`);
  }
}

export interface SandboxRawReceipt extends RawReceipt {
  readonly gasUsed?: bigint;
}

/**
 * The chain surface the execute path needs, bound to ONE session's fork RPC — never a
 * wallet's injected provider (A1). Implemented by `fork-session.ts`; faked in unit tests.
 * Every method takes its contract address explicitly, and every address it is ever called
 * with comes off the session's captured snapshot — nothing here is hand-typed.
 *
 * Dispatch and confirmation are SEPARATE calls (finding 2): the engine must know the
 * hash the moment it exists, because a confirmation failure after dispatch is a
 * recovery problem, not a retry license.
 */
export interface SandboxChain {
  /** Submit; resolves to the tx hash. A throw here means the RESPONSE was lost — the
   *  transaction may or may not have been accepted (ambiguous by construction). */
  dispatchTransaction(tx: {
    readonly from: Address;
    readonly to: Address;
    readonly data: Hex;
    readonly value: bigint;
  }): Promise<Hex>;
  /** Poll to a mined receipt. Throws `SandboxTxRevertedError` on status 0; any other
   *  throw is a transport failure with the transaction already in flight. */
  confirmTransaction(txHash: Hex): Promise<SandboxRawReceipt>;
  /** Replay a mined-but-reverted tx to surface its revert data; null when replay succeeds. */
  revertDataOf(txHash: Hex): Promise<string | null>;
  /** Full receipt lookup for reconciliation — verification against the fork's history. */
  receiptOf(txHash: Hex): Promise<SandboxRawReceipt | null>;
  /** Current actor nonce — the discovery pin for lost-response reconciliation. */
  actorNonce(actor: Address): Promise<bigint>;
  /** Find the hash of the actor's transaction at a given nonce, if one landed. */
  transactionByNonce(actor: Address, nonce: bigint): Promise<Hex | null>;
  sharesOf(eeth: Address, actor: Address): Promise<bigint>;
  amountForShare(liquidityPool: Address, shares: bigint): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  healthFactorOf(pool: Address, actor: Address): Promise<bigint>;
}

export type SandboxRefusal =
  | { readonly kind: "unknown-session" }
  | {
      readonly kind: "session-expired";
      readonly executedSteps: number;
      readonly tombstone: SessionTombstone;
    }
  | { readonly kind: "session-busy" }
  | { readonly kind: "rate-limited"; readonly retryAfterMs: number }
  | { readonly kind: "tx-cap" }
  | { readonly kind: "at-capacity" }
  | { readonly kind: "no-plan" }
  | { readonly kind: "plan-changed" }
  | { readonly kind: "plan-complete" }
  | { readonly kind: "out-of-order"; readonly expectedIndex: number }
  | { readonly kind: "session-dirty" }
  | { readonly kind: "reconcile-required" }
  | { readonly kind: "nothing-to-reconcile" }
  | { readonly kind: "reconcile-mismatch"; readonly detail: string }
  | { readonly kind: "reset-failed" }
  | { readonly kind: "halted"; readonly halt: HaltEvidence }
  | { readonly kind: "failed"; readonly failure: FailureEvidence }
  | { readonly kind: "document-refused"; readonly failure: DecodeFailure }
  | { readonly kind: "plan-refused"; readonly errors: readonly PlanError[] };

export type ExecuteStepResult =
  | SettledStepResult
  | { readonly status: "failed"; readonly failure: FailureEvidence }
  | {
      readonly status: "attribution-unavailable";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: ReceiptFactsView;
      readonly beforeShares: bigint | null;
    }
  | {
      readonly status: "persistence-failed";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: ReceiptFactsView;
      readonly measurement: ShareDeltaMeasurement;
    }
  | {
      /** Post-dispatch transport failure: outcome unknown until reconciled (finding 2). */
      readonly status: "dispatch-unresolved";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly txHash: Hex | null;
    }
  | {
      /** Reconciliation proved the dispatch never landed; the step may be re-dispatched. */
      readonly status: "dispatch-vacated";
      readonly stepIndex: number;
      readonly stepId: string;
    };

export type ExecuteOutcome =
  | { readonly ok: true; readonly result: ExecuteStepResult }
  | { readonly ok: false; readonly refusal: SandboxRefusal };

export type PlanOutcome =
  | { readonly ok: true; readonly planHash: Hex; readonly plan: PlanSuccess }
  | { readonly ok: false; readonly refusal: SandboxRefusal };

/**
 * The composed session service a transport (the tRPC router) runs against: the registry
 * plus the three fork-bound capabilities. Production wiring lives in `fork-session.ts`
 * (`sandboxServiceFromEnv`); tests compose fakes.
 */
export interface SandboxService {
  readonly store: SessionRegistry;
  readonly spawnFork: () => Promise<SessionFork>;
  readonly chainFor: (session: Session) => SandboxChain;
  readonly captureSnapshot: (session: Session) => Promise<ChainSnapshot>;
}

/** ASCII unit/record separators: cannot occur in ids, symbols, or decimal figures. */
const HASH_FIELD = "\u001f";
const HASH_ROW = "\u001e";

function serializeArg(arg: CallArg): string {
  if (arg.kind === "amount") return "amount";
  return `value:${typeof arg.value}:${String(arg.value)}`;
}

function serializeAmountSpec(spec: AmountSpec): string {
  switch (spec.kind) {
    case "literal":
      return `literal:${spec.amount.value.toString()}`;
    case "derived":
      return `derived:${spec.amount.value.toString()}`;
    case "step-output":
      return `step-output:${spec.producerStepId}:${spec.attribution}:${spec.allocationBps}`;
    case "none":
      return "none";
  }
}

/**
 * keccak over an EXPLICIT field walk of the ordered steps (§2.4) — to, functionName,
 * args, valueSpec, amount spec — not `JSON.stringify` of the step objects, whose key
 * order is an accident of construction. The server computes this from its OWN rebuild;
 * the client presents it on every step call; mismatch is the designed "plan changed"
 * state. Step SAMENESS inside a plan stays reference identity (D4) — this hash names a
 * frozen plan for reconciliation, it never decides which step is which.
 */
export function planHashOf(steps: readonly TransactionStep[]): Hex {
  const rows = steps.map((step) =>
    [
      step.id,
      String(step.index),
      step.blockId,
      step.to,
      step.functionName,
      step.valueSpec,
      step.args.map(serializeArg).join(","),
      serializeAmountSpec(step.amount),
    ].join(HASH_FIELD),
  );
  return keccak256(stringToBytes(rows.join(HASH_ROW)));
}

/**
 * Which steps are PRODUCERS whose attributed output gates the plan's suffix — exactly
 * the SPEC §5.5 whitelist, keyed the way `buildPlan` emits steps (`producesShareDelta`'s
 * reasoning: stake blocks alone emit `deposit`; wrap/borrow outputs arrive as Transfer
 * logs; a withdraw's output is its own argument). Approve/supply/set-emode steps produce
 * no consumable output and get no comparison — there is no honest mechanism to measure
 * one with, and inventing a fourth is treatment §10.2.
 */
export function producerMechanismOf(step: TransactionStep): OutputMechanism | null {
  switch (step.functionName) {
    case "deposit":
      return "share-delta";
    case "wrap":
    case "borrow":
      return "transfer-event";
    case "withdraw":
      return "withdraw-argument";
    default:
      return null;
  }
}

/** stepId → the block's own `flows.outputWei` — a recording off the plan, never recomputed. */
export function predictedOutputsOf(plan: PlanSuccess): ReadonlyMap<string, bigint> {
  const flowByBlock = new Map(plan.flows.map((flow) => [flow.blockId, flow]));
  const predicted = new Map<string, bigint>();
  for (const step of plan.steps) {
    if (producerMechanismOf(step) === null) continue;
    const flow = flowByBlock.get(step.blockId);
    if (flow === undefined || flow.outputWei === null) continue;
    predicted.set(step.id, valueOf(flow.outputWei));
  }
  return predicted;
}

/** stepId → the riskLedger checkpoint the §5.4 per-step cross-check compares against. */
export function riskExpectationsOf(
  graph: StrategyGraph,
  snapshot: ChainSnapshot,
): ReadonlyMap<string, RiskExpectation> {
  const expectations = new Map<string, RiskExpectation>();
  const ledger = riskLedger(graph, snapshot);
  if (!ledger.ok) return expectations;
  for (const checkpoint of ledger.checkpoints) {
    const stepId = `${checkpoint.blockId}:${checkpoint.cause}`;
    const hf = checkpoint.healthFactor;
    expectations.set(
      stepId,
      hf.status === "healthy"
        ? { status: "healthy", hfWad: hf.hfWad }
        : hf.status === "no-debt"
          ? { status: "no-debt" }
          : { status: "unknown", reason: hf.reason },
    );
  }
  return expectations;
}

export interface PlanDeps {
  /** Snapshot captured FROM the session's fork with the session actor (§5.3 invariant). */
  captureSnapshot(session: Session): Promise<ChainSnapshot>;
}

function phaseRefusal(session: Session): SandboxRefusal | null {
  switch (session.phase.kind) {
    case "active":
    case "attribution-pending":
      return null;
    case "reconcile-required":
      return { kind: "reconcile-required" };
    case "halted":
      return { kind: "halted", halt: session.phase.halt };
    case "failed":
      return { kind: "failed", failure: session.phase.failure };
  }
}

/**
 * Plan under the session mutex (finding 1): while a step is in flight — including the
 * window where its entry has not yet been appended — a concurrent plan call is refused
 * busy, so `session.plan` can never be replaced under an in-flight execution. The
 * generation check is the belt on top: a capture that somehow spanned a reset records
 * nothing.
 */
export async function planForSession(
  store: SessionRegistry,
  deps: PlanDeps,
  sessionKey: string,
  document: string,
): Promise<PlanOutcome> {
  const looked = await store.lookup(sessionKey);
  if (!looked.ok) return { ok: false, refusal: looked.refusal };
  const session = looked.session;
  const begun = store.beginExclusive(session);
  if (!begun.ok) return { ok: false, refusal: begun.refusal };
  try {
    const generation = session.generation;
    const blocked = phaseRefusal(session);
    if (blocked !== null) return { ok: false, refusal: blocked };
    // A plan's simulation base must BE the fork's current state. Once a step has executed
    // the fork has moved past the pinned base, so re-planning is refused until a reset
    // restores the base — otherwise the "simulated at block {n}" claim would be false.
    if (session.entries.length > 0) return { ok: false, refusal: { kind: "session-dirty" } };
    if (session.phase.kind !== "active") return { ok: false, refusal: { kind: "session-dirty" } };
    const decoded = decodeShareGraph(document);
    if (!decoded.ok) {
      return { ok: false, refusal: { kind: "document-refused", failure: decoded.failure } };
    }
    const snapshot = await deps.captureSnapshot(session);
    const built = buildPlan(decoded.graph, snapshot);
    if (!built.ok) return { ok: false, refusal: { kind: "plan-refused", errors: built.errors } };
    const recorded: RecordedPlan = {
      plan: built,
      snapshot,
      planHash: planHashOf(built.steps),
      predictedOutputs: predictedOutputsOf(built),
      risk: riskExpectationsOf(decoded.graph, snapshot),
    };
    store.recordPlan(session, recorded, generation);
    return { ok: true, planHash: recorded.planHash, plan: built };
  } finally {
    store.endExecution(session);
  }
}

/** Insertion order is execution order — `resolveStepAmount`'s reuse scan relies on it. */
function executedRecordsOf(session: Session): ReadonlyMap<string, ExecutedStepRecord> {
  const records = new Map<string, ExecutedStepRecord>();
  for (const entry of session.entries) {
    if (entry.settled === null) continue;
    records.set(entry.stepId, {
      step: entry.step,
      receipt: entry.receipt,
      resolvedAmount: entry.resolvedAmount,
      sharesDelta: entry.sharesDelta,
    });
  }
  return records;
}

function spenderOf(step: TransactionStep): Address {
  const arg = step.args[0];
  if (arg !== undefined && arg.kind === "value" && typeof arg.value === "string") {
    return getAddress(arg.value);
  }
  throw new Error(`approve step ${step.id} has no spender argument`);
}

/**
 * The consuming member of an approve pair, by REFERENCE identity on the shared amount
 * spec — `buildPlan` hands one object to both members, so `===` IS the pair relation and
 * field comparison would fuse equal-split fan-outs (doctrine D4).
 */
function approvePairOf(plan: PlanSuccess, consumer: TransactionStep): TransactionStep | null {
  if (consumer.functionName === "approve") return null;
  for (const step of plan.steps) {
    if (step.functionName === "approve" && step.amount === consumer.amount) return step;
  }
  return null;
}

/**
 * Everything that happens to a step AFTER its transaction is confirmed and its record
 * appended: output attribution against the plan's own prediction (§6.2), the §3.3
 * zero-after-consume check, and the §6.3 per-step HF cross-check. Shared by the normal
 * path, attribution re-entry, and both reconciliation branches, so every road arrives
 * at settlement through one door.
 *
 * A halt settles the ENTRY (the transaction is a fact and its record is immutable) and
 * flips the SESSION: nothing further dispatches, prediction never overwrites attribution,
 * and there is no automatic way out (A12).
 */
async function settleConfirmedStep(
  store: SessionRegistry,
  chain: SandboxChain,
  session: Session,
  plan: RecordedPlan,
  entry: StepEntry,
): Promise<SettledStepResult> {
  const step = entry.step;
  const receipt = receiptFactsViewOf(entry.receipt);

  const haltWith = (halt: HaltEvidence): HaltedStepResult => {
    const settled: HaltedStepResult = {
      status: "halted",
      stepIndex: entry.stepIndex,
      stepId: entry.stepId,
      receipt,
      resolvedAmountWei: entry.resolvedAmount,
      sharesDelta: entry.sharesDelta,
      halt,
    };
    store.completeStep(session, entry.stepIndex, entry.sharesDelta, settled);
    store.markHalted(session, halt);
    return settled;
  };

  let output: OutputAttribution | null = null;
  const mechanism = producerMechanismOf(step);
  if (mechanism !== null) {
    const predicted = plan.predictedOutputs.get(step.id);
    if (predicted === undefined) {
      throw new Error(`producer step ${step.id} has no predicted flow output`);
    }
    const toleranceWei = toleranceWeiFor(predicted, SANDBOX_OUTPUT_TOLERANCE);
    let attributed: bigint | null = null;
    let detail: string | null = null;
    if (mechanism === "share-delta") {
      if (entry.sharesDelta === null) throw new Error(`step ${step.id} has no share delta`);
      attributed = await chain.amountForShare(plan.snapshot.etherfi.liquidityPool, entry.sharesDelta);
    } else if (mechanism === "transfer-event") {
      try {
        attributed = transferValueTo(entry.receipt, outputTokenOf(step), session.actor);
      } catch (cause) {
        // Zero matches THROWS in the module; the engine converts that into the divergence
        // state — a silent 0n would flow into the next step's calldata as a real amount (A9).
        detail = cause instanceof Error ? cause.message : String(cause);
      }
    } else {
      if (entry.resolvedAmount === null) throw new Error(`step ${step.id} has no resolved amount`);
      attributed = entry.resolvedAmount;
    }
    if (attributed === null || !withinOutputTolerance(predicted, attributed, SANDBOX_OUTPUT_TOLERANCE)) {
      return haltWith({
        kind: "output-divergence",
        stepIndex: entry.stepIndex,
        stepId: entry.stepId,
        mechanism,
        predictedWei: predicted,
        attributedWei: attributed,
        toleranceWei,
        detail,
        receipt,
      });
    }
    output = { mechanism, predictedWei: predicted, attributedWei: attributed, toleranceWei };
  }

  let consumedApproval: ConsumedApprovalFacts | null = null;
  const pairedApprove = approvePairOf(plan.plan, step);
  if (pairedApprove !== null) {
    const spender = spenderOf(pairedApprove);
    const residualAllowanceWei = await chain.allowance(pairedApprove.to, session.actor, spender);
    consumedApproval = { spender, residualAllowanceWei };
    if (residualAllowanceWei !== 0n) {
      return haltWith({
        kind: "residual-allowance",
        stepIndex: entry.stepIndex,
        stepId: entry.stepId,
        spender,
        residualAllowanceWei,
        receipt,
      });
    }
  }

  let risk: RiskReading | null = null;
  if (step.functionName === "supply" || step.functionName === "borrow") {
    const expected = plan.risk.get(step.id);
    const chainHfWad = await chain.healthFactorOf(plan.snapshot.pool, session.actor);
    if (expected !== undefined) {
      risk = { expected, chainHfWad };
      const agree =
        expected.status === "no-debt"
          ? chainHfWad === HF_NO_DEBT
          : expected.status === "healthy"
            ? relWithin(expected.hfWad, chainHfWad, SANDBOX_HF_REL_POW)
            : // An unknown prediction has nothing to disagree with; the chain reading is
              // recorded and rendered as such — never silently picked (SPEC §5.4).
              true;
      if (!agree) {
        return haltWith({
          kind: "hf-disagreement",
          stepIndex: entry.stepIndex,
          stepId: entry.stepId,
          expected,
          chainHfWad,
          receipt,
        });
      }
    }
  }

  const settled: AttributedStepResult = {
    status: "attributed",
    stepIndex: entry.stepIndex,
    stepId: entry.stepId,
    receipt,
    resolvedAmountWei: entry.resolvedAmount,
    sharesDelta: entry.sharesDelta,
    output,
    approval: entry.approval,
    consumedApproval,
    risk,
  };
  store.completeStep(session, entry.stepIndex, entry.sharesDelta, settled);
  return settled;
}

/**
 * Settle, converting a failed read into the re-enterable pending state instead of losing
 * the confirmed record: the receipt and measurement are already persisted on the entry,
 * so the next call for this index re-enters attributing(k) (doctrine D3 — a failure
 * branch never discards data that only exists in that moment).
 */
async function trySettle(
  store: SessionRegistry,
  chain: SandboxChain,
  session: Session,
  plan: RecordedPlan,
  entry: StepEntry,
): Promise<ExecuteStepResult> {
  try {
    return await settleConfirmedStep(store, chain, session, plan, entry);
  } catch {
    store.markAttributionPending(session, entry.stepIndex, entry.beforeShares);
    return {
      status: "attribution-unavailable",
      stepIndex: entry.stepIndex,
      stepId: entry.stepId,
      receipt: receiptFactsViewOf(entry.receipt),
      beforeShares: entry.beforeShares,
    };
  }
}

/** D3 recovery for `attribution-unavailable`: re-read and difference against the
 *  retained beforeShares — never a re-send. */
async function resumeAttribution(
  store: SessionRegistry,
  chain: SandboxChain,
  session: Session,
  plan: RecordedPlan,
  stepIndex: number,
): Promise<ExecuteOutcome> {
  const entry = session.entries[stepIndex];
  if (entry === undefined) {
    throw new Error(`attribution-pending session has no entry at index ${stepIndex}`);
  }
  if (producesShareDelta(entry.step) && entry.sharesDelta === null) {
    if (entry.beforeShares === null) {
      throw new Error(`step ${entry.stepId}: pending attribution lost its before-shares reading`);
    }
    const after = await chain.sharesOf(plan.snapshot.etherfi.eETH, session.actor);
    store.recordMeasurement(session, stepIndex, after - entry.beforeShares);
  }
  return { ok: true, result: await trySettle(store, chain, session, plan, entry) };
}

export async function executeSandboxStep(
  store: SessionRegistry,
  chainFor: (session: Session) => SandboxChain,
  sessionKey: string,
  planHash: Hex,
  stepIndex: number,
): Promise<ExecuteOutcome> {
  const looked = await store.lookup(sessionKey);
  if (!looked.ok) return { ok: false, refusal: looked.refusal };
  const session = looked.session;
  const plan = session.plan;
  if (plan === null) return { ok: false, refusal: { kind: "no-plan" } };
  if (plan.planHash !== planHash) return { ok: false, refusal: { kind: "plan-changed" } };

  // Idempotency before any gate (A4): a repeated call for an already-settled index
  // returns the recorded result and never re-executes, whatever state the session has
  // since entered — a client retrying a timed-out call must not be told "halted".
  const existing = session.entries[stepIndex];
  if (existing !== undefined && existing.settled !== null) {
    return { ok: true, result: existing.settled };
  }

  const chain = chainFor(session);

  if (session.phase.kind === "attribution-pending") {
    if (stepIndex !== session.phase.stepIndex) {
      return { ok: false, refusal: { kind: "out-of-order", expectedIndex: session.phase.stepIndex } };
    }
    const begun = store.beginExclusive(session);
    if (!begun.ok) return { ok: false, refusal: begun.refusal };
    try {
      return await resumeAttribution(store, chain, session, plan, stepIndex);
    } finally {
      store.endExecution(session);
    }
  }

  const blocked = phaseRefusal(session);
  if (blocked !== null) return { ok: false, refusal: blocked };

  if (session.entries.length >= plan.plan.steps.length) {
    return { ok: false, refusal: { kind: "plan-complete" } };
  }
  if (stepIndex !== session.entries.length) {
    return { ok: false, refusal: { kind: "out-of-order", expectedIndex: session.entries.length } };
  }
  const step = plan.plan.steps[stepIndex];
  if (step === undefined) {
    return { ok: false, refusal: { kind: "out-of-order", expectedIndex: session.entries.length } };
  }

  const begun = store.beginExecution(session);
  if (!begun.ok) return { ok: false, refusal: begun.refusal };
  try {
    // The before-read is measureShareDelta's — the read/send/read ordering has ONE home
    // (§10.10) — but the dispatch intent needs the reading too, so the reads surface is
    // wrapped to capture the first sharesOf value this step observes (D3: moment-bound).
    let observedBeforeShares: bigint | null = null;
    const reads: AttributionReads = {
      sharesOf: async (who) => {
        const value = await chain.sharesOf(plan.snapshot.etherfi.eETH, who);
        if (observedBeforeShares === null) observedBeforeShares = value;
        return value;
      },
      amountForShare: (shares) => chain.amountForShare(plan.snapshot.etherfi.liquidityPool, shares),
    };
    const context: AttributionContext = { actor: session.actor, reads };
    const resolved = await resolveStepAmount(step, executedRecordsOf(session), context);

    // §3.1: allowance is READ before it is assumed. Expected 0 for a fresh session actor —
    // but expected is not observed, and the read→write→verify structure is the deliverable.
    let approval: ApprovalFacts | null = null;
    if (step.functionName === "approve") {
      if (resolved === null) throw new Error(`approve step ${step.id} resolved no amount`);
      const spender = spenderOf(step);
      const priorAllowanceWei = await chain.allowance(step.to, session.actor, spender);
      approval = { spender, priorAllowanceWei, approvedWei: resolved };
    }

    const encoded = encodeResolvedStep(step, resolved);
    const minter = receiptMinter(session.fork.rpcUrl);
    let outcome;
    try {
      outcome = await measureShareDelta(
        step,
        context,
        async () => {
          // Finding 2: the intent is persisted and the budget charged BEFORE dispatch.
          // From this point on, "nothing happened" is not an assumption the engine may
          // make — every failure below classifies as reconcile-required, never retry.
          const preNonce = await chain.actorNonce(session.actor);
          store.recordDispatchIntent(session, {
            stepIndex,
            step,
            resolvedAmount: resolved,
            approval,
            beforeShares: observedBeforeShares,
            preNonce,
            txHash: null,
          });
          store.noteTransaction(session);
          const txHash = await chain.dispatchTransaction({
            from: session.actor,
            to: encoded.to,
            data: encoded.data,
            value: encoded.value,
          });
          store.noteDispatchHash(session, txHash);
          const raw = await chain.confirmTransaction(txHash);
          return minter.confirm(raw);
        },
        (receipt) => {
          store.appendConfirmed(session, {
            stepIndex,
            stepId: step.id,
            step,
            receipt,
            resolvedAmount: resolved,
            approval,
          });
        },
      );
    } catch (cause) {
      if (cause instanceof SandboxTxRevertedError) {
        // A mined revert is a definitive outcome: the session transitions to the
        // non-dispatchable failed state BEFORE any further await (Codex round-2
        // finding 2) — the diagnostic replay is best-effort ENRICHMENT of an already
        // recorded failure. Raw bytes absent is acceptable; a second send is not.
        store.clearDispatchIntent(session);
        let failure: FailureEvidence = {
          stepIndex,
          stepId: step.id,
          txHash: cause.txHash,
          decoded: null,
          raw: null,
        };
        store.markFailed(session, failure);
        try {
          const raw = await chain.revertDataOf(cause.txHash);
          const decoded = raw !== null && raw.startsWith("0x") ? decodeRevert(raw) : null;
          failure = { ...failure, decoded, raw };
          store.markFailed(session, failure);
        } catch {
          // The failure stands as recorded; only its human-readable enrichment is lost.
        }
        return { ok: true, result: { status: "failed", failure } };
      }
      if (session.pendingDispatch !== null) {
        // Post-dispatch transport failure (finding 2): response lost, poll failed, or
        // receipt timed out. The intent becomes the reconcile-required pending; recovery
        // resumes discovery against the fork — it never sends.
        const intent = store.markDispatchUnresolved(session, cause);
        return {
          ok: true,
          result: {
            status: "dispatch-unresolved",
            stepIndex,
            stepId: step.id,
            txHash: intent.txHash,
          },
        };
      }
      // Nothing was dispatched (a read failed before the intent was recorded): a true
      // infrastructure error, not a state the machine can classify.
      throw cause;
    }
    store.clearDispatchIntent(session);

    if (outcome.status === "persistence-failed") {
      // D3: the session may not dispatch, retry, or redispatch until the registry is
      // reconciled against the fork's history — a redispatch on top of an unrecorded
      // confirmed transaction is the double-send. Receipt and measurement both survive.
      store.markReconcileRequired(session, {
        kind: "persistence",
        stepIndex,
        step,
        receipt: outcome.receipt,
        resolvedAmount: resolved,
        approval,
        measurement: outcome.measurement,
        cause: outcome.cause,
      });
      return {
        ok: true,
        result: {
          status: "persistence-failed",
          stepIndex,
          stepId: step.id,
          receipt: receiptFactsViewOf(outcome.receipt),
          measurement: outcome.measurement,
        },
      };
    }
    if (outcome.status === "attribution-unavailable") {
      store.markAttributionPending(session, stepIndex, outcome.beforeShares);
      return {
        ok: true,
        result: {
          status: "attribution-unavailable",
          stepIndex,
          stepId: step.id,
          receipt: receiptFactsViewOf(outcome.receipt),
          beforeShares: outcome.beforeShares,
        },
      };
    }

    const entry = session.entries[stepIndex];
    if (entry === undefined) throw new Error(`confirmed step ${step.id} has no appended entry`);
    store.recordMeasurement(session, stepIndex, outcome.sharesDelta);
    return { ok: true, result: await trySettle(store, chain, session, plan, entry) };
  } finally {
    store.endExecution(session);
  }
}

export type ReconcileOutcome =
  | { readonly ok: true; readonly result: ExecuteStepResult }
  | { readonly ok: false; readonly refusal: SandboxRefusal };

/** Measurement for an adopted dispatch: the retained beforeShares differenced against a
 *  fresh read (D3's recipe — the session fork is single-actor and serial, so no foreign
 *  transaction can move the balance between confirmation and this read). */
async function adoptedSharesDelta(
  chain: SandboxChain,
  plan: RecordedPlan,
  session: Session,
  intent: DispatchIntent,
): Promise<bigint | null> {
  if (!producesShareDelta(intent.step)) return null;
  if (intent.beforeShares === null) {
    throw new Error(`step ${intent.step.id}: dispatch intent lost its before-shares reading`);
  }
  const after = await chain.sharesOf(plan.snapshot.etherfi.eETH, session.actor);
  return after - intent.beforeShares;
}

/**
 * Reconcile a `reconcile-required` session against the fork's own transaction history
 * and NEVER re-send (§5.2 rev 3.1; finding 2).
 *
 * Persistence pending: the pinning facts are the retained receipt's block identity —
 * verified against `eth_getTransactionReceipt` on the session fork — and the
 * measurement's beforeShares, differenced against a fresh read when the post-send
 * reading was the failure.
 *
 * Dispatch pending: discovery, not assumption. With a hash, the fork's receipt decides:
 * present-and-successful → adopt and settle; present-and-reverted → the failed state;
 * absent with the nonce unchanged → the dispatch provably never landed and is vacated
 * (the step may be re-dispatched by a NEW executeStep call — this path itself never
 * sends). Without a hash, the pre-dispatch nonce is the pin: unchanged → vacated;
 * advanced → the transaction at that nonce is looked up and adopted.
 */
export async function reconcileSession(
  store: SessionRegistry,
  chainFor: (session: Session) => SandboxChain,
  sessionKey: string,
): Promise<ReconcileOutcome> {
  const looked = await store.lookup(sessionKey);
  if (!looked.ok) return { ok: false, refusal: looked.refusal };
  const session = looked.session;
  if (session.phase.kind !== "reconcile-required") {
    return { ok: false, refusal: { kind: "nothing-to-reconcile" } };
  }
  const plan = session.plan;
  if (plan === null) return { ok: false, refusal: { kind: "no-plan" } };
  const chain = chainFor(session);
  const begun = store.beginExclusive(session);
  if (!begun.ok) return { ok: false, refusal: begun.refusal };
  try {
    const pending = session.phase.pending;

    if (pending.kind === "persistence") {
      const facts = receiptFactsViewOf(pending.receipt);
      const onchain = await chain.receiptOf(facts.txHash);
      if (
        onchain === null ||
        onchain.status !== 1n ||
        onchain.blockNumber !== facts.blockNumber ||
        onchain.blockHash !== facts.blockHash
      ) {
        return {
          ok: false,
          refusal: {
            kind: "reconcile-mismatch",
            detail:
              onchain === null
                ? `fork has no receipt for ${facts.txHash}`
                : `fork receipt for ${facts.txHash} does not match the retained block identity`,
          },
        };
      }
      let sharesDelta: bigint | null;
      if (pending.measurement.status === "measured") {
        sharesDelta = pending.measurement.sharesDelta;
      } else {
        const after = await chain.sharesOf(plan.snapshot.etherfi.eETH, session.actor);
        sharesDelta = after - pending.measurement.beforeShares;
      }
      const entry = store.applyReconciliation(session, sharesDelta);
      return { ok: true, result: await trySettle(store, chain, session, plan, entry) };
    }

    // Dispatch pending: discover what actually happened.
    const intent = pending.intent;
    let txHash = intent.txHash;
    if (txHash === null) {
      const nonce = await chain.actorNonce(session.actor);
      if (nonce === intent.preNonce) {
        store.vacateDispatch(session);
        return {
          ok: true,
          result: { status: "dispatch-vacated", stepIndex: intent.stepIndex, stepId: intent.step.id },
        };
      }
      txHash = await chain.transactionByNonce(session.actor, intent.preNonce);
      if (txHash === null) {
        return {
          ok: false,
          refusal: {
            kind: "reconcile-mismatch",
            detail: `actor nonce advanced past ${intent.preNonce} but no transaction was found at it`,
          },
        };
      }
    }
    const raw = await chain.receiptOf(txHash);
    if (raw === null) {
      const nonce = await chain.actorNonce(session.actor);
      if (nonce === intent.preNonce) {
        store.vacateDispatch(session);
        return {
          ok: true,
          result: { status: "dispatch-vacated", stepIndex: intent.stepIndex, stepId: intent.step.id },
        };
      }
      return {
        ok: false,
        refusal: {
          kind: "reconcile-mismatch",
          detail: `fork has no receipt for dispatched ${txHash} yet the actor nonce moved`,
        },
      };
    }
    if (BigInt(raw.status) !== 1n) {
      // Same discipline as the direct revert path (round-2 finding 2): record the
      // non-dispatchable failure FIRST; the replay only enriches it, best-effort.
      let failure: FailureEvidence = {
        stepIndex: intent.stepIndex,
        stepId: intent.step.id,
        txHash,
        decoded: null,
        raw: null,
      };
      store.markFailed(session, failure);
      try {
        const revertData = await chain.revertDataOf(txHash);
        const decoded =
          revertData !== null && revertData.startsWith("0x") ? decodeRevert(revertData) : null;
        failure = { ...failure, decoded, raw: revertData };
        store.markFailed(session, failure);
      } catch {
        // The failure stands as recorded; only its enrichment is lost.
      }
      return { ok: true, result: { status: "failed", failure } };
    }
    const minter = receiptMinter(session.fork.rpcUrl);
    const receipt: ConfirmedReceipt = minter.confirm(raw);
    const sharesDelta = await adoptedSharesDelta(chain, plan, session, intent);
    const entry = store.adoptDispatchedStep(session, receipt, sharesDelta);
    return { ok: true, result: await trySettle(store, chain, session, plan, entry) };
  } finally {
    store.endExecution(session);
  }
}
