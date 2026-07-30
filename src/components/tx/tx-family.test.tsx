/** @vitest-environment jsdom */
// The tx family, asserted against its rulings: the T7 glyph vocabulary, the T1/T3/T4/T22
// chroma budget as DOM facts, the T17 achromatic stop, the T20 trichotomy, the T31 single
// narrator, and the T25/T33 gating contract. Fixtures reduce the REAL flagship plan
// through the real machine — no hand-built states the machine could not produce.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Wallet } from "lucide-react";
import type { Hex } from "viem";
import { buildPlan, type PlanSuccess } from "../../core/plan";
import { riskLedger, simulate } from "../../core/risk";
import { formatUnits, formatWadAsPercent } from "../../core/format";
import { encodeShareGraph } from "../../lib/share/encode";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import {
  memoryStorage,
  scriptedSandbox,
  wireAttributed,
} from "../../../tests/helpers/sandbox-transport";
import {
  createExecutionMachine,
  reduce,
  type ExecutionMachine,
} from "../../lib/execution/machine";
import { planHashOf } from "../../lib/execution/plan-hash";
import { stepResultFactOf } from "../../lib/execution/resume";
import type { ExecutionEvent } from "../../lib/execution/types";
import { receiptMinter } from "../../lib/execution/attribution";
import { SANDBOX_OUTPUT_TOLERANCE } from "../../lib/execution/tolerance";
import type { HaltFact, ReceiptRef } from "../../lib/execution/types";
import { SandboxDriver, type DriverSnapshot, type SessionFacts } from "../../lib/tx/driver";
import { ComposerStoreProvider } from "../../app/store/composer-provider";
import { createComposerStore } from "../../app/store/composer-store";
import { flagshipStore } from "../composer/arrival";
import { ExecutionFlow, FaultCard } from "./execution-flow";
import { ExecutionHost } from "./execution-host";
import { FailureCard } from "./failure-card";
import { HaltCard } from "./halt-card";
import { StepList } from "./step-list";
import { StopCard } from "./stop-card";
import { TransactionButton } from "./transaction-button";

afterEach(cleanup);

const PLAN_HASH = `0x${"cd".repeat(32)}` as Hex;
const graph = flagshipGraph();
const snapshot = fixtureSnapshot();

const plan: PlanSuccess = (() => {
  const built = buildPlan(graph, snapshot);
  if (!built.ok) throw new Error("flagship plan failed to build");
  return built;
})();

const token: string = (() => {
  const encoded = encodeShareGraph(graph);
  if (!encoded.ok) throw new Error("flagship document failed to encode");
  return encoded.token;
})();

const N = plan.steps.length;
const NULL_FACTS = { nonce: null, resolvedAmountWei: null, approval: null, beforeShares: null };

function ok(machine: ExecutionMachine, event: ExecutionEvent): ExecutionMachine {
  const result = reduce(machine, event);
  if (result.refusal !== null) throw new Error(`refused: ${result.refusal.kind}`);
  return result.machine;
}

function readyMachine(): ExecutionMachine {
  let machine = createExecutionMachine({ mode: "sandbox" });
  machine = ok(machine, { type: "simulate" });
  return ok(machine, { type: "plan-ready", plan, planHash: PLAN_HASH, address: null });
}

function settled(machine: ExecutionMachine, index: number): ExecutionMachine {
  const parsed = stepResultFactOf(wireAttributed(plan, index));
  if (!parsed.ok) throw new Error("wire fixture failed to parse");
  return ok(machine, { type: "step-result", result: parsed.value });
}

function settledThrough(count: number): ExecutionMachine {
  let machine = readyMachine();
  for (let index = 0; index < count; index += 1) {
    machine = ok(machine, index === 0 ? { type: "execute", facts: NULL_FACTS } : { type: "advance", facts: NULL_FACTS });
    machine = settled(machine, index);
  }
  return machine;
}

const sessionFacts: SessionFacts = {
  baseBlock: 23_000_000n,
  baseBlockHash: `0x${"ef".repeat(32)}`,
  actor: `0x${"12".repeat(20)}`,
  createdAtMs: 1_000,
  expiresAtMs: 1_801_000,
};

function driverSnapshot(machine: ExecutionMachine, plannedAtMs: number | null = 1_000): DriverSnapshot {
  return { machine, busy: null, fault: null, session: sessionFacts, plannedAtMs, nowMs: 61_000 };
}

const RECOVER = { label: "Re-simulate", onAct: () => undefined, gateReason: null };

const flowProps = {
  plan,
  planActor: snapshot.user.address,
  simulation: null,
  checkpoints: null,
  simulatedAtBlock: snapshot.block,
  nowMs: 61_000,
  onExecute: () => undefined,
  onRearm: () => undefined,
  onRetryFault: () => undefined,
};

const chromaIn = (root: Element): number =>
  root.querySelectorAll(
    '[class*="text-destructive"], [class*="text-warning"], [class*="text-success"], [class*="text-primary"], [class*="bg-primary"], [class*="bg-destructive"]',
  ).length;

describe("TransactionButton (T25/T33)", () => {
  it("gated: aria-disabled with a reachable reason, click intercepted — never disabled", () => {
    const onClick = vi.fn();
    render(
      <TransactionButton onClick={onClick} gateReason="the residual simulation has not rendered">
        Continue
      </TransactionButton>,
    );
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    const reasonId = button.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    if (reasonId === null) throw new Error("unreachable");
    expect(document.getElementById(reasonId)?.textContent).toBe(
      "the residual simulation has not rendered",
    );
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("ungated primary is the terminal-commit variant and fires", () => {
    const onClick = vi.fn();
    render(
      <TransactionButton onClick={onClick} variant="primary">
        Execute
      </TransactionButton>,
    );
    const button = screen.getByRole("button", { name: "Execute" });
    expect(button.className).toContain("bg-primary");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("StepList — rows and the chroma budget", () => {
  it("all rows exist at ready with zero chroma and no spinner (T1/T11)", () => {
    const { container } = render(
      <StepList plan={plan} machine={readyMachine()} reconciling={false} recover={RECOVER} />,
    );
    expect(screen.getAllByRole("listitem").length).toBe(N);
    expect(container.querySelector(".step-spinner")).toBeNull();
    expect(container.querySelectorAll('[class*="text-success"]').length).toBe(0);
    expect(container.querySelectorAll('[class*="text-destructive"]').length).toBe(0);
    expect(screen.getAllByText(/bound to step \d+/).length).toBeGreaterThan(0);
  });

  it("the active row carries THE one spinner, text-primary, linear licence (T2/T3)", () => {
    let machine = settledThrough(2);
    machine = ok(machine, { type: "advance", facts: NULL_FACTS });
    const { container } = render(
      <StepList plan={plan} machine={machine} reconciling={false} recover={RECOVER} />,
    );
    const spinners = container.querySelectorAll(".step-spinner");
    expect(spinners.length).toBe(1);
    expect(spinners[0]?.getAttribute("class")).toContain("text-primary");
  });

  it("settled rows: one green Check each, PREDICTED/ATTRIBUTED pair in the detail (T4/T10)", () => {
    const machine = settledThrough(3);
    const { container } = render(
      <StepList plan={plan} machine={machine} reconciling={false} recover={RECOVER} />,
    );
    expect(container.querySelectorAll('[class*="text-success"]').length).toBe(3);
    expect(screen.getAllByText("Predicted").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Attributed").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Copy transaction hash").length).toBeGreaterThan(0);
    // Column slots use the PANEL surface (gif-capture defect): disclosure triggers
    // (aria-expanded), never the floating tooltip a 320px clipping aside cannot fit.
    const triggers = container.querySelectorAll("button[aria-expanded]");
    expect(triggers.length).toBeGreaterThan(0);
    fireEvent.click(triggers[0] as HTMLElement);
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(screen.getByRole("group", { name: /provenance/i })).not.toBeNull();
  });

  it("a mined revert renders the T20 trichotomy and the T21 card, focus on recovery", () => {
    let machine = settledThrough(2);
    machine = ok(machine, { type: "advance", facts: NULL_FACTS });
    const step = plan.steps[2];
    if (step === undefined) throw new Error("fixture");
    machine = ok(machine, {
      type: "step-result",
      result: {
        status: "failed",
        failure: {
          stepIndex: 2,
          stepId: step.id,
          txHash: `0x${"11".repeat(32)}` as Hex,
          decoded: { message: "health factor too low", raw: "0x36", source: "custom-error" },
          raw: "0xdeadbeef",
        },
      },
    });
    const { container } = render(
      <StepList plan={plan} machine={machine} reconciling={false} recover={RECOVER} />,
    );
    expect(screen.getByText("health factor too low")).not.toBeNull();
    expect(screen.getByText("0xdeadbeef")).not.toBeNull();
    expect(screen.getByLabelText("Copy raw error")).not.toBeNull();
    expect(container.querySelector(".border-destructive")).not.toBeNull();
    // The unexecuted suffix: N - 3 rows say "not sent" as prose, never a dash or zero.
    expect(screen.getAllByText("not sent").length).toBe(N - 3);
    // SPEC §6: focus moved to the recovery action.
    expect(document.activeElement?.textContent).toBe("Re-simulate");
  });

  it("halted-divergent is the achromatic maximum-contrast stop (T17), both truths kept", () => {
    let machine = settledThrough(2);
    machine = ok(machine, { type: "advance", facts: NULL_FACTS });
    const step = plan.steps[2];
    if (step === undefined) throw new Error("fixture");
    const base = wireAttributed(plan, 2);
    if (base.status !== "attributed" || base.output === null) throw new Error("fixture");
    const parsed = stepResultFactOf({
      status: "halted",
      stepIndex: 2,
      stepId: step.id,
      receipt: base.receipt,
      resolvedAmountWei: null,
      sharesDelta: null,
      halt: {
        kind: "output-divergence",
        stepIndex: 2,
        stepId: step.id,
        mechanism: base.output.mechanism,
        predictedWei: base.output.predictedWei,
        attributedWei: (BigInt(base.output.predictedWei) * 3n).toString(),
        toleranceWei: base.output.toleranceWei,
        detail: null,
        receipt: base.receipt,
      },
    });
    if (!parsed.ok) throw new Error("fixture");
    machine = ok(machine, { type: "step-result", result: parsed.value });
    const { container } = render(
      <StepList plan={plan} machine={machine} reconciling={false} recover={RECOVER} />,
    );
    const card = container.querySelector(".border-foreground");
    expect(card).not.toBeNull();
    if (card === null) throw new Error("unreachable");
    // T36.9: the collision was ruled — zero chroma anywhere on the halt card.
    expect(chromaIn(card)).toBe(0);
    expect(screen.getByText(/HALTED — step 3 output diverged/)).not.toBeNull();
    expect(card.textContent).toContain("Predicted");
    expect(card.textContent).toContain("Attributed");
    expect(card.textContent).toContain("Tolerance");
    // Codex fix 4: the delta is a derived quantity over both source wrappers, rendered
    // through SourcedValue — attributed was predicted × 3, so delta = 2 × predicted.
    expect(card.textContent).toContain("Delta");
    expect(
      screen.getByRole("button", {
        name: formatUnits(BigInt(base.output.predictedWei) * 2n, 18, 6),
      }),
    ).not.toBeNull();
    expect(screen.getByText("transaction confirmed")).not.toBeNull();
    expect(screen.getByText("attribution diverged")).not.toBeNull();
    // T19: no dismiss affordance exists — the only button is the recovery action.
    const cardButtons = Array.from(card.querySelectorAll("button")).map(
      (button) => button.textContent,
    );
    expect(cardButtons.filter((label) => label === "Re-simulate").length).toBe(1);
    expect(cardButtons).not.toContain("Close");
    expect(cardButtons).not.toContain("Dismiss");
  });
});

describe("ExecutionFlow — the container and its narrator", () => {
  it("ready: no region of its own (the host narrates, T31), the one primary Execute (T3a)", () => {
    const { container } = render(
      <ExecutionFlow {...flowProps} snapshot={driverSnapshot(readyMachine())} />,
    );
    expect(container.querySelectorAll('[role="status"]').length).toBe(0);
    const execute = screen.getByRole("button", { name: "Execute" });
    expect(execute.className).toContain("bg-primary");
    expect(container.querySelectorAll('[class*="bg-primary"]').length).toBe(1);
    expect(screen.getByText(`Execute ${N} steps on the session fork`)).not.toBeNull();
    expect(screen.getByText(/Simulated at block/)).not.toBeNull();
    expect(screen.getByText(/1m 00s ago/)).not.toBeNull();
    expect(screen.getByText(/This session expires 30m 00s after creation/)).not.toBeNull();
  });

  it("past ready the header carries the sandbox badge line verbatim (T28)", () => {
    let machine = settledThrough(1);
    machine = ok(machine, { type: "advance", facts: NULL_FACTS });
    render(<ExecutionFlow {...flowProps} snapshot={driverSnapshot(machine)} />);
    expect(screen.getByText("No signatures in sandbox")).not.toBeNull();
    expect(screen.getByText(`step 2 of ${N}`)).not.toBeNull();
  });

  it("abandoned renders the T24 card with its one action", () => {
    const machine = ok(settledThrough(2), { type: "session-lost", executedSteps: 2 });
    render(<ExecutionFlow {...flowProps} snapshot={driverSnapshot(machine)} />);
    expect(screen.getByText("This session expired.")).not.toBeNull();
    expect(screen.getByText(/Steps 1–2 executed on its fork before expiry/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Start a fresh session" })).not.toBeNull();
  });

  it("complete is the still receipt: N+1 green glyphs and not one more (T4/T23)", async () => {
    const sandbox = scriptedSandbox();
    const driver = new SandboxDriver({
      transport: sandbox.transport,
      storage: memoryStorage(),
      now: () => 1_000,
    });
    await driver.arm({ plan, token });
    await driver.execute();
    const simulation = simulate(graph, snapshot, {});
    const { container } = render(
      <ExecutionFlow {...flowProps} simulation={simulation} snapshot={driver.snapshot()} />,
    );
    expect(screen.getByText("Execution complete")).not.toBeNull();
    expect(container.querySelectorAll('[class*="text-success"]').length).toBe(N + 1);
    expect(container.querySelectorAll('[class*="text-destructive"]').length).toBe(0);
    expect(container.querySelector(".step-spinner")).toBeNull();
    // The §5.4 cross-check made visible: both labels render; the scripted server sent no
    // per-step risk reading, so the CHAIN column states that absence explicitly.
    expect(screen.getByText("Chain")).not.toBeNull();
    expect(screen.getAllByText("Predicted").length).toBeGreaterThan(0);
    expect(screen.getByText("no chain reading in the record")).not.toBeNull();
    expect(screen.getByText(/forked-mainnet demo/)).not.toBeNull();
    // The receipt's evidence slots are disclosure-mode too (gif-capture defect).
    expect(container.querySelectorAll("button[aria-expanded]").length).toBeGreaterThan(0);
  });
});

describe("ExecutionHost — the composer integration, end to end", () => {
  function hostUnderTest(overrides: Parameters<typeof scriptedSandbox>[0] = {}) {
    const sandbox = scriptedSandbox(overrides);
    const storage = memoryStorage();
    const store = flagshipStore();
    const view = render(
      <ComposerStoreProvider store={store}>
        <ExecutionHost
          snapshot={{ status: "ready", snapshot }}
          simulation={null}
          simulationPending={false}
          transport={sandbox.transport}
          storage={storage}
          now={() => 1_000}
        />
      </ComposerStoreProvider>,
    );
    return { sandbox, storage, store, view };
  }

  it("drives review → execute → complete against the scripted sandbox", async () => {
    const { sandbox, storage } = hostUnderTest();
    // Idle: the simulation panel column plus the entry affordance.
    expect(document.querySelector('aside[aria-label="Simulation"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review & execute in sandbox" }));
    const execute = await screen.findByRole("button", { name: "Execute" });
    expect(document.querySelector('aside[aria-label="Execution"]')).not.toBeNull();
    expect(document.querySelector('aside[aria-label="Simulation"]')).toBeNull();
    expect(storage.held()).not.toBeNull();
    fireEvent.click(execute);
    await screen.findByText("Execution complete");
    expect(sandbox.calls.executeStep.length).toBe(N);
    // T31: the execution column is the single narrator on screen.
    expect(document.querySelectorAll('[role="status"]').length).toBe(1);
  });

  it("renders a capacity refusal as the T27 designed stop with its retry", async () => {
    hostUnderTest({ onCreate: () => ({ ok: false, refusal: { kind: "at-capacity" } }) });
    fireEvent.click(screen.getByRole("button", { name: "Review & execute in sandbox" }));
    await screen.findByText("The sandbox is at capacity.");
    // The mechanism renders on the card AND is spoken by the narrator (Codex fix 6).
    expect(
      screen.getAllByText(/Sessions are capped so each gets an isolated fork/).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
    // The refusal landed the machine back on idle — the simulation panel stays.
    expect(document.querySelector('aside[aria-label="Simulation"]')).not.toBeNull();
  });

  /**
   * Codex round-5, the adjacent half: a fault card outlives the document it was raised against.
   * An arming refusal lands the machine back on idle, so §2.4's disarm path returned early and
   * the driver kept the arm input it would re-run — an edit followed by Retry opened a session,
   * reset the fork and planned, for the plan the canvas had already replaced. The mutation
   * retires the offer with the plan it belonged to; what remains is the §6 control, which reads
   * the document now on screen.
   */
  it("retires a fault's Retry when the document changes under it (round-5)", async () => {
    let atCapacity = true;
    const { sandbox, store } = hostUnderTest({
      onCreate: () => {
        if (!atCapacity) return undefined;
        return { ok: false, refusal: { kind: "at-capacity" } };
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review & execute in sandbox" }));
    await screen.findByText("The sandbox is at capacity.");
    expect(sandbox.calls.create).toBe(1);
    const faulted = buildPlan(store.getState().doc, snapshot);
    if (!faulted.ok) throw new Error("the flagship must plan");

    // SPEC §3.3's own gesture: the borrow allocation moves 50% → 70%.
    act(() => {
      expect(store.getState().setBorrowAllocationBps("borrow", 7_000)).toEqual({ ok: true });
    });
    atCapacity = false;

    // The card went with the plan it was about, so there is no Retry left to press — and the
    // edit itself asked nothing of the wire.
    await waitFor(() => {
      expect(screen.queryByText("The sandbox is at capacity.")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(sandbox.calls.create).toBe(1);
    expect(sandbox.calls.reset).toBe(0);
    expect(sandbox.calls.plan).toBe(0);

    // What IS offered arms the CURRENT document: the server plans from the token this press
    // sends, and its plan is the one the edited canvas builds — not the plan that faulted.
    fireEvent.click(screen.getByRole("button", { name: "Re-simulate" }));
    await waitFor(() => {
      expect(sandbox.calls.plan).toBe(1);
    });
    const current = buildPlan(store.getState().doc, snapshot);
    if (!current.ok) throw new Error("the edited flagship must still plan");
    const served = sandbox.planned();
    if (served === null) throw new Error("the scripted server planned nothing");
    expect(planHashOf(served.steps)).toBe(planHashOf(current.steps));
    expect(planHashOf(served.steps)).not.toBe(planHashOf(faulted.steps));
  });
});

const RECEIPT: ReceiptRef = {
  txHash: `0x${"ab".repeat(32)}`,
  blockNumber: 23_000_007n,
  blockHash: `0x${"cd".repeat(32)}`,
  gasUsed: null,
};

function liveMachineAt(
  stage: "awaiting" | "pending" | "timeout" | "attributing" | "wallet-changed",
): ExecutionMachine {
  let machine = createExecutionMachine({ mode: "live", tolerance: SANDBOX_OUTPUT_TOLERANCE });
  machine = ok(machine, { type: "simulate" });
  machine = ok(machine, {
    type: "plan-ready",
    plan,
    planHash: PLAN_HASH,
    address: `0x${"aa".repeat(20)}` as Hex,
  });
  machine = ok(machine, { type: "execute", facts: { ...NULL_FACTS, nonce: 1n } });
  if (stage === "awaiting") return machine;
  const txHash = `0x${"11".repeat(32)}` as Hex;
  machine = ok(machine, { type: "signed", txHash });
  if (stage === "pending") return machine;
  if (stage === "timeout") return ok(machine, { type: "tx-timeout" });
  if (stage === "wallet-changed") return ok(machine, { type: "wallet-changed" });
  const minter = receiptMinter("test-rpc");
  const receipt = minter.confirm({
    status: 1n,
    txHash,
    blockNumber: 123n,
    blockHash: `0x${"bb".repeat(32)}` as Hex,
    logs: [],
  });
  return ok(machine, { type: "tx-confirmed", receipt });
}

describe("FailureCard — cause discrimination (T7/T21/T22)", () => {
  const recover = { label: "Re-simulate", onAct: () => undefined, gateReason: null };
  const failureOf = (cause: "user-rejected" | "timeout-gave-up" | "cancelled" | "reverted") => ({
    stepIndex: 1,
    stepId: "s",
    cause,
    txHash: cause === "user-rejected" ? null : (`0x${"11".repeat(32)}` as Hex),
    decoded: null,
    raw: null,
  });

  it("a declined signature is neutral — never destructive", () => {
    const { container } = render(
      <FailureCard failure={failureOf("user-rejected")} recover={recover} />,
    );
    expect(container.querySelector(".border-destructive")).toBeNull();
    expect(container.querySelectorAll('[class*="text-destructive"]').length).toBe(0);
    expect(screen.getByText(/Signature declined — step 2 was not sent/)).not.toBeNull();
  });

  it("an unwatched timeout states the unknown without claiming failure", () => {
    const { container } = render(
      <FailureCard failure={failureOf("timeout-gave-up")} recover={recover} />,
    );
    expect(container.querySelector(".border-destructive")).toBeNull();
    expect(
      screen.getByText(/its transaction had not confirmed when watching stopped/),
    ).not.toBeNull();
  });

  it("a cancelled replacement takes the failed grammar", () => {
    const { container } = render(
      <FailureCard failure={failureOf("cancelled")} recover={recover} />,
    );
    expect(container.querySelector(".border-destructive")).not.toBeNull();
    expect(screen.getByText(/was replaced and did not execute/)).not.toBeNull();
  });

  it("a revert whose raw never arrived states the absence rather than faking bytes (D7)", () => {
    render(<FailureCard failure={failureOf("reverted")} recover={recover} />);
    expect(screen.getByText(/raw error unavailable — enrichment did not complete/)).not.toBeNull();
    expect(screen.getByText("Step 2 reverted on chain.")).not.toBeNull();
  });
});

describe("HaltCard — the T18 family beyond output divergence", () => {
  const recover = { label: "Reset session & re-simulate", onAct: () => undefined, gateReason: null };

  it("hf-disagreement renders PREDICTED/CHAIN achromatically", () => {
    const halt: HaltFact = {
      kind: "hf-disagreement",
      stepIndex: 5,
      stepId: "s",
      expected: { status: "healthy", hfWad: 2n * 10n ** 18n },
      chainHfWad: 10n ** 18n,
      receipt: RECEIPT,
    };
    const { container } = render(<HaltCard halt={halt} plan={plan} tolerance={SANDBOX_OUTPUT_TOLERANCE} recover={recover} />);
    const card = container.querySelector(".border-foreground");
    expect(card).not.toBeNull();
    if (card === null) throw new Error("unreachable");
    expect(chromaIn(card)).toBe(0);
    expect(card.textContent).toContain("Chain");
    expect(card.textContent).toContain("health-factor readings disagree");
  });

  it("hf-disagreement with an unknown expectation states why the prediction is absent", () => {
    const halt: HaltFact = {
      kind: "hf-disagreement",
      stepIndex: 5,
      stepId: "s",
      expected: { status: "unknown", reason: "oracle gap" },
      chainHfWad: 10n ** 18n,
      receipt: RECEIPT,
    };
    render(<HaltCard halt={halt} plan={plan} tolerance={SANDBOX_OUTPUT_TOLERANCE} recover={recover} />);
    expect(screen.getByText(/prediction unavailable — oracle gap/)).not.toBeNull();
  });

  it("residual-allowance renders the spender and the non-zero residual", () => {
    const halt: HaltFact = {
      kind: "residual-allowance",
      stepIndex: 6,
      stepId: "s",
      spender: `0x${"aa".repeat(20)}` as Hex,
      residualAllowanceWei: 5n,
      receipt: RECEIPT,
    };
    const { container } = render(<HaltCard halt={halt} plan={plan} tolerance={SANDBOX_OUTPUT_TOLERANCE} recover={recover} />);
    const card = container.querySelector(".border-foreground");
    expect(card).not.toBeNull();
    if (card === null) throw new Error("unreachable");
    expect(chromaIn(card)).toBe(0);
    expect(card.textContent).toContain("Spender");
    expect(card.textContent).toContain("allowance did not return to zero");
    expect(card.textContent).toContain("residual allowance is not zero");
  });
});

describe("StopCard and FaultCard variants", () => {
  it("the halted tone takes the border-foreground family frame; no action, no button", () => {
    const { container } = render(
      <StopCard
        tone="halted"
        icon={Wallet}
        title="Execution halted — the connected wallet changed."
        explanation="stated mechanism"
      />,
    );
    expect(container.querySelector(".border-foreground")).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("each fault kind states its mechanism and its retry verb", () => {
    const noop = () => undefined;
    const cases: readonly [Parameters<typeof FaultCard>[0]["fault"], string, string][] = [
      [
        { kind: "refusal", stage: "execute", refusal: { kind: "session-busy" }, retry: "run" },
        "Another call is in flight for this session.",
        "Retry",
      ],
      [
        {
          kind: "refusal",
          stage: "execute",
          refusal: { kind: "rate-limited", retryAfterMs: 65_000 },
          retry: "run",
        },
        "Rate limited.",
        "Retry",
      ],
      [
        { kind: "refusal", stage: "plan", refusal: { kind: "tx-cap" }, retry: "arm" },
        "This session reached its transaction cap.",
        "Retry",
      ],
      [
        { kind: "refusal", stage: "execute", refusal: { kind: "plan-changed" }, retry: "arm" },
        "The server holds a different plan.",
        "Retry",
      ],
      [
        {
          kind: "refusal",
          stage: "execute",
          refusal: { kind: "out-of-order", expectedIndex: 4 },
          retry: "run",
        },
        "The session expects step 5.",
        "Retry",
      ],
      [
        { kind: "refusal", stage: "execute", refusal: { kind: "unknown-session" }, retry: "run" },
        "The sandbox refused: unknown-session.",
        "Retry",
      ],
      [
        { kind: "transport-failed", stage: "execute", detail: "socket", retry: "reload" },
        "The sandbox service did not answer.",
        "Reload session state",
      ],
      [
        { kind: "wire-mismatch", stage: "execute", detail: "skew", retry: "reload" },
        "The server answered in a shape this build cannot read.",
        "Reload session state",
      ],
      [
        { kind: "plan-mismatch", detail: "step 2", retry: "arm" },
        "The server built a different plan.",
        "Retry",
      ],
      [
        { kind: "machine-refused", detail: "illegal-transition", retry: "reload" },
        "The client and server disagree about this run.",
        "Reload session state",
      ],
    ];
    for (const [fault, title, label] of cases) {
      const view = render(<FaultCard fault={fault} onRetryFault={noop} busyReason={null} />);
      expect(screen.getByText(title)).not.toBeNull();
      expect(screen.getByRole("button", { name: label })).not.toBeNull();
      view.unmount();
    }
  });
});

describe("StepList — the remaining T7 vocabulary", () => {
  it("awaiting-signature rows keep the planned amount and the Circle (stillness, T14)", () => {
    const { container } = render(
      <StepList plan={plan} machine={liveMachineAt("awaiting")} reconciling={false} recover={RECOVER} />,
    );
    expect(container.querySelector(".step-spinner")).toBeNull();
    expect(container.querySelectorAll('[class*="text-primary"]').length).toBe(0);
  });

  it("a live pending row shows the truncated hash with a full-hash copy affordance (T9)", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(
      <StepList plan={plan} machine={liveMachineAt("pending")} reconciling={false} recover={RECOVER} />,
    );
    expect(screen.getByText("transaction pending")).not.toBeNull();
    expect(screen.getByText("0x1111…1111")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("Copy transaction hash"));
    expect(writeText).toHaveBeenCalledWith(`0x${"11".repeat(32)}`);
  });

  it("timeout keeps the pending grammar in the amount slot and says it may still land", () => {
    const { container } = render(
      <StepList plan={plan} machine={liveMachineAt("timeout")} reconciling={false} recover={RECOVER} />,
    );
    expect(
      screen.getByText(/not confirmed within the expected time — it may still land/),
    ).not.toBeNull();
    expect(container.querySelectorAll('[class*="text-destructive"]').length).toBe(0);
  });

  it("attributing keeps the spinner and states the confirmed-but-unsettled truth", () => {
    const { container } = render(
      <StepList plan={plan} machine={liveMachineAt("attributing")} reconciling={false} recover={RECOVER} />,
    );
    expect(container.querySelectorAll(".step-spinner").length).toBe(1);
    expect(screen.getByText(/transaction confirmed — attributing output/)).not.toBeNull();
  });

  it("dispatch-unresolved and dispatch-vacated speak discovery's language (D6/§8a)", () => {
    let machine = settledThrough(1);
    machine = ok(machine, { type: "advance", facts: NULL_FACTS });
    const step = plan.steps[1];
    if (step === undefined) throw new Error("fixture");
    const unresolved = ok(machine, {
      type: "step-result",
      result: { status: "dispatch-unresolved", stepIndex: 1, stepId: step.id, txHash: null },
    });
    const first = render(
      <StepList plan={plan} machine={unresolved} reconciling recover={RECOVER} />,
    );
    expect(screen.getByText(/nothing is re-sent/)).not.toBeNull();
    expect(first.container.querySelectorAll(".step-spinner").length).toBe(1);
    first.unmount();
    const vacated = ok(machine, {
      type: "step-result",
      result: { status: "dispatch-vacated", stepIndex: 1, stepId: step.id },
    });
    render(<StepList plan={plan} machine={vacated} reconciling={false} recover={RECOVER} />);
    expect(screen.getByText(/discovery proved this transaction never landed/)).not.toBeNull();
    expect(screen.getAllByText("not sent").length).toBeGreaterThan(0);
  });

  it("an interrupted step under an expired session shows its preserved evidence (T24/D8)", () => {
    const base = settledThrough(2);
    const step = plan.steps[2];
    if (step === undefined) throw new Error("fixture");
    const machine: ExecutionMachine = {
      ...base,
      phase: {
        kind: "abandoned",
        executedSteps: 3,
        recovery: {
          kind: "attribution-pending",
          stepIndex: 2,
          stepId: step.id,
          receipt: RECEIPT,
          resolvedAmountWei: null,
          beforeShares: null,
          sharesDelta: null,
        },
      },
    };
    render(<StepList plan={plan} machine={machine} reconciling={false} recover={RECOVER} />);
    expect(
      screen.getByText(/attribution never completed before the session expired/),
    ).not.toBeNull();
    expect(screen.getByText("held server-side")).not.toBeNull();
  });
});

describe("ExecutionFlow — remaining phases and gating", () => {
  it("simulating states the preparation in prose over the pre-existing rows (T11)", () => {
    let machine = createExecutionMachine({ mode: "sandbox" });
    machine = ok(machine, { type: "simulate" });
    render(
      <ExecutionFlow
        {...flowProps}
        snapshot={{ machine, busy: "plan", fault: null, session: null, plannedAtMs: null, nowMs: 0 }}
      />,
    );
    expect(screen.getByText(/Preparing the session fork and building the plan/)).not.toBeNull();
    expect(screen.getAllByRole("listitem").length).toBe(N);
  });

  it("a busy driver gates Execute with a stated reason, never a dead control (T25)", () => {
    render(
      <ExecutionFlow
        {...flowProps}
        snapshot={{ ...driverSnapshot(readyMachine()), busy: "execute" }}
      />,
    );
    const execute = screen.getByRole("button", { name: "Execute" });
    expect(execute.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getAllByText("A sandbox call is in flight.").length).toBeGreaterThan(0);
  });

  it("wallet-changed renders the halted-family stop with the split-position mechanism (T27)", () => {
    const { container } = render(
      <ExecutionFlow {...flowProps} snapshot={driverSnapshot(liveMachineAt("wallet-changed"))} />,
    );
    expect(screen.getByText("Execution halted — the connected wallet changed.")).not.toBeNull();
    expect(screen.getByText(/split the position across two owners/)).not.toBeNull();
    expect(container.querySelector(".border-foreground")).not.toBeNull();
  });

  it("timeout renders the keep-waiting truth as a designed card, not an error", () => {
    const { container } = render(
      <ExecutionFlow {...flowProps} snapshot={driverSnapshot(liveMachineAt("timeout"))} />,
    );
    expect(
      screen.getByText("Step 1 has not confirmed within the expected time."),
    ).not.toBeNull();
    expect(container.querySelectorAll('[class*="text-destructive"]').length).toBe(0);
  });

  it("a fault renders beside the machine's truth, not over it", () => {
    render(
      <ExecutionFlow
        {...flowProps}
        snapshot={{
          ...driverSnapshot(readyMachine()),
          fault: {
            kind: "refusal",
            stage: "execute",
            refusal: { kind: "rate-limited", retryAfterMs: 65_000 },
            retry: "run",
          },
        }}
      />,
    );
    expect(screen.getByText("Rate limited.")).not.toBeNull();
    expect(screen.getByText(/1m 05s/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Execute" })).not.toBeNull();
  });
});

describe("ExecutionHost — gating reasons", () => {
  it("gates the entry when the read set is unavailable", () => {
    render(
      <ComposerStoreProvider store={flagshipStore()}>
        <ExecutionHost
          snapshot={{ status: "unavailable", reason: "reads log missing" }}
          simulation={null}
          simulationPending={false}
          transport={scriptedSandbox().transport}
          storage={memoryStorage()}
          now={() => 1_000}
        />
      </ComposerStoreProvider>,
    );
    const entry = screen.getByRole("button", { name: "Review & execute in sandbox" });
    expect(entry.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("the block-pinned read set is unavailable")).not.toBeNull();
  });

  it("gates the entry on an empty canvas", () => {
    render(
      <ComposerStoreProvider store={createComposerStore()}>
        <ExecutionHost
          snapshot={{ status: "ready", snapshot }}
          simulation={null}
          simulationPending={false}
          transport={scriptedSandbox().transport}
          storage={memoryStorage()}
          now={() => 1_000}
        />
      </ComposerStoreProvider>,
    );
    const entry = screen.getByRole("button", { name: "Review & execute in sandbox" });
    expect(entry.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("the canvas is empty")).not.toBeNull();
  });
});

describe("PreSignReview — the T13 call surface (Codex fix 5)", () => {
  it("renders every step's call zone from the PlanSuccess reference, with flows and risk", () => {
    const ledger = riskLedger(graph, snapshot);
    if (!ledger.ok) throw new Error("fixture: flagship ledger failed");
    render(
      <ExecutionFlow
        {...flowProps}
        checkpoints={ledger.checkpoints}
        snapshot={driverSnapshot(readyMachine())}
      />,
    );
    const list = screen.getByRole("list", { name: "Planned calls" });
    expect(list.querySelectorAll("li").length).toBe(N);
    for (const step of plan.steps) {
      // The target's FULL address and the function signature, from the step object.
      expect(list.textContent).toContain(step.to);
      expect(list.textContent).toContain(`${step.functionName}(`);
    }
    // Spec-or-resolved honesty: unresolved step-output amounts state their binding.
    expect(list.textContent).toContain("bound to the attributed output of step");
    // The actor slot takes the same grammar (taste finding 1): named in the signature,
    // bound by the line beneath — the sentinel address never prints raw.
    expect(list.textContent).not.toContain(snapshot.user.address);
    expect(list.textContent).toContain("actor: bound to the session account at execution");
    expect(screen.getAllByText(/\(.*actor.*\)/).length).toBeGreaterThan(0);
    // The block flow row through the SourcedValue machinery.
    expect(list.textContent).toContain("→");
    // Risk-changing steps carry the ledger checkpoint's after-this-step line.
    const riskLines = screen.getAllByText(/After this step:/);
    expect(riskLines.length).toBeGreaterThan(0);
  });
});

describe("run-pinned predictions (Codex fix 1)", () => {
  it("the receipt keeps the predictions pinned at arm when the live simulation moves on", async () => {
    const sandbox = scriptedSandbox();
    const storage = memoryStorage();
    const store = flagshipStore();
    const pinnedSimulation = simulate(graph, snapshot, {});
    const hostWith = (simulation: ReturnType<typeof simulate> | null) => (
      <ComposerStoreProvider store={store}>
        <ExecutionHost
          snapshot={{ status: "ready", snapshot }}
          simulation={simulation}
          simulationPending={false}
          transport={sandbox.transport}
          storage={storage}
          now={() => 1_000}
        />
      </ComposerStoreProvider>
    );
    const view = render(hostWith(pinnedSimulation));
    fireEvent.click(screen.getByRole("button", { name: "Review & execute in sandbox" }));
    const execute = await screen.findByRole("button", { name: "Execute" });
    fireEvent.click(execute);
    await screen.findByText("Execution complete");
    // The canvas recomputes (here: loses) its simulation — the run's receipt must not.
    view.rerender(hostWith(null));
    expect(screen.getByText("Execution complete")).not.toBeNull();
    if (pinnedSimulation.netApyWad === null) throw new Error("fixture");
    const netApy = formatWadAsPercent(pinnedSimulation.netApyWad.value);
    expect(screen.getByRole("button", { name: netApy })).not.toBeNull();
    expect(screen.queryByText(/summary unavailable/)).toBeNull();
  });
});

describe("the persistent narrator (Codex fix 6)", () => {
  it("announces the run across the panel swap and speaks transport faults at idle", async () => {
    const sandbox = scriptedSandbox({
      onCreate: () => ({ ok: false, refusal: { kind: "at-capacity" } }),
    });
    render(
      <ComposerStoreProvider store={flagshipStore()}>
        <ExecutionHost
          snapshot={{ status: "ready", snapshot }}
          simulation={null}
          simulationPending={false}
          transport={sandbox.transport}
          storage={memoryStorage()}
          now={() => 1_000}
        />
      </ComposerStoreProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review & execute in sandbox" }));
    await screen.findByText("The sandbox is at capacity.");
    // The machine returned to idle — the flow unmounted — yet the narrator region
    // survived the swap and carries the fault's sentence.
    const regions = Array.from(document.querySelectorAll('[role="status"]'));
    expect(
      regions.some((region) => region.textContent?.includes("The sandbox is at capacity.")),
    ).toBe(true);
  });

  it("narrates ready and complete through one region in the flow view", async () => {
    const sandbox = scriptedSandbox();
    render(
      <ComposerStoreProvider store={flagshipStore()}>
        <ExecutionHost
          snapshot={{ status: "ready", snapshot }}
          simulation={null}
          simulationPending={false}
          transport={sandbox.transport}
          storage={memoryStorage()}
          now={() => 1_000}
        />
      </ComposerStoreProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review & execute in sandbox" }));
    const execute = await screen.findByRole("button", { name: "Execute" });
    // In the flow view exactly ONE region exists (the panel's own unmounted with it).
    expect(document.querySelectorAll('[role="status"]').length).toBe(1);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      `Simulation complete: ${N} steps.`,
    );
    fireEvent.click(execute);
    await screen.findByText("Execution complete");
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      `Execution complete: ${N} steps confirmed.`,
    );
  });
});

describe("restore is bound to the document generation (thread 019fa749 finding 2)", () => {
  it("an edit while the restore lookup is in flight adopts nothing", async () => {
    // Seed a completed run so a resumable pointer exists.
    const sandbox = scriptedSandbox();
    const storage = memoryStorage();
    const seed = new SandboxDriver({
      transport: sandbox.transport,
      storage,
      now: () => 1_000,
    });
    await seed.arm({ plan, token });
    await seed.execute();
    const stepCalls = sandbox.calls.executeStep.length;

    // The session lookup is HELD OPEN while the document changes underneath it.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = {
      ...sandbox.transport,
      session: async (key: string) => {
        await gate;
        return sandbox.transport.session(key);
      },
    };
    const store = flagshipStore();
    render(
      <ComposerStoreProvider store={store}>
        <ExecutionHost
          snapshot={{ status: "ready", snapshot }}
          simulation={null}
          simulationPending={false}
          transport={transport}
          storage={storage}
          now={() => 1_000}
        />
      </ComposerStoreProvider>,
    );
    // The restore effect launched against the flagship document; edit it mid-flight.
    act(() => {
      store.getState().clear();
    });
    release();
    // The adoption is refused in memory. The pointer STAYS (Codex round-11): the slot is one
    // origin-wide key, an edit in this tab says nothing about whose pointer is in it, and the run
    // this one names is still the server's — an undo could resume it. This beat asserted the slot
    // emptied, which encoded the defect. What proves the refusal is the absence of the column.
    await waitFor(() => expect(document.querySelector('aside[aria-label="Execution"]')).toBeNull());
    expect(storage.held()).not.toBeNull();
    // Nothing was adopted: no execution column and no further dispatches.
    expect(document.querySelector('aside[aria-label="Execution"]')).toBeNull();
    expect(document.querySelector('aside[aria-label="Simulation"]')).not.toBeNull();
    expect(sandbox.calls.executeStep.length).toBe(stepCalls);
  });
});

describe("the executing frame's seam (taste finding 2)", () => {
  it("ExecutionHost adopts an externally owned driver — one machine, two consumers", async () => {
    const sandbox = scriptedSandbox();
    const driver = new SandboxDriver({
      transport: sandbox.transport,
      storage: memoryStorage(),
      now: () => 1_000,
    });
    await driver.arm({ plan, token });
    render(
      <ComposerStoreProvider store={flagshipStore()}>
        <ExecutionHost
          snapshot={{ status: "ready", snapshot }}
          simulation={null}
          simulationPending={false}
          driver={driver}
          now={() => 1_000}
        />
      </ComposerStoreProvider>,
    );
    // The host renders the externally armed machine's state — the same driver whose
    // snapshot the composer body maps to the canvas's executingBlockId prop.
    expect(screen.getByRole("button", { name: "Execute" })).not.toBeNull();
    expect(document.querySelector('aside[aria-label="Execution"]')).not.toBeNull();
  });
});

