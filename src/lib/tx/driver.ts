/**
 * The sandbox execution driver — the machine's impure counterpart (machine.ts header:
 * "Effects are the DRIVER's ... The machine owns the DECISIONS").
 *
 * Everything money-shaped is decided elsewhere: the machine sequences, compares and
 * refuses; `resume.ts`'s strict parsers gate the wire; the server executes. This module
 * only RELAYS — it calls the transport, hands responses to the adapters
 * (`stepResultFactOf`/`refusalFactOf`), feeds the resulting events to `reduce`, and
 * surfaces every refusal it is handed. It never constructs an amount, never compares two
 * figures, and never invents a state: components render `machine.phase`, and the only
 * driver-owned surface beside it is the transport ledger (`busy`/`fault`) — facts about
 * the WIRE, rendered through the designed-stop grammar (T27), never a fifth execution
 * state.
 *
 * Persistence is a POINTER, not a record: `{sessionKey, planHash}` in storage, nothing
 * else. The session registry is the truth and the client record is a cache of it (§2.2),
 * so a reload rehydrates through `sandbox.session` → `resumePlan` (D11) rather than
 * trusting client memory of the run — a reload mid-recovery lands on the same card
 * because the card renders from the server's payload (A29).
 */
import type { Hex } from "viem";
import type { PlanSuccess } from "../../core/plan";
import {
  createExecutionMachine,
  reduce,
  type ExecutionMachine,
} from "../execution/machine";
import { planHashOf } from "../execution/plan-hash";
import { stepResultClaimMismatch } from "../execution/output-claims";
import { refusalFactOf, resumePlan, stepResultFactOf } from "../execution/resume";
import type {
  DispatchFacts,
  ExecutionEvent,
  ExecutionPhase,
  SandboxRefusalFact,
} from "../execution/types";
import {
  asSessionResponse,
  type SandboxTransport,
  type WireCreatedSession,
  type WirePlanView,
  type WireTransportRefusal,
} from "./transport";

/** Sandbox dispatch facts: the server owns nonce, resolution, approvals and share reads. */
const NULL_FACTS: DispatchFacts = {
  nonce: null,
  resolvedAmountWei: null,
  approval: null,
  beforeShares: null,
};

/** Phases whose next move is a `sandbox.reconcile` call, never a dispatch (D3/D6). */
const RECONCILE_PHASES: ReadonlySet<ExecutionPhase["kind"]> = new Set([
  "attributing",
  "attribution-unavailable",
  "persistence-failed",
  "dispatch-unresolved",
]);

/**
 * Phases a reload-retry may CONTINUE from: the interrupted middle of a run the user
 * already committed. Continuation is discovery plus idempotent replay — never a new
 * commitment and never a blind re-send. Terminal states, `ready`, and `idle` stay put.
 */
const RESUMABLE: ReadonlySet<ExecutionPhase["kind"]> = new Set([
  "pending",
  "attributed",
  "dispatch-vacated",
  "attributing",
  "attribution-unavailable",
  "persistence-failed",
  "dispatch-unresolved",
]);

/** Session facts the chrome states (T29 TTL prose; pre-execute call zone). */
export interface SessionFacts {
  readonly baseBlock: bigint;
  readonly baseBlockHash: string;
  readonly actor: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export type DriverStage = "create" | "plan" | "execute" | "reconcile" | "resume" | "reset";

/**
 * A transport-ledger fault. `retry` names the driver method that resumes: "arm" re-runs
 * the arming sequence, "run" re-enters the step loop, "reload" rehydrates server truth.
 */
export type DriverFault =
  | {
      readonly kind: "refusal";
      readonly stage: DriverStage;
      readonly refusal: SandboxRefusalFact;
      readonly retry: "arm" | "run";
    }
  | {
      readonly kind: "transport-failed";
      readonly stage: DriverStage;
      readonly detail: string;
      readonly retry: "arm" | "reload";
    }
  | {
      readonly kind: "wire-mismatch";
      readonly stage: DriverStage;
      readonly detail: string;
      readonly retry: "reload";
    }
  | { readonly kind: "plan-mismatch"; readonly detail: string; readonly retry: "arm" }
  | { readonly kind: "machine-refused"; readonly detail: string; readonly retry: "reload" };

export interface DriverSnapshot {
  readonly machine: ExecutionMachine;
  readonly busy: DriverStage | null;
  readonly fault: DriverFault | null;
  readonly session: SessionFacts | null;
  /** Wall clock at `plan-ready`, display-only (D9): feeds the T29 "Simulated … · {age}" line. */
  readonly plannedAtMs: number | null;
  /**
   * The driver's clock at the last transition, display-only. Ages render from THIS
   * reading, so they refresh with machine transitions rather than ticking (T29 — a
   * ticking clock is urgency theater), and component render stays pure.
   */
  readonly nowMs: number;
}

export interface PointerStorage {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

const POINTER_KEY = "circuit:tx:session:v1";

/** localStorage wrapped so a denied storage (private mode) degrades to no persistence. */
export function localPointerStorage(storage: Storage): PointerStorage {
  return {
    read() {
      try {
        return storage.getItem(POINTER_KEY);
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        storage.setItem(POINTER_KEY, value);
      } catch {
        // Persistence is best-effort; the run continues un-resumable rather than failing.
      }
    },
    clear() {
      try {
        storage.removeItem(POINTER_KEY);
      } catch {
        // Same contract as write.
      }
    },
  };
}

export interface SessionPointer {
  readonly sessionKey: string;
  /** The SERVER's reconciliation hash, presented on every step call. */
  readonly planHash: Hex;
  /**
   * The LOCAL plan's money-bearing fingerprint (`planHashOf` over the local rebuild),
   * persisted at arm time. Restoration recomputes it from the CURRENT document's plan
   * and refuses to adopt on any difference (Codex hard-gate finding 1): same step IDs
   * with different amounts is a different plan, and rehydration's step-identity checks
   * alone cannot see that.
   */
  readonly fingerprint: Hex;
}

/** Loose mirror of the server's key shape — the server re-validates; this only filters junk. */
const SESSION_KEY_SHAPE = /^[0-9a-f]{16,128}$/;
const PLAN_HASH_SHAPE = /^0x[0-9a-f]{64}$/;
const BASE_BLOCK_SHAPE = /^(?:0|[1-9][0-9]*)$/;

export function encodePointer(pointer: SessionPointer): string {
  return JSON.stringify(pointer);
}

/** Strict parse: a malformed pointer is discarded, never partially trusted. */
export function parsePointer(raw: string | null): SessionPointer | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const sessionKey = (value as { readonly sessionKey?: unknown }).sessionKey;
  const planHash = (value as { readonly planHash?: unknown }).planHash;
  const fingerprint = (value as { readonly fingerprint?: unknown }).fingerprint;
  if (typeof sessionKey !== "string" || !SESSION_KEY_SHAPE.test(sessionKey)) return null;
  if (typeof planHash !== "string" || !PLAN_HASH_SHAPE.test(planHash)) return null;
  if (typeof fingerprint !== "string" || !PLAN_HASH_SHAPE.test(fingerprint)) return null;
  return { sessionKey, planHash: planHash as Hex, fingerprint: fingerprint as Hex };
}

export interface DriverOptions {
  readonly transport: SandboxTransport;
  readonly storage: PointerStorage;
  /** Display-only wall clock (D9). Injected so tests pin it. */
  readonly now?: () => number;
}

interface ArmInput {
  /** The frozen local plan — the SAME reference the canvas rendered (T33/§4.1). */
  readonly plan: PlanSuccess;
  /** The document as the share-codec token — the only form the server accepts (A3). */
  readonly token: string;
}

/** Bounds mid-run transport recoveries so a half-broken network cannot loop the driver. */
const MAX_RUN_RECOVERIES = 3;

/**
 * The session's own rate floor (registry `minExecuteIntervalMs`) fires during a HEALTHY
 * sandbox walk — a local fork settles a simple step faster than the floor — and the
 * refusal names its own remedy (`retryAfterMs`). The driver honours that stated wait
 * and re-dispatches, keeping SPEC §3 step 6 one gesture ("Execute → all steps run")
 * instead of a stop card asking a human to click Retry after single-digit milliseconds.
 * The machine's own contract makes the re-dispatch legal: a transient refusal leaves
 * the run state untouched, still `pending` (machine.test "run state untouched").
 *
 * Both bounds keep the absorption from becoming a livelock. A wait stated beyond
 * `MAX_ABSORBED_RATE_WAIT_MS` (seconds mean something other than the floor is wrong),
 * or more waits than a run can plausibly need, falls through to the designed T27
 * rate-limited stop card exactly as before — the card is the exception path now, not
 * the response to the floor working as configured.
 */
export const MAX_RATE_WAITS_PER_RUN = 32;
export const MAX_ABSORBED_RATE_WAIT_MS = 5_000;

const waitMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const detailOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The two plan-stage refusal kinds the resume mirror deliberately omits. */
const isPlanStageRefusal = (
  refusal: WireTransportRefusal,
): refusal is Extract<WireTransportRefusal, { kind: "document-refused" | "plan-refused" }> =>
  refusal.kind === "document-refused" || refusal.kind === "plan-refused";

export class SandboxDriver {
  private readonly transport: SandboxTransport;
  private readonly storage: PointerStorage;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  private machine: ExecutionMachine = createExecutionMachine({ mode: "sandbox" });
  private busy: DriverStage | null = null;
  private fault: DriverFault | null = null;
  private session: SessionFacts | null = null;
  private plannedAtMs: number | null = null;
  private view: DriverSnapshot;

  private sessionKey: string | null = null;
  /**
   * The plan hash rehydration verifies against, retained BEFORE any lookup so a thrown
   * first restore leaves the reload retry able to run the same pointer-based path
   * (Codex W07 finding 2b). Written at `plan-ready` and at restore; cleared with the
   * pointer.
   */
  private retainedPlanHash: Hex | null = null;
  /** True once the session fork has seen any transaction — a re-arm must reset it first. */
  private forkDirty = false;
  private lastArm: ArmInput | null = null;
  /**
   * The DOCUMENT generation, bumped by every `documentMutated` call whatever the phase. An arm
   * spends its whole flight in `simulating` with no fault to retire, so this counter is the only
   * thing an in-flight attempt can compare itself against to learn that the document it is
   * arming no longer exists (Codex round-6). The server keeps the same kind of counter per
   * session fork (`recordPlan`'s `expectedGeneration`) for the same reason.
   */
  private generation = 0;

  constructor(options: DriverOptions) {
    this.transport = options.transport;
    this.storage = options.storage;
    this.now = options.now ?? (() => Date.now());
    this.view = this.composeView();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): DriverSnapshot => this.view;

  private composeView(): DriverSnapshot {
    return {
      machine: this.machine,
      busy: this.busy,
      fault: this.fault,
      session: this.session,
      plannedAtMs: this.plannedAtMs,
      nowMs: this.now(),
    };
  }

  private notify(): void {
    this.view = this.composeView();
    for (const listener of this.listeners) listener();
  }

  /**
   * Feed one event. A refusal is surfaced as a fault — a stray event is a wiring bug the
   * driver must be able to see (types.ts TransitionRefusal) — except where the caller
   * handles the refusal itself (`step-refused` routing below).
   */
  private dispatch(event: ExecutionEvent): boolean {
    const result = reduce(this.machine, event);
    this.machine = result.machine;
    if (result.refusal !== null) {
      this.fault = {
        kind: "machine-refused",
        detail: `${result.refusal.kind} on ${event.type} in ${this.machine.phase.kind}`,
        retry: "reload",
      };
      this.notify();
      return false;
    }
    this.notify();
    return true;
  }

  private setFault(fault: DriverFault): void {
    this.fault = fault;
    this.notify();
  }

  private begin(stage: DriverStage): boolean {
    if (this.busy !== null) return false;
    this.busy = stage;
    this.fault = null;
    this.notify();
    return true;
  }

  private end(): void {
    this.busy = null;
    this.notify();
  }

  private adoptSessionFacts(created: WireCreatedSession): boolean {
    if (!BASE_BLOCK_SHAPE.test(created.baseBlock)) {
      this.setFault({
        kind: "wire-mismatch",
        stage: "create",
        detail: `create.baseBlock: not an unsigned decimal (${created.baseBlock})`,
        retry: "reload",
      });
      return false;
    }
    this.session = {
      baseBlock: BigInt(created.baseBlock),
      baseBlockHash: created.baseBlockHash,
      actor: created.actor,
      createdAtMs: created.createdAtMs,
      expiresAtMs: created.expiresAtMs,
    };
    return true;
  }

  /**
   * Arm a run: session (create, or reset when the fork is dirty) → server plan → `ready`.
   * One method serves the entry point and every card's recovery action — "Re-simulate"
   * and "Start a fresh session" are this sequence under their T-ruled labels, because a
   * failed or expired run has no resumable prefix (SPEC §6; T24).
   */
  async arm(input: ArmInput): Promise<void> {
    if (!this.begin("plan")) return;
    // Captured at entry, compared after every await: the attempt belongs to THIS document
    // generation and to no other (Codex round-6).
    const generation = this.generation;
    this.lastArm = input;
    try {
      // Recovery is a NEW machine (machine.ts PINNED note): terminal and failed states
      // do not transition out; arming replaces the machine wholesale.
      if (this.machine.phase.kind !== "idle") {
        this.machine = createExecutionMachine({ mode: "sandbox" });
        this.plannedAtMs = null;
      }
      if (!this.dispatch({ type: "simulate" })) return;
      const key = await this.ensureSession();
      if (this.discardStaleArm(generation)) return;
      if (key === null) {
        // ensureSession set the fault; the machine returns to idle honestly.
        this.dispatch({ type: "plan-refused" });
        return;
      }
      await this.planOnSession(key, input, generation);
    } catch (cause) {
      // The same gate on the failure path: a thrown call for a document that is gone must not
      // leave a fault behind whose Retry re-runs the plan the canvas replaced.
      if (this.discardStaleArm(generation)) return;
      this.dispatch({ type: "plan-refused" });
      this.setFault({
        kind: "transport-failed",
        stage: "plan",
        detail: detailOf(cause),
        retry: "arm",
      });
    } finally {
      this.end();
    }
  }

  /**
   * The generation gate for an in-flight arm (Codex round-6).
   *
   * An edit landing DURING the flight is invisible to the round-5 retirement rule: the machine is
   * `simulating` and there is no fault yet, so nothing was recorded — and the attempt then
   * adopted `ready` for the pre-edit plan, or minted an arm fault whose Retry re-ran it.
   *
   * So the attempt is discarded whole, and it is discarded BEFORE anything is adopted, stated or
   * persisted. The machine leaves `simulating` through the same `plan-refused` transition every
   * other failed arm uses, the retained input goes with it (nothing legitimate is left to
   * re-arm), and no fault is minted — the landing is exactly the one the round-5 retirement
   * produces, where the only offer on screen is a fresh arm of the current document.
   *
   * The SESSION is kept rather than destroyed, which is the honest teardown here: nothing was
   * dispatched on its fork, so it is clean, and the next arm reuses it and re-plans — the server
   * accepts that while no step has executed (`recordPlan` overwrites a plan on an entry-free
   * session, and refuses across a fork generation change). It is not orphaned: the driver still
   * holds the key, this is the ruling §2.4 already makes for a mutation at `ready` (the fork is
   * untouched, so the key stays for reuse rather than paying to spawn another), and the registry's
   * TTL reclaims it on either route.
   */
  private discardStaleArm(generation: number): boolean {
    if (this.generation === generation) return false;
    this.lastArm = null;
    // Any fault the discarded attempt already set — a refused create, say — names the dead
    // document too. Dropped BEFORE the transition, so a genuine machine refusal below stands.
    this.fault = null;
    if (this.machine.phase.kind === "simulating") {
      this.dispatch({ type: "plan-refused" });
      return true;
    }
    this.notify();
    return true;
  }

  /** A session key ready to plan on, or null with the fault already set. */
  private async ensureSession(): Promise<string | null> {
    if (this.sessionKey !== null && this.forkDirty) {
      const response = await this.transport.reset(this.sessionKey);
      if (response.ok) {
        this.forkDirty = false;
        const summary = response.session;
        if (BASE_BLOCK_SHAPE.test(summary.baseBlock)) {
          this.session = {
            baseBlock: BigInt(summary.baseBlock),
            baseBlockHash: summary.baseBlockHash,
            actor: summary.actor,
            createdAtMs: summary.createdAtMs,
            expiresAtMs: summary.expiresAtMs,
          };
        }
        return this.sessionKey;
      }
      // A session that cannot reset is not reused: expired, destroyed or reset-failed all
      // resolve to a fresh session — the designed recovery the router names (finding 6).
      this.sessionKey = null;
      this.session = null;
      this.retainedPlanHash = null;
      this.storage.clear();
    }
    if (this.sessionKey !== null) return this.sessionKey;
    const created = await this.transport.create();
    if (!created.ok) {
      if (isPlanStageRefusal(created.refusal)) {
        this.setFault({
          kind: "wire-mismatch",
          stage: "create",
          detail: `unexpected plan-stage refusal on create: ${created.refusal.kind}`,
          retry: "reload",
        });
        return null;
      }
      const parsed = refusalFactOf(created.refusal);
      if (parsed.ok) {
        this.setFault({ kind: "refusal", stage: "create", refusal: parsed.value, retry: "arm" });
      } else {
        this.setFault({
          kind: "wire-mismatch",
          stage: "create",
          detail: parsed.refusal.kind === "malformed-wire" ? parsed.refusal.detail : parsed.refusal.kind,
          retry: "reload",
        });
      }
      return null;
    }
    if (!this.adoptSessionFacts(created.session)) return null;
    this.sessionKey = created.session.sessionKey;
    this.forkDirty = false;
    return this.sessionKey;
  }

  private async planOnSession(
    key: string,
    input: ArmInput,
    generation: number,
  ): Promise<void> {
    const response = await this.transport.plan(key, input.token);
    // Before ANY reading of the response: a plan for a document that is gone is not adopted, not
    // refused in words, and not persisted (Codex round-6).
    if (this.discardStaleArm(generation)) return;
    if (!response.ok) {
      if (isPlanStageRefusal(response.refusal)) {
        // The client's own encode/plan gates passed, so a server-side document or plan
        // refusal means the two sides disagree about the same bytes -- a designed
        // mismatch state, never a guessed number.
        this.dispatch({ type: "plan-refused" });
        this.setFault({
          kind: "plan-mismatch",
          detail:
            response.refusal.kind === "document-refused"
              ? "the server's decode gate refused the document"
              : "the server could not build a plan from the document",
          retry: "arm",
        });
        return;
      }
      const parsed = refusalFactOf(response.refusal);
      if (!parsed.ok) {
        this.dispatch({ type: "plan-refused" });
        this.setFault({
          kind: "wire-mismatch",
          stage: "plan",
          detail: parsed.refusal.kind === "malformed-wire" ? parsed.refusal.detail : parsed.refusal.kind,
          retry: "reload",
        });
        return;
      }
      if (parsed.value.kind === "session-expired") {
        this.dispatch({ type: "session-lost", executedSteps: parsed.value.executedSteps });
        this.retainedPlanHash = null;
        this.storage.clear();
        this.sessionKey = null;
        this.session = null;
        return;
      }
      this.dispatch({ type: "plan-refused" });
      this.setFault({ kind: "refusal", stage: "plan", refusal: parsed.value, retry: "arm" });
      return;
    }
    const mismatch = planAgreementFailure(input.plan, response.plan);
    if (mismatch !== null) {
      this.dispatch({ type: "plan-refused" });
      this.setFault({ kind: "plan-mismatch", detail: mismatch, retry: "arm" });
      return;
    }
    const planHash = response.plan.planHash as Hex;
    if (
      !this.dispatch({
        type: "plan-ready",
        plan: input.plan,
        planHash,
        address: null,
      })
    ) {
      return;
    }
    this.plannedAtMs = this.now();
    this.retainedPlanHash = planHash;
    this.storage.write(
      encodePointer({ sessionKey: key, planHash, fingerprint: planHashOf(input.plan.steps) }),
    );
    this.notify();
  }

  /** The Execute commit (T3a): legal only from `ready`; runs the plan to a settled state. */
  async execute(): Promise<void> {
    if (this.machine.phase.kind !== "ready") return;
    if (!this.begin("execute")) return;
    try {
      await this.runSteps();
    } finally {
      this.end();
    }
  }

  /** Re-enter the step loop after a retryable mid-run refusal (busy, rate-limited). */
  private async continueRun(): Promise<void> {
    if (!this.begin("execute")) return;
    try {
      await this.runSteps();
    } finally {
      this.end();
    }
  }

  private async runSteps(): Promise<void> {
    let recoveries = 0;
    let rateWaits = 0;
    for (;;) {
      const phase = this.machine.phase;
      if (phase.kind === "ready") {
        if (!this.dispatch({ type: "execute", facts: NULL_FACTS })) return;
      } else if (phase.kind === "attributed" || phase.kind === "dispatch-vacated") {
        // `dispatch-vacated`: discovery PROVED nothing landed, the one case where
        // re-dispatch is legal (D6) — and in sandbox there is no signature to wait for.
        if (!this.dispatch({ type: "advance", facts: NULL_FACTS })) return;
      } else if (phase.kind === "pending") {
        const outcome = await this.settleStep(phase.stepIndex, recoveries, rateWaits);
        if (outcome === "stop") return;
        if (outcome === "recovered") recoveries += 1;
        if (outcome === "rate-waited") rateWaits += 1;
      } else if (RECONCILE_PHASES.has(phase.kind)) {
        const outcome = await this.reconcileStep(recoveries);
        if (outcome === "stop") return;
        if (outcome === "recovered") recoveries += 1;
      } else {
        return;
      }
    }
  }

  private async settleStep(
    stepIndex: number,
    recoveries: number,
    rateWaits: number,
  ): Promise<"continue" | "recovered" | "stop" | "rate-waited"> {
    const key = this.sessionKey;
    const planHash = this.machine.planHash;
    if (key === null || planHash === null) {
      this.setFault({
        kind: "machine-refused",
        detail: "pending step without a session or plan hash",
        retry: "reload",
      });
      return "stop";
    }
    this.forkDirty = true;
    let response;
    try {
      response = await this.transport.executeStep(key, planHash, stepIndex);
    } catch (cause) {
      // D6 at this seam: a lost response is NOT "nothing happened" — the server may have
      // executed. Discovery, never assumption: rehydrate server truth and continue.
      return this.recoverRun("execute", cause, recoveries);
    }
    if (response.ok) {
      const parsed = stepResultFactOf(response.result);
      if (!parsed.ok) {
        this.setFault({
          kind: "wire-mismatch",
          stage: "execute",
          detail: parsed.refusal.kind === "malformed-wire" ? parsed.refusal.detail : parsed.refusal.kind,
          retry: "reload",
        });
        return "stop";
      }
      const disagreement = stepResultClaimMismatch(this.machine.plan, this.machine.tolerance, parsed.value);
      if (disagreement !== null) {
        this.setFault({ kind: "wire-mismatch", stage: "execute", detail: disagreement, retry: "reload" });
        return "stop";
      }
      return this.dispatch({ type: "step-result", result: parsed.value }) ? "continue" : "stop";
    }
    if (isPlanStageRefusal(response.refusal)) {
      this.setFault({
        kind: "wire-mismatch",
        stage: "execute",
        detail: `unexpected plan-stage refusal on executeStep: ${response.refusal.kind}`,
        retry: "reload",
      });
      return "stop";
    }
    const parsed = refusalFactOf(response.refusal);
    if (!parsed.ok) {
      this.setFault({
        kind: "wire-mismatch",
        stage: "execute",
        detail: parsed.refusal.kind === "malformed-wire" ? parsed.refusal.detail : parsed.refusal.kind,
        retry: "reload",
      });
      return "stop";
    }
    const refusal = parsed.value;
    if (refusal.kind === "session-expired") {
      this.retainedPlanHash = null;
      this.storage.clear();
    }
    const result = reduce(this.machine, { type: "step-refused", refusal });
    this.machine = result.machine;
    this.notify();
    if (result.refusal === null) return "continue";
    if (result.refusal.kind === "resync-required") {
      return this.recoverRun("execute", new Error(result.refusal.reason), recoveries);
    }
    if (result.refusal.kind === "transport-refusal") {
      if (
        refusal.kind === "rate-limited" &&
        refusal.retryAfterMs <= MAX_ABSORBED_RATE_WAIT_MS &&
        rateWaits < MAX_RATE_WAITS_PER_RUN
      ) {
        // The floor working as configured: honour the refusal's own stated wait, then
        // re-dispatch — the machine held the run at `pending`, so the loop re-enters
        // this same step. Bounded above by the constants' rationale.
        await waitMs(refusal.retryAfterMs);
        return "rate-waited";
      }
      this.setFault({ kind: "refusal", stage: "execute", refusal, retry: "run" });
      return "stop";
    }
    this.setFault({
      kind: "machine-refused",
      detail: `${result.refusal.kind} on step-refused in ${this.machine.phase.kind}`,
      retry: "reload",
    });
    return "stop";
  }

  private async reconcileStep(recoveries: number): Promise<"continue" | "recovered" | "stop"> {
    const key = this.sessionKey;
    if (key === null) {
      this.setFault({
        kind: "machine-refused",
        detail: "reconcile-gated phase without a session",
        retry: "reload",
      });
      return "stop";
    }
    let response;
    try {
      response = await this.transport.reconcile(key);
    } catch (cause) {
      return this.recoverRun("reconcile", cause, recoveries);
    }
    if (response.ok) {
      const parsed = stepResultFactOf(response.result);
      if (!parsed.ok) {
        this.setFault({
          kind: "wire-mismatch",
          stage: "reconcile",
          detail: parsed.refusal.kind === "malformed-wire" ? parsed.refusal.detail : parsed.refusal.kind,
          retry: "reload",
        });
        return "stop";
      }
      const disagreement = stepResultClaimMismatch(this.machine.plan, this.machine.tolerance, parsed.value);
      if (disagreement !== null) {
        this.setFault({ kind: "wire-mismatch", stage: "reconcile", detail: disagreement, retry: "reload" });
        return "stop";
      }
      return this.dispatch({ type: "reconcile-result", result: parsed.value }) ? "continue" : "stop";
    }
    if (isPlanStageRefusal(response.refusal)) {
      this.setFault({
        kind: "wire-mismatch",
        stage: "reconcile",
        detail: `unexpected plan-stage refusal on reconcile: ${response.refusal.kind}`,
        retry: "reload",
      });
      return "stop";
    }
    const parsed = refusalFactOf(response.refusal);
    if (!parsed.ok) {
      this.setFault({
        kind: "wire-mismatch",
        stage: "reconcile",
        detail: parsed.refusal.kind === "malformed-wire" ? parsed.refusal.detail : parsed.refusal.kind,
        retry: "reload",
      });
      return "stop";
    }
    const refusal = parsed.value;
    if (refusal.kind === "session-expired") {
      this.retainedPlanHash = null;
      this.storage.clear();
      // `session-lost` is legal from every reconcile-gated phase (SESSION_LOSABLE).
      this.dispatch({ type: "session-lost", executedSteps: refusal.executedSteps });
      return "stop";
    }
    if (refusal.kind === "session-busy" || refusal.kind === "rate-limited") {
      this.setFault({ kind: "refusal", stage: "reconcile", refusal, retry: "run" });
      return "stop";
    }
    // halted / failed / nothing-to-reconcile: the server has moved past what this client
    // remembers — server truth wins, rehydrated whole (D11).
    return this.recoverRun("reconcile", new Error(`reconcile refused: ${refusal.kind}`), recoveries);
  }

  private async recoverRun(
    stage: DriverStage,
    cause: unknown,
    recoveries: number,
  ): Promise<"recovered" | "stop"> {
    if (recoveries >= MAX_RUN_RECOVERIES) {
      this.setFault({
        kind: "transport-failed",
        stage,
        detail: `recovery budget exhausted: ${detailOf(cause)}`,
        retry: "reload",
      });
      return "stop";
    }
    const rehydrated = await this.rehydrate();
    if (!rehydrated) return "stop";
    return "recovered";
  }

  /**
   * Replace the machine with server truth: `sandbox.session` → `resumePlan`. The frozen
   * plan comes from the live machine or the last arm, the hash from the machine or the
   * retained pointer — never re-derived. `silentStale` is the mount-restore mode: a
   * pointer the current document can no longer vouch for is DISCARDED without a fault
   * (judgment call 6); the fault-retry mode surfaces the same refusal as a wire fault.
   */
  private async rehydrate(
    silentStale = false,
    stillCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    const key = this.sessionKey;
    const plan = this.machine.plan ?? this.lastArm?.plan ?? null;
    const planHash = this.machine.planHash ?? this.retainedPlanHash;
    if (key === null || plan === null || planHash === null) {
      this.setFault({
        kind: "machine-refused",
        detail: "nothing to rehydrate: no session, plan, or plan hash",
        retry: "reload",
      });
      return false;
    }
    let transportResponse;
    try {
      transportResponse = await this.transport.session(key);
    } catch (cause) {
      this.setFault({
        kind: "transport-failed",
        stage: "resume",
        detail: detailOf(cause),
        retry: "reload",
      });
      return false;
    }
    const response = asSessionResponse(transportResponse);
    if (response === null) {
      this.setFault({
        kind: "wire-mismatch",
        stage: "resume",
        detail: "unexpected plan-stage refusal on session lookup",
        retry: "reload",
      });
      return false;
    }
    const outcome = resumePlan({ plan, planHash, response });
    if (!outcome.ok) {
      if (
        outcome.refusal.kind === "unresumable-refusal" &&
        outcome.refusal.refusal === "unknown-session"
      ) {
        // Owner-destroy silence is deliberate (D8): the key is simply unknown; the
        // designed story is a fresh session, not an error.
        this.sessionKey = null;
        this.session = null;
        this.retainedPlanHash = null;
        this.storage.clear();
        this.machine = createExecutionMachine({ mode: "sandbox" });
        this.plannedAtMs = null;
        this.notify();
        return false;
      }
      if (silentStale && outcome.refusal.kind !== "money-claim-mismatch") {
        // Mount restore: the pointer names a run the current document cannot vouch for
        // (hash or identity mismatch). It retires silently — a notice about an
        // invisible run explains nothing. A MONEY-CLAIM mismatch is different: the
        // pointer is not stale (the fingerprint matched); the server's record failed
        // the recompute gate, and evidence of that is never swallowed — it faults.
        this.retainedPlanHash = null;
        this.storage.clear();
        this.notify();
        return false;
      }
      this.setFault({
        kind: "wire-mismatch",
        stage: "resume",
        detail: describeResumeRefusal(outcome.refusal),
        retry: "reload",
      });
      return false;
    }
    if (!stillCurrent()) {
      // The document moved while the lookup was in flight (Codex thread 019fa749
      // finding 2): the run the pointer names belongs to a document no longer on the
      // canvas. Checked immediately BEFORE machine adoption; the pointer retires under
      // the silent-discard ruling and nothing is adopted.
      this.sessionKey = null;
      this.session = null;
      this.retainedPlanHash = null;
      this.storage.clear();
      this.notify();
      return false;
    }
    this.machine = outcome.machine;
    if (response.ok) {
      if (BASE_BLOCK_SHAPE.test(response.session.baseBlock)) {
        this.session = {
          baseBlock: BigInt(response.session.baseBlock),
          baseBlockHash: response.session.baseBlockHash,
          actor: response.session.actor,
          createdAtMs: response.session.createdAtMs,
          expiresAtMs: response.session.expiresAtMs,
        };
      }
      this.forkDirty = response.session.txCount > 0;
    }
    this.notify();
    return true;
  }

  /**
   * Reload-mount restoration (D11): a stored pointer plus the same frozen plan resumes
   * the run server-truth-first, on the SAME pointer-based rehydration path the fault
   * retry uses (Codex W07 finding 2). The session identifiers are retained BEFORE the
   * lookup, so a thrown first lookup leaves the advertised reload retry able to run;
   * and a machine restored into the middle of a committed run CONTINUES it — a
   * partially executed session must never rehydrate into a stuck state with no fault
   * and no affordance.
   */
  async restore(input: ArmInput, stillCurrent: () => boolean = () => true): Promise<void> {
    if (!this.begin("resume")) return;
    this.lastArm = input;
    let resumed = false;
    try {
      const pointer = parsePointer(this.storage.read());
      if (pointer === null) return;
      // Codex hard-gate finding 1: the pointer binds to the MONEY-BEARING fingerprint
      // of the plan that was armed. The current document's plan must recompute to the
      // same hash BEFORE anything is looked up or adopted — step identity alone cannot
      // distinguish same-topology plans with different amounts. A mismatch retires the
      // pointer silently (the stale-pointer ruling): the run it names belongs to a
      // document no longer on the canvas.
      if (planHashOf(input.plan.steps) !== pointer.fingerprint) {
        this.storage.clear();
        return;
      }
      this.sessionKey = pointer.sessionKey;
      this.retainedPlanHash = pointer.planHash;
      resumed = await this.rehydrate(true, stillCurrent);
      if (resumed) this.plannedAtMs = null;
      // Re-checked between adoption and continuation (Codex thread 019fa749 finding
      // 2): a document edit landing in that window un-adopts the machine — nothing may
      // run, or render, plan A while the canvas shows plan B.
      if (resumed && !stillCurrent()) {
        this.machine = createExecutionMachine({ mode: "sandbox" });
        this.sessionKey = null;
        this.session = null;
        this.retainedPlanHash = null;
        this.plannedAtMs = null;
        this.storage.clear();
        this.notify();
        resumed = false;
      }
    } finally {
      this.end();
    }
    if (resumed && RESUMABLE.has(this.machine.phase.kind)) {
      await this.continueRun();
    }
  }

  /**
   * §2.4: a document mutation while `ready` disarms the run — back to idle, with notice.
   *
   * And while idle holding an ARM-family fault, the same mutation retires the RETRY (Codex
   * round-5). `lastArm` is the input `retry()` re-arms from, and a fault card outlives the
   * document it was raised against: an edit followed by Retry opened a session, reset a fork and
   * planned — for the document the canvas no longer shows. Retiring the fault with its input
   * leaves exactly one offer on screen, a fresh arm of the CURRENT document, which is what
   * "Re-simulate" has meant since SPEC §6; nothing is stated because nothing survived to state,
   * and the edit that caused it is the user's own.
   *
   * The other two families survive an edit on purpose: `run` and `reload` name a run the user
   * already committed, whose record the server holds. An edit is not standing to cancel the only
   * route back to that record (D6/D11) — the document changing does not un-execute a step.
   *
   * The generation bump is unconditional and comes first, because the two rules below are about
   * states the mutation can SEE, and an arm in flight is neither of them (round-6,
   * `discardStaleArm`): the notification arrives once, so what it cannot act on now it must at
   * least record.
   */
  documentMutated(): void {
    this.generation += 1;
    if (this.machine.phase.kind === "ready") {
      this.dispatch({ type: "document-mutated" });
      this.plannedAtMs = null;
      // The session fork is untouched (nothing dispatched from ready), so the key is kept
      // for reuse; only the resumable-run pointer retires with the plan it named.
      this.retainedPlanHash = null;
      this.storage.clear();
      this.notify();
      return;
    }
    if (this.fault === null || this.fault.retry !== "arm") return;
    // The pointer stays: it names an earlier COMMITTED run, not this failed arm, and the
    // fingerprint gate in `restore` is what decides whether the current document may adopt it.
    this.lastArm = null;
    this.fault = null;
    this.notify();
  }

  /** Resume the action the current fault names. No fault, no action. */
  async retry(): Promise<void> {
    const fault = this.fault;
    if (fault === null) return;
    if (fault.retry === "arm") {
      if (this.lastArm !== null) await this.arm(this.lastArm);
      return;
    }
    if (fault.retry === "run") {
      await this.continueRun();
      return;
    }
    if (!this.begin("resume")) return;
    let rehydrated = false;
    try {
      rehydrated = await this.rehydrate();
      if (rehydrated) {
        this.fault = null;
        this.notify();
      }
    } finally {
      this.end();
    }
    // A rehydrated machine mid-run CONTINUES the run the user already committed —
    // idempotent replay and discovery, never a re-send. Settled and armed states stop.
    if (rehydrated && RESUMABLE.has(this.machine.phase.kind)) {
      await this.continueRun();
    }
  }
}

/**
 * D4 at the client/server seam: the server's plan must BE the local plan, checked by
 * step identity (id + index agreement), never by field shape. The hashes then reconcile
 * every later call.
 */
export function planAgreementFailure(local: PlanSuccess, wire: WirePlanView): string | null {
  if (!PLAN_HASH_SHAPE.test(wire.planHash)) {
    return `plan hash shape: ${wire.planHash}`;
  }
  if (wire.stepCount !== local.steps.length || wire.steps.length !== local.steps.length) {
    return `step count: server ${wire.stepCount}/${wire.steps.length}, local ${local.steps.length}`;
  }
  for (let i = 0; i < local.steps.length; i += 1) {
    const localStep = local.steps[i];
    const wireStep = wire.steps[i];
    if (localStep === undefined || wireStep === undefined) {
      return `step ${i}: missing on one side`;
    }
    if (wireStep.id !== localStep.id || wireStep.index !== localStep.index) {
      return `step ${i}: server ${wireStep.id}@${wireStep.index}, local ${localStep.id}@${localStep.index}`;
    }
  }
  return null;
}

function describeResumeRefusal(refusal: { readonly kind: string; readonly detail?: string }): string {
  return refusal.detail === undefined ? refusal.kind : `${refusal.kind}: ${refusal.detail}`;
}
