/**
 * Sandbox session registry — the server-side truth for SPEC §6's session contract
 * (P3 treatment §5.1/§5.2). Sessions are owned by possession of an unguessable bearer key,
 * TTL'd, per-session tx- and rate-limited, globally capped, and each holds exactly one
 * isolated fork. The registry is DELIBERATELY pure state: every fork operation arrives
 * through the injected `SessionFork` handle, so the whole lifecycle is unit-provable
 * without a process or a socket, and the fork suite proves the composed service.
 *
 * Concurrency discipline (Codex round 1, findings 1/3/4): ONE mutex serializes every
 * session-mutating operation — dispatch, planning, reconciliation, reset, destroy — so
 * no operation can observe or replace another's half-written state; capacity is RESERVED
 * atomically before a fork spawn is awaited; and TTL expiry never destroys a fork out
 * from under an in-flight operation — an expired-but-busy session refuses new callers
 * and is destroyed only after its operation releases the mutex.
 *
 * The registry is also the PERSISTENCE AXIS of doctrine D3 (treatment §6a): the execute
 * path wires `appendConfirmed` as `measureShareDelta`'s awaited on-confirmed hook, and
 * records a DISPATCH INTENT before any transaction leaves the building (finding 2), so
 * every post-dispatch transport failure lands in `reconcile-required` with the facts
 * recovery needs — receipt or tx hash, retained beforeShares, pre-dispatch nonce.
 * Failure gates dispatch; it never discards the receipt, the measurement, or the
 * intent. Expiry preserves the same evidence into the tombstone (finding 4): facts
 * survive their session (T24).
 */
import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import type { ChainSnapshot, PlanSuccess, TransactionStep } from "../../core/plan";
import type { DecodedRevert } from "../../core/errors";
import {
  confirmationOf,
  type ConfirmedReceipt,
  type ShareDeltaMeasurement,
} from "../../lib/execution/attribution";

/**
 * The narrow fork surface the registry owns the lifecycle of. Implemented by
 * `fork-session.ts` (a per-session anvil child process) and by test fakes.
 */
export interface SessionFork {
  readonly rpcUrl: string;
  readonly baseBlock: bigint;
  readonly baseBlockHash: Hex;
  /** The session actor at creation; `reset()` mints a fresh one. */
  readonly actor: Address;
  /**
   * Fresh fork at the pinned base, identity re-verified by the fork layer, new actor.
   * MUST be transactional at the fork layer: on any failure after the underlying
   * re-fork begins, the fork destroys itself and throws — a fork that cannot prove its
   * identity never serves (A7). The registry mirrors that by invalidating the session
   * (finding 6).
   */
  reset(): Promise<{ readonly actor: Address }>;
  destroy(): Promise<void>;
}

export type RiskExpectation =
  | { readonly status: "no-debt" }
  | { readonly status: "healthy"; readonly hfWad: bigint }
  | { readonly status: "unknown"; readonly reason: string };

export type OutputMechanism = "share-delta" | "transfer-event" | "withdraw-argument";

/**
 * What the server recorded at plan time — every figure the execute path later compares
 * against is a RECORDING off the plan's own objects (`flows`, `riskLedger`), never a
 * recomputation (treatment §0: no third derivation).
 */
export interface RecordedPlan {
  readonly plan: PlanSuccess;
  readonly snapshot: ChainSnapshot;
  readonly planHash: Hex;
  /** stepId → the block's `flows.outputWei` for producer steps. */
  readonly predictedOutputs: ReadonlyMap<string, bigint>;
  /** stepId → the riskLedger checkpoint the SPEC §5.4 per-step cross-check compares against. */
  readonly risk: ReadonlyMap<string, RiskExpectation>;
}

/** The chain-record facet a result exposes for display — never the transport facet. */
export interface ReceiptFactsView {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  /** Renders as gas "used", off the receipt only (SPEC §6); null when the fork omits it. */
  readonly gasUsed: bigint | null;
}

/** The one mapping from a minted receipt to its display facet, shared by the execute
 *  path, the session summary, and the tombstone. */
export function receiptFactsViewOf(receipt: ConfirmedReceipt): ReceiptFactsView {
  const mark = confirmationOf(receipt);
  const gasUsed = (receipt as { readonly gasUsed?: unknown }).gasUsed;
  return {
    txHash: mark.txHash,
    blockNumber: mark.blockNumber,
    blockHash: mark.blockHash,
    gasUsed: typeof gasUsed === "bigint" ? gasUsed : null,
  };
}

export interface OutputAttribution {
  readonly mechanism: OutputMechanism;
  readonly predictedWei: bigint;
  readonly attributedWei: bigint;
  readonly toleranceWei: bigint;
}

export interface ApprovalFacts {
  readonly spender: Address;
  /** Read before the approve was assumed zero (treatment §3.1: expected is not observed). */
  readonly priorAllowanceWei: bigint;
  readonly approvedWei: bigint;
}

export interface ConsumedApprovalFacts {
  readonly spender: Address;
  /** Must be zero after the consuming step (treatment §3.3); nonzero halts as a data error. */
  readonly residualAllowanceWei: bigint;
}

export interface RiskReading {
  readonly expected: RiskExpectation;
  readonly chainHfWad: bigint;
}

export interface AttributedStepResult {
  readonly status: "attributed";
  readonly stepIndex: number;
  readonly stepId: string;
  readonly receipt: ReceiptFactsView;
  readonly resolvedAmountWei: bigint | null;
  readonly sharesDelta: bigint | null;
  /** Present for producer steps: the §6.2 PREDICTED/ATTRIBUTED pair with its bound. */
  readonly output: OutputAttribution | null;
  readonly approval: ApprovalFacts | null;
  readonly consumedApproval: ConsumedApprovalFacts | null;
  readonly risk: RiskReading | null;
}

export type HaltEvidence =
  | {
      readonly kind: "output-divergence";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly mechanism: OutputMechanism;
      readonly predictedWei: bigint;
      /** Null when attribution itself refused (e.g. zero Transfer matches, A9). */
      readonly attributedWei: bigint | null;
      readonly toleranceWei: bigint;
      readonly detail: string | null;
      readonly receipt: ReceiptFactsView;
    }
  | {
      readonly kind: "hf-disagreement";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly expected: RiskExpectation;
      readonly chainHfWad: bigint;
      readonly receipt: ReceiptFactsView;
    }
  | {
      readonly kind: "residual-allowance";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly spender: Address;
      readonly residualAllowanceWei: bigint;
      readonly receipt: ReceiptFactsView;
    };

/**
 * A halted step's settled record. The transaction CONFIRMED — the receipt stays in the
 * record and the state renders both truths (tx-treatment T17) — but the machine refuses
 * to build anything further on a number it cannot vouch for (treatment §6.2).
 */
export interface HaltedStepResult {
  readonly status: "halted";
  readonly stepIndex: number;
  readonly stepId: string;
  readonly receipt: ReceiptFactsView;
  readonly resolvedAmountWei: bigint | null;
  readonly sharesDelta: bigint | null;
  readonly halt: HaltEvidence;
}

export type SettledStepResult = AttributedStepResult | HaltedStepResult;

export interface FailureEvidence {
  readonly stepIndex: number;
  readonly stepId: string;
  readonly txHash: Hex;
  readonly decoded: DecodedRevert | null;
  /** Raw revert bytes, surfaced alongside the human message (SPEC §6), never swallowed. */
  readonly raw: string | null;
}

/**
 * Everything known about a transaction BEFORE its confirmation is in hand, persisted at
 * submission (finding 2): once a dispatch is attempted the engine may no longer assume
 * "nothing happened" — the intent, the pre-dispatch nonce, the retained beforeShares,
 * and the hash once known are exactly what post-dispatch recovery needs.
 */
export interface DispatchIntent {
  readonly stepIndex: number;
  readonly step: TransactionStep;
  readonly resolvedAmount: bigint | null;
  readonly approval: ApprovalFacts | null;
  /** The pre-send share reading for share-producing steps; moment-bound (D3). */
  readonly beforeShares: bigint | null;
  /** Actor nonce read before dispatch — the discovery pin when the response is lost. */
  readonly preNonce: bigint;
  txHash: Hex | null;
}

/** A confirmed receipt whose registry append failed (D3's persistence axis). */
export interface PersistencePending {
  readonly kind: "persistence";
  readonly stepIndex: number;
  readonly step: TransactionStep;
  readonly receipt: ConfirmedReceipt;
  readonly resolvedAmount: bigint | null;
  readonly approval: ApprovalFacts | null;
  readonly measurement: ShareDeltaMeasurement;
  readonly cause: unknown;
}

/** A dispatch whose transport outcome is unknown (response lost, confirmation failed). */
export interface DispatchPending {
  readonly kind: "dispatch";
  readonly intent: DispatchIntent;
  readonly cause: unknown;
}

export type PendingReconciliation = PersistencePending | DispatchPending;

export type SessionPhase =
  | { readonly kind: "active" }
  /** Step confirmed and persisted, settlement incomplete; re-entry re-reads/differences
   *  against the retained facts (D3 recovery for `attribution-unavailable`). */
  | { readonly kind: "attribution-pending"; readonly stepIndex: number }
  | { readonly kind: "reconcile-required"; readonly pending: PendingReconciliation }
  | { readonly kind: "halted"; readonly halt: HaltEvidence }
  | { readonly kind: "failed"; readonly failure: FailureEvidence };

export interface StepEntry {
  readonly stepIndex: number;
  readonly stepId: string;
  readonly step: TransactionStep;
  readonly receipt: ConfirmedReceipt;
  readonly resolvedAmount: bigint | null;
  /** Pre-send allowance facts for approve steps, persisted with the record: the prior
   *  reading cannot be re-observed once the approve has landed (§3.1). */
  readonly approval: ApprovalFacts | null;
  sharesDelta: bigint | null;
  /** Retained while attribution is pending; cannot be re-observed after the fact (D3). */
  beforeShares: bigint | null;
  /** Null until settled; then the exact result an idempotent replay returns (A4). */
  settled: SettledStepResult | null;
}

export interface Session {
  readonly key: string;
  /** Wall-clock epoch stamps, for the WIRE ONLY (popover prose, T29/T24). Enforcement
   *  never reads them — see the monotonic track below (Codex round-5). */
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly fork: SessionFork;
  actor: Address;
  /** Bumped on reset/invalidation; a plan capture spanning a bump must not record (finding 1). */
  generation: number;
  phase: SessionPhase;
  plan: RecordedPlan | null;
  inFlight: boolean;
  txCount: number;
  /**
   * The MONOTONIC enforcement track (Codex round-5): TTL sweeping and the rate floor
   * read these and only these. A backward wall-clock correction would otherwise make
   * `at - lastExecuteAt` negative (execution refused with a rollback-inflated
   * retryAfterMs) and hold the expiry comparison false (abandoned sessions unsweepable,
   * every anvil slot occupied past TTL) — an availability failure with no await in it.
   */
  readonly expiresAtMono: number;
  lastExecuteAtMono: number | null;
  /** Transient submission record for the step currently in flight (finding 2). */
  pendingDispatch: DispatchIntent | null;
  readonly entries: StepEntry[];
}

export interface RegistryConfig {
  readonly maxSessions: number;
  readonly ttlMs: number;
  readonly maxTxPerSession: number;
  readonly minExecuteIntervalMs: number;
  /** Injectable WALL clock — display epoch stamps only, never enforcement. */
  readonly now?: () => number;
  /** Injectable MONOTONIC clock — all TTL/rate enforcement; test-only override. */
  readonly monotonicNow?: () => number;
}

/**
 * Global session cap. Each session is its own anvil child process holding a full fork
 * backend in memory; eight bounds the host's worst case while keeping the designed
 * "sandbox at capacity" state (SPEC §6) an honest rarity rather than a lie.
 */
export const SANDBOX_MAX_SESSIONS = 8;
/** SPEC §6: sessions are TTL'd. Stated as prose in the session popover, never a countdown (T29). */
export const SANDBOX_SESSION_TTL_MS = 15 * 60_000;
/**
 * Per-session transaction budget: the 13-step flagship plus reconciliation headroom and
 * one full re-run after a reset. A session that needs more is being scripted at, not used.
 */
export const SANDBOX_MAX_TX_PER_SESSION = 32;
/**
 * Per-session rate floor between execute dispatches. A step is a mined block plus
 * attribution reads; sub-250ms repeats are a retry storm, not a user.
 */
export const SANDBOX_MIN_EXECUTE_INTERVAL_MS = 250;

export const SANDBOX_REGISTRY_DEFAULTS: RegistryConfig = {
  maxSessions: SANDBOX_MAX_SESSIONS,
  ttlMs: SANDBOX_SESSION_TTL_MS,
  maxTxPerSession: SANDBOX_MAX_TX_PER_SESSION,
  minExecuteIntervalMs: SANDBOX_MIN_EXECUTE_INTERVAL_MS,
};

/** 32 CSPRNG bytes — double the treatment's ≥128-bit floor (§5.1), asserted at mint (A5). */
const SESSION_KEY_BYTES = 32;
export const SESSION_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Expired sessions kept (bounded) so a returning client gets T24's honest "abandoned" facts. */
const TOMBSTONE_LIMIT = 64;

/**
 * The receipt-backed evidence an interrupted step leaves behind. Carried by the session
 * summary (rehydration, finding 5) and by the expiry tombstone (finding 4): the facts a
 * recovery needs must survive both a reload and the session's own death.
 */
export type RecoveryEvidence =
  | {
      readonly kind: "attribution-pending";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: ReceiptFactsView;
      readonly resolvedAmountWei: bigint | null;
      readonly beforeShares: bigint | null;
      readonly sharesDelta: bigint | null;
    }
  | {
      readonly kind: "reconcile-persistence";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: ReceiptFactsView;
      readonly resolvedAmountWei: bigint | null;
      readonly measurement: ShareDeltaMeasurement;
    }
  | {
      readonly kind: "reconcile-dispatch";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly txHash: Hex | null;
      readonly beforeShares: bigint | null;
      readonly preNonce: bigint;
    };

/** What an expired session leaves behind — the immutable receipt-backed prefix plus any
 *  pending recovery evidence. Facts survive their session (T24). */
export interface SessionTombstone {
  readonly executedSteps: number;
  readonly executed: readonly SettledStepResult[];
  readonly recovery: RecoveryEvidence | null;
}

export type CreateOutcome =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly refusal: { readonly kind: "at-capacity" } };

export interface SessionExpiredRefusal {
  readonly kind: "session-expired";
  readonly executedSteps: number;
  readonly tombstone: SessionTombstone;
}

export type LookupOutcome =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly refusal: { readonly kind: "unknown-session" } }
  | { readonly ok: false; readonly refusal: SessionExpiredRefusal };

export type BeginOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly refusal:
        | { readonly kind: "session-busy" }
        | { readonly kind: "rate-limited"; readonly retryAfterMs: number }
        | { readonly kind: "tx-cap" };
    };

export type ResetOutcome = { readonly ok: true } | { readonly ok: false; readonly cause: unknown };

export interface SessionSummary {
  readonly baseBlock: bigint;
  readonly baseBlockHash: Hex;
  readonly actor: Address;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly phase: SessionPhase;
  readonly planHash: Hex | null;
  readonly planStepCount: number | null;
  readonly txCount: number;
  /** Every settled step in order — the client's reload/recovery story in one read (§5.2). */
  readonly executed: readonly SettledStepResult[];
  /** Receipt-backed evidence of an interrupted step, when one exists (finding 5). */
  readonly recovery: RecoveryEvidence | null;
}

export interface SessionRegistry {
  create(spawn: () => Promise<SessionFork>): Promise<CreateOutcome>;
  lookup(key: string): Promise<LookupOutcome>;
  sessionCount(): number;
  recordPlan(session: Session, recorded: RecordedPlan, expectedGeneration: number): void;
  beginExecution(session: Session): BeginOutcome;
  /** Busy-guard WITHOUT the dispatch budget gates, for every exclusive non-dispatch
   *  operation — planning, reconciliation, reset, destroy. Recovery and planning are
   *  not transactions, so the tx cap and rate floor must not be able to strand them. */
  beginExclusive(session: Session): BeginOutcome;
  endExecution(session: Session): void;
  noteTransaction(session: Session): void;
  recordDispatchIntent(session: Session, intent: DispatchIntent): void;
  noteDispatchHash(session: Session, txHash: Hex): void;
  clearDispatchIntent(session: Session): void;
  /** Post-dispatch transport failure: the intent becomes the reconcile-required pending. */
  markDispatchUnresolved(session: Session, cause: unknown): DispatchIntent;
  appendConfirmed(
    session: Session,
    entry: {
      readonly stepIndex: number;
      readonly stepId: string;
      readonly step: TransactionStep;
      readonly receipt: ConfirmedReceipt;
      readonly resolvedAmount: bigint | null;
      readonly approval: ApprovalFacts | null;
    },
  ): void;
  recordMeasurement(session: Session, stepIndex: number, sharesDelta: bigint | null): void;
  markAttributionPending(session: Session, stepIndex: number, beforeShares: bigint | null): void;
  completeStep(
    session: Session,
    stepIndex: number,
    sharesDelta: bigint | null,
    settled: SettledStepResult,
  ): void;
  markHalted(session: Session, halt: HaltEvidence): void;
  markFailed(session: Session, failure: FailureEvidence): void;
  markReconcileRequired(session: Session, pending: PersistencePending): void;
  /** Restore the record a failed append lost — reconciliation, never a re-send (D3). */
  applyReconciliation(session: Session, sharesDelta: bigint | null): StepEntry;
  /** Adopt a dispatch whose receipt was discovered from the fork's own history. */
  adoptDispatchedStep(
    session: Session,
    receipt: ConfirmedReceipt,
    sharesDelta: bigint | null,
  ): StepEntry;
  /** The dispatch provably never landed (nonce unchanged): clear it; the step may re-dispatch. */
  vacateDispatch(session: Session): void;
  /** Transactional (finding 6): on failure the session is invalidated and removed. */
  reset(session: Session): Promise<ResetOutcome>;
  destroy(session: Session): Promise<void>;
  summaryOf(session: Session): SessionSummary;
}

function mintSessionKey(): string {
  const bytes = randomBytes(SESSION_KEY_BYTES);
  if (bytes.length !== SESSION_KEY_BYTES) {
    throw new Error(`session key entropy: expected ${SESSION_KEY_BYTES} bytes, got ${bytes.length}`);
  }
  const key = bytes.toString("hex");
  if (!SESSION_KEY_PATTERN.test(key)) {
    throw new Error("session key entropy: minted key failed its own pattern");
  }
  return key;
}

function settledResultsOf(session: Session): SettledStepResult[] {
  const settled: SettledStepResult[] = [];
  for (const entry of session.entries) {
    if (entry.settled !== null) settled.push(entry.settled);
  }
  return settled;
}

/** The receipt-backed evidence of an interrupted step, if the session holds one. */
export function recoveryEvidenceOf(session: Session): RecoveryEvidence | null {
  if (session.phase.kind === "attribution-pending") {
    const entry = session.entries[session.phase.stepIndex];
    if (entry === undefined) return null;
    return {
      kind: "attribution-pending",
      stepIndex: entry.stepIndex,
      stepId: entry.stepId,
      receipt: receiptFactsViewOf(entry.receipt),
      resolvedAmountWei: entry.resolvedAmount,
      beforeShares: entry.beforeShares,
      sharesDelta: entry.sharesDelta,
    };
  }
  if (session.phase.kind === "reconcile-required") {
    const pending = session.phase.pending;
    if (pending.kind === "persistence") {
      return {
        kind: "reconcile-persistence",
        stepIndex: pending.stepIndex,
        stepId: pending.step.id,
        receipt: receiptFactsViewOf(pending.receipt),
        resolvedAmountWei: pending.resolvedAmount,
        measurement: pending.measurement,
      };
    }
    return {
      kind: "reconcile-dispatch",
      stepIndex: pending.intent.stepIndex,
      stepId: pending.intent.step.id,
      txHash: pending.intent.txHash,
      beforeShares: pending.intent.beforeShares,
      preNonce: pending.intent.preNonce,
    };
  }
  return null;
}

function tombstoneOf(session: Session): SessionTombstone {
  const executed = settledResultsOf(session);
  return {
    executedSteps: executed.length,
    executed,
    recovery: recoveryEvidenceOf(session),
  };
}

export function createSessionRegistry(
  config: RegistryConfig = SANDBOX_REGISTRY_DEFAULTS,
): SessionRegistry {
  // Two clocks, deliberately (Codex round-5): the wall clock mints the epoch stamps the
  // wire displays; the MONOTONIC clock makes every enforcement decision. A backward
  // host-clock correction can therefore neither inflate a rate-limit window nor hold
  // expired sessions unsweepable with all the anvil slots occupied.
  const wallNow = config.now ?? Date.now;
  const monoNow = config.monotonicNow ?? (() => performance.now());
  const sessions = new Map<string, Session>();
  /** key → what the session left behind at expiry, for the T24 discovery read. */
  const tombstones = new Map<string, SessionTombstone>();
  /** Capacity reserved for spawns that have not yet resolved (finding 3). */
  let pendingSpawns = 0;

  function entomb(session: Session): void {
    tombstones.set(session.key, tombstoneOf(session));
    if (tombstones.size > TOMBSTONE_LIMIT) {
      const oldest = tombstones.keys().next().value;
      if (oldest !== undefined) tombstones.delete(oldest);
    }
  }

  function isExpired(session: Session): boolean {
    // Enforcement reads the monotonic track ONLY (round-5): the wall-clock
    // `expiresAtMs` twin exists for display and never decides anything.
    return session.expiresAtMono <= monoNow();
  }

  /**
   * Destroy expired sessions — but NEVER one holding the mutex (finding 4): killing a
   * fork mid-send would orphan a live transaction and its evidence. A busy expired
   * session stays in the map (refusing new callers via the expiry check in `lookup`)
   * until its operation releases; the next sweep collects it.
   */
  async function sweepExpired(): Promise<void> {
    for (const session of [...sessions.values()]) {
      if (isExpired(session) && !session.inFlight) {
        sessions.delete(session.key);
        session.generation += 1;
        entomb(session);
        await session.fork.destroy();
      }
    }
  }

  return {
    async create(spawn) {
      await sweepExpired();
      // Capacity is RESERVED before the spawn is awaited (finding 3): concurrent creates
      // each take a slot synchronously or refuse — none can observe a stale count. And it
      // is still checked before paying for the process at all.
      if (sessions.size + pendingSpawns >= config.maxSessions) {
        return { ok: false, refusal: { kind: "at-capacity" } };
      }
      pendingSpawns += 1;
      let fork: SessionFork;
      try {
        fork = await spawn();
      } finally {
        pendingSpawns -= 1;
      }
      const createdAtMs = wallNow();
      const session: Session = {
        key: mintSessionKey(),
        createdAtMs,
        expiresAtMs: createdAtMs + config.ttlMs,
        fork,
        actor: fork.actor,
        generation: 0,
        phase: { kind: "active" },
        plan: null,
        inFlight: false,
        txCount: 0,
        expiresAtMono: monoNow() + config.ttlMs,
        lastExecuteAtMono: null,
        pendingDispatch: null,
        entries: [],
      };
      sessions.set(session.key, session);
      return { ok: true, session };
    },

    async lookup(key) {
      await sweepExpired();
      const session = sessions.get(key);
      if (session !== undefined) {
        // Expired but still busy (sweep deferred, finding 4): refuse with the live
        // evidence rather than serving a session past its TTL.
        if (isExpired(session)) {
          const tombstone = tombstoneOf(session);
          return {
            ok: false,
            refusal: { kind: "session-expired", executedSteps: tombstone.executedSteps, tombstone },
          };
        }
        return { ok: true, session };
      }
      const tombstone = tombstones.get(key);
      if (tombstone !== undefined) {
        return {
          ok: false,
          refusal: { kind: "session-expired", executedSteps: tombstone.executedSteps, tombstone },
        };
      }
      return { ok: false, refusal: { kind: "unknown-session" } };
    },

    sessionCount() {
      return sessions.size;
    },

    recordPlan(session, recorded, expectedGeneration) {
      // The execute path holds the mutex and gates dirty sessions; these are the belts.
      if (session.generation !== expectedGeneration) {
        throw new Error("recordPlan across a session generation change — the fork moved");
      }
      if (session.entries.length > 0) {
        throw new Error("recordPlan on a session with executed steps — reset first");
      }
      session.plan = recorded;
    },

    beginExecution(session) {
      // At most one in-flight operation per session; a concurrent call (second tab) is a
      // designed refusal, never queued (§5.2).
      if (session.inFlight) return { ok: false, refusal: { kind: "session-busy" } };
      if (session.txCount >= config.maxTxPerSession) {
        return { ok: false, refusal: { kind: "tx-cap" } };
      }
      // Elapsed time on the monotonic track (round-5): under a backward wall-clock
      // correction, `at - last` would go negative and refuse dispatch with a
      // rollback-inflated retryAfterMs until the wall clock caught back up.
      const at = monoNow();
      if (
        session.lastExecuteAtMono !== null &&
        at - session.lastExecuteAtMono < config.minExecuteIntervalMs
      ) {
        // Ceiled to an integer: the monotonic clock is fractional (performance.now),
        // and the wire contract types retryAfterMs as a non-negative INTEGER — the
        // client's strict parser refuses a fractional value as malformed-wire, which
        // turned this refusal into a dead stop mid-run (found by the §3 steps 5-7
        // e2e gate). Ceil, never round: "retry after" must not understate the wait.
        return {
          ok: false,
          refusal: {
            kind: "rate-limited",
            retryAfterMs: Math.ceil(
              config.minExecuteIntervalMs - (at - session.lastExecuteAtMono),
            ),
          },
        };
      }
      session.inFlight = true;
      session.lastExecuteAtMono = at;
      return { ok: true };
    },

    beginExclusive(session) {
      if (session.inFlight) return { ok: false, refusal: { kind: "session-busy" } };
      session.inFlight = true;
      return { ok: true };
    },

    endExecution(session) {
      session.inFlight = false;
    },

    noteTransaction(session) {
      session.txCount += 1;
    },

    recordDispatchIntent(session, intent) {
      if (session.pendingDispatch !== null) {
        throw new Error("a dispatch intent is already pending on this session");
      }
      if (session.entries.length !== intent.stepIndex) {
        throw new Error(
          `dispatch intent out of sequence: expected index ${session.entries.length}, got ${intent.stepIndex}`,
        );
      }
      session.pendingDispatch = intent;
    },

    noteDispatchHash(session, txHash) {
      if (session.pendingDispatch === null) {
        throw new Error("no pending dispatch to note a hash on");
      }
      session.pendingDispatch.txHash = txHash;
    },

    clearDispatchIntent(session) {
      session.pendingDispatch = null;
    },

    markDispatchUnresolved(session, cause) {
      const intent = session.pendingDispatch;
      if (intent === null) throw new Error("no pending dispatch to mark unresolved");
      session.pendingDispatch = null;
      session.phase = { kind: "reconcile-required", pending: { kind: "dispatch", intent, cause } };
      return intent;
    },

    appendConfirmed(session, entry) {
      if (session.entries.length !== entry.stepIndex) {
        throw new Error(
          `append out of sequence: expected index ${session.entries.length}, got ${entry.stepIndex}`,
        );
      }
      session.entries.push({
        stepIndex: entry.stepIndex,
        stepId: entry.stepId,
        step: entry.step,
        receipt: entry.receipt,
        resolvedAmount: entry.resolvedAmount,
        approval: entry.approval,
        sharesDelta: null,
        beforeShares: null,
        settled: null,
      });
    },

    recordMeasurement(session, stepIndex, sharesDelta) {
      const entry = session.entries[stepIndex];
      if (entry === undefined) throw new Error(`no entry at index ${stepIndex}`);
      entry.sharesDelta = sharesDelta;
    },

    markAttributionPending(session, stepIndex, beforeShares) {
      const entry = session.entries[stepIndex];
      if (entry === undefined) throw new Error(`no entry at index ${stepIndex}`);
      entry.beforeShares = beforeShares;
      session.phase = { kind: "attribution-pending", stepIndex };
    },

    completeStep(session, stepIndex, sharesDelta, settled) {
      const entry = session.entries[stepIndex];
      if (entry === undefined) throw new Error(`no entry at index ${stepIndex}`);
      entry.sharesDelta = sharesDelta;
      entry.beforeShares = null;
      entry.settled = settled;
      if (session.phase.kind === "attribution-pending") {
        session.phase = { kind: "active" };
      }
    },

    markHalted(session, halt) {
      session.phase = { kind: "halted", halt };
    },

    markFailed(session, failure) {
      session.phase = { kind: "failed", failure };
    },

    markReconcileRequired(session, pending) {
      session.phase = { kind: "reconcile-required", pending };
    },

    applyReconciliation(session, sharesDelta) {
      if (
        session.phase.kind !== "reconcile-required" ||
        session.phase.pending.kind !== "persistence"
      ) {
        throw new Error("applyReconciliation without a persistence-pending session");
      }
      const pending = session.phase.pending;
      if (session.entries.length !== pending.stepIndex) {
        throw new Error(
          `reconciliation out of sequence: expected index ${session.entries.length}, got ${pending.stepIndex}`,
        );
      }
      const entry: StepEntry = {
        stepIndex: pending.stepIndex,
        stepId: pending.step.id,
        step: pending.step,
        receipt: pending.receipt,
        resolvedAmount: pending.resolvedAmount,
        approval: pending.approval,
        sharesDelta,
        beforeShares: null,
        settled: null,
      };
      session.entries.push(entry);
      session.phase = { kind: "active" };
      return entry;
    },

    adoptDispatchedStep(session, receipt, sharesDelta) {
      if (
        session.phase.kind !== "reconcile-required" ||
        session.phase.pending.kind !== "dispatch"
      ) {
        throw new Error("adoptDispatchedStep without a dispatch-pending session");
      }
      const intent = session.phase.pending.intent;
      if (session.entries.length !== intent.stepIndex) {
        throw new Error(
          `dispatch adoption out of sequence: expected index ${session.entries.length}, got ${intent.stepIndex}`,
        );
      }
      const entry: StepEntry = {
        stepIndex: intent.stepIndex,
        stepId: intent.step.id,
        step: intent.step,
        receipt,
        resolvedAmount: intent.resolvedAmount,
        approval: intent.approval,
        sharesDelta,
        beforeShares: null,
        settled: null,
      };
      session.entries.push(entry);
      session.phase = { kind: "active" };
      return entry;
    },

    vacateDispatch(session) {
      if (
        session.phase.kind !== "reconcile-required" ||
        session.phase.pending.kind !== "dispatch"
      ) {
        throw new Error("vacateDispatch without a dispatch-pending session");
      }
      session.phase = { kind: "active" };
    },

    async reset(session) {
      try {
        const { actor } = await session.fork.reset();
        session.actor = actor;
        session.generation += 1;
        session.phase = { kind: "active" };
        session.plan = null;
        session.txCount = 0;
        session.lastExecuteAtMono = null;
        session.pendingDispatch = null;
        session.entries.length = 0;
        return { ok: true };
      } catch (cause) {
        // Transactional (finding 6): the fork layer destroyed itself on the way out; a
        // session whose fork state is unknowable is removed, never served again. Its
        // evidence survives as a tombstone — the record predates the failed reset.
        sessions.delete(session.key);
        session.generation += 1;
        entomb(session);
        return { ok: false, cause };
      }
    },

    async destroy(session) {
      // No tombstone: T24's "session expired" discovery story is for TTL expiry; an owner
      // destroy is the owner's own act, and its key afterwards is simply unknown.
      sessions.delete(session.key);
      session.generation += 1;
      await session.fork.destroy();
    },

    summaryOf(session) {
      return {
        baseBlock: session.fork.baseBlock,
        baseBlockHash: session.fork.baseBlockHash,
        actor: session.actor,
        createdAtMs: session.createdAtMs,
        expiresAtMs: session.expiresAtMs,
        phase: session.phase,
        planHash: session.plan === null ? null : session.plan.planHash,
        planStepCount: session.plan === null ? null : session.plan.plan.steps.length,
        txCount: session.txCount,
        executed: settledResultsOf(session),
        recovery: recoveryEvidenceOf(session),
      };
    },
  };
}
