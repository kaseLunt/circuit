/**
 * The sandbox tRPC router — the transport for treatment §5's session service, and the
 * repo's first tRPC surface (tRPC v11, zod v4 via Standard Schema).
 *
 * The A3 property is structural and lives in the INPUT SCHEMAS: no procedure accepts a
 * `to`, `data`, address, or amount — there is no field client calldata could ride in,
 * and `z.strictObject` refuses unknown keys, so that absence is the check. The `plan`
 * document rides as the share-codec token and goes through the SAME two-gate untrusted
 * pipeline SPEC §5.6 fixed (`decodeShareGraph`), not a second schema that could drift.
 *
 * Designed states (capacity, expiry, busy, plan-changed, halted, failed, …) return as
 * typed `{ ok: false, refusal }` payloads — the tx-UX grammar renders states, not
 * transport errors; `TRPCError` is reserved for malformed input (zod) and true
 * infrastructure failure.
 *
 * Wire shapes are JSON-safe BY EXPLICIT MAPPING (bigint → decimal string), a deliberate
 * choice over a transformer dependency: the wire contract stays reviewable in this file.
 * The HTTP route handler is deliberately NOT mounted yet — the tx-family surface that
 * consumes this router mounts it; an execution endpoint with no consumer would be live
 * attack surface with no user.
 */
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import type { PlanSuccess, TransactionStep, CallArg, AmountSpec } from "../../core/plan";
import { MAX_ENCODED_LENGTH } from "../../lib/share/encode";
import type { ShareDeltaMeasurement } from "../../lib/execution/attribution";
import {
  SESSION_KEY_PATTERN,
  type HaltEvidence,
  type ReceiptFactsView,
  type RecoveryEvidence,
  type RiskExpectation,
  type SessionSummary,
  type SessionTombstone,
} from "../sandbox/session-registry";
import {
  executeSandboxStep,
  planForSession,
  reconcileSession,
  type ExecuteStepResult,
  type SandboxRefusal,
  type SandboxService,
} from "../sandbox/execute-step";

/** The router context IS the composed service. Production wiring: `sandboxServiceFromEnv`
 *  in `fork-session.ts`; tests and the fork suite compose their own. */
export type SandboxContext = SandboxService;

const t = initTRPC.context<SandboxContext>().create();

const SESSION_KEY = z.string().regex(SESSION_KEY_PATTERN, "session key shape");
const PLAN_HASH = z.string().regex(/^0x[0-9a-f]{64}$/, "plan hash shape");
/** Schema ceiling only — the runtime bound is the recorded plan's own length. A graph is
 *  capped at 64 blocks and no block emits more than 4 steps. */
const MAX_STEP_INDEX = 255;

const keyInput = z.strictObject({ sessionKey: SESSION_KEY });
const planInput = z.strictObject({
  sessionKey: SESSION_KEY,
  document: z.string().min(1).max(MAX_ENCODED_LENGTH),
});
const executeInput = z.strictObject({
  sessionKey: SESSION_KEY,
  planHash: PLAN_HASH,
  stepIndex: z.number().int().min(0).max(MAX_STEP_INDEX),
});

// ————————————————— JSON-safe views (bigint → decimal string, explicit) —————————————————

const wei = (value: bigint): string => value.toString();
const weiOrNull = (value: bigint | null): string | null => (value === null ? null : value.toString());

function receiptView(receipt: ReceiptFactsView) {
  return {
    txHash: receipt.txHash,
    blockNumber: wei(receipt.blockNumber),
    blockHash: receipt.blockHash,
    gasUsed: weiOrNull(receipt.gasUsed),
  };
}

function riskExpectationView(expected: RiskExpectation) {
  switch (expected.status) {
    case "healthy":
      return { status: "healthy" as const, hfWad: wei(expected.hfWad) };
    case "no-debt":
      return { status: "no-debt" as const };
    case "unknown":
      return { status: "unknown" as const, reason: expected.reason };
  }
}

function haltView(halt: HaltEvidence) {
  switch (halt.kind) {
    case "output-divergence":
      return {
        kind: halt.kind,
        stepIndex: halt.stepIndex,
        stepId: halt.stepId,
        mechanism: halt.mechanism,
        predictedWei: wei(halt.predictedWei),
        attributedWei: weiOrNull(halt.attributedWei),
        toleranceWei: wei(halt.toleranceWei),
        detail: halt.detail,
        receipt: receiptView(halt.receipt),
      };
    case "hf-disagreement":
      return {
        kind: halt.kind,
        stepIndex: halt.stepIndex,
        stepId: halt.stepId,
        expected: riskExpectationView(halt.expected),
        chainHfWad: wei(halt.chainHfWad),
        receipt: receiptView(halt.receipt),
      };
    case "residual-allowance":
      return {
        kind: halt.kind,
        stepIndex: halt.stepIndex,
        stepId: halt.stepId,
        spender: halt.spender,
        residualAllowanceWei: wei(halt.residualAllowanceWei),
        receipt: receiptView(halt.receipt),
      };
  }
}

function measurementView(measurement: ShareDeltaMeasurement) {
  if (measurement.status === "measured") {
    return {
      status: "measured" as const,
      beforeShares: weiOrNull(measurement.beforeShares),
      sharesDelta: weiOrNull(measurement.sharesDelta),
    };
  }
  return {
    status: "unavailable" as const,
    beforeShares: wei(measurement.beforeShares),
    cause: String(measurement.cause),
  };
}

function resultView(result: ExecuteStepResult) {
  switch (result.status) {
    case "attributed":
      return {
        status: result.status,
        stepIndex: result.stepIndex,
        stepId: result.stepId,
        receipt: receiptView(result.receipt),
        resolvedAmountWei: weiOrNull(result.resolvedAmountWei),
        sharesDelta: weiOrNull(result.sharesDelta),
        output:
          result.output === null
            ? null
            : {
                mechanism: result.output.mechanism,
                predictedWei: wei(result.output.predictedWei),
                attributedWei: wei(result.output.attributedWei),
                toleranceWei: wei(result.output.toleranceWei),
              },
        approval:
          result.approval === null
            ? null
            : {
                spender: result.approval.spender,
                priorAllowanceWei: wei(result.approval.priorAllowanceWei),
                approvedWei: wei(result.approval.approvedWei),
              },
        consumedApproval:
          result.consumedApproval === null
            ? null
            : {
                spender: result.consumedApproval.spender,
                residualAllowanceWei: wei(result.consumedApproval.residualAllowanceWei),
              },
        risk:
          result.risk === null
            ? null
            : {
                expected: riskExpectationView(result.risk.expected),
                chainHfWad: wei(result.risk.chainHfWad),
              },
      };
    case "halted":
      return {
        status: result.status,
        stepIndex: result.stepIndex,
        stepId: result.stepId,
        receipt: receiptView(result.receipt),
        resolvedAmountWei: weiOrNull(result.resolvedAmountWei),
        sharesDelta: weiOrNull(result.sharesDelta),
        halt: haltView(result.halt),
      };
    case "failed":
      return { status: result.status, failure: result.failure };
    case "attribution-unavailable":
      return {
        status: result.status,
        stepIndex: result.stepIndex,
        stepId: result.stepId,
        receipt: receiptView(result.receipt),
        beforeShares: weiOrNull(result.beforeShares),
      };
    case "persistence-failed":
      return {
        status: result.status,
        stepIndex: result.stepIndex,
        stepId: result.stepId,
        receipt: receiptView(result.receipt),
        measurement: measurementView(result.measurement),
      };
    case "dispatch-unresolved":
      return {
        status: result.status,
        stepIndex: result.stepIndex,
        stepId: result.stepId,
        txHash: result.txHash,
      };
    case "dispatch-vacated":
      return { status: result.status, stepIndex: result.stepIndex, stepId: result.stepId };
  }
}

/**
 * The recovery facts a client needs to rehydrate an interrupted step (Codex finding 5):
 * step identity, the confirmed receipt where one exists, the retained beforeShares, and
 * the measurement cell — everything the server-truth recovery states promise.
 */
function recoveryView(recovery: RecoveryEvidence | null) {
  if (recovery === null) return null;
  switch (recovery.kind) {
    case "attribution-pending":
      return {
        kind: recovery.kind,
        stepIndex: recovery.stepIndex,
        stepId: recovery.stepId,
        receipt: receiptView(recovery.receipt),
        resolvedAmountWei: weiOrNull(recovery.resolvedAmountWei),
        beforeShares: weiOrNull(recovery.beforeShares),
        sharesDelta: weiOrNull(recovery.sharesDelta),
      };
    case "reconcile-persistence":
      return {
        kind: recovery.kind,
        stepIndex: recovery.stepIndex,
        stepId: recovery.stepId,
        receipt: receiptView(recovery.receipt),
        resolvedAmountWei: weiOrNull(recovery.resolvedAmountWei),
        measurement: measurementView(recovery.measurement),
      };
    case "reconcile-dispatch":
      return {
        kind: recovery.kind,
        stepIndex: recovery.stepIndex,
        stepId: recovery.stepId,
        txHash: recovery.txHash,
        beforeShares: weiOrNull(recovery.beforeShares),
        preNonce: wei(recovery.preNonce),
      };
  }
}

/** T24's discovery facts: the receipt-backed prefix plus any pending recovery evidence. */
function tombstoneView(tombstone: SessionTombstone) {
  return {
    executedSteps: tombstone.executedSteps,
    executed: tombstone.executed.map(resultView),
    recovery: recoveryView(tombstone.recovery),
  };
}

function refusalView(refusal: SandboxRefusal) {
  switch (refusal.kind) {
    case "halted":
      return { kind: refusal.kind, halt: haltView(refusal.halt) };
    case "failed":
      return { kind: refusal.kind, failure: refusal.failure };
    case "session-expired":
      return {
        kind: refusal.kind,
        executedSteps: refusal.executedSteps,
        tombstone: tombstoneView(refusal.tombstone),
      };
    default:
      return refusal;
  }
}

function argView(arg: CallArg) {
  if (arg.kind === "amount") return { kind: "amount" as const };
  return { kind: "value" as const, value: String(arg.value), valueType: typeof arg.value };
}

function amountSpecView(spec: AmountSpec) {
  switch (spec.kind) {
    case "literal":
      return { kind: spec.kind, wei: wei(spec.amount.value), provenance: spec.amount.kind };
    case "derived":
      return { kind: spec.kind, wei: wei(spec.amount.value), provenance: spec.amount.kind };
    case "step-output":
      return {
        kind: spec.kind,
        producerStepId: spec.producerStepId,
        attribution: spec.attribution,
        allocationBps: spec.allocationBps,
      };
    case "none":
      return { kind: spec.kind };
  }
}

function stepView(step: TransactionStep) {
  return {
    id: step.id,
    index: step.index,
    blockId: step.blockId,
    description: step.description,
    to: step.to,
    functionName: step.functionName,
    valueSpec: step.valueSpec,
    args: step.args.map(argView),
    amount: amountSpecView(step.amount),
  };
}

/**
 * The plan view carries each flow's wei plus its provenance KIND. The full provenance
 * trail transport (tooltip chains, SourcedValue rehydration) is the tx-family surface's
 * contract and is deliberately not invented here.
 */
function planView(plan: PlanSuccess, planHash: string) {
  return {
    planHash,
    stepCount: plan.steps.length,
    targetEModeCategoryId: plan.targetEModeCategoryId,
    steps: plan.steps.map(stepView),
    flows: plan.flows.map((flow) => ({
      blockId: flow.blockId,
      type: flow.type,
      inputAsset: flow.inputAsset,
      inputWei: flow.inputWei === null ? null : wei(flow.inputWei.value),
      inputProvenance: flow.inputWei === null ? null : flow.inputWei.kind,
      outputAsset: flow.outputAsset,
      outputWei: flow.outputWei === null ? null : wei(flow.outputWei.value),
      outputProvenance: flow.outputWei === null ? null : flow.outputWei.kind,
    })),
  };
}

function summaryView(summary: SessionSummary) {
  // Every phase crosses the wire with the payload its rehydration needs (finding 5):
  // the interrupted-step facts themselves ride in `recovery`.
  const phase =
    summary.phase.kind === "halted"
      ? { kind: "halted" as const, halt: haltView(summary.phase.halt) }
      : summary.phase.kind === "failed"
        ? { kind: "failed" as const, failure: summary.phase.failure }
        : summary.phase.kind === "attribution-pending"
          ? { kind: "attribution-pending" as const, stepIndex: summary.phase.stepIndex }
          : summary.phase.kind === "reconcile-required"
            ? { kind: "reconcile-required" as const, pendingKind: summary.phase.pending.kind }
            : { kind: "active" as const };
  return {
    baseBlock: wei(summary.baseBlock),
    baseBlockHash: summary.baseBlockHash,
    actor: summary.actor,
    createdAtMs: summary.createdAtMs,
    expiresAtMs: summary.expiresAtMs,
    phase,
    planHash: summary.planHash,
    planStepCount: summary.planStepCount,
    txCount: summary.txCount,
    executed: summary.executed.map(resultView),
    recovery: recoveryView(summary.recovery),
  };
}

// ————————————————————————— the router —————————————————————————

export const sandboxRouter = t.router({
  create: t.procedure.mutation(async ({ ctx }) => {
    const created = await ctx.store.create(ctx.spawnFork);
    if (!created.ok) return { ok: false as const, refusal: refusalView(created.refusal) };
    const session = created.session;
    return {
      ok: true as const,
      session: {
        sessionKey: session.key,
        baseBlock: wei(session.fork.baseBlock),
        baseBlockHash: session.fork.baseBlockHash,
        actor: session.actor,
        createdAtMs: session.createdAtMs,
        expiresAtMs: session.expiresAtMs,
      },
    };
  }),

  plan: t.procedure.input(planInput).mutation(async ({ ctx, input }) => {
    const outcome = await planForSession(
      ctx.store,
      { captureSnapshot: ctx.captureSnapshot },
      input.sessionKey,
      input.document,
    );
    if (!outcome.ok) return { ok: false as const, refusal: refusalView(outcome.refusal) };
    return { ok: true as const, plan: planView(outcome.plan, outcome.planHash) };
  }),

  executeStep: t.procedure.input(executeInput).mutation(async ({ ctx, input }) => {
    const outcome = await executeSandboxStep(
      ctx.store,
      ctx.chainFor,
      input.sessionKey,
      input.planHash as `0x${string}`,
      input.stepIndex,
    );
    if (!outcome.ok) return { ok: false as const, refusal: refusalView(outcome.refusal) };
    return { ok: true as const, result: resultView(outcome.result) };
  }),

  session: t.procedure.input(keyInput).query(async ({ ctx, input }) => {
    const looked = await ctx.store.lookup(input.sessionKey);
    if (!looked.ok) return { ok: false as const, refusal: refusalView(looked.refusal) };
    return { ok: true as const, session: summaryView(ctx.store.summaryOf(looked.session)) };
  }),

  reconcile: t.procedure.input(keyInput).mutation(async ({ ctx, input }) => {
    const outcome = await reconcileSession(ctx.store, ctx.chainFor, input.sessionKey);
    if (!outcome.ok) return { ok: false as const, refusal: refusalView(outcome.refusal) };
    return { ok: true as const, result: resultView(outcome.result) };
  }),

  reset: t.procedure.input(keyInput).mutation(async ({ ctx, input }) => {
    const looked = await ctx.store.lookup(input.sessionKey);
    if (!looked.ok) return { ok: false as const, refusal: refusalView(looked.refusal) };
    const session = looked.session;
    const begun = ctx.store.beginExclusive(session);
    if (!begun.ok) return { ok: false as const, refusal: refusalView(begun.refusal) };
    let reset;
    try {
      reset = await ctx.store.reset(session);
    } finally {
      ctx.store.endExecution(session);
    }
    if (!reset.ok) {
      // Transactional reset failed (finding 6): the session was invalidated and its fork
      // destroyed; the designed recovery is a fresh session.
      return { ok: false as const, refusal: { kind: "reset-failed" as const } };
    }
    return { ok: true as const, session: summaryView(ctx.store.summaryOf(session)) };
  }),

  destroy: t.procedure.input(keyInput).mutation(async ({ ctx, input }) => {
    const looked = await ctx.store.lookup(input.sessionKey);
    if (!looked.ok) return { ok: false as const, refusal: refusalView(looked.refusal) };
    const session = looked.session;
    const begun = ctx.store.beginExclusive(session);
    if (!begun.ok) return { ok: false as const, refusal: refusalView(begun.refusal) };
    try {
      await ctx.store.destroy(session);
    } finally {
      ctx.store.endExecution(session);
    }
    return { ok: true as const };
  }),
});

export type SandboxRouter = typeof sandboxRouter;

export const createSandboxCaller = t.createCallerFactory(sandboxRouter);
