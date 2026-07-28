/**
 * Shared execution-domain types: the state grammar of the execution machine (P3 treatment
 * §2.1/§2.2, tx treatment T7/T32/T32a) and the domain-side facts it exchanges with the
 * sandbox session service.
 *
 * Every phase kind below maps onto a state the tx grammar can render — the halted family
 * (T16–T19), the failure trichotomy (T20–T22), the T32a transition sentences, the rev 3.1
 * both-truths recovery states, and rev 3.2's `dispatch-vacated` neutral fact. The machine
 * never emits a state outside this set.
 *
 * Wire-mirror contract: `src/lib/execution` is pure and may not import server modules, so
 * the `Sandbox*Fact` types here MIRROR the registry/router contracts by name —
 * `ExecuteStepResult`/`SandboxRefusal` (`src/server/sandbox/execute-step.ts`) and the
 * evidence types they carry (`src/server/sandbox/session-registry.ts`) — with bigint where
 * the router's JSON views carry decimal strings. The string-encoded wire forms and their
 * strict parsers live in `resume.ts`; drift between the two sides fails there with a typed
 * refusal, never a guess.
 */
import type { Address, Hex } from "viem";
import type { AmountAttribution, PlanSuccess } from "../../core/plan";
import type { DecodedRevert } from "../../core/errors";
import type { ConfirmedReceipt, ShareDeltaMeasurement } from "./attribution";

export type ExecutionMode = "sandbox" | "live";

/**
 * Transport facts (treatment §1.1). Structurally cannot become `Provenanced`: no
 * ObservationMinter exists outside server/chain, and the observed-literal lint ban keeps
 * the shape unforgeable. Display and sequencing only — never money-math.
 */
export interface StepTransport {
  readonly txHash: Hex;
  readonly nonce: number;
  readonly status: "pending" | "confirmed" | "reverted" | "replaced" | "timeout";
  /** Display only, labelled "used" off the receipt per SPEC §6 (T9). */
  readonly gasUsed?: bigint;
  readonly effectiveGasPrice?: bigint;
}

/** SPEC §5.5 whitelist mechanisms that attribute a measured output (`return-value` unused). */
export type OutputMechanism = Exclude<AmountAttribution, "return-value">;

/** Mirrors `ReceiptFactsView` (session-registry): receipt identity, no transport facet. */
export interface ReceiptRef {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly gasUsed: bigint | null;
}

/** Mirrors `RiskExpectation` (session-registry). */
export type RiskExpectationFact =
  | { readonly status: "no-debt" }
  | { readonly status: "healthy"; readonly hfWad: bigint }
  | { readonly status: "unknown"; readonly reason: string };

/** Mirrors `RiskReading` (session-registry): the §5.4 per-step cross-check pair. */
export interface RiskReadingFact {
  readonly expected: RiskExpectationFact;
  readonly chainHfWad: bigint;
}

/** Mirrors `ApprovalFacts` (session-registry): allowance read before it was assumed (§3.1). */
export interface ApprovalFact {
  readonly spender: Address;
  readonly priorAllowanceWei: bigint;
  readonly approvedWei: bigint;
}

/** Mirrors `ConsumedApprovalFacts`: must be zero after the consuming step (§3.3). */
export interface ConsumedApprovalFact {
  readonly spender: Address;
  readonly residualAllowanceWei: bigint;
}

/** The §6.2 PREDICTED/ATTRIBUTED pair with its named bound (mirrors `OutputAttribution`). */
export interface OutputComparisonFact {
  readonly mechanism: OutputMechanism;
  readonly predictedWei: bigint;
  readonly attributedWei: bigint;
  readonly toleranceWei: bigint;
}

/** Mirrors `HaltEvidence` (session-registry): the three T18-identity data errors. */
export type HaltFact =
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
      readonly receipt: ReceiptRef;
    }
  | {
      readonly kind: "hf-disagreement";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly expected: RiskExpectationFact;
      readonly chainHfWad: bigint;
      readonly receipt: ReceiptRef;
    }
  | {
      readonly kind: "residual-allowance";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly spender: Address;
      readonly residualAllowanceWei: bigint;
      readonly receipt: ReceiptRef;
    };

/** An attributed step as the record keeps it (mirrors `AttributedStepResult` sans status). */
export interface SettledStepFact {
  readonly stepIndex: number;
  readonly stepId: string;
  readonly receipt: ReceiptRef;
  readonly resolvedAmountWei: bigint | null;
  readonly sharesDelta: bigint | null;
  readonly output: OutputComparisonFact | null;
  readonly approval: ApprovalFact | null;
  readonly consumedApproval: ConsumedApprovalFact | null;
  readonly risk: RiskReadingFact | null;
}

/** The halted step: confirmed on chain AND divergent — both truths kept (T17). */
export interface HaltedStepFact {
  readonly stepIndex: number;
  readonly stepId: string;
  readonly receipt: ReceiptRef;
  readonly resolvedAmountWei: bigint | null;
  readonly sharesDelta: bigint | null;
  readonly halt: HaltFact;
}

export type FailureCause = "reverted" | "user-rejected" | "timeout-gave-up" | "cancelled";

/**
 * The durable failure entry (D7): committed at the failure transition with `decoded`/`raw`
 * null, enriched later — enrichment may fail; this record may not.
 */
export interface FailureRecordFact {
  readonly stepIndex: number;
  readonly stepId: string;
  readonly cause: FailureCause;
  /** Null when nothing was sent (user-rejected) — never a placeholder hash. */
  readonly txHash: Hex | null;
  readonly decoded: DecodedRevert | null;
  readonly raw: string | null;
}

/**
 * The moment-bound facts a dispatch pins BEFORE the send leaves. They are historical the
 * instant the transaction lands — the resolved calldata amount, the §3.1 approval reads,
 * and the pre-send share reading cannot be re-observed after a lost response or a reload —
 * so they ride the durable intent, not the driver's memory (D6, D3).
 */
export interface DispatchFacts {
  /** Pre-dispatch nonce where the driver could read one — the D6 discovery pin. */
  readonly nonce: bigint | null;
  /** The resolved calldata amount for this step; null for steps that carry none. */
  readonly resolvedAmountWei: bigint | null;
  /** §3.1 allowance-read-before-approve evidence, for approve dispatches. */
  readonly approval: ApprovalFact | null;
  /** Pre-send `sharesOf` reading for share-producing steps — the D3 pinning fact. */
  readonly beforeShares: bigint | null;
}

/**
 * The D6 dispatch intent, persisted BEFORE the send leaves: a request that throws after
 * `eth_sendTransaction` may have sent, so post-request failures reconcile against the
 * chain — never "nothing happened". Carries the full `DispatchFacts` so the intent alone
 * can reconstruct the step after reload, wallet change, or reconciliation.
 */
export interface DispatchIntentFact extends DispatchFacts {
  readonly stepIndex: number;
  readonly stepId: string;
  readonly txHash: Hex | null;
}

/** Mirrors `FailureEvidence` (session-registry) — server failures always carry the hash. */
export interface SandboxFailureFact {
  readonly stepIndex: number;
  readonly stepId: string;
  readonly txHash: Hex;
  readonly decoded: DecodedRevert | null;
  readonly raw: string | null;
}

/** Mirrors `ExecuteStepResult` (execute-step.ts), domain-side. */
export type SandboxStepResult =
  | ({ readonly status: "attributed" } & SettledStepFact)
  | ({ readonly status: "halted" } & HaltedStepFact)
  | { readonly status: "failed"; readonly failure: SandboxFailureFact }
  | {
      readonly status: "attribution-unavailable";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: ReceiptRef;
      readonly beforeShares: bigint | null;
    }
  | {
      readonly status: "persistence-failed";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: ReceiptRef;
      readonly measurement: ShareDeltaMeasurement;
    }
  | {
      readonly status: "dispatch-unresolved";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly txHash: Hex | null;
    }
  | { readonly status: "dispatch-vacated"; readonly stepIndex: number; readonly stepId: string };

/** Mirrors the refusal kinds `refusalView` (sandbox-router.ts) puts on the wire. */
export type SandboxRefusalFact =
  | { readonly kind: "unknown-session" }
  | { readonly kind: "session-expired"; readonly executedSteps: number }
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
  | { readonly kind: "halted"; readonly halt: HaltFact }
  | { readonly kind: "failed"; readonly failure: SandboxFailureFact };

/**
 * The machine's renderable states — flattened from §2.1 (the per-step states are
 * `executing(k)`'s substates). `attributing(k)` is explicit and blocking (A10);
 * `halted-divergent` carries all three T18-identity halt kinds; the rev 3.1 recovery pair
 * plus `dispatch-unresolved`/`dispatch-vacated` complete the D3/D6 surfaces.
 */
export type ExecutionPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "simulating" }
  | { readonly kind: "ready" }
  | { readonly kind: "awaiting-signature"; readonly stepIndex: number }
  | { readonly kind: "pending"; readonly stepIndex: number; readonly txHash: Hex | null }
  | { readonly kind: "timeout"; readonly stepIndex: number; readonly txHash: Hex }
  | {
      readonly kind: "attributing";
      readonly stepIndex: number;
      readonly receipt: ReceiptRef;
      readonly consumedApproval: ConsumedApprovalFact | null;
    }
  | { readonly kind: "attributed"; readonly stepIndex: number }
  | { readonly kind: "complete" }
  | { readonly kind: "failed-at"; readonly stepIndex: number; readonly cause: FailureCause }
  | { readonly kind: "halted-divergent"; readonly stepIndex: number; readonly halt: HaltFact }
  | { readonly kind: "halted-wallet-changed" }
  | {
      readonly kind: "abandoned";
      readonly executedSteps: number;
      /** Read-only interrupted-step evidence off a TTL tombstone (D8/D11); never actionable. */
      readonly recovery: RecoveryFact | null;
    }
  | {
      readonly kind: "attribution-unavailable";
      readonly stepIndex: number;
      readonly receipt: ReceiptRef;
      readonly beforeShares: bigint | null;
      /** A §3.3 verdict already taken survives the measurement failure (moment-bound). */
      readonly consumedApproval: ConsumedApprovalFact | null;
    }
  | {
      readonly kind: "persistence-failed";
      readonly stepIndex: number;
      readonly receipt: ReceiptRef;
      readonly measurement: ShareDeltaMeasurement;
    }
  | {
      readonly kind: "dispatch-unresolved";
      readonly stepIndex: number;
      readonly txHash: Hex | null;
    }
  | { readonly kind: "dispatch-vacated"; readonly stepIndex: number };

/**
 * What a step demands before it may settle, derived from the frozen plan's own spec
 * objects (never recomputed): the SPEC §5.5 mechanism whose measured output settles it
 * (null → an explicit no-output settlement), and the spender whose allowance must read
 * zero after it confirms (§3.3 — mandatory for every consuming step).
 */
export interface StepRequirements {
  readonly output: OutputMechanism | null;
  readonly consumesApprovalFrom: Hex | null;
}

/**
 * Domain mirror of the registry's `RecoveryEvidence` (D11): the receipt-backed facts of
 * an interrupted step. Preserved read-only on `abandoned` when a TTL tombstone ships one.
 */
export type RecoveryFact =
  | {
      readonly kind: "attribution-pending";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: ReceiptRef;
      readonly resolvedAmountWei: bigint | null;
      readonly beforeShares: bigint | null;
      readonly sharesDelta: bigint | null;
    }
  | {
      readonly kind: "reconcile-persistence";
      readonly stepIndex: number;
      readonly stepId: string;
      readonly receipt: ReceiptRef;
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

/** The four D3 persistence × measurement cells, distinguishable by name. */
export type AttributionCell =
  | "persisted-measured"
  | "persisted-unmeasured"
  | "unpersisted-measured"
  | "unpersisted-unmeasured";

export type ExecutionEvent =
  | { readonly type: "simulate" }
  | {
      readonly type: "plan-ready";
      readonly plan: PlanSuccess;
      readonly planHash: Hex;
      /** Pinned at `ready` (treatment §1.2); null in sandbox — the server owns the actor. */
      readonly address: Address | null;
    }
  | { readonly type: "plan-refused" }
  | { readonly type: "document-mutated" }
  | { readonly type: "execute"; readonly facts: DispatchFacts }
  | { readonly type: "advance"; readonly facts: DispatchFacts }
  | { readonly type: "signed"; readonly txHash: Hex }
  | { readonly type: "user-rejected" }
  | { readonly type: "request-failed" }
  | { readonly type: "tx-confirmed"; readonly receipt: ConfirmedReceipt }
  | { readonly type: "tx-reverted"; readonly txHash: Hex }
  | { readonly type: "tx-timeout" }
  | { readonly type: "keep-waiting" }
  | { readonly type: "give-up" }
  | {
      /**
       * A classified replacement names BOTH transactions: the hash it replaced and the
       * hash that replaced it. The machine applies it only when `replacedHash` matches
       * the watched intent — duplicates are idempotent, stale reorderings refuse.
       */
      readonly type: "tx-replaced";
      readonly classification: "repriced" | "superseded";
      readonly replacedHash: Hex;
      readonly replacementHash: Hex;
    }
  | {
      readonly type: "attribution-measured";
      readonly mechanism: OutputMechanism;
      readonly attributedWei: bigint;
      readonly sharesDelta: bigint | null;
    }
  | {
      /** Live D3 cell: persisted, post-send read failed — `beforeShares` is retained. */
      readonly type: "attribution-unavailable";
      readonly beforeShares: bigint | null;
    }
  | {
      /** Live D3 cell: the durable record did not stick; the measurement rides along. */
      readonly type: "persistence-failed";
      readonly measurement: ShareDeltaMeasurement;
    }
  | {
      readonly type: "residual-allowance-checked";
      readonly spender: Address;
      readonly residualAllowanceWei: bigint;
    }
  | {
      /** Explicit settlement for steps with no measured output (approve, setUserEMode, supply). */
      readonly type: "non-producer-settled";
    }
  | { readonly type: "step-result"; readonly result: SandboxStepResult }
  | { readonly type: "step-refused"; readonly refusal: SandboxRefusalFact }
  | { readonly type: "reconcile-result"; readonly result: SandboxStepResult }
  | {
      readonly type: "failure-enriched";
      readonly decoded: DecodedRevert | null;
      readonly raw: string | null;
    }
  | { readonly type: "wallet-changed" }
  | { readonly type: "session-lost"; readonly executedSteps: number };

/** Refusals of record transitions — the record refuses rather than half-applies. */
export type RecordRefusal =
  | { readonly kind: "out-of-sequence"; readonly expectedIndex: number; readonly receivedIndex: number }
  | { readonly kind: "intent-open"; readonly stepIndex: number }
  | { readonly kind: "no-intent" }
  | { readonly kind: "intent-mismatch"; readonly intentIndex: number; readonly receivedIndex: number }
  | { readonly kind: "submission-exists"; readonly txHash: Hex }
  | { readonly kind: "no-submission" }
  | { readonly kind: "run-closed" }
  | { readonly kind: "no-failure" }
  | { readonly kind: "enrichment-overwrite"; readonly field: "decoded" | "raw" }
  | { readonly kind: "enrichment-illegal-cause"; readonly cause: FailureCause };

/**
 * A refused transition: the machine is returned UNCHANGED alongside one of these. Illegal
 * events are surfaced, never silently absorbed — a stray event is a wiring bug the driver
 * must be able to see.
 */
export type TransitionRefusal =
  | {
      readonly kind: "illegal-transition";
      readonly phase: ExecutionPhase["kind"];
      readonly event: ExecutionEvent["type"];
    }
  | {
      /** A12/T19: the halted family and the run's terminal states accept nothing. */
      readonly kind: "halt-pinned";
      readonly phase: ExecutionPhase["kind"];
      readonly event: ExecutionEvent["type"];
    }
  | {
      /** D3: no dispatch out of a persistence/dispatch failure before reconciliation. */
      readonly kind: "reconcile-required";
      readonly phase: ExecutionPhase["kind"];
    }
  | { readonly kind: "unminted-receipt" }
  | { readonly kind: "receipt-mismatch"; readonly expected: Hex | null; readonly received: Hex }
  | {
      readonly kind: "step-identity-mismatch";
      readonly expectedIndex: number;
      readonly expectedId: string | null;
      readonly receivedIndex: number;
      readonly receivedId: string | null;
    }
  | { readonly kind: "no-prediction"; readonly stepId: string }
  | {
      /** A replacement citing a transaction that is not the watched one (out-of-order watch). */
      readonly kind: "stale-replacement";
      readonly currentTxHash: Hex | null;
      readonly replacedHash: Hex;
      readonly replacementHash: Hex;
    }
  | {
      /** The step's required settlement mechanism and the offered measurement disagree. */
      readonly kind: "mechanism-mismatch";
      readonly stepId: string;
      readonly expected: OutputMechanism | null;
      readonly received: OutputMechanism;
    }
  | {
      /** A producing step cannot take the no-output settlement path. */
      readonly kind: "output-required";
      readonly stepId: string;
      readonly mechanism: OutputMechanism;
    }
  | {
      /** §3.3: a consuming step may not settle before its zero-residual verdict exists. */
      readonly kind: "residual-check-required";
      readonly stepId: string;
      readonly spender: Hex;
    }
  | { readonly kind: "no-approval-to-check"; readonly stepId: string }
  | {
      readonly kind: "spender-mismatch";
      readonly stepId: string;
      readonly expected: Hex;
      readonly received: Hex;
    }
  | { readonly kind: "resync-required"; readonly reason: string }
  | { readonly kind: "transport-refusal"; readonly refusal: SandboxRefusalFact }
  | { readonly kind: "record-refused"; readonly refusal: RecordRefusal }
  | { readonly kind: "empty-plan" };
