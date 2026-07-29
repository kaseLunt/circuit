/**
 * A scripted `SandboxTransport` for driver and tx-component tests: it behaves like the
 * landed session service at the WIRE level — it decodes the document through the same
 * share codec the server uses, builds the plan with the same `buildPlan` over the
 * recorded fixture snapshot, and answers `executeStep` with wire-shaped attributed
 * results whose identities come from that plan — so the driver's agreement checks and
 * the machine's identity checks are exercised against honest shapes, not hand-typed
 * ones.
 *
 * Nothing here mocks a decision: sequencing, tolerance and §3.3 verdicts stay the
 * machine's. `script` lets one test bend ONE call (a halt, a failure, a thrown fetch)
 * while everything around it stays canonical.
 */
import type { Hex } from "viem";
import { buildPlan, type ChainSnapshot, type PlanSuccess } from "../../src/core/plan";
import { decodeShareGraph } from "../../src/lib/share/encode";
import { stepRequirementsOf } from "../../src/lib/execution/machine";
import { SANDBOX_OUTPUT_TOLERANCE, toleranceWeiFor } from "../../src/lib/execution/tolerance";
import type { WireStepResult } from "../../src/lib/execution/resume";
import type {
  SandboxTransport,
  WireCreateResponse,
  WireExecuteResponse,
  WirePlanResponse,
  WireTransportSessionResponse,
} from "../../src/lib/tx/transport";
import { fixtureSnapshot } from "./chain-snapshot";

export const SCRIPT_SESSION_KEY = "ab".repeat(32);
export const SCRIPT_PLAN_HASH = `0x${"cd".repeat(32)}` as Hex;
export const SCRIPT_ACTOR = `0x${"12".repeat(20)}`;
export const SCRIPT_BASE_BLOCK = "23000000";
export const SCRIPT_BASE_BLOCK_HASH = `0x${"ef".repeat(32)}`;
export const SCRIPT_CREATED_AT_MS = 1_000;
export const SCRIPT_TTL_MS = 1_800_000;

export const wireHash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

export function predictedWeiOf(plan: PlanSuccess, stepIndex: number): bigint | null {
  const step = plan.steps[stepIndex];
  if (step === undefined) return null;
  const flow = plan.flows.find((candidate) => candidate.blockId === step.blockId);
  return flow === undefined || flow.outputWei === null ? null : flow.outputWei.value;
}

/** An honest wire "attributed" result for step `index` of `plan`. */
export function wireAttributed(plan: PlanSuccess, index: number): WireStepResult {
  const step = plan.steps[index];
  if (step === undefined) throw new Error(`no step ${index}`);
  const requirements = stepRequirementsOf(plan, step);
  const predicted = predictedWeiOf(plan, index);
  const receipt = {
    txHash: wireHash(0xa000 + index),
    blockNumber: `${23_000_001 + index}`,
    blockHash: wireHash(0xb000 + index),
    gasUsed: "210000",
  };
  return {
    status: "attributed",
    stepIndex: index,
    stepId: step.id,
    receipt,
    resolvedAmountWei: null,
    sharesDelta: null,
    output:
      requirements.output === null || predicted === null
        ? null
        : {
            mechanism: requirements.output,
            predictedWei: predicted.toString(),
            attributedWei: predicted.toString(),
            toleranceWei: toleranceWeiFor(predicted, SANDBOX_OUTPUT_TOLERANCE).toString(),
          },
    approval: null,
    consumedApproval:
      requirements.consumesApprovalFrom === null
        ? null
        : { spender: requirements.consumesApprovalFrom, residualAllowanceWei: "0" },
    risk: null,
  };
}

export interface ScriptedCalls {
  readonly create: number;
  readonly plan: number;
  readonly executeStep: readonly number[];
  readonly session: number;
  readonly reconcile: number;
  readonly reset: number;
  readonly destroy: number;
}

export interface ScriptedSandbox {
  readonly transport: SandboxTransport;
  readonly calls: ScriptedCalls;
  /** The plan the "server" built from the last `plan` call's document. */
  planned(): PlanSuccess | null;
  /** The wire results the "server" has recorded so far. */
  executed(): readonly WireStepResult[];
}

export interface ScriptOverrides {
  /**
   * Bend one executeStep call by index; return a response or throw. Falsy = canonical.
   * `record` commits a result server-side FIRST, so a test can model the D6 dark case:
   * the server executed, and only the response was lost.
   */
  readonly onExecuteStep?: (
    index: number,
    canonical: WireExecuteResponse,
    record: (result: WireStepResult) => void,
  ) => WireExecuteResponse | undefined;
  readonly onCreate?: () => WireCreateResponse | undefined;
  readonly onPlan?: () => WirePlanResponse | undefined;
  readonly onSession?: () => WireTransportSessionResponse | undefined;
  readonly onReconcile?: () => WireExecuteResponse | undefined;
  readonly onReset?: () => WireTransportSessionResponse | undefined;
  readonly snapshot?: ChainSnapshot;
}

export function scriptedSandbox(overrides: ScriptOverrides = {}): ScriptedSandbox {
  const snapshot = overrides.snapshot ?? fixtureSnapshot();
  const calls = {
    create: 0,
    plan: 0,
    executeStep: [] as number[],
    session: 0,
    reconcile: 0,
    reset: 0,
    destroy: 0,
  };
  let planned: PlanSuccess | null = null;
  let executed: WireStepResult[] = [];

  const summary = (): WireTransportSessionResponse => ({
    ok: true,
    session: {
      baseBlock: SCRIPT_BASE_BLOCK,
      baseBlockHash: SCRIPT_BASE_BLOCK_HASH,
      actor: SCRIPT_ACTOR,
      createdAtMs: SCRIPT_CREATED_AT_MS,
      expiresAtMs: SCRIPT_CREATED_AT_MS + SCRIPT_TTL_MS,
      phase: { kind: "active" },
      planHash: planned === null ? null : SCRIPT_PLAN_HASH,
      planStepCount: planned === null ? null : planned.steps.length,
      txCount: executed.length,
      executed,
      recovery: null,
    },
  });

  const transport: SandboxTransport = {
    create: async () => {
      calls.create += 1;
      const bent = overrides.onCreate?.();
      if (bent !== undefined) return bent;
      return {
        ok: true,
        session: {
          sessionKey: SCRIPT_SESSION_KEY,
          baseBlock: SCRIPT_BASE_BLOCK,
          baseBlockHash: SCRIPT_BASE_BLOCK_HASH,
          actor: SCRIPT_ACTOR,
          createdAtMs: SCRIPT_CREATED_AT_MS,
          expiresAtMs: SCRIPT_CREATED_AT_MS + SCRIPT_TTL_MS,
        },
      };
    },
    plan: async (_sessionKey, document) => {
      calls.plan += 1;
      const bent = overrides.onPlan?.();
      if (bent !== undefined) return bent;
      const decoded = decodeShareGraph(document);
      if (!decoded.ok) return { ok: false, refusal: { kind: "document-refused", failure: decoded.failure } };
      const built = buildPlan(decoded.graph, snapshot);
      if (!built.ok) return { ok: false, refusal: { kind: "plan-refused", errors: built.errors } };
      planned = built;
      executed = [];
      return {
        ok: true,
        plan: {
          planHash: SCRIPT_PLAN_HASH,
          stepCount: built.steps.length,
          steps: built.steps.map((step) => ({ id: step.id, index: step.index })),
        },
      };
    },
    executeStep: async (_sessionKey, _planHash, stepIndex) => {
      calls.executeStep.push(stepIndex);
      if (planned === null) return { ok: false, refusal: { kind: "no-plan" } };
      const record = (result: WireStepResult): void => {
        if (executed[stepIndex] !== undefined) return;
        if (result.status === "attributed" || result.status === "halted") executed.push(result);
      };
      const replay = executed[stepIndex];
      const canonical: WireExecuteResponse =
        replay !== undefined
          ? { ok: true, result: replay }
          : { ok: true, result: wireAttributed(planned, stepIndex) };
      const bent = overrides.onExecuteStep?.(stepIndex, canonical, record);
      const response = bent ?? canonical;
      if (response.ok) record(response.result);
      return response;
    },
    session: async () => {
      calls.session += 1;
      const bent = overrides.onSession?.();
      if (bent !== undefined) return bent;
      return summary();
    },
    reconcile: async () => {
      calls.reconcile += 1;
      const bent = overrides.onReconcile?.();
      if (bent !== undefined) return bent;
      return { ok: false, refusal: { kind: "nothing-to-reconcile" } };
    },
    reset: async () => {
      calls.reset += 1;
      const bent = overrides.onReset?.();
      if (bent !== undefined) return bent;
      planned = null;
      executed = [];
      return summary();
    },
    destroy: async () => {
      calls.destroy += 1;
    },
  };

  return {
    transport,
    calls,
    planned: () => planned,
    executed: () => executed,
  };
}

/** In-memory pointer storage for driver tests. */
export function memoryStorage(): {
  read(): string | null;
  write(value: string): void;
  clear(): void;
  held(): string | null;
} {
  let value: string | null = null;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
    clear: () => {
      value = null;
    },
    held: () => value,
  };
}
