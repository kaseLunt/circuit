import { describe, expect, it } from "vitest";
import { buildPlan, type PlanSuccess } from "../../core/plan";
import { encodeShareGraph } from "../share/encode";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import {
  SCRIPT_ACTOR,
  SCRIPT_PLAN_HASH,
  SCRIPT_SESSION_KEY,
  memoryStorage,
  scriptedSandbox,
  wireAttributed,
  wireHash,
  predictedWeiOf,
  type ScriptOverrides,
} from "../../../tests/helpers/sandbox-transport";
import type { SandboxTransport } from "./transport";
import { stepRequirementsOf } from "../execution/machine";
import { planHashOf } from "../execution/plan-hash";
import { SANDBOX_OUTPUT_TOLERANCE, toleranceWeiFor } from "../execution/tolerance";
import { stepResultFactOf, type WireStepResult } from "../execution/resume";
import { stepResultClaimMismatch } from "../execution/output-claims";
import {
  MAX_ABSORBED_RATE_WAIT_MS,
  MAX_RATE_WAITS_PER_RUN,
  SandboxDriver,
  encodePointer,
  localPointerStorage,
  parsePointer,
  planAgreementFailure,
  type PointerStorage,
} from "./driver";

const graph = flagshipGraph();
const snapshot = fixtureSnapshot();

function localPlan(): PlanSuccess {
  const built = buildPlan(graph, snapshot);
  if (!built.ok) throw new Error("flagship plan failed to build");
  return built;
}

function localToken(): string {
  const encoded = encodeShareGraph(graph);
  if (!encoded.ok) throw new Error("flagship document failed to encode");
  return encoded.token;
}

const plan = localPlan();
const token = localToken();
const armInput = { plan, token };
const FINGERPRINT = planHashOf(plan.steps);

/** First flagship step whose output is attributed from Transfer logs — halt fixture site. */
const transferStepIndex = plan.steps.findIndex(
  (step) => stepRequirementsOf(plan, step).output === "transfer-event",
);

function driverWith(
  sandbox = scriptedSandbox(),
  storage = memoryStorage(),
  now: () => number = () => 5_000,
) {
  const driver = new SandboxDriver({ transport: sandbox.transport, storage, now });
  return { driver, sandbox, storage };
}

describe("pointer codec", () => {
  it("round-trips a valid pointer and refuses junk", () => {
    const pointer = {
      sessionKey: SCRIPT_SESSION_KEY,
      planHash: SCRIPT_PLAN_HASH,
      fingerprint: FINGERPRINT,
    };
    expect(parsePointer(encodePointer(pointer))).toEqual(pointer);
    expect(parsePointer(null)).toBeNull();
    expect(parsePointer("not json")).toBeNull();
    expect(
      parsePointer(
        JSON.stringify({ sessionKey: "zz", planHash: SCRIPT_PLAN_HASH, fingerprint: FINGERPRINT }),
      ),
    ).toBeNull();
    expect(
      parsePointer(
        JSON.stringify({ sessionKey: SCRIPT_SESSION_KEY, planHash: "0x1", fingerprint: FINGERPRINT }),
      ),
    ).toBeNull();
    // A pointer without the money-bearing fingerprint predates the binding — discarded.
    expect(
      parsePointer(JSON.stringify({ sessionKey: SCRIPT_SESSION_KEY, planHash: SCRIPT_PLAN_HASH })),
    ).toBeNull();
    expect(parsePointer(JSON.stringify(42))).toBeNull();
  });
});

describe("planAgreementFailure", () => {
  const view = {
    planHash: SCRIPT_PLAN_HASH,
    stepCount: plan.steps.length,
    steps: plan.steps.map((step) => ({ id: step.id, index: step.index })),
  };

  it("accepts the server's mirror of the local plan", () => {
    expect(planAgreementFailure(plan, view)).toBeNull();
  });

  it("refuses a bad hash shape, a count mismatch, and an identity mismatch", () => {
    expect(planAgreementFailure(plan, { ...view, planHash: "nope" })).toContain("plan hash");
    expect(planAgreementFailure(plan, { ...view, stepCount: 3 })).toContain("step count");
    const swapped = view.steps.map((step, i) =>
      i === 2 ? { id: "someone-else", index: step.index } : step,
    );
    expect(planAgreementFailure(plan, { ...view, steps: swapped })).toContain("step 2");
  });
});

describe("arm", () => {
  it("creates a session, plans, and lands on ready with the pointer persisted", async () => {
    const { driver, storage } = driverWith();
    await driver.arm(armInput);
    const snap = driver.snapshot();
    expect(snap.machine.phase.kind).toBe("ready");
    expect(snap.machine.plan).toBe(plan);
    expect(snap.machine.planHash).toBe(SCRIPT_PLAN_HASH);
    expect(snap.fault).toBeNull();
    expect(snap.plannedAtMs).toBe(5_000);
    expect(snap.session?.actor).toBeDefined();
    expect(parsePointer(storage.held())).toEqual({
      sessionKey: SCRIPT_SESSION_KEY,
      planHash: SCRIPT_PLAN_HASH,
      fingerprint: FINGERPRINT,
    });
  });

  it("surfaces at-capacity as a designed refusal fault and returns to idle", async () => {
    const sandbox = scriptedSandbox({
      onCreate: () => ({ ok: false, refusal: { kind: "at-capacity" } }),
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    const snap = driver.snapshot();
    expect(snap.machine.phase.kind).toBe("idle");
    expect(snap.fault).toMatchObject({ kind: "refusal", stage: "create", retry: "arm" });
  });

  it("refuses a server plan whose step identities differ (D4 at the seam)", async () => {
    const sandbox = scriptedSandbox({
      onPlan: () => ({
        ok: true,
        plan: {
          planHash: SCRIPT_PLAN_HASH,
          stepCount: plan.steps.length,
          steps: plan.steps.map((step) => ({ id: `not-${step.id}`, index: step.index })),
        },
      }),
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    const snap = driver.snapshot();
    expect(snap.machine.phase.kind).toBe("idle");
    expect(snap.fault?.kind).toBe("plan-mismatch");
  });

  it("hands a server-side document refusal a designed mismatch state", async () => {
    const sandbox = scriptedSandbox({
      onPlan: () => ({ ok: false, refusal: { kind: "document-refused", failure: {} } }),
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    expect(driver.snapshot().fault).toMatchObject({ kind: "plan-mismatch", retry: "arm" });
  });

  it("classifies a thrown transport as transport-failed with an arm retry", async () => {
    const sandbox = scriptedSandbox({
      onPlan: () => {
        throw new Error("socket down");
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    const snap = driver.snapshot();
    expect(snap.machine.phase.kind).toBe("idle");
    expect(snap.fault).toMatchObject({ kind: "transport-failed", detail: "socket down", retry: "arm" });
  });

  it("retry re-runs the arm the fault interrupted", async () => {
    let failures = 1;
    const sandbox = scriptedSandbox({
      onPlan: () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("first call lost");
        }
        return undefined;
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    expect(driver.snapshot().fault?.kind).toBe("transport-failed");
    await driver.retry();
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
    expect(driver.snapshot().fault).toBeNull();
  });
});

describe("execute", () => {
  it("runs the full flagship plan to complete, one executeStep per step, in order", async () => {
    const { driver, sandbox } = driverWith();
    await driver.arm(armInput);
    await driver.execute();
    const snap = driver.snapshot();
    expect(snap.machine.phase.kind).toBe("complete");
    expect(snap.machine.record?.settled.length).toBe(plan.steps.length);
    expect(sandbox.calls.executeStep).toEqual(plan.steps.map((_, position) => position));
    expect(snap.fault).toBeNull();
  });

  it("is a no-op outside ready", async () => {
    const { driver, sandbox } = driverWith();
    await driver.execute();
    expect(driver.snapshot().machine.phase.kind).toBe("idle");
    expect(sandbox.calls.executeStep).toEqual([]);
  });

  it("halts at a divergent step and dispatches nothing further (A12)", async () => {
    const halted: WireStepResult = (() => {
      const base = wireAttributed(plan, transferStepIndex);
      if (base.status !== "attributed" || base.output === null) throw new Error("fixture");
      return {
        status: "halted",
        stepIndex: base.stepIndex,
        stepId: base.stepId,
        receipt: base.receipt,
        resolvedAmountWei: null,
        sharesDelta: null,
        halt: {
          kind: "output-divergence",
          stepIndex: base.stepIndex,
          stepId: base.stepId,
          mechanism: base.output.mechanism,
          predictedWei: base.output.predictedWei,
          attributedWei: (BigInt(base.output.predictedWei) * 2n).toString(),
          toleranceWei: base.output.toleranceWei,
          detail: null,
          receipt: base.receipt,
        },
      };
    })();
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) =>
        index === transferStepIndex ? { ok: true, result: halted } : undefined,
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    const snap = driver.snapshot();
    expect(snap.machine.phase).toMatchObject({
      kind: "halted-divergent",
      stepIndex: transferStepIndex,
    });
    expect(sandbox.calls.executeStep.length).toBe(transferStepIndex + 1);
    expect(snap.machine.record?.settled.length).toBe(transferStepIndex);
  });

  it("lands a mined revert on failed-at with the prefix intact and the suffix unsent", async () => {
    const failedAt = 2;
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) => {
        if (index !== failedAt) return undefined;
        const step = plan.steps[failedAt];
        if (step === undefined) throw new Error("fixture");
        return {
          ok: true,
          result: {
            status: "failed",
            failure: {
              stepIndex: failedAt,
              stepId: step.id,
              txHash: wireHash(0xdead),
              decoded: { message: "health factor too low", raw: "0x36", source: "custom-error" },
              raw: "0xdeadbeef",
            },
          },
        };
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    const snap = driver.snapshot();
    expect(snap.machine.phase).toMatchObject({ kind: "failed-at", stepIndex: failedAt, cause: "reverted" });
    expect(snap.machine.record?.settled.length).toBe(failedAt);
    expect(snap.machine.record?.failure?.decoded?.message).toBe("health factor too low");
    expect(sandbox.calls.executeStep.length).toBe(failedAt + 1);
  });

  it("treats session expiry mid-run as abandoned and clears the pointer (T24)", async () => {
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) =>
        index === 4
          ? {
              ok: false,
              refusal: {
                kind: "session-expired",
                executedSteps: 4,
                tombstone: { executedSteps: 4, executed: [], recovery: null },
              },
            }
          : undefined,
    });
    const storage = memoryStorage();
    const { driver } = driverWith(sandbox, storage);
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().machine.phase).toMatchObject({ kind: "abandoned", executedSteps: 4 });
    expect(storage.held()).toBeNull();
  });

  it("surfaces session-busy as a retryable refusal without losing the run", async () => {
    let busyOnce = true;
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) => {
        if (index === 1 && busyOnce) {
          busyOnce = false;
          return { ok: false, refusal: { kind: "session-busy" } };
        }
        return undefined;
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().fault).toMatchObject({ kind: "refusal", retry: "run" });
    expect(driver.snapshot().machine.phase.kind).toBe("pending");
    await driver.retry();
    expect(driver.snapshot().machine.phase.kind).toBe("complete");
    expect(driver.snapshot().fault).toBeNull();
  });

  it("absorbs a rate-limited refusal for its stated wait and completes the run unassisted", async () => {
    let limited = false;
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) => {
        if (index === 1 && !limited) {
          limited = true;
          return { ok: false, refusal: { kind: "rate-limited", retryAfterMs: 1 } };
        }
        return undefined;
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    const snap = driver.snapshot();
    // SPEC §3 step 6 stays one gesture: the floor's refusal named its own remedy and
    // the driver honoured it — no stop card, no human Retry for a stated 1ms wait.
    expect(snap.machine.phase.kind).toBe("complete");
    expect(snap.fault).toBeNull();
    // One extra transport call: the refused attempt, then the honoured re-dispatch.
    expect(sandbox.calls.executeStep.length).toBe(plan.steps.length + 1);
  });

  it("stops with the designed card when the stated wait exceeds the absorption cap", async () => {
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) =>
        index === 1
          ? {
              ok: false,
              refusal: { kind: "rate-limited", retryAfterMs: MAX_ABSORBED_RATE_WAIT_MS + 1 },
            }
          : undefined,
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    // A wait stated in seconds is not the floor working — it is the T27 designed stop,
    // with the run held at pending so Retry can continue it.
    expect(driver.snapshot().fault).toMatchObject({ kind: "refusal", retry: "run" });
    expect(driver.snapshot().machine.phase.kind).toBe("pending");
    expect(sandbox.calls.executeStep.length).toBe(2);
  });

  it("bounds absorbed waits per run — a floor that never opens lands on the designed card", async () => {
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) =>
        index === 1
          ? { ok: false, refusal: { kind: "rate-limited", retryAfterMs: 1 } }
          : undefined,
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().fault).toMatchObject({ kind: "refusal", retry: "run" });
    expect(driver.snapshot().machine.phase.kind).toBe("pending");
    // Step 0's call, MAX_RATE_WAITS_PER_RUN absorbed attempts on step 1, then the
    // attempt that fell through to the card: the absorption is provably bounded.
    expect(sandbox.calls.executeStep.length).toBe(2 + MAX_RATE_WAITS_PER_RUN);
  });

  it("recovers a lost executeStep response by discovery, never by assuming (D6)", async () => {
    let thrown = false;
    const sandbox = scriptedSandbox({
      onExecuteStep: (index, canonical, record) => {
        if (index === 5 && !thrown) {
          thrown = true;
          // The D6 dark case: the server DID execute — the result is committed
          // server-side — and only the response is lost on the wire.
          if (canonical.ok) record(canonical.result);
          throw new Error("response lost");
        }
        return undefined;
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    const snap = driver.snapshot();
    expect(snap.machine.phase.kind).toBe("complete");
    expect(snap.machine.record?.settled.length).toBe(plan.steps.length);
    // The session was consulted for truth, the executed step was adopted from it, and
    // step 5 was never re-sent: exactly one executeStep call carried index 5.
    expect(sandbox.calls.session).toBeGreaterThan(0);
    expect(sandbox.calls.executeStep.filter((index) => index === 5).length).toBe(1);
  });
});

describe("restore and lifecycle", () => {
  it("rehydrates a persisted run from server truth (D11)", async () => {
    const first = driverWith();
    await first.driver.arm(armInput);
    await first.driver.execute();
    expect(first.driver.snapshot().machine.phase.kind).toBe("complete");

    // A new driver over the SAME transport state and storage — the reload.
    const second = new SandboxDriver({
      transport: first.sandbox.transport,
      storage: first.storage,
      now: () => 9_000,
    });
    await second.restore(armInput);
    const snap = second.snapshot();
    expect(snap.machine.phase.kind).toBe("complete");
    expect(snap.machine.record?.settled.length).toBe(plan.steps.length);
    expect(snap.session?.baseBlockHash).toBeDefined();
  });

  it("clears a pointer whose session the server no longer knows (owner-destroy silence)", async () => {
    const storage = memoryStorage();
    storage.write(
      encodePointer({
        sessionKey: SCRIPT_SESSION_KEY,
        planHash: SCRIPT_PLAN_HASH,
        fingerprint: FINGERPRINT,
      }),
    );
    const sandbox = scriptedSandbox({
      onSession: () => ({ ok: false, refusal: { kind: "unknown-session" } }),
    });
    const driver = new SandboxDriver({ transport: sandbox.transport, storage, now: () => 0 });
    await driver.restore(armInput);
    expect(driver.snapshot().machine.phase.kind).toBe("idle");
    expect(storage.held()).toBeNull();
  });

  it("discards a pointer whose plan hash no longer matches the local document", async () => {
    const storage = memoryStorage();
    storage.write(
      encodePointer({
        sessionKey: SCRIPT_SESSION_KEY,
        planHash: `0x${"77".repeat(32)}`,
        fingerprint: FINGERPRINT,
      }),
    );
    const sandbox = scriptedSandbox();
    // Seed the scripted server with a plan so its summary carries SCRIPT_PLAN_HASH.
    const seed = new SandboxDriver({ transport: sandbox.transport, storage: memoryStorage(), now: () => 0 });
    await seed.arm(armInput);
    const driver = new SandboxDriver({ transport: sandbox.transport, storage, now: () => 0 });
    await driver.restore(armInput);
    expect(driver.snapshot().machine.phase.kind).toBe("idle");
    expect(storage.held()).toBeNull();
  });

  it("document mutation at ready disarms the run and retires the pointer (§2.4)", async () => {
    const { driver, storage } = driverWith();
    await driver.arm(armInput);
    driver.documentMutated();
    expect(driver.snapshot().machine.phase.kind).toBe("idle");
    expect(storage.held()).toBeNull();
  });

  it("document mutation anywhere else is a no-op", async () => {
    const { driver } = driverWith();
    driver.documentMutated();
    expect(driver.snapshot().machine.phase.kind).toBe("idle");
  });

  it("a document mutation retires an arm-family fault with the input it would re-arm", async () => {
    let failing = true;
    const sandbox = scriptedSandbox({
      onCreate: () => {
        if (!failing) return undefined;
        throw new Error("the sandbox service did not answer");
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    expect(driver.snapshot().fault).toMatchObject({ kind: "transport-failed", retry: "arm" });
    expect(sandbox.calls.create).toBe(1);

    driver.documentMutated();
    expect(driver.snapshot().fault).toBeNull();

    // The advertised retry named a document that no longer exists, so it reaches no wire: the
    // arm input went with the fault rather than waiting to be re-run against the wrong plan.
    await driver.retry();
    expect(sandbox.calls.create).toBe(1);
    expect(sandbox.calls.reset).toBe(0);
    expect(sandbox.calls.plan).toBe(0);
    expect(driver.snapshot().machine.phase.kind).toBe("idle");

    // What the host still offers works: a fresh arm, of whatever the canvas now holds.
    failing = false;
    await driver.arm(armInput);
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
    expect(sandbox.calls.create).toBe(2);
  });

  it("a document mutation leaves a committed run's own recovery standing", async () => {
    let busyOnce = true;
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) => {
        if (index === 1 && busyOnce) {
          busyOnce = false;
          return { ok: false, refusal: { kind: "session-busy" } };
        }
        return undefined;
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().fault).toMatchObject({ kind: "refusal", retry: "run" });

    // The edit does not un-execute step 1. A mid-run fault is the route back to what the server
    // holds, and cancelling it on a canvas edit would strand the run (D6/D11).
    driver.documentMutated();
    expect(driver.snapshot().fault).toMatchObject({ kind: "refusal", retry: "run" });
    await driver.retry();
    expect(driver.snapshot().machine.phase.kind).toBe("complete");
  });

  it("re-arming after a completed run resets the dirty fork before planning (D8 hygiene)", async () => {
    const { driver, sandbox } = driverWith();
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().machine.phase.kind).toBe("complete");
    await driver.arm(armInput);
    expect(sandbox.calls.reset).toBe(1);
    expect(sandbox.calls.create).toBe(1);
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
  });

  it("reuses a clean session without a reset when re-arming from idle", async () => {
    const { driver, sandbox } = driverWith();
    await driver.arm(armInput);
    driver.documentMutated();
    await driver.arm(armInput);
    expect(sandbox.calls.create).toBe(1);
    expect(sandbox.calls.reset).toBe(0);
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
  });
});

describe("wire fixtures stay honest", () => {
  it("the flagship plan carries at least one transfer-event producer for the halt drill", () => {
    expect(transferStepIndex).toBeGreaterThanOrEqual(0);
    expect(predictedWeiOf(plan, transferStepIndex)).not.toBeNull();
  });
});

describe("reconcile paths (D3/D6)", () => {
  const unavailableAt = (index: number) => {
    const base = wireAttributed(plan, index);
    if (base.status !== "attributed") throw new Error("fixture");
    return {
      status: "attribution-unavailable" as const,
      stepIndex: index,
      stepId: base.stepId,
      receipt: base.receipt,
      beforeShares: "7",
    };
  };

  it("auto-reconciles an attribution-unavailable outcome and completes the run", async () => {
    let bent = true;
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) => {
        if (index === 3 && bent) {
          bent = false;
          return { ok: true, result: unavailableAt(3) };
        }
        return undefined;
      },
      onReconcile: () => ({ ok: true, result: wireAttributed(plan, 3) }),
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().machine.phase.kind).toBe("complete");
    expect(sandbox.calls.reconcile).toBe(1);
    // Reconciliation never re-sent: step 3 was dispatched exactly once.
    expect(sandbox.calls.executeStep.filter((index) => index === 3).length).toBe(1);
  });

  it("a nothing-to-reconcile answer rehydrates server truth and continues", async () => {
    let bent = true;
    const sandbox = scriptedSandbox({
      onExecuteStep: (index, canonical, record) => {
        if (index === 3 && bent) {
          bent = false;
          // The server settled the step; the client got the unresolved cell.
          if (canonical.ok) record(canonical.result);
          return { ok: true, result: unavailableAt(3) };
        }
        return undefined;
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().machine.phase.kind).toBe("complete");
    expect(sandbox.calls.session).toBeGreaterThan(0);
    expect(sandbox.calls.executeStep.filter((index) => index === 3).length).toBe(1);
  });

  it("session expiry during reconciliation abandons with the pointer cleared", async () => {
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) => (index === 2 ? { ok: true, result: unavailableAt(2) } : undefined),
      onReconcile: () => ({
        ok: false,
        refusal: {
          kind: "session-expired",
          executedSteps: 2,
          tombstone: { executedSteps: 2, executed: [], recovery: null },
        },
      }),
    });
    const storage = memoryStorage();
    const { driver } = driverWith(sandbox, storage);
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().machine.phase).toMatchObject({ kind: "abandoned", executedSteps: 2 });
    expect(storage.held()).toBeNull();
  });

  it("a busy reconcile faults retryable and the retry finishes the run", async () => {
    let busyOnce = true;
    let bentOnce = true;
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) => {
        if (index === 2 && bentOnce) {
          bentOnce = false;
          return { ok: true, result: unavailableAt(2) };
        }
        return undefined;
      },
      onReconcile: () => {
        if (busyOnce) {
          busyOnce = false;
          return { ok: false, refusal: { kind: "session-busy" } };
        }
        return { ok: true, result: wireAttributed(plan, 2) };
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().fault).toMatchObject({ kind: "refusal", stage: "reconcile", retry: "run" });
    await driver.retry();
    expect(driver.snapshot().machine.phase.kind).toBe("complete");
  });

  it("a thrown reconcile transport recovers by rehydration", async () => {
    let bentOnce = true;
    let threwOnce = false;
    const sandbox = scriptedSandbox({
      onExecuteStep: (index, canonical, record) => {
        if (index === 2 && bentOnce) {
          bentOnce = false;
          if (canonical.ok) record(canonical.result);
          return { ok: true, result: unavailableAt(2) };
        }
        return undefined;
      },
      onReconcile: () => {
        if (!threwOnce) {
          threwOnce = true;
          throw new Error("socket reset");
        }
        return undefined;
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().machine.phase.kind).toBe("complete");
  });
});

describe("faults, budgets, and reload continuation", () => {
  it("a garbage step result refuses as wire-mismatch; reload rehydrates AND continues", async () => {
    let bentOnce = true;
    const sandbox = scriptedSandbox({
      onExecuteStep: (index, canonical, record) => {
        if (index === 1 && bentOnce) {
          bentOnce = false;
          if (canonical.ok) record(canonical.result);
          return { ok: true, result: { status: "weird" } as never };
        }
        return undefined;
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().fault).toMatchObject({ kind: "wire-mismatch", retry: "reload" });
    await driver.retry();
    const snap = driver.snapshot();
    expect(snap.fault).toBeNull();
    expect(snap.machine.phase.kind).toBe("complete");
    expect(sandbox.calls.executeStep.filter((index) => index === 1).length).toBe(1);
  });

  it("exhausts the recovery budget instead of looping a half-broken network", async () => {
    const sandbox = scriptedSandbox({
      onExecuteStep: () => {
        throw new Error("always down");
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    const fault = driver.snapshot().fault;
    expect(fault).toMatchObject({ kind: "transport-failed", retry: "reload" });
    if (fault === null || fault.kind !== "transport-failed") throw new Error("unreachable");
    expect(fault.detail).toContain("recovery budget exhausted");
  });

  it("hands a server-side plan build refusal a designed mismatch state", async () => {
    const sandbox = scriptedSandbox({
      onPlan: () => ({ ok: false, refusal: { kind: "plan-refused", errors: [] } }),
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    const fault = driver.snapshot().fault;
    expect(fault).toMatchObject({ kind: "plan-mismatch", retry: "arm" });
    if (fault === null || fault.kind !== "plan-mismatch") throw new Error("unreachable");
    expect(fault.detail).toContain("could not build a plan");
  });

  it("a create answering with a malformed base block is refused, never parsed loosely", async () => {
    const sandbox = scriptedSandbox({
      onCreate: () => ({
        ok: true,
        session: {
          sessionKey: SCRIPT_SESSION_KEY,
          baseBlock: "not-a-block",
          baseBlockHash: `0x${"ef".repeat(32)}`,
          actor: `0x${"12".repeat(20)}`,
          createdAtMs: 1,
          expiresAtMs: 2,
        },
      }),
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    expect(driver.snapshot().fault).toMatchObject({ kind: "wire-mismatch", stage: "create" });
    expect(driver.snapshot().machine.phase.kind).toBe("idle");
  });

  it("retry is a no-op without a fault", async () => {
    const { driver } = driverWith();
    await driver.retry();
    expect(driver.snapshot().machine.phase.kind).toBe("idle");
  });
});

describe("session lifecycle edges", () => {
  it("a reset the server refuses resolves to a fresh session", async () => {
    const sandbox = scriptedSandbox({
      onReset: () => ({ ok: false, refusal: { kind: "reset-failed" } }),
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    await driver.arm(armInput);
    expect(sandbox.calls.reset).toBe(1);
    expect(sandbox.calls.create).toBe(2);
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
  });

  it("restore is silent when no pointer is stored", async () => {
    const { driver, sandbox } = driverWith();
    await driver.restore(armInput);
    expect(driver.snapshot().machine.phase.kind).toBe("idle");
    expect(sandbox.calls.session).toBe(0);
  });

  it("restore surfaces an unreachable service as a transport fault", async () => {
    const storage = memoryStorage();
    storage.write(
      encodePointer({
        sessionKey: SCRIPT_SESSION_KEY,
        planHash: SCRIPT_PLAN_HASH,
        fingerprint: FINGERPRINT,
      }),
    );
    const sandbox = scriptedSandbox({
      onSession: () => {
        throw new Error("offline");
      },
    });
    const driver = new SandboxDriver({ transport: sandbox.transport, storage, now: () => 0 });
    await driver.restore(armInput);
    expect(driver.snapshot().fault).toMatchObject({ kind: "transport-failed", stage: "resume" });
  });
});

describe("localPointerStorage", () => {
  function fakeStorage(behaviour: "working" | "throwing"): Storage {
    const held = new Map<string, string>();
    const boom = (): never => {
      throw new Error("denied");
    };
    return {
      get length() {
        return held.size;
      },
      clear: () => held.clear(),
      key: () => null,
      getItem: behaviour === "working" ? (key: string) => held.get(key) ?? null : boom,
      setItem:
        behaviour === "working"
          ? (key: string, value: string) => {
              held.set(key, value);
            }
          : boom,
      removeItem:
        behaviour === "working"
          ? (key: string) => {
              held.delete(key);
            }
          : boom,
    };
  }

  it("round-trips through a working Storage", () => {
    const pointer = localPointerStorage(fakeStorage("working"));
    expect(pointer.read()).toBeNull();
    pointer.write("value");
    expect(pointer.read()).toBe("value");
    pointer.clear();
    expect(pointer.read()).toBeNull();
  });

  it("degrades to no persistence when the Storage throws (private mode)", () => {
    const pointer = localPointerStorage(fakeStorage("throwing"));
    expect(pointer.read()).toBeNull();
    pointer.write("value");
    pointer.clear();
    expect(pointer.read()).toBeNull();
  });
});

describe("reload restoration continues the committed run (Codex fix 2)", () => {
  it("a partial-prefix reload rehydrates AND continues to completion", async () => {
    let blocked = true;
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) =>
        index === 5 && blocked ? { ok: false, refusal: { kind: "session-busy" } } : undefined,
    });
    const first = driverWith(sandbox);
    await first.driver.arm(armInput);
    await first.driver.execute();
    // Five steps settled; the run stopped on a retryable refusal — then the tab reloads.
    expect(first.driver.snapshot().machine.record?.settled.length).toBe(5);
    blocked = false;
    const second = new SandboxDriver({
      transport: sandbox.transport,
      storage: first.storage,
      now: () => 9_000,
    });
    await second.restore(armInput);
    const snap = second.snapshot();
    expect(snap.machine.phase.kind).toBe("complete");
    expect(snap.machine.record?.settled.length).toBe(plan.steps.length);
    // The settled prefix was adopted from server truth, never re-dispatched.
    expect(sandbox.calls.executeStep.filter((index) => index < 5).length).toBe(5);
  });

  it("a recovery-state reload lands on the same card's state and reconciles through", async () => {
    const sandbox = scriptedSandbox({
      onReconcile: () => ({ ok: true, result: wireAttributed(plan, 2) }),
      onSession: () => {
        const executed = [0, 1].map((index) => wireAttributed(plan, index));
        const base = wireAttributed(plan, 2);
        if (base.status !== "attributed") throw new Error("fixture");
        return {
          ok: true,
          session: {
            baseBlock: "23000000",
            baseBlockHash: `0x${"ef".repeat(32)}`,
            actor: `0x${"12".repeat(20)}`,
            createdAtMs: 1_000,
            expiresAtMs: 1_801_000,
            phase: { kind: "attribution-pending", stepIndex: 2 },
            planHash: SCRIPT_PLAN_HASH,
            planStepCount: plan.steps.length,
            txCount: 3,
            executed,
            recovery: {
              kind: "attribution-pending",
              stepIndex: 2,
              stepId: base.stepId,
              receipt: base.receipt,
              resolvedAmountWei: null,
              beforeShares: "7",
              sharesDelta: null,
            },
          },
        };
      },
    });
    // Seed the scripted server's plan so post-reconcile steps replay canonically.
    await sandbox.transport.plan(SCRIPT_SESSION_KEY, token);
    const storage = memoryStorage();
    storage.write(
      encodePointer({
        sessionKey: SCRIPT_SESSION_KEY,
        planHash: SCRIPT_PLAN_HASH,
        fingerprint: FINGERPRINT,
      }),
    );
    const driver = new SandboxDriver({ transport: sandbox.transport, storage, now: () => 0 });
    await driver.restore(armInput);
    expect(sandbox.calls.reconcile).toBe(1);
    expect(driver.snapshot().machine.phase.kind).toBe("complete");
    // Reconciliation and continuation never re-sent the interrupted step.
    expect(sandbox.calls.executeStep.filter((index) => index === 2).length).toBe(0);
  });

  it("a thrown first lookup leaves the retained pointer, and retry rehydrates from it", async () => {
    let offlineOnce = true;
    const sandbox = scriptedSandbox({
      onSession: () => {
        if (offlineOnce) {
          offlineOnce = false;
          throw new Error("offline");
        }
        return undefined;
      },
    });
    // Seed the server with a planned, unexecuted session — a `ready` run to restore.
    const seed = driverWith(sandbox);
    await seed.driver.arm(armInput);
    const driver = new SandboxDriver({
      transport: sandbox.transport,
      storage: seed.storage,
      now: () => 0,
    });
    await driver.restore(armInput);
    expect(driver.snapshot().fault).toMatchObject({ kind: "transport-failed", stage: "resume" });
    await driver.retry();
    const snap = driver.snapshot();
    expect(snap.fault).toBeNull();
    expect(snap.machine.phase.kind).toBe("ready");
  });
});

describe("wire predictions must be the plan's own (Codex fix 3)", () => {
  it("a tampered predicted output is refused as a wire fault before any event is fed", async () => {
    const sandbox = scriptedSandbox({
      onExecuteStep: (index, canonical) => {
        if (index !== 2 || !canonical.ok) return undefined;
        const result = canonical.result;
        if (result.status !== "attributed" || result.output === null) return undefined;
        return {
          ok: true,
          result: {
            ...result,
            output: {
              ...result.output,
              predictedWei: (BigInt(result.output.predictedWei) + 1n).toString(),
            },
          },
        };
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    const snap = driver.snapshot();
    const fault = snap.fault;
    expect(fault).toMatchObject({ kind: "wire-mismatch", stage: "execute", retry: "reload" });
    if (fault === null || fault.kind !== "wire-mismatch") throw new Error("unreachable");
    expect(fault.detail).toContain("disagrees with the plan's flows wrapper");
    // The result was refused BEFORE any event: the machine still awaits step 2's outcome.
    expect(snap.machine.phase).toMatchObject({ kind: "pending", stepIndex: 2 });
    expect(snap.machine.record?.settled.length).toBe(2);
  });

  it("the shared money-claim validator discriminates exactly, tolerance and classification included", () => {
    const attributed = wireAttributed(plan, 2);
    const parsed = stepResultFactOf(attributed);
    if (!parsed.ok) throw new Error("fixture");
    const T = SANDBOX_OUTPUT_TOLERANCE;
    expect(stepResultClaimMismatch(plan, T, parsed.value)).toBeNull();
    expect(stepResultClaimMismatch(null, T, parsed.value)).toBeNull();
    if (parsed.value.status !== "attributed" || parsed.value.output === null) {
      throw new Error("fixture");
    }
    const output = parsed.value.output;
    const tamperedPrediction = {
      ...parsed.value,
      output: { ...output, predictedWei: output.predictedWei + 1n },
    };
    expect(stepResultClaimMismatch(plan, T, tamperedPrediction)).toContain(
      "disagrees with the plan's flows wrapper",
    );
    const widenedTolerance = {
      ...parsed.value,
      output: { ...output, toleranceWei: output.toleranceWei + 1n },
    };
    expect(stepResultClaimMismatch(plan, T, widenedTolerance)).toContain(
      "disagrees with the machine's recomputed bound",
    );
    const outOfBound = {
      ...parsed.value,
      output: { ...output, attributedWei: output.predictedWei * 2n },
    };
    expect(stepResultClaimMismatch(plan, T, outOfBound)).toContain(
      "outside the machine's bound but arrived as attributed",
    );
    const noOutput = { ...parsed.value, output: null };
    expect(stepResultClaimMismatch(plan, T, noOutput)).toBeNull();
  });
});

describe("restoration binds to the money-bearing fingerprint (hard-gate finding 1)", () => {
  it("refuses a same-topology plan with different amounts: B is neither rendered nor executed", async () => {
    const first = driverWith();
    await first.driver.arm(armInput);
    await first.driver.execute();
    expect(first.driver.snapshot().machine.phase.kind).toBe("complete");

    // Plan B: identical step IDs and count, a different input amount — the exact skew
    // rehydration's step-identity checks cannot see.
    const graphB = flagshipGraph("12");
    const planB = buildPlan(graphB, snapshot);
    if (!planB.ok) throw new Error("fixture: plan B failed to build");
    const encodedB = encodeShareGraph(graphB);
    if (!encodedB.ok) throw new Error("fixture: plan B failed to encode");
    expect(planB.steps.map((step) => step.id)).toEqual(plan.steps.map((step) => step.id));
    expect(planHashOf(planB.steps)).not.toBe(planHashOf(plan.steps));

    const sessionCallsBefore = first.sandbox.calls.session;
    const stepCallsBefore = first.sandbox.calls.executeStep.length;
    const second = new SandboxDriver({
      transport: first.sandbox.transport,
      storage: first.storage,
      now: () => 0,
    });
    await second.restore({ plan: planB, token: encodedB.token });
    // The pointer is retired BEFORE any lookup: session A is never adopted under plan
    // B's predictions, and nothing executes.
    expect(second.snapshot().machine.phase.kind).toBe("idle");
    expect(second.snapshot().machine.plan).toBeNull();
    expect(first.sandbox.calls.session).toBe(sessionCallsBefore);
    expect(first.sandbox.calls.executeStep.length).toBe(stepCallsBefore);
    expect(first.storage.held()).toBeNull();
  });

  it("still restores when the document's plan recomputes to the armed fingerprint", async () => {
    const first = driverWith();
    await first.driver.arm(armInput);
    await first.driver.execute();
    const second = new SandboxDriver({
      transport: first.sandbox.transport,
      storage: first.storage,
      now: () => 0,
    });
    // A fresh buildPlan over the same document: new object, same money content.
    await second.restore({ plan: localPlan(), token });
    expect(second.snapshot().machine.phase.kind).toBe("complete");
  });
});

describe("wire tolerance and classification are recomputed (hard-gate finding 2)", () => {
  const bentAt = (
    index: number,
    bend: (result: Extract<WireStepResult, { status: "attributed" }>) => WireStepResult,
  ) =>
    scriptedSandbox({
      onExecuteStep: (stepIndex, canonical) => {
        if (stepIndex !== index || !canonical.ok) return undefined;
        const result = canonical.result;
        if (result.status !== "attributed") return undefined;
        return { ok: true, result: bend(result) };
      },
    });

  it("a widened toleranceWei with a matching prediction is refused before the machine sees it", async () => {
    const sandbox = bentAt(2, (result) => {
      if (result.output === null) throw new Error("fixture");
      return {
        ...result,
        output: {
          ...result.output,
          toleranceWei: (BigInt(result.output.toleranceWei) + 10n ** 18n).toString(),
        },
      };
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    const fault = driver.snapshot().fault;
    expect(fault).toMatchObject({ kind: "wire-mismatch", stage: "execute", retry: "reload" });
    if (fault === null || fault.kind !== "wire-mismatch") throw new Error("unreachable");
    expect(fault.detail).toContain("recomputed bound");
    expect(driver.snapshot().machine.phase).toMatchObject({ kind: "pending", stepIndex: 2 });
    expect(driver.snapshot().machine.record?.settled.length).toBe(2);
  });

  it("an out-of-bound attributedWei arriving as 'attributed' is refused", async () => {
    const sandbox = bentAt(2, (result) => {
      if (result.output === null) throw new Error("fixture");
      return {
        ...result,
        output: {
          ...result.output,
          attributedWei: (BigInt(result.output.predictedWei) * 2n).toString(),
        },
      };
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    const fault = driver.snapshot().fault;
    if (fault === null || fault.kind !== "wire-mismatch") throw new Error("expected wire fault");
    expect(fault.detail).toContain("outside the machine's bound but arrived as attributed");
    expect(driver.snapshot().machine.phase).toMatchObject({ kind: "pending", stepIndex: 2 });
  });

  it("a within-bound attributedWei arriving as an output-divergence halt is refused", async () => {
    const sandbox = bentAt(2, (result) => {
      if (result.output === null) throw new Error("fixture");
      const predicted = BigInt(result.output.predictedWei);
      return {
        status: "halted",
        stepIndex: result.stepIndex,
        stepId: result.stepId,
        receipt: result.receipt,
        resolvedAmountWei: null,
        sharesDelta: null,
        halt: {
          kind: "output-divergence",
          stepIndex: result.stepIndex,
          stepId: result.stepId,
          mechanism: result.output.mechanism,
          predictedWei: result.output.predictedWei,
          attributedWei: predicted.toString(),
          toleranceWei: toleranceWeiFor(predicted, SANDBOX_OUTPUT_TOLERANCE).toString(),
          detail: null,
          receipt: result.receipt,
        },
      };
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    const fault = driver.snapshot().fault;
    if (fault === null || fault.kind !== "wire-mismatch") throw new Error("expected wire fault");
    expect(fault.detail).toContain("within the machine's bound but arrived as a halt");
    // Refused before the machine: no halt was recorded, the step stays unsettled.
    expect(driver.snapshot().machine.record?.halted ?? null).toBeNull();
    expect(driver.snapshot().machine.phase).toMatchObject({ kind: "pending", stepIndex: 2 });
  });
});

describe("the wire-mismatch gate is durable across reload (thread 019fa749 finding 1)", () => {
  const bentSandbox = (
    bend: (result: Extract<WireStepResult, { status: "attributed" }>) => WireStepResult,
  ) =>
    scriptedSandbox({
      onExecuteStep: (stepIndex, canonical) => {
        if (stepIndex !== 2 || !canonical.ok) return undefined;
        const result = canonical.result;
        if (result.status !== "attributed") return undefined;
        // The bend is RECORDED server-side by the script — the invalid result is what
        // the session summary will replay to any rehydration.
        return { ok: true, result: bend(result) };
      },
    });

  const drills: readonly [string, (result: Extract<WireStepResult, { status: "attributed" }>) => WireStepResult, string][] = [
    [
      "widened tolerance",
      (result) => {
        if (result.output === null) throw new Error("fixture");
        return {
          ...result,
          output: {
            ...result.output,
            toleranceWei: (BigInt(result.output.toleranceWei) + 1n).toString(),
          },
        };
      },
      "recomputed bound",
    ],
    [
      "out-of-bound attributed",
      (result) => {
        if (result.output === null) throw new Error("fixture");
        return {
          ...result,
          output: {
            ...result.output,
            attributedWei: (BigInt(result.output.predictedWei) * 2n).toString(),
          },
        };
      },
      "outside the machine's bound",
    ],
    [
      "misclassified halt",
      (result) => {
        if (result.output === null) throw new Error("fixture");
        return {
          status: "halted",
          stepIndex: result.stepIndex,
          stepId: result.stepId,
          receipt: result.receipt,
          resolvedAmountWei: null,
          sharesDelta: null,
          halt: {
            kind: "output-divergence",
            stepIndex: result.stepIndex,
            stepId: result.stepId,
            mechanism: result.output.mechanism,
            predictedWei: result.output.predictedWei,
            attributedWei: result.output.predictedWei,
            toleranceWei: result.output.toleranceWei,
            detail: null,
            receipt: result.receipt,
          },
        };
      },
      "within the machine's bound",
    ],
  ];

  for (const [name, bend, detail] of drills) {
    it(`${name}: reload after the refusal re-refuses — never adopts, never dispatches the suffix`, async () => {
      const sandbox = bentSandbox(bend);
      const { driver } = driverWith(sandbox);
      await driver.arm(armInput);
      await driver.execute();
      const first = driver.snapshot();
      expect(first.fault).toMatchObject({ kind: "wire-mismatch", retry: "reload" });
      expect(first.machine.phase).toMatchObject({ kind: "pending", stepIndex: 2 });
      const callsAfterRefusal = sandbox.calls.executeStep.length;

      // The advertised recovery: Reload session state. The server's session payload
      // carries the SAME invalid persisted result — the gate must hold at this seam too.
      await driver.retry();
      const snap = driver.snapshot();
      const fault = snap.fault;
      expect(fault).toMatchObject({ kind: "wire-mismatch" });
      if (fault === null || fault.kind !== "wire-mismatch") throw new Error("unreachable");
      expect(fault.detail).toContain(detail);
      // Machine NOT replaced, record unchanged, zero suffix dispatches.
      expect(snap.machine.phase).toMatchObject({ kind: "pending", stepIndex: 2 });
      expect(snap.machine.record?.settled.length).toBe(2);
      expect(snap.machine.record?.halted ?? null).toBeNull();
      expect(sandbox.calls.executeStep.length).toBe(callsAfterRefusal);
    });
  }
});

describe("restore is bound to the document generation (thread 019fa749 finding 2)", () => {
  it("an edit while the lookup is in flight adopts nothing and retires the pointer", async () => {
    const first = driverWith();
    await first.driver.arm(armInput);
    await first.driver.execute();
    const stepCalls = first.sandbox.calls.executeStep.length;

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = {
      ...first.sandbox.transport,
      session: async (key: string) => {
        await gate;
        return first.sandbox.transport.session(key);
      },
    };
    const driver = new SandboxDriver({ transport, storage: first.storage, now: () => 0 });
    let current = true;
    const pending = driver.restore(armInput, () => current);
    // The document edit lands while the lookup is still in flight.
    current = false;
    release();
    await pending;

    const snap = driver.snapshot();
    expect(snap.machine.phase.kind).toBe("idle");
    expect(snap.machine.plan).toBeNull();
    expect(snap.fault).toBeNull();
    expect(first.storage.held()).toBeNull();
    expect(first.sandbox.calls.executeStep.length).toBe(stepCalls);
  });
});


/**
 * Codex round-6 — AN ARM IS BOUND TO THE DOCUMENT GENERATION.
 *
 * The round-5 retirement reads state a mutation can SEE: `ready`, or an arm fault already on
 * screen. An arm in flight is neither — the machine sits in `simulating` with no fault yet — so an
 * edit landing between the request and its response went unrecorded, and the attempt then adopted
 * `ready` for the pre-edit plan (executable), or minted a fault whose Retry re-ran it. The
 * notification arrives once, and normal network latency is all the window it needs.
 *
 * Every beat below holds ONE wire call open and lands the edit while it is genuinely out, which is
 * the only way to reach this seam: a transport that answers immediately cannot be interrupted.
 */
/**
 * A transport that HOLDS one verb: the call is announced as asked and its response withheld until
 * the test releases it. Everything else answers through the scripted server unchanged, so the plan
 * agreement and identity checks stay real. Shared by the round-6 and round-7 beats — an edit or a
 * second client can only land mid-flight against a call that is genuinely still out.
 */
function heldSandbox(verb: "create" | "plan", overrides: ScriptOverrides = {}) {
  const inner = scriptedSandbox(overrides);
  let announce!: () => void;
  const asked = new Promise<void>((resolve) => {
    announce = () => resolve();
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const hold = async <T>(run: () => Promise<T>): Promise<T> => {
    announce();
    await released;
    return run();
  };
  const transport: SandboxTransport = {
    ...inner.transport,
    ...(verb === "create"
      ? { create: () => hold(() => inner.transport.create()) }
      : {
          plan: (key: string, document: string) => hold(() => inner.transport.plan(key, document)),
        }),
  };
  return { ...inner, transport, asked, release };
}

describe("an arm is bound to the document generation (round-6)", () => {
  it("adopts ready when nothing edits the document while the plan call is out", async () => {
    const sandbox = heldSandbox("plan");
    const { driver, storage } = driverWith(sandbox);
    const arming = driver.arm(armInput);
    await sandbox.asked;
    expect(driver.snapshot().machine.phase.kind).toBe("simulating");
    sandbox.release();
    await arming;
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
    expect(driver.snapshot().fault).toBeNull();
    expect(storage.held()).not.toBeNull();
  });

  it("adopts nothing when the document changes while the plan call is out and it SUCCEEDS", async () => {
    const sandbox = heldSandbox("plan");
    const { driver, storage } = driverWith(sandbox);
    const arming = driver.arm(armInput);
    await sandbox.asked;

    driver.documentMutated();
    sandbox.release();
    await arming;

    // A plan for a document that is gone may not become executable, and may not be remembered.
    const snap = driver.snapshot();
    expect(snap.machine.phase.kind).toBe("idle");
    expect(snap.machine.plan).toBeNull();
    expect(snap.machine.planHash).toBeNull();
    expect(snap.fault).toBeNull();
    expect(snap.plannedAtMs).toBeNull();
    expect(storage.held()).toBeNull();

    // The session it opened is KEPT — the fresh arm reuses the key rather than paying to spawn
    // another — and what it pins is the CURRENT document's plan.
    //
    // The reset here is round-7 correcting round-6: this beat originally asserted `reset === 0`,
    // on the reasoning that a driver which dispatched nothing leaves a clean fork. That reasoning
    // does not hold for a SHARED session (the key is persisted, a second tab can execute the
    // moment the planning mutex frees), and an uncertified fork reused without a reset is how the
    // `session-dirty` loop below became reachable. The claim was weakened on purpose: one reset
    // this driver may not have needed, instead of a document that cannot be armed at all.
    await driver.arm(armInput);
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
    expect(storage.held()).not.toBeNull();
    expect(sandbox.calls.create).toBe(1);
    expect(sandbox.calls.reset).toBe(1);
    expect(sandbox.calls.plan).toBe(2);
  });

  it("mints no fault when the document changes while the plan call is out and it FAILS", async () => {
    let failing = true;
    const sandbox = heldSandbox("plan", {
      onPlan: () => {
        if (!failing) return undefined;
        throw new Error("the plan call did not answer");
      },
    });
    const { driver, storage } = driverWith(sandbox);
    const arming = driver.arm(armInput);
    await sandbox.asked;

    driver.documentMutated();
    sandbox.release();
    await arming;

    // No card, so no Retry — the offer that would have re-run the dead plan does not exist.
    expect(driver.snapshot().fault).toBeNull();
    expect(driver.snapshot().machine.phase.kind).toBe("idle");
    expect(storage.held()).toBeNull();
    await driver.retry();
    expect(sandbox.calls.plan).toBe(1);
    expect(sandbox.calls.create).toBe(1);

    failing = false;
    await driver.arm(armInput);
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
  });

  it("stops before the plan call when the document changes while the session call is out", async () => {
    const sandbox = heldSandbox("create");
    const { driver, storage } = driverWith(sandbox);
    const arming = driver.arm(armInput);
    await sandbox.asked;

    driver.documentMutated();
    sandbox.release();
    await arming;

    expect(driver.snapshot().machine.phase.kind).toBe("idle");
    expect(driver.snapshot().fault).toBeNull();
    expect(storage.held()).toBeNull();
    // Nothing was planned for the dead document — the gate closed at the first await.
    expect(sandbox.calls.plan).toBe(0);
    expect(sandbox.calls.create).toBe(1);
  });

  it("drops a fault the discarded attempt had already set", async () => {
    const sandbox = heldSandbox("create", {
      onCreate: () => ({ ok: false, refusal: { kind: "at-capacity" } }),
    });
    const { driver } = driverWith(sandbox);
    const arming = driver.arm(armInput);
    await sandbox.asked;

    driver.documentMutated();
    sandbox.release();
    await arming;

    // The refusal was real, but it was refused FOR a document that no longer exists: keeping the
    // card would keep an arm-family Retry pointed at the plan the canvas replaced.
    expect(driver.snapshot().fault).toBeNull();
    expect(driver.snapshot().machine.phase.kind).toBe("idle");
    await driver.retry();
    expect(sandbox.calls.create).toBe(1);
  });
});

/**
 * Codex round-7 — A SHARED FORK'S STATE IS NOT THIS CLIENT'S TO CERTIFY.
 *
 * `forkDirty` used to mean "did I dispatch anything", and the driver read that as "is the fork
 * still pinned at its base". The session key is PERSISTED, so those are different questions: a
 * second tab holding the same key executes the moment the planning mutex frees, and the server then
 * refuses every re-plan `session-dirty` until a reset restores the base (`planForSession`).
 *
 * Both halves of the loop are asserted here. The client stops claiming a fork is clean when it
 * cannot know (the discard marks it dirty), and it honours the refusal's own remedy when the server
 * says the fork moved — without either, the fault's Retry re-sends the same plan call for the same
 * refusal, and the document cannot be armed until a reload or the session's TTL.
 */
describe("a shared fork is never certified clean by this client (round-7)", () => {
  /** The other tab: the same key, the same wire, a step this driver never dispatched. */
  const executeElsewhere = async (transport: SandboxTransport): Promise<void> => {
    const response = await transport.executeStep(SCRIPT_SESSION_KEY, SCRIPT_PLAN_HASH, 0);
    if (!response.ok) throw new Error("the other client's step was refused by the fixture");
  };

  it("resets the fork a discarded arm could no longer vouch for", async () => {
    const sandbox = heldSandbox("plan");
    const { driver, storage } = driverWith(sandbox);
    const arming = driver.arm(armInput);
    await sandbox.asked;

    // The canvas moves while the plan call is out, so this attempt is discarded (round-6) — but
    // the plan it asked for still LANDED server-side, and another client runs a step on it.
    driver.documentMutated();
    sandbox.release();
    await arming;
    await executeElsewhere(sandbox.transport);

    // One arm, one convergence: the reset restores the base the server requires, and the current
    // document reaches ready. Before this, the arm planned on a fork the server called dirty and
    // every Retry repeated the refusal.
    await driver.arm(armInput);
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
    expect(driver.snapshot().fault).toBeNull();
    expect(sandbox.calls.reset).toBe(1);
    expect(sandbox.calls.create).toBe(1);
    expect(storage.held()).not.toBeNull();
  });

  it("converges on a plan-stage session-dirty refusal instead of looping it", async () => {
    const sandbox = scriptedSandbox();
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    expect(driver.snapshot().machine.phase.kind).toBe("ready");

    // The fork moves under a driver that dispatched nothing and therefore believes it is clean.
    await executeElsewhere(sandbox.transport);
    driver.documentMutated();
    await driver.arm(armInput);

    // The refusal is designed and its Retry is offered — the question is whether pressing it can
    // ever succeed.
    expect(driver.snapshot().fault).toMatchObject({
      kind: "refusal",
      stage: "plan",
      retry: "arm",
    });
    expect(driver.snapshot().machine.phase.kind).toBe("idle");
    const plansBefore = sandbox.calls.plan;

    await driver.retry();
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
    expect(driver.snapshot().fault).toBeNull();
    expect(sandbox.calls.reset).toBe(1);
    expect(sandbox.calls.plan).toBe(plansBefore + 1);
  });

  it("falls back to a fresh session when the reset the refusal requires is itself refused", async () => {
    const sandbox = scriptedSandbox({
      onReset: () => ({ ok: false, refusal: { kind: "reset-failed" } }),
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await executeElsewhere(sandbox.transport);
    driver.documentMutated();
    await driver.arm(armInput);
    expect(driver.snapshot().fault).toMatchObject({ kind: "refusal", stage: "plan" });

    // A session that cannot reset is not reused (`ensureSession`): the convergence still happens,
    // one step further out, on a fork nobody else holds.
    await driver.retry();
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
    expect(sandbox.calls.reset).toBe(1);
    expect(sandbox.calls.create).toBe(2);
  });
});

/**
 * Codex round-8 — WHAT A REFUSAL PROVES ABOUT THE RETAINED SESSION.
 *
 * Round-7 taught the client one refusal's remedy (`session-dirty` → reset). But the server refuses
 * on the session PHASE before it ever reaches that check (`planForSession` runs `phaseRefusal`
 * first), so a session another tab left `halted`, `failed` or `reconcile-required` arrived as
 * itself — and every one of those took the unclassified path: the key retained as though clean, an
 * arm-family Retry offered, and that Retry resubmitting the same plan to the same state forever.
 *
 * The mirror defect sat on the reset side. EVERY refused reset discarded the key, including
 * `session-busy`, which proves only that another caller holds the one-at-a-time mutex. Below the
 * cap that leaks a live fork until its TTL; at the cap the create that followed came back
 * `at-capacity`, and the still-live session could no longer be named.
 *
 * Both halves are asserted through the door the user actually has: the fault card's Retry.
 */
describe("a refusal is classified by what it proves (round-8)", () => {
  /** The other tab: one step on the shared key, whose outcome moves the session's phase. */
  const otherClientStep = async (transport: SandboxTransport): Promise<void> => {
    const response = await transport.executeStep(SCRIPT_SESSION_KEY, SCRIPT_PLAN_HASH, 0);
    if (!response.ok) throw new Error(`the other client step was refused: ${response.refusal.kind}`);
  };

  const firstStep = () => {
    const base = wireAttributed(plan, 0);
    if (base.status !== "attributed") throw new Error("fixture");
    return { stepId: base.stepId, receipt: base.receipt };
  };

  /**
   * Arm, let the other tab move the phase, then edit the document — the §2.4 disarm — so the next
   * arm is the ordinary "Re-simulate" a user presses, planning on a session this driver still
   * believes is clean because IT dispatched nothing.
   */
  async function armIntoPhaseRefusal(result: WireStepResult) {
    const sandbox = scriptedSandbox({
      onExecuteStep: (index) => (index === 0 ? { ok: true, result } : undefined),
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
    await otherClientStep(sandbox.transport);
    driver.documentMutated();
    await driver.arm(armInput);
    return { driver, sandbox };
  }

  /** The convergence every phase refusal must reach: one Retry, one reset, no new fork. */
  async function expectRetryConverges(
    driver: SandboxDriver,
    sandbox: { readonly calls: { readonly reset: number; readonly create: number } },
  ): Promise<void> {
    await driver.retry();
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
    expect(driver.snapshot().fault).toBeNull();
    expect(sandbox.calls.reset).toBe(1);
    expect(sandbox.calls.create).toBe(1);
  }

  it("converges out of a first-step revert the other tab left (failed)", async () => {
    const step = firstStep();
    const { driver, sandbox } = await armIntoPhaseRefusal({
      status: "failed",
      failure: {
        stepIndex: 0,
        stepId: step.stepId,
        txHash: wireHash(0xdead),
        decoded: { message: "health factor too low", raw: "0x36", source: "custom-error" },
        raw: "0xdeadbeef",
      },
    });
    // Refused AS a failure: the server's phase check runs before its moved-fork check, and the
    // reset that clears the phase is what the Retry now performs.
    expect(driver.snapshot().fault).toMatchObject({
      kind: "refusal",
      stage: "plan",
      refusal: { kind: "failed" },
      retry: "arm",
    });
    await expectRetryConverges(driver, sandbox);
  });

  it("converges out of a halt the other tab left, refused AS a halt", async () => {
    const step = firstStep();
    const { driver, sandbox } = await armIntoPhaseRefusal({
      status: "halted",
      stepIndex: 0,
      stepId: step.stepId,
      receipt: step.receipt,
      resolvedAmountWei: null,
      sharesDelta: null,
      halt: {
        kind: "residual-allowance",
        stepIndex: 0,
        stepId: step.stepId,
        spender: SCRIPT_ACTOR,
        residualAllowanceWei: "1",
        receipt: step.receipt,
      },
    });
    // The fixture-honesty half of the finding: a halted session must never be laundered into
    // `session-dirty`, or the client is being proven against a server that does not exist.
    expect(driver.snapshot().fault).toMatchObject({
      kind: "refusal",
      stage: "plan",
      refusal: { kind: "halted" },
      retry: "arm",
    });
    await expectRetryConverges(driver, sandbox);
  });

  it("converges out of an unresolved dispatch the other tab left (reconcile-required)", async () => {
    const step = firstStep();
    const { driver, sandbox } = await armIntoPhaseRefusal({
      status: "dispatch-unresolved",
      stepIndex: 0,
      stepId: step.stepId,
      txHash: wireHash(0xbeef),
    });
    // Nothing SETTLED here — the fork has no entries at all — so `session-dirty` could not have
    // fired even in principle: the phase is the only thing that refuses, and so the only thing that
    // could teach the client what to do about it.
    expect(driver.snapshot().fault).toMatchObject({
      kind: "refusal",
      stage: "plan",
      refusal: { kind: "reconcile-required" },
      retry: "arm",
    });
    await expectRetryConverges(driver, sandbox);
  });

  it("retires a key the server no longer knows instead of re-planning it", async () => {
    let unknownOnce = true;
    const sandbox = scriptedSandbox({
      onPlan: () => {
        if (!unknownOnce) return undefined;
        unknownOnce = false;
        return { ok: false, refusal: { kind: "unknown-session" } };
      },
    });
    const { driver, storage } = driverWith(sandbox);
    await driver.arm(armInput);
    expect(driver.snapshot().fault).toMatchObject({
      kind: "refusal",
      stage: "plan",
      refusal: { kind: "unknown-session" },
    });
    // A key the registry will not serve again is not worth resetting and not worth remembering.
    expect(storage.held()).toBeNull();

    await driver.retry();
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
    expect(sandbox.calls.create).toBe(2);
    expect(sandbox.calls.reset).toBe(0);
  });

  it("keeps a live key when the reset is refused BUSY, and converges when the mutex frees", async () => {
    let busyOnce = true;
    let forks = 0;
    const sandbox = scriptedSandbox({
      onReset: () => {
        if (!busyOnce) return undefined;
        busyOnce = false;
        return { ok: false, refusal: { kind: "session-busy" } };
      },
      // The sandbox is AT CAPACITY for a second fork, which is the shape of the defect: a client
      // that discards a live key on a transient refusal cannot get another one, and can no longer
      // name the one it abandoned.
      onCreate: () => {
        forks += 1;
        return forks > 1 ? { ok: false, refusal: { kind: "at-capacity" } } : undefined;
      },
    });
    const { driver } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().machine.phase.kind).toBe("complete");

    // The re-arm resets the fork this driver itself dirtied — and the other caller holds the mutex,
    // so the reset is refused for a reason that says nothing at all about the session.
    await driver.arm(armInput);
    expect(driver.snapshot().fault).toMatchObject({
      kind: "refusal",
      stage: "reset",
      refusal: { kind: "session-busy" },
      retry: "arm",
    });
    // The leak assertion: no second fork was asked for while the first key is alive.
    expect(sandbox.calls.create).toBe(1);
    expect(sandbox.calls.reset).toBe(1);

    await driver.retry();
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
    expect(driver.snapshot().fault).toBeNull();
    expect(sandbox.calls.reset).toBe(2);
    expect(sandbox.calls.create).toBe(1);
  });
});

/**
 * Codex round-9 — A POINTER'S EVIDENCE BINDS TO ONE PLAN.
 *
 * `rehydrate` pairs a plan with a plan hash, and when the machine is empty it takes them from two
 * different places: the plan from `lastArm` (the NEWEST arm) and the hash from `retainedPlanHash`
 * (the run the pointer names). After a failed run is re-simulated those are different plans, and the
 * round-8 reset fallback opened the door — an out-of-contract reset refusal advertises the reload
 * family while retaining the old hash.
 *
 * `restore` had always checked the money-bearing fingerprint before adopting anything; the reload
 * retry never did. Same-topology plans agree step for step, and a session whose only record is a
 * first-step failure has no settled money row left to disagree over — so plan A's run could be
 * adopted, and rendered, under plan B. The check now lives at the pairing itself.
 */
describe("a retained hash binds only to the plan the pointer named (round-9)", () => {
  /** Plan B: the same strategy at a different borrow allocation — same steps, different money. */
  const graphB = flagshipGraph("10", 5_000);
  const planB: PlanSuccess = (() => {
    const built = buildPlan(graphB, snapshot);
    if (!built.ok) throw new Error("plan B failed to build");
    return built;
  })();
  const tokenB: string = (() => {
    const encoded = encodeShareGraph(graphB);
    if (!encoded.ok) throw new Error("document B failed to encode");
    return encoded.token;
  })();
  const armInputB = { plan: planB, token: tokenB };

  /** A first-step revert, and a reset stage that answers out of contract exactly once. */
  function failedRunThenBrokenReset() {
    const base = wireAttributed(plan, 0);
    if (base.status !== "attributed") throw new Error("fixture");
    let outOfContract = true;
    return scriptedSandbox({
      onExecuteStep: (index) =>
        index === 0
          ? {
              ok: true,
              result: {
                status: "failed",
                failure: {
                  stepIndex: 0,
                  stepId: base.stepId,
                  txHash: wireHash(0xdead),
                  decoded: { message: "health factor too low", raw: "0x36", source: "custom-error" },
                  raw: "0xdeadbeef",
                },
              },
            }
          : undefined,
      // `tx-cap` cannot honestly come back from a reset, so the round-8 classifier lands it on
      // wire-mismatch / reload — the one fault family that rehydrates.
      onReset: () => {
        if (!outOfContract) return undefined;
        outOfContract = false;
        return { ok: false, refusal: { kind: "tx-cap" } };
      },
    });
  }

  it("proves its own premise: B is A's topology with different money", () => {
    const identity = (candidate: PlanSuccess) =>
      candidate.steps.map((step) => `${step.id}@${step.index}`);
    expect(identity(planB)).toEqual(identity(plan));
    expect(planHashOf(planB.steps)).not.toBe(planHashOf(plan.steps));
  });

  it("adopts no evidence from the run the pointer named when the plan has moved on", async () => {
    const sandbox = failedRunThenBrokenReset();
    const { driver, storage } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().machine.phase).toMatchObject({ kind: "failed-at", stepIndex: 0 });
    expect(storage.held()).not.toBeNull();

    // The user re-simulates the EDITED document, and the reset stage answers out of contract: the
    // fault offers "Reload session state" while the retained hash still belongs to plan A.
    await driver.arm(armInputB);
    expect(driver.snapshot().fault).toMatchObject({
      kind: "wire-mismatch",
      stage: "reset",
      retry: "reload",
    });

    await driver.retry();

    // The claim, first: plan A's run is not adopted, so nothing of A's can be rendered against B.
    expect(driver.snapshot().machine.phase.kind).toBe("idle");
    expect(driver.snapshot().machine.record).toBeNull();
    expect(driver.snapshot().machine.planHash).toBeNull();
    expect(driver.snapshot().machine.plan).toBeNull();
    expect(driver.snapshot().fault).toBeNull();
    // And its corollary: nothing was even looked up, because no answer to that lookup could have
    // been legally adopted — asking only produces another plan's evidence to render against this one.
    expect(sandbox.calls.session).toBe(0);
    // The pointer retires with the binding it can no longer honour.
    expect(storage.held()).toBeNull();

    // What remains on offer is a fresh arm of the document on the canvas, and it is B that arms.
    await driver.arm(armInputB);
    expect(driver.snapshot().machine.phase.kind).toBe("ready");
    const served = sandbox.planned();
    if (served === null) throw new Error("the scripted server planned nothing");
    expect(planHashOf(served.steps)).toBe(planHashOf(planB.steps));
  });

  /**
   * The scope of the gate, pinned (it is a decision, so it is asserted rather than assumed).
   *
   * The binding is demanded only when the plan comes from the FALLBACK. A live machine's plan and
   * hash were adopted together at `plan-ready` and cannot disagree, and demanding a pointer for them
   * would break mid-run recovery wherever there IS no pointer: `localPointerStorage` degrades to no
   * persistence in a private window, so a lost response during a committed run would strand a
   * session the server can still account for — D6 discovery traded away for a check that had nothing
   * to check.
   */
  it("recovers a committed run by rehydration with no pointer in storage at all", async () => {
    let lostOnce = true;
    const sandbox = scriptedSandbox({
      onExecuteStep: (index, canonical, record) => {
        if (index === 2 && lostOnce) {
          lostOnce = false;
          // The server executed and the RESPONSE was lost: the D6 dark case, recovered by
          // discovery through `sandbox.session`.
          if (canonical.ok) record(canonical.result);
          throw new Error("the response never arrived");
        }
        return undefined;
      },
    });
    const denied: PointerStorage = { read: () => null, write: () => undefined, clear: () => undefined };
    const driver = new SandboxDriver({ transport: sandbox.transport, storage: denied, now: () => 5_000 });
    await driver.arm(armInput);
    await driver.execute();
    expect(driver.snapshot().machine.phase.kind).toBe("complete");
    expect(sandbox.calls.session).toBeGreaterThan(0);
  });

  it("still rehydrates the reload family when the pointer vouches for the plan", async () => {
    const sandbox = failedRunThenBrokenReset();
    const { driver, storage } = driverWith(sandbox);
    await driver.arm(armInput);
    await driver.execute();

    // The same document, re-simulated: nothing has moved, so the pointer still vouches and the
    // reload path is the discovery it has always been.
    await driver.arm(armInput);
    expect(driver.snapshot().fault).toMatchObject({
      kind: "wire-mismatch",
      stage: "reset",
      retry: "reload",
    });

    await driver.retry();
    expect(sandbox.calls.session).toBe(1);
    expect(storage.held()).not.toBeNull();
    expect(driver.snapshot().machine.phase.kind).not.toBe("idle");
    expect(driver.snapshot().fault).toBeNull();
  });
});
