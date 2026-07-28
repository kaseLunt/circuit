/**
 * The durable execution record — pure data plus its legal transitions, storage-agnostic
 * (treatment §2.2 "Persists" column). Sandbox: a client cache of the server registry,
 * rehydrated through `resume.ts`; live (P3b): the localStorage shape a reload reconstructs
 * progress from. Either way the TRANSITIONS are the contract:
 *
 *  - D6, pessimistic dispatch accounting: `openDispatchIntent` persists the intent BEFORE
 *    any send leaves; an intent survives every post-request failure and is removed only by
 *    `settleStep`, `recordHalt`, or an explicit `resolveIntent` once the outcome is KNOWN
 *    (mined revert, wallet's own rejection, proven-vacated nonce). A timeout resolves
 *    nothing — the transaction may still land, so its intent stays.
 *  - D7, durable-first failure recording: `recordFailure` accepts null `decoded`/`raw`;
 *    `enrichFailure` fills exactly those nulls later and refuses overwrites, so enrichment
 *    can fail without the failure record being the casualty.
 *  - Settled prefix: strict sequence, append-only; a settled entry is never edited.
 *
 * Every transition returns a NEW record or a typed refusal — never a half-applied state.
 */
import type { Hex } from "viem";
import type {
  DispatchIntentFact,
  FailureRecordFact,
  HaltedStepFact,
  RecordRefusal,
  SettledStepFact,
} from "./types";
import type { DecodedRevert } from "../../core/errors";

export interface ExecutionRecord {
  readonly planHash: Hex;
  /** Attributed steps in strict execution order — the immutable, fully readable prefix (T8). */
  readonly settled: readonly SettledStepFact[];
  /** The halted step, when the run stopped on a T18 data error; closes the run. */
  readonly halted: HaltedStepFact | null;
  /** The durable failure entry (D7); closes the run. */
  readonly failure: FailureRecordFact | null;
  /** The open dispatch intent (D6); at most one. */
  readonly intent: DispatchIntentFact | null;
}

export type RecordOutcome =
  | { readonly ok: true; readonly record: ExecutionRecord }
  | { readonly ok: false; readonly refusal: RecordRefusal };

const ok = (record: ExecutionRecord): RecordOutcome => ({ ok: true, record });
const refuse = (refusal: RecordRefusal): RecordOutcome => ({ ok: false, refusal });

export function createRecord(planHash: Hex): ExecutionRecord {
  return { planHash, settled: [], halted: null, failure: null, intent: null };
}

/** The next dispatchable index — always the settled count, by strict sequence. */
export function nextStepIndexOf(record: ExecutionRecord): number {
  return record.settled.length;
}

/** A closed run (halt or failure recorded) accepts no dispatch and settles nothing further. */
export function runClosed(record: ExecutionRecord): boolean {
  return record.halted !== null || record.failure !== null;
}

export function openDispatchIntent(
  record: ExecutionRecord,
  intent: DispatchIntentFact,
): RecordOutcome {
  if (runClosed(record)) return refuse({ kind: "run-closed" });
  if (record.intent !== null) return refuse({ kind: "intent-open", stepIndex: record.intent.stepIndex });
  if (intent.stepIndex !== record.settled.length) {
    return refuse({
      kind: "out-of-sequence",
      expectedIndex: record.settled.length,
      receivedIndex: intent.stepIndex,
    });
  }
  return ok({ ...record, intent });
}

/** Fill the intent's hash once the send returned one; refuses to overwrite (that is a replacement). */
export function noteSubmission(record: ExecutionRecord, stepIndex: number, txHash: Hex): RecordOutcome {
  if (record.intent === null) return refuse({ kind: "no-intent" });
  if (record.intent.stepIndex !== stepIndex) {
    return refuse({ kind: "intent-mismatch", intentIndex: record.intent.stepIndex, receivedIndex: stepIndex });
  }
  if (record.intent.txHash !== null) return refuse({ kind: "submission-exists", txHash: record.intent.txHash });
  return ok({ ...record, intent: { ...record.intent, txHash } });
}

/** A classified repriced replacement (T7): the same call under a new hash — watch that one. */
export function noteReplacement(record: ExecutionRecord, stepIndex: number, newTxHash: Hex): RecordOutcome {
  if (record.intent === null) return refuse({ kind: "no-intent" });
  if (record.intent.stepIndex !== stepIndex) {
    return refuse({ kind: "intent-mismatch", intentIndex: record.intent.stepIndex, receivedIndex: stepIndex });
  }
  if (record.intent.txHash === null) return refuse({ kind: "no-submission" });
  return ok({ ...record, intent: { ...record.intent, txHash: newTxHash } });
}

/**
 * Drop an open intent whose outcome is now KNOWN and recorded in the same transition — a
 * failure entry with the mined hash, the wallet's own rejection, or a nonce proven vacated
 * (D6's one legal re-dispatch precondition). Total by design: the intent is evidence for an
 * AMBIGUOUS outcome, so once the caller has recorded the resolved one, an absent or
 * differently-indexed intent is simply not this step's ambiguity and stays untouched.
 */
export function clearResolvedIntent(record: ExecutionRecord, stepIndex: number): ExecutionRecord {
  if (record.intent === null || record.intent.stepIndex !== stepIndex) return record;
  return { ...record, intent: null };
}

/**
 * Pin a hash discovered during reconciliation onto a hashless intent (D6: the discovered
 * hash is evidence the moment it exists). Total: an intent that already carries a hash
 * keeps its own truth — discovery never overwrites what the dispatch itself recorded.
 */
export function pinDiscoveredHash(record: ExecutionRecord, stepIndex: number, txHash: Hex): ExecutionRecord {
  if (record.intent === null || record.intent.stepIndex !== stepIndex || record.intent.txHash !== null) {
    return record;
  }
  return { ...record, intent: { ...record.intent, txHash } };
}

export function settleStep(record: ExecutionRecord, entry: SettledStepFact): RecordOutcome {
  if (runClosed(record)) return refuse({ kind: "run-closed" });
  if (entry.stepIndex !== record.settled.length) {
    return refuse({
      kind: "out-of-sequence",
      expectedIndex: record.settled.length,
      receivedIndex: entry.stepIndex,
    });
  }
  if (record.intent !== null && record.intent.stepIndex !== entry.stepIndex) {
    return refuse({ kind: "intent-mismatch", intentIndex: record.intent.stepIndex, receivedIndex: entry.stepIndex });
  }
  return ok({ ...record, settled: [...record.settled, entry], intent: null });
}

/** Persist the divergence pair (§2.2 halted row); the halted step's receipt rides along (T17). */
export function recordHalt(record: ExecutionRecord, halted: HaltedStepFact): RecordOutcome {
  if (runClosed(record)) return refuse({ kind: "run-closed" });
  if (halted.stepIndex !== record.settled.length) {
    return refuse({
      kind: "out-of-sequence",
      expectedIndex: record.settled.length,
      receivedIndex: halted.stepIndex,
    });
  }
  if (record.intent !== null && record.intent.stepIndex !== halted.stepIndex) {
    return refuse({ kind: "intent-mismatch", intentIndex: record.intent.stepIndex, receivedIndex: halted.stepIndex });
  }
  return ok({ ...record, halted, intent: null });
}

/**
 * D7: the durable entry lands with whatever is known NOW — null `decoded`/`raw` is
 * acceptable; a failure record contingent on enrichment is not. Deliberately leaves any
 * open intent alone: whether the outcome is known is the caller's classification
 * (`resolveIntent` for a mined revert or a rejection; retained for a timeout give-up).
 */
export function recordFailure(record: ExecutionRecord, failure: FailureRecordFact): RecordOutcome {
  if (runClosed(record)) return refuse({ kind: "run-closed" });
  if (failure.stepIndex !== record.settled.length) {
    return refuse({
      kind: "out-of-sequence",
      expectedIndex: record.settled.length,
      receivedIndex: failure.stepIndex,
    });
  }
  return ok({ ...record, failure });
}

/**
 * Best-effort enrichment (D7), fill-null-only. Restricted to `reverted`: a timeout give-up
 * or a rejection decoded nothing on-chain, so a decoded-revert sentence there would be a
 * fabrication (T32a).
 */
export function enrichFailure(
  record: ExecutionRecord,
  enrichment: { readonly decoded: DecodedRevert | null; readonly raw: string | null },
): RecordOutcome {
  const failure = record.failure;
  if (failure === null) return refuse({ kind: "no-failure" });
  if (failure.cause !== "reverted") return refuse({ kind: "enrichment-illegal-cause", cause: failure.cause });
  if (enrichment.decoded !== null && failure.decoded !== null) {
    return refuse({ kind: "enrichment-overwrite", field: "decoded" });
  }
  if (enrichment.raw !== null && failure.raw !== null) {
    return refuse({ kind: "enrichment-overwrite", field: "raw" });
  }
  return ok({
    ...record,
    failure: {
      ...failure,
      decoded: enrichment.decoded === null ? failure.decoded : enrichment.decoded,
      raw: enrichment.raw === null ? failure.raw : enrichment.raw,
    },
  });
}
