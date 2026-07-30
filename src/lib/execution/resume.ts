/**
 * resumePlan (treatment §2.3): reconcile a machine against the SERVER-TRUTH session view.
 *
 * Resumption never goes through `buildPlan` — the frozen `PlanSuccess` is the plan, the
 * executed prefix's amounts are adopted as recorded facts off the wire, and nothing here
 * re-derives an amount from the document (§2.3.1: a re-derivation would double-spend the
 * plan's own history). Record-to-step matching is by STEP IDENTITY — `step.id` plus index
 * agreement against the frozen steps (doctrine D4; field-identical steps are not the same
 * step) — and every mismatch is a typed refusal, never a guess. Resumption never re-sends:
 * every phase this module produces either continues from the NEXT unexecuted step or lands
 * in a state whose dispatch is refused until reconciliation (D3/D6).
 *
 * Wire contract: the `Wire*` types below MIRROR the JSON views `src/server/trpc/
 * sandbox-router.ts` emits (`receiptView`/`measurementView`/`haltView`/`resultView`/
 * `recoveryView`/`summaryView`/`refusalView`; doctrine D11 — every phase crosses with its
 * rehydration payload). The import direction lib→server is illegal under the purity
 * boundary, so the shapes are mirrored rather than imported; wire drift fails the strict
 * parsers here with `malformed-wire`, never a silent number (SPEC §5).
 */
import type { Hex } from "viem";
import type { PlanSuccess } from "../../core/plan";
import type { DecodedRevert } from "../../core/errors";
import { SANDBOX_OUTPUT_TOLERANCE, type OutputTolerance } from "./tolerance";
import { haltClaimMismatch, stepResultClaimMismatch } from "./output-claims";
import type { ShareDeltaMeasurement } from "./attribution";
import {
  createRecord,
  openDispatchIntent,
  recordFailure,
  recordHalt,
  settleStep,
  type ExecutionRecord,
  type RecordOutcome,
} from "./record";
import type { ExecutionMachine } from "./machine";
import type {
  ExecutionPhase,
  HaltFact,
  HaltedStepFact,
  OutputMechanism,
  ReceiptRef,
  RecordRefusal,
  RecoveryFact,
  RiskExpectationFact,
  SandboxFailureFact,
  SandboxRefusalFact,
  SandboxStepResult,
} from "./types";

// ————————————————— wire shapes (mirrors of sandbox-router.ts views) —————————————————

export interface WireReceipt {
  readonly txHash: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly gasUsed: string | null;
}

export type WireMeasurement =
  | {
      readonly status: "measured";
      readonly beforeShares: string | null;
      readonly sharesDelta: string | null;
    }
  | { readonly status: "unavailable"; readonly beforeShares: string; readonly cause: string };

export type WireRiskExpectation =
  | { readonly status: "healthy"; readonly hfWad: string }
  | { readonly status: "no-debt" }
  | { readonly status: "unknown"; readonly reason: string };

export type WireHalt =
  | {
      readonly kind: "output-divergence";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly mechanism: string;
      readonly predictedWei: string;
      readonly attributedWei: string | null;
      readonly toleranceWei: string;
      readonly detail: string | null;
      readonly receipt: WireReceipt;
    }
  | {
      readonly kind: "hf-disagreement";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly expected: WireRiskExpectation;
      readonly chainHfWad: string;
      readonly receipt: WireReceipt;
    }
  | {
      readonly kind: "residual-allowance";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly spender: string;
      readonly residualAllowanceWei: string;
      readonly receipt: WireReceipt;
    };

export interface WireFailure {
  readonly stepIndex: number;
  readonly stepId: string;
  readonly txHash: string;
  readonly decoded: DecodedRevert | null;
  readonly raw: string | null;
}

export type WireStepResult =
  | {
      readonly status: "attributed";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: WireReceipt;
      readonly resolvedAmountWei: string | null;
      readonly sharesDelta: string | null;
      readonly output: {
        readonly mechanism: string;
        readonly predictedWei: string;
        readonly attributedWei: string;
        readonly toleranceWei: string;
      } | null;
      readonly approval: {
        readonly spender: string;
        readonly priorAllowanceWei: string;
        readonly approvedWei: string;
      } | null;
      readonly consumedApproval: {
        readonly spender: string;
        readonly residualAllowanceWei: string;
      } | null;
      readonly risk: { readonly expected: WireRiskExpectation; readonly chainHfWad: string } | null;
    }
  | {
      readonly status: "halted";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: WireReceipt;
      readonly resolvedAmountWei: string | null;
      readonly sharesDelta: string | null;
      readonly halt: WireHalt;
    }
  | { readonly status: "failed"; readonly failure: WireFailure }
  | {
      readonly status: "attribution-unavailable";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: WireReceipt;
      readonly beforeShares: string | null;
    }
  | {
      readonly status: "persistence-failed";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: WireReceipt;
      readonly measurement: WireMeasurement;
    }
  | {
      readonly status: "dispatch-unresolved";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly txHash: string | null;
    }
  | { readonly status: "dispatch-vacated"; readonly stepIndex: number; readonly stepId: string };

export type WireRecovery =
  | {
      readonly kind: "attribution-pending";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: WireReceipt;
      readonly resolvedAmountWei: string | null;
      readonly beforeShares: string | null;
      readonly sharesDelta: string | null;
    }
  | {
      readonly kind: "reconcile-persistence";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: WireReceipt;
      readonly resolvedAmountWei: string | null;
      readonly measurement: WireMeasurement;
    }
  | {
      readonly kind: "reconcile-dispatch";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly txHash: string | null;
      readonly beforeShares: string | null;
      readonly preNonce: string;
    };

export type WireSessionPhase =
  | { readonly kind: "active" }
  | { readonly kind: "attribution-pending"; readonly stepIndex: number }
  | { readonly kind: "reconcile-required"; readonly pendingKind: string }
  | { readonly kind: "halted"; readonly halt: WireHalt }
  | { readonly kind: "failed"; readonly failure: WireFailure };

export interface WireSessionSummary {
  readonly baseBlock: string;
  readonly baseBlockHash: string;
  readonly actor: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly phase: WireSessionPhase;
  readonly planHash: string | null;
  readonly planStepCount: number | null;
  readonly txCount: number;
  readonly executed: readonly WireStepResult[];
  readonly recovery: WireRecovery | null;
}

export interface WireTombstone {
  readonly executedSteps: number;
  readonly executed: readonly WireStepResult[];
  readonly recovery: WireRecovery | null;
}

export type WireRefusal =
  | { readonly kind: "unknown-session" }
  | {
      readonly kind: "session-expired";
      readonly executedSteps: number;
      readonly tombstone: WireTombstone;
    }
  | { readonly kind: "session-busy" }
  /** TTL crossed while an operation held the session: no final record yet, so retry (round-13). */
  | { readonly kind: "expiring-in-flight" }
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
  | { readonly kind: "halted"; readonly halt: WireHalt }
  | { readonly kind: "failed"; readonly failure: WireFailure };

export type WireSessionResponse =
  | { readonly ok: true; readonly session: WireSessionSummary }
  | { readonly ok: false; readonly refusal: WireRefusal };

// ————————————————— strict parsing (money rule: garbage refuses, never defaults) —————————————————
//
// Every discriminator switch throws on an unknown kind and every primitive is validated at
// runtime — the TS types above describe what THIS build expects, and a rolling deploy can
// put a newer server behind an older client. Version skew must land as the typed
// `malformed-wire` refusal, never as a silently mis-filed D3 cell or an untyped crash.

class WireShapeError extends Error {}

const UNSIGNED = /^(?:0|[1-9][0-9]*)$/;
const SIGNED = /^-?(?:0|[1-9][0-9]*)$/;
const HEX_WORD = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MECHANISMS: readonly OutputMechanism[] = ["share-delta", "transfer-event", "withdraw-argument"];
const DECODED_SOURCES = ["custom-error", "legacy-code", "unknown"] as const;

/** Callers assert the record shape first, so only the unknown TAG needs rendering. */
function kindOf(value: object): string {
  const tag = (value as { readonly kind?: unknown; readonly status?: unknown }).kind ??
    (value as { readonly status?: unknown }).status;
  return String(tag);
}

/**
 * Every parser guards its payload BEFORE any property access: a null, undefined, or
 * omitted nested object under version skew must land as the typed `malformed-wire`
 * refusal, never as a native TypeError escaping the WireShapeError translation.
 */
function assertRecord(value: unknown, field: string): void {
  if (typeof value !== "object" || value === null) {
    throw new WireShapeError(`${field}: not an object (${String(value)})`);
  }
}

/** Nullable nested payloads: null stays null; anything else must be a real object. */
function nullableRecord<T>(value: T | null, field: string): T | null {
  if (value === null) return null;
  assertRecord(value, field);
  return value;
}

function assertArray(value: unknown, field: string): void {
  if (!Array.isArray(value)) {
    throw new WireShapeError(`${field}: not an array (${String(value)})`);
  }
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new WireShapeError(`${field}: not a string (${String(value)})`);
  return value;
}

function parseStringOrNull(value: unknown, field: string): string | null {
  return value === null ? null : parseString(value, field);
}

function parseIndex(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new WireShapeError(`${field}: not a non-negative integer (${String(value)})`);
  }
  return value;
}

function parseWei(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !UNSIGNED.test(value)) {
    throw new WireShapeError(`${field}: not an unsigned decimal (${String(value)})`);
  }
  return BigInt(value);
}

function parseSignedWei(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !SIGNED.test(value)) {
    throw new WireShapeError(`${field}: not a decimal (${String(value)})`);
  }
  return BigInt(value);
}

function parseWeiOrNull(value: unknown, field: string): bigint | null {
  return value === null ? null : parseWei(value, field);
}

function parseSignedWeiOrNull(value: unknown, field: string): bigint | null {
  return value === null ? null : parseSignedWei(value, field);
}

function parseHexWord(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !HEX_WORD.test(value)) {
    throw new WireShapeError(`${field}: not a 32-byte hex word (${String(value)})`);
  }
  return value as Hex;
}

function parseHexWordOrNull(value: unknown, field: string): Hex | null {
  return value === null ? null : parseHexWord(value, field);
}

function parseHexAddress(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !HEX_ADDRESS.test(value)) {
    throw new WireShapeError(`${field}: not an address (${String(value)})`);
  }
  return value as Hex;
}

function parseMechanism(value: unknown, field: string): OutputMechanism {
  const found = MECHANISMS.find((mechanism) => mechanism === value);
  if (found === undefined) throw new WireShapeError(`${field}: unknown mechanism (${String(value)})`);
  return found;
}

function parseDecoded(value: DecodedRevert | null, field: string): DecodedRevert | null {
  if (value === null) return null;
  if (typeof value !== "object") throw new WireShapeError(`${field}: not an object`);
  const source = DECODED_SOURCES.find((candidate) => candidate === value.source);
  if (source === undefined) {
    throw new WireShapeError(`${field}.source: unknown decode source (${String(value.source)})`);
  }
  return {
    message: parseString(value.message, `${field}.message`),
    raw: parseString(value.raw, `${field}.raw`),
    source,
  };
}

function parseReceipt(receipt: WireReceipt): ReceiptRef {
  assertRecord(receipt, "receipt");
  return {
    txHash: parseHexWord(receipt.txHash, "receipt.txHash"),
    blockNumber: parseWei(receipt.blockNumber, "receipt.blockNumber"),
    blockHash: parseHexWord(receipt.blockHash, "receipt.blockHash"),
    gasUsed: parseWeiOrNull(receipt.gasUsed, "receipt.gasUsed"),
  };
}

function parseMeasurement(measurement: WireMeasurement): ShareDeltaMeasurement {
  assertRecord(measurement, "measurement");
  switch (measurement.status) {
    case "measured":
      return {
        status: "measured",
        beforeShares: parseWeiOrNull(measurement.beforeShares, "measurement.beforeShares"),
        sharesDelta: parseSignedWeiOrNull(measurement.sharesDelta, "measurement.sharesDelta"),
      };
    case "unavailable":
      return {
        status: "unavailable",
        beforeShares: parseWei(measurement.beforeShares, "measurement.beforeShares"),
        cause: parseString(measurement.cause, "measurement.cause"),
      };
    default:
      throw new WireShapeError(`measurement.status: unknown cell (${kindOf(measurement)})`);
  }
}

function parseRiskExpectation(expected: WireRiskExpectation): RiskExpectationFact {
  assertRecord(expected, "risk.expected");
  switch (expected.status) {
    case "healthy":
      return { status: "healthy", hfWad: parseWei(expected.hfWad, "risk.expected.hfWad") };
    case "no-debt":
      return { status: "no-debt" };
    case "unknown":
      return { status: "unknown", reason: parseString(expected.reason, "risk.expected.reason") };
    default:
      throw new WireShapeError(`risk.expected.status: unknown status (${kindOf(expected)})`);
  }
}

function parseHalt(halt: WireHalt): HaltFact {
  assertRecord(halt, "halt");
  switch (halt.kind) {
    case "output-divergence":
      return {
        kind: "output-divergence",
        stepIndex: parseIndex(halt.stepIndex, "halt.stepIndex"),
        stepId: parseString(halt.stepId, "halt.stepId"),
        mechanism: parseMechanism(halt.mechanism, "halt.mechanism"),
        predictedWei: parseWei(halt.predictedWei, "halt.predictedWei"),
        attributedWei: parseWeiOrNull(halt.attributedWei, "halt.attributedWei"),
        toleranceWei: parseWei(halt.toleranceWei, "halt.toleranceWei"),
        detail: parseStringOrNull(halt.detail, "halt.detail"),
        receipt: parseReceipt(halt.receipt),
      };
    case "hf-disagreement":
      return {
        kind: "hf-disagreement",
        stepIndex: parseIndex(halt.stepIndex, "halt.stepIndex"),
        stepId: parseString(halt.stepId, "halt.stepId"),
        expected: parseRiskExpectation(halt.expected),
        chainHfWad: parseWei(halt.chainHfWad, "halt.chainHfWad"),
        receipt: parseReceipt(halt.receipt),
      };
    case "residual-allowance":
      return {
        kind: "residual-allowance",
        stepIndex: parseIndex(halt.stepIndex, "halt.stepIndex"),
        stepId: parseString(halt.stepId, "halt.stepId"),
        spender: parseHexAddress(halt.spender, "halt.spender"),
        residualAllowanceWei: parseWei(halt.residualAllowanceWei, "halt.residualAllowanceWei"),
        receipt: parseReceipt(halt.receipt),
      };
    default:
      throw new WireShapeError(`halt.kind: unknown halt kind (${kindOf(halt)})`);
  }
}

function parseFailure(failure: WireFailure): SandboxFailureFact {
  assertRecord(failure, "failure");
  return {
    stepIndex: parseIndex(failure.stepIndex, "failure.stepIndex"),
    stepId: parseString(failure.stepId, "failure.stepId"),
    txHash: parseHexWord(failure.txHash, "failure.txHash"),
    decoded: parseDecoded(failure.decoded, "failure.decoded"),
    raw: parseStringOrNull(failure.raw, "failure.raw"),
  };
}

function parseRecovery(recovery: WireRecovery): RecoveryFact {
  assertRecord(recovery, "recovery");
  switch (recovery.kind) {
    case "attribution-pending":
      return {
        kind: "attribution-pending",
        stepIndex: parseIndex(recovery.stepIndex, "recovery.stepIndex"),
        stepId: parseString(recovery.stepId, "recovery.stepId"),
        receipt: parseReceipt(recovery.receipt),
        resolvedAmountWei: parseWeiOrNull(recovery.resolvedAmountWei, "recovery.resolvedAmountWei"),
        beforeShares: parseWeiOrNull(recovery.beforeShares, "recovery.beforeShares"),
        sharesDelta: parseSignedWeiOrNull(recovery.sharesDelta, "recovery.sharesDelta"),
      };
    case "reconcile-persistence":
      return {
        kind: "reconcile-persistence",
        stepIndex: parseIndex(recovery.stepIndex, "recovery.stepIndex"),
        stepId: parseString(recovery.stepId, "recovery.stepId"),
        receipt: parseReceipt(recovery.receipt),
        resolvedAmountWei: parseWeiOrNull(recovery.resolvedAmountWei, "recovery.resolvedAmountWei"),
        measurement: parseMeasurement(recovery.measurement),
      };
    case "reconcile-dispatch":
      return {
        kind: "reconcile-dispatch",
        stepIndex: parseIndex(recovery.stepIndex, "recovery.stepIndex"),
        stepId: parseString(recovery.stepId, "recovery.stepId"),
        txHash: parseHexWordOrNull(recovery.txHash, "recovery.txHash"),
        beforeShares: parseWeiOrNull(recovery.beforeShares, "recovery.beforeShares"),
        preNonce: parseWei(recovery.preNonce, "recovery.preNonce"),
      };
    default:
      throw new WireShapeError(`recovery.kind: unknown recovery kind (${kindOf(recovery)})`);
  }
}

function parseStepResult(result: WireStepResult): SandboxStepResult {
  assertRecord(result, "result");
  switch (result.status) {
    case "attributed": {
      const output = nullableRecord(result.output, "result.output");
      const approval = nullableRecord(result.approval, "result.approval");
      const consumedApproval = nullableRecord(result.consumedApproval, "result.consumedApproval");
      const risk = nullableRecord(result.risk, "result.risk");
      return {
        status: "attributed",
        stepIndex: parseIndex(result.stepIndex, "result.stepIndex"),
        stepId: parseString(result.stepId, "result.stepId"),
        receipt: parseReceipt(result.receipt),
        resolvedAmountWei: parseWeiOrNull(result.resolvedAmountWei, "result.resolvedAmountWei"),
        sharesDelta: parseSignedWeiOrNull(result.sharesDelta, "result.sharesDelta"),
        output:
          output === null
            ? null
            : {
                mechanism: parseMechanism(output.mechanism, "result.output.mechanism"),
                predictedWei: parseWei(output.predictedWei, "result.output.predictedWei"),
                attributedWei: parseWei(output.attributedWei, "result.output.attributedWei"),
                toleranceWei: parseWei(output.toleranceWei, "result.output.toleranceWei"),
              },
        approval:
          approval === null
            ? null
            : {
                spender: parseHexAddress(approval.spender, "result.approval.spender"),
                priorAllowanceWei: parseWei(approval.priorAllowanceWei, "result.approval.priorAllowanceWei"),
                approvedWei: parseWei(approval.approvedWei, "result.approval.approvedWei"),
              },
        consumedApproval:
          consumedApproval === null
            ? null
            : {
                spender: parseHexAddress(consumedApproval.spender, "result.consumedApproval.spender"),
                residualAllowanceWei: parseWei(
                  consumedApproval.residualAllowanceWei,
                  "result.consumedApproval.residualAllowanceWei",
                ),
              },
        risk:
          risk === null
            ? null
            : {
                expected: parseRiskExpectation(risk.expected),
                chainHfWad: parseWei(risk.chainHfWad, "result.risk.chainHfWad"),
              },
      };
    }
    case "halted":
      return {
        status: "halted",
        stepIndex: parseIndex(result.stepIndex, "result.stepIndex"),
        stepId: parseString(result.stepId, "result.stepId"),
        receipt: parseReceipt(result.receipt),
        resolvedAmountWei: parseWeiOrNull(result.resolvedAmountWei, "result.resolvedAmountWei"),
        sharesDelta: parseSignedWeiOrNull(result.sharesDelta, "result.sharesDelta"),
        halt: parseHalt(result.halt),
      };
    case "failed":
      return { status: "failed", failure: parseFailure(result.failure) };
    case "attribution-unavailable":
      return {
        status: "attribution-unavailable",
        stepIndex: parseIndex(result.stepIndex, "result.stepIndex"),
        stepId: parseString(result.stepId, "result.stepId"),
        receipt: parseReceipt(result.receipt),
        beforeShares: parseWeiOrNull(result.beforeShares, "result.beforeShares"),
      };
    case "persistence-failed":
      return {
        status: "persistence-failed",
        stepIndex: parseIndex(result.stepIndex, "result.stepIndex"),
        stepId: parseString(result.stepId, "result.stepId"),
        receipt: parseReceipt(result.receipt),
        measurement: parseMeasurement(result.measurement),
      };
    case "dispatch-unresolved":
      return {
        status: "dispatch-unresolved",
        stepIndex: parseIndex(result.stepIndex, "result.stepIndex"),
        stepId: parseString(result.stepId, "result.stepId"),
        txHash: parseHexWordOrNull(result.txHash, "result.txHash"),
      };
    case "dispatch-vacated":
      return {
        status: "dispatch-vacated",
        stepIndex: parseIndex(result.stepIndex, "result.stepIndex"),
        stepId: parseString(result.stepId, "result.stepId"),
      };
    default:
      throw new WireShapeError(`result.status: unknown result status (${kindOf(result)})`);
  }
}

// ————————————————— driver adapters —————————————————

export type ResumeRefusal =
  | {
      readonly kind: "plan-hash-mismatch";
      readonly expected: Hex;
      readonly received: string | null;
    }
  | {
      readonly kind: "plan-shape-mismatch";
      readonly planSteps: number;
      readonly sessionSteps: number | null;
    }
  | {
      readonly kind: "step-identity-mismatch";
      readonly expectedIndex: number;
      readonly expectedId: string | null;
      readonly receivedIndex: number;
      readonly receivedId: string;
    }
  | { readonly kind: "malformed-summary"; readonly detail: string }
  | { readonly kind: "malformed-wire"; readonly detail: string }
  | {
      /**
       * A persisted result whose money claims fail the recompute-and-compare validator
       * (output-claims.ts): the record is NOT adopted, the machine is NOT replaced.
       * This is the same gate the driver's live path applies — a reload must never
       * adopt what the live path refused (Codex thread 019fa749 finding 1).
       */
      readonly kind: "money-claim-mismatch";
      readonly detail: string;
    }
  | { readonly kind: "missing-recovery"; readonly phase: string }
  | { readonly kind: "recovery-kind-mismatch"; readonly phase: string; readonly recovery: string }
  | { readonly kind: "unresumable-refusal"; readonly refusal: WireRefusal["kind"] }
  | { readonly kind: "record-refused"; readonly refusal: RecordRefusal };

export type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ResumeRefusal };

function guarded<T>(parse: () => T): ParseOutcome<T> {
  try {
    return { ok: true, value: parse() };
  } catch (cause) {
    if (cause instanceof WireShapeError) {
      return { ok: false, refusal: { kind: "malformed-wire", detail: cause.message } };
    }
    throw cause;
  }
}

/** Wire→domain adapter for one step result — the driver feeds machine events from this. */
export function stepResultFactOf(wire: WireStepResult): ParseOutcome<SandboxStepResult> {
  return guarded(() => parseStepResult(wire));
}

/** Wire→domain adapter for a refusal — tombstone evidence stays on the wire side (T24). */
export function refusalFactOf(wire: WireRefusal): ParseOutcome<SandboxRefusalFact> {
  return guarded((): SandboxRefusalFact => {
    assertRecord(wire, "refusal");
    switch (wire.kind) {
      case "session-expired":
        return {
          kind: "session-expired",
          executedSteps: parseIndex(wire.executedSteps, "refusal.executedSteps"),
        };
      case "halted":
        return { kind: "halted", halt: parseHalt(wire.halt) };
      case "failed":
        return { kind: "failed", failure: parseFailure(wire.failure) };
      case "rate-limited":
        return { kind: "rate-limited", retryAfterMs: parseIndex(wire.retryAfterMs, "refusal.retryAfterMs") };
      case "out-of-order":
        return { kind: "out-of-order", expectedIndex: parseIndex(wire.expectedIndex, "refusal.expectedIndex") };
      case "reconcile-mismatch":
        return { kind: "reconcile-mismatch", detail: parseString(wire.detail, "refusal.detail") };
      case "unknown-session":
      case "session-busy":
      case "expiring-in-flight":
      case "tx-cap":
      case "at-capacity":
      case "no-plan":
      case "plan-changed":
      case "plan-complete":
      case "session-dirty":
      case "reconcile-required":
      case "nothing-to-reconcile":
      case "reset-failed":
        return { kind: wire.kind };
      default:
        throw new WireShapeError(`refusal.kind: unknown refusal kind (${kindOf(wire)})`);
    }
  });
}

// ————————————————— resumePlan —————————————————

export interface ResumeInput {
  /** The FROZEN plan (§2.3): resumption operates on it, never on the document. */
  readonly plan: PlanSuccess;
  readonly planHash: Hex;
  /** The verbatim `sandbox.session` response — D11's rehydration payload. */
  readonly response: WireSessionResponse;
  readonly tolerance?: OutputTolerance;
}

export type ResumeOutcome =
  | { readonly ok: true; readonly machine: ExecutionMachine }
  | { readonly ok: false; readonly refusal: ResumeRefusal };

const refuse = (refusal: ResumeRefusal): ResumeOutcome => ({ ok: false, refusal });

function landOnRecord(outcome: RecordOutcome): ExecutionRecord {
  if (!outcome.ok) throw new RecordRefusedError(outcome.refusal);
  return outcome.record;
}

class RecordRefusedError extends Error {
  constructor(readonly refusal: RecordRefusal) {
    super(`record refused: ${refusal.kind}`);
  }
}

/**
 * Adopt the settled prefix off the wire, matching each record to its frozen step by
 * identity (D4): index agreement AND `step.id` agreement, both required, mismatch refuses.
 */
function adoptExecuted(
  plan: PlanSuccess,
  planHash: Hex,
  executed: readonly WireStepResult[],
  tolerance: OutputTolerance,
): { record: ExecutionRecord } | { refusal: ResumeRefusal } {
  let record = createRecord(planHash);
  for (let i = 0; i < executed.length; i += 1) {
    const wire = executed[i];
    if (wire === undefined) return { refusal: { kind: "malformed-summary", detail: `executed[${i}] missing` } };
    const result = parseStepResult(wire);
    if (result.status !== "attributed" && result.status !== "halted") {
      return {
        refusal: {
          kind: "malformed-summary",
          detail: `executed[${i}] has non-settled status ${result.status}`,
        },
      };
    }
    const step = plan.steps[result.stepIndex];
    if (result.stepIndex !== i || step === undefined || step.id !== result.stepId) {
      return {
        refusal: {
          kind: "step-identity-mismatch",
          expectedIndex: i,
          expectedId: step === undefined ? null : step.id,
          receivedIndex: result.stepIndex,
          receivedId: result.stepId,
        },
      };
    }
    // The money-claim gate runs on EVERY identity-valid adopted entry — session
    // summaries and tombstones alike flow through here, so no rehydration path can
    // skip it (thread 019fa749 finding 1). Identity problems keep their own refusal.
    const claimMismatch = stepResultClaimMismatch(plan, tolerance, result);
    if (claimMismatch !== null) {
      return { refusal: { kind: "money-claim-mismatch", detail: claimMismatch } };
    }
    if (result.status === "halted") {
      if (i !== executed.length - 1) {
        return { refusal: { kind: "malformed-summary", detail: "halted step is not the last executed entry" } };
      }
      record = landOnRecord(
        recordHalt(record, {
          stepIndex: result.stepIndex,
          stepId: result.stepId,
          receipt: result.receipt,
          resolvedAmountWei: result.resolvedAmountWei,
          sharesDelta: result.sharesDelta,
          halt: result.halt,
        }),
      );
    } else {
      record = landOnRecord(
        settleStep(record, {
          stepIndex: result.stepIndex,
          stepId: result.stepId,
          receipt: result.receipt,
          resolvedAmountWei: result.resolvedAmountWei,
          sharesDelta: result.sharesDelta,
          output: result.output,
          approval: result.approval,
          consumedApproval: result.consumedApproval,
          risk: result.risk,
        }),
      );
    }
  }
  return { record };
}

function machineOf(
  input: ResumeInput,
  record: ExecutionRecord,
  phase: ExecutionPhase,
): ExecutionMachine {
  return {
    mode: "sandbox",
    tolerance: input.tolerance ?? SANDBOX_OUTPUT_TOLERANCE,
    plan: input.plan,
    planHash: input.planHash,
    address: null,
    record,
    phase,
  };
}

/**
 * Canonical serialization of a halt's FACTS, for agreement between two wire copies of
 * the same event (the executed record's halt and the phase payload's duplicate). This
 * is fact-agreement, NOT step sameness — D4's reference-identity rule governs which
 * step is which and stays untouched; here two copies of one claim must simply say the
 * same thing, field for field.
 */
const expectationKeyOf = (expected: RiskExpectationFact): string =>
  expected.status === "healthy"
    ? `healthy:${expected.hfWad}`
    : expected.status === "unknown"
      ? `unknown:${expected.reason}`
      : "no-debt";

function haltKeyOf(halt: HaltFact): string {
  const receipt = `${halt.receipt.txHash}:${halt.receipt.blockNumber}:${halt.receipt.blockHash}:${halt.receipt.gasUsed}`;
  switch (halt.kind) {
    case "output-divergence":
      return `output:${halt.stepIndex}:${halt.stepId}:${halt.mechanism}:${halt.predictedWei}:${halt.attributedWei}:${halt.toleranceWei}:${halt.detail}:${receipt}`;
    case "hf-disagreement":
      return `hf:${halt.stepIndex}:${halt.stepId}:${expectationKeyOf(halt.expected)}:${halt.chainHfWad}:${receipt}`;
    case "residual-allowance":
      return `residual:${halt.stepIndex}:${halt.stepId}:${halt.spender}:${halt.residualAllowanceWei}:${receipt}`;
  }
}

/** Identity gate for a recovery payload against the frozen plan and the settled prefix. */
function recoveryIdentityRefusal(
  plan: PlanSuccess,
  record: ExecutionRecord,
  stepIndex: number,
  stepId: string,
): ResumeRefusal | null {
  const step = plan.steps[stepIndex];
  if (step === undefined || step.id !== stepId || stepIndex !== record.settled.length) {
    return {
      kind: "step-identity-mismatch",
      expectedIndex: record.settled.length,
      expectedId: step === undefined ? null : step.id,
      receivedIndex: stepIndex,
      receivedId: stepId,
    };
  }
  return null;
}

export function resumePlan(input: ResumeInput): ResumeOutcome {
  try {
    return resumeUnguarded(input);
  } catch (cause) {
    if (cause instanceof WireShapeError) {
      return refuse({ kind: "malformed-wire", detail: cause.message });
    }
    if (cause instanceof RecordRefusedError) {
      return refuse({ kind: "record-refused", refusal: cause.refusal });
    }
    throw cause;
  }
}

function resumeUnguarded(input: ResumeInput): ResumeOutcome {
  const { plan, planHash, response } = input;
  const tolerance = input.tolerance ?? SANDBOX_OUTPUT_TOLERANCE;
  assertRecord(response, "response");
  if (!response.ok) {
    assertRecord(response.refusal, "response.refusal");
    if (response.refusal.kind !== "session-expired") {
      // Nothing to resume from: no executed record crossed the wire. `unknown-session`
      // after an owner destroy is deliberate silence (D8) — a fresh session is the story.
      return refuse({ kind: "unresumable-refusal", refusal: response.refusal.kind });
    }
    const tombstone = response.refusal.tombstone;
    assertRecord(tombstone, "tombstone");
    assertArray(tombstone.executed, "tombstone.executed");
    const executedSteps = parseIndex(response.refusal.executedSteps, "refusal.executedSteps");
    if (
      executedSteps !== tombstone.executed.length ||
      parseIndex(tombstone.executedSteps, "tombstone.executedSteps") !== tombstone.executed.length
    ) {
      return refuse({
        kind: "malformed-summary",
        detail: "tombstone step count disagrees with its executed record",
      });
    }
    const adopted = adoptExecuted(plan, planHash, tombstone.executed, tolerance);
    if ("refusal" in adopted) return refuse(adopted.refusal);
    // A TTL tombstone deliberately ships the interrupted step's evidence (D8) — the
    // pending receipt, retained beforeShares, measurement cell, or dispatch pins would be
    // unreconstructable otherwise. It rides the abandoned state read-only (T24).
    let recovery: RecoveryFact | null = null;
    if (tombstone.recovery !== null) {
      recovery = parseRecovery(tombstone.recovery);
      const identityRefusal = recoveryIdentityRefusal(
        plan,
        adopted.record,
        recovery.stepIndex,
        recovery.stepId,
      );
      if (identityRefusal !== null) return refuse(identityRefusal);
    }
    return {
      ok: true,
      machine: machineOf(input, adopted.record, { kind: "abandoned", executedSteps, recovery }),
    };
  }
  const summary = response.session;
  assertRecord(summary, "session");
  assertRecord(summary.phase, "session.phase");
  assertArray(summary.executed, "session.executed");
  if (summary.planHash !== planHash) {
    return refuse({
      kind: "plan-hash-mismatch",
      expected: planHash,
      received: summary.planHash === null ? null : String(summary.planHash),
    });
  }
  if (summary.planStepCount !== plan.steps.length) {
    return refuse({
      kind: "plan-shape-mismatch",
      planSteps: plan.steps.length,
      sessionSteps: summary.planStepCount,
    });
  }
  const adopted = adoptExecuted(plan, planHash, summary.executed, tolerance);
  if ("refusal" in adopted) return refuse(adopted.refusal);
  const record = adopted.record;

  switch (summary.phase.kind) {
    case "active": {
      if (record.halted !== null) {
        return refuse({ kind: "malformed-summary", detail: "active phase over a halted record" });
      }
      const settledCount = record.settled.length;
      const phase: ExecutionPhase =
        settledCount === plan.steps.length
          ? { kind: "complete" }
          : settledCount === 0
            ? { kind: "ready" }
            : { kind: "attributed", stepIndex: settledCount - 1 };
      return { ok: true, machine: machineOf(input, record, phase) };
    }
    case "halted": {
      const halt = parseHalt(summary.phase.halt);
      let haltedRecord = record;
      let durable: HaltedStepFact;
      if (record.halted === null) {
        const identityRefusal = recoveryIdentityRefusal(plan, record, halt.stepIndex, halt.stepId);
        if (identityRefusal !== null) return refuse(identityRefusal);
        const claimMismatch = haltClaimMismatch(plan, tolerance, halt);
        if (claimMismatch !== null) {
          return refuse({ kind: "money-claim-mismatch", detail: claimMismatch });
        }
        const entry: HaltedStepFact = {
          stepIndex: halt.stepIndex,
          stepId: halt.stepId,
          receipt: halt.receipt,
          resolvedAmountWei: null,
          sharesDelta: null,
          halt,
        };
        haltedRecord = landOnRecord(recordHalt(record, entry));
        durable = entry;
      } else {
        if (record.halted.stepIndex !== halt.stepIndex) {
          return refuse({ kind: "malformed-summary", detail: "phase halt cites a different step than the executed record" });
        }
        // The phase payload is validated UNCONDITIONALLY (thread 019fa75e): a valid
        // executed halt must not launder an invalid duplicate through the phase field.
        const claimMismatch = haltClaimMismatch(plan, tolerance, halt);
        if (claimMismatch !== null) {
          return refuse({ kind: "money-claim-mismatch", detail: claimMismatch });
        }
        // Two copies of one fact must agree, field for field — otherwise the machine
        // phase and the durable record would carry different numbers for one event.
        if (haltKeyOf(record.halted.halt) !== haltKeyOf(halt)) {
          return refuse({
            kind: "malformed-summary",
            detail: "phase halt disagrees with the executed record's halt",
          });
        }
        durable = record.halted;
      }
      // The machine phase is built from the VALIDATED RECORD's halt — the durable
      // truth — never from the wire duplicate.
      return {
        ok: true,
        machine: machineOf(input, haltedRecord, {
          kind: "halted-divergent",
          stepIndex: durable.stepIndex,
          halt: durable.halt,
        }),
      };
    }
    case "failed": {
      const failure = parseFailure(summary.phase.failure);
      const identityRefusal = recoveryIdentityRefusal(plan, record, failure.stepIndex, failure.stepId);
      if (identityRefusal !== null) return refuse(identityRefusal);
      const failed = landOnRecord(
        recordFailure(record, {
          stepIndex: failure.stepIndex,
          stepId: failure.stepId,
          cause: "reverted",
          txHash: failure.txHash,
          decoded: failure.decoded,
          raw: failure.raw,
        }),
      );
      return {
        ok: true,
        machine: machineOf(input, failed, {
          kind: "failed-at",
          stepIndex: failure.stepIndex,
          cause: "reverted",
        }),
      };
    }
    case "attribution-pending": {
      if (summary.recovery === null) {
        return refuse({ kind: "missing-recovery", phase: summary.phase.kind });
      }
      const recovery = parseRecovery(summary.recovery);
      if (recovery.kind !== "attribution-pending") {
        return refuse({ kind: "recovery-kind-mismatch", phase: summary.phase.kind, recovery: recovery.kind });
      }
      const identityRefusal = recoveryIdentityRefusal(plan, record, recovery.stepIndex, recovery.stepId);
      if (identityRefusal !== null) return refuse(identityRefusal);
      // The confirmed transaction is re-pinned as the open intent — WITH the recovery's
      // moment-bound dispatch facts — so the eventual reconcile-result settles against
      // it. Resumption re-attributes, never re-sends.
      const pinned = landOnRecord(
        openDispatchIntent(record, {
          stepIndex: recovery.stepIndex,
          stepId: recovery.stepId,
          txHash: recovery.receipt.txHash,
          nonce: null,
          resolvedAmountWei: recovery.resolvedAmountWei,
          approval: null,
          beforeShares: recovery.beforeShares,
        }),
      );
      return {
        ok: true,
        machine: machineOf(input, pinned, {
          kind: "attributing",
          stepIndex: recovery.stepIndex,
          receipt: recovery.receipt,
          consumedApproval: null,
        }),
      };
    }
    case "reconcile-required": {
      // Mirrors `PendingReconciliation["kind"]` (session-registry) — an unknown pending
      // tag is version skew, and a known one must AGREE with the recovery payload's kind.
      const pendingKind = summary.phase.pendingKind;
      if (pendingKind !== "persistence" && pendingKind !== "dispatch") {
        throw new WireShapeError(`session.phase.pendingKind: unknown pending kind (${String(pendingKind)})`);
      }
      if (summary.recovery === null) {
        return refuse({ kind: "missing-recovery", phase: summary.phase.kind });
      }
      const recovery = parseRecovery(summary.recovery);
      if (recovery.kind === "attribution-pending") {
        return refuse({ kind: "recovery-kind-mismatch", phase: summary.phase.kind, recovery: recovery.kind });
      }
      if ((pendingKind === "persistence") !== (recovery.kind === "reconcile-persistence")) {
        return refuse({
          kind: "recovery-kind-mismatch",
          phase: `reconcile-required(${pendingKind})`,
          recovery: recovery.kind,
        });
      }
      const identityRefusal = recoveryIdentityRefusal(plan, record, recovery.stepIndex, recovery.stepId);
      if (identityRefusal !== null) return refuse(identityRefusal);
      if (recovery.kind === "reconcile-persistence") {
        const pinned = landOnRecord(
          openDispatchIntent(record, {
            stepIndex: recovery.stepIndex,
            stepId: recovery.stepId,
            txHash: recovery.receipt.txHash,
            nonce: null,
            resolvedAmountWei: recovery.resolvedAmountWei,
            approval: null,
            beforeShares: recovery.measurement.beforeShares,
          }),
        );
        return {
          ok: true,
          machine: machineOf(input, pinned, {
            kind: "persistence-failed",
            stepIndex: recovery.stepIndex,
            receipt: recovery.receipt,
            measurement: recovery.measurement,
          }),
        };
      }
      const pinned = landOnRecord(
        openDispatchIntent(record, {
          stepIndex: recovery.stepIndex,
          stepId: recovery.stepId,
          txHash: recovery.txHash,
          nonce: recovery.preNonce,
          resolvedAmountWei: null,
          approval: null,
          beforeShares: recovery.beforeShares,
        }),
      );
      return {
        ok: true,
        machine: machineOf(input, pinned, {
          kind: "dispatch-unresolved",
          stepIndex: recovery.stepIndex,
          txHash: recovery.txHash,
        }),
      };
    }
    default:
      throw new WireShapeError(`session.phase.kind: unknown phase kind (${kindOf(summary.phase)})`);
  }
}
