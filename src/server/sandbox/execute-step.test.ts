/**
 * Unit proofs for the sandbox execute path, with every chain interaction injected:
 * the REAL 13-step flagship plan (recorded snapshot + share codec + buildPlan) drives
 * the happy path, sequencing, idempotency, and the D1 pair-reuse property; hand-built
 * mini plans drive each failure axis — revert, divergence, residual allowance, HF
 * disagreement, attribution-unavailable re-entry, the D3 persistence-failure /
 * reconcile drill (treatment §9.9's unit half), and the Codex round-1 transport
 * drills: lost dispatch response (landed and not), confirmation failure, receipt
 * discovery, vacated dispatches, and the in-flight replan window.
 */
import { describe, expect, it } from "vitest";
import { getAddress, parseAbi, type Address, type Hex } from "viem";
import { configured } from "../../core/provenance";
import { HF_NO_DEBT } from "../../core/health-factor";
import type { AmountSpec, ChainSnapshot, TransactionStep } from "../../core/plan";
import { encodeShareGraph } from "../../lib/share/encode";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { scriptedChain, transferLog } from "../../../tests/helpers/sandbox-chain";
import { withDeadline } from "./deadlines";
import { sandboxSnapshot, SANDBOX_USER } from "../../lib/recorded-reads/sandbox-snapshot";
import {
  executeSandboxStep,
  planForSession,
  planHashOf,
  predictedOutputsOf,
  producerMechanismOf,
  reconcileSession,
  riskExpectationsOf,
} from "./execute-step";
import {
  createSessionRegistry,
  type RecordedPlan,
  type RiskExpectation,
  type Session,
  type SessionFork,
  type SessionRegistry,
} from "./session-registry";

const BASE_HASH = `0x${"ab".repeat(32)}` as Hex;
const TEST_ACTOR = getAddress("0x4444444444444444444444444444444444444444");
const POOL = getAddress("0x5555555555555555555555555555555555555555");
const EETH = getAddress("0x6666666666666666666666666666666666666666");
const LP = getAddress("0x7777777777777777777777777777777777777777");
const WEETH = getAddress("0x8888888888888888888888888888888888888888");
const WAD = 10n ** 18n;

const DEPOSIT_ABI = parseAbi(["function deposit() payable returns (uint256)"]);
const APPROVE_ABI = parseAbi(["function approve(address,uint256) returns (bool)"]);
const WRAP_ABI = parseAbi(["function wrap(uint256) returns (uint256)"]);
const SUPPLY_ABI = parseAbi(["function supply(address,uint256,address,uint16)"]);

function testRegistry(): SessionRegistry {
  // Unit dispatches are back-to-back; the production rate floor is exercised in
  // session-registry.test.ts with an injected clock, not re-proven here.
  return createSessionRegistry({ maxSessions: 4, ttlMs: 60_000, maxTxPerSession: 32, minExecuteIntervalMs: 0 });
}

function forkWith(actor: Address): SessionFork {
  return {
    rpcUrl: "http://127.0.0.1:9999",
    baseBlock: 100n,
    baseBlockHash: BASE_HASH,
    actor,
    async reset() {
      return { actor };
    },
    async destroy() {},
  };
}

async function activeSession(
  registry: SessionRegistry,
  actor: Address = TEST_ACTOR,
): Promise<Session> {
  const created = await registry.create(async () => forkWith(actor));
  if (!created.ok) throw new Error("session creation refused in fixture");
  return created.session;
}

// ————————————————— mini-plan fixtures (targeted failure axes) —————————————————

const SNAP_STUB = {
  pool: POOL,
  etherfi: { eETH: EETH, liquidityPool: LP },
} as unknown as ChainSnapshot;

function depositStep(): TransactionStep {
  return {
    id: "stake1:deposit",
    index: 1,
    blockId: "stake1",
    description: "Stake ETH",
    to: LP,
    abi: DEPOSIT_ABI,
    functionName: "deposit",
    args: [],
    valueSpec: "amount",
    amount: { kind: "literal", amount: configured(10n * WAD, "TEST_INPUT_WEI", "execute-step.test.ts") },
  };
}

function wrapPairSteps(): { approve: TransactionStep; wrap: TransactionStep } {
  const shared: AmountSpec = {
    kind: "step-output",
    producerStepId: "stake1:deposit",
    attribution: "share-delta",
    allocationBps: 10_000,
  };
  return {
    approve: {
      id: "wrap1:approve",
      index: 2,
      blockId: "wrap1",
      description: "Approve eETH",
      to: EETH,
      abi: APPROVE_ABI,
      functionName: "approve",
      args: [{ kind: "value", value: WEETH }, { kind: "amount" }],
      valueSpec: "none",
      amount: shared,
    },
    wrap: {
      id: "wrap1:wrap",
      index: 3,
      blockId: "wrap1",
      description: "Wrap eETH",
      to: WEETH,
      abi: WRAP_ABI,
      functionName: "wrap",
      args: [{ kind: "amount" }],
      valueSpec: "none",
      amount: shared,
    },
  };
}

function supplyStep(): TransactionStep {
  return {
    id: "supply1:supply",
    index: 1,
    blockId: "supply1",
    description: "Supply weETH",
    to: POOL,
    abi: SUPPLY_ABI,
    functionName: "supply",
    args: [
      { kind: "value", value: WEETH },
      { kind: "amount" },
      { kind: "value", value: TEST_ACTOR },
      { kind: "value", value: 0 },
    ],
    valueSpec: "none",
    amount: { kind: "literal", amount: configured(5n * WAD, "TEST_SUPPLY_WEI", "execute-step.test.ts") },
  };
}

function miniPlan(
  steps: readonly TransactionStep[],
  predicted: ReadonlyMap<string, bigint> = new Map(),
  risk: ReadonlyMap<string, RiskExpectation> = new Map(),
): RecordedPlan {
  return {
    plan: { ok: true, steps, targetEModeCategoryId: null, flows: [] },
    snapshot: SNAP_STUB,
    planHash: planHashOf(steps),
    predictedOutputs: predicted,
    risk,
  };
}

function recordMini(
  registry: SessionRegistry,
  session: Session,
  steps: readonly TransactionStep[],
  predicted: ReadonlyMap<string, bigint> = new Map(),
  risk: ReadonlyMap<string, RiskExpectation> = new Map(),
): Hex {
  registry.recordPlan(session, miniPlan(steps, predicted, risk), session.generation);
  return session.plan!.planHash;
}

// ————————————————— pure derivations —————————————————

describe("planHashOf", () => {
  it("is deterministic and sensitive to order, args, and amount specs", () => {
    const { approve, wrap } = wrapPairSteps();
    const steps = [depositStep(), approve, wrap];
    expect(planHashOf(steps)).toBe(planHashOf([depositStep(), approve, wrap]));
    expect(planHashOf(steps)).not.toBe(planHashOf([approve, depositStep(), wrap]));
    const differentAllocation: TransactionStep = {
      ...wrap,
      amount: { kind: "step-output", producerStepId: "stake1:deposit", attribution: "share-delta", allocationBps: 5_000 },
    };
    expect(planHashOf(steps)).not.toBe(planHashOf([depositStep(), approve, differentAllocation]));
    const differentSpender: TransactionStep = {
      ...approve,
      args: [{ kind: "value", value: POOL }, { kind: "amount" }],
    };
    expect(planHashOf(steps)).not.toBe(planHashOf([depositStep(), differentSpender, wrap]));
  });
});

describe("producer derivations from the real flagship plan", () => {
  const snapshot = sandboxSnapshot();
  const graph = flagshipGraph();

  it("maps exactly the §5.5 whitelist producers to predicted flow outputs", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry, SANDBOX_USER);
    const encoded = encodeShareGraph(graph);
    if (!encoded.ok) throw new Error("fixture graph refused by the share codec");
    const planned = await planForSession(
      registry,
      { captureSnapshot: async () => snapshot },
      session.key,
      encoded.token,
    );
    if (!planned.ok) throw new Error("fixture plan refused");
    const predicted = predictedOutputsOf(planned.plan);
    expect([...predicted.keys()].sort()).toEqual(
      ["borrow:borrow", "stake1:deposit", "stake2:deposit", "unwrap:withdraw", "wrap1:wrap", "wrap2:wrap"].sort(),
    );
    for (const step of planned.plan.steps) {
      const mechanism = producerMechanismOf(step);
      if (step.functionName === "deposit") expect(mechanism).toBe("share-delta");
      else if (step.functionName === "wrap" || step.functionName === "borrow") {
        expect(mechanism).toBe("transfer-event");
      } else if (step.functionName === "withdraw") expect(mechanism).toBe("withdraw-argument");
      else expect(mechanism).toBeNull();
    }
  });

  it("records the riskLedger checkpoints for exactly the risk-changing steps", () => {
    const expectations = riskExpectationsOf(graph, snapshot);
    expect([...expectations.keys()]).toEqual(["supply1:supply", "borrow:borrow", "supply2:supply"]);
    expect(expectations.get("supply1:supply")).toEqual({ status: "no-debt" });
    const borrow = expectations.get("borrow:borrow");
    if (borrow === undefined || borrow.status !== "healthy") {
      throw new Error("borrow checkpoint should be a healthy HF");
    }
    expect(borrow.hfWad > WAD).toBe(true);
  });
});

// ————————————————— planForSession —————————————————

describe("planForSession", () => {
  const snapshot = sandboxSnapshot();
  const token = (() => {
    const encoded = encodeShareGraph(flagshipGraph());
    if (!encoded.ok) throw new Error("fixture graph refused");
    return encoded.token;
  })();

  it("refuses a document the share codec refuses — same pipeline, same codes", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const outcome = await planForSession(
      registry,
      { captureSnapshot: async () => snapshot },
      session.key,
      "not-a-token-!!!",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("document-refused");
  });

  it("refuses a plan buildPlan refuses (footprint predicate), with the plan errors", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const withFootprint: ChainSnapshot = {
      ...snapshot,
      user: {
        ...snapshot.user,
        hasAaveFootprint: configured(true, "TEST_FOOTPRINT", "execute-step.test.ts"),
      },
    };
    const outcome = await planForSession(
      registry,
      { captureSnapshot: async () => withFootprint },
      session.key,
      token,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    if (outcome.refusal.kind !== "plan-refused") throw new Error(`got ${outcome.refusal.kind}`);
    expect(
      outcome.refusal.errors.some(
        (e) => e.kind === "constraint" && e.constraint === "existing-footprint",
      ),
    ).toBe(true);
  });

  it("records the plan with the server's own hash and returns it", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry, SANDBOX_USER);
    const outcome = await planForSession(
      registry,
      { captureSnapshot: async () => snapshot },
      session.key,
      token,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.plan.steps).toHaveLength(13);
    expect(outcome.planHash).toBe(planHashOf(outcome.plan.steps));
    expect(session.plan?.planHash).toBe(outcome.planHash);
  });

  it("refuses re-planning a session whose fork has moved (session-dirty)", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const chain = scriptedChain({
      shares: [0n, 500n],
      amountForShare: () => 10n * WAD,
      sends: [{}],
    });
    const hash = recordMini(registry, session, [depositStep()], new Map([["stake1:deposit", 10n * WAD]]));
    const executed = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    expect(executed.ok).toBe(true);
    const replanned = await planForSession(
      registry,
      { captureSnapshot: async () => snapshot },
      session.key,
      token,
    );
    expect(replanned.ok).toBe(false);
    if (replanned.ok) throw new Error("unreachable");
    expect(replanned.refusal.kind).toBe("session-dirty");
  });

  it("refuses planning while the session is in a terminal phase", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    registry.markFailed(session, {
      stepIndex: 0,
      stepId: "stake1:deposit",
      txHash: `0x${"00".repeat(32)}` as Hex,
      decoded: null,
      raw: null,
    });
    const outcome = await planForSession(
      registry,
      { captureSnapshot: async () => snapshot },
      session.key,
      token,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("failed");
  });

  it("refuses re-planning while a step is in flight — the entries-empty window (finding 1)", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = scriptedChain({
      shares: [0n, 500n],
      amountForShare: () => 10n * WAD,
      sends: [{ gate }],
    });
    const hash = recordMini(registry, session, [depositStep()], new Map([["stake1:deposit", 10n * WAD]]));
    const inFlight = executeSandboxStep(registry, () => chain, session.key, hash, 0);
    // Wait until the step holds the mutex and its dispatch is gated.
    for (let i = 0; i < 50 && session.pendingDispatch === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(session.pendingDispatch).not.toBeNull();
    // The exact window finding 1 names: the step is in flight but no entry exists yet.
    expect(session.entries).toHaveLength(0);
    const replan = await planForSession(
      registry,
      { captureSnapshot: async () => snapshot },
      session.key,
      token,
    );
    expect(replan.ok).toBe(false);
    if (replan.ok) throw new Error("unreachable");
    expect(replan.refusal.kind).toBe("session-busy");

    release();
    const done = await inFlight;
    if (!done.ok) throw new Error("gated step refused");
    expect(done.result.status).toBe("attributed");
    // The plan the in-flight step executed under was never replaced.
    expect(session.plan?.planHash).toBe(hash);
  });
});

// ————————————————— the real plan through the execute path —————————————————

describe("executeSandboxStep on the real flagship plan", () => {
  async function plannedFixture() {
    const registry = testRegistry();
    const session = await activeSession(registry, SANDBOX_USER);
    const encoded = encodeShareGraph(flagshipGraph());
    if (!encoded.ok) throw new Error("fixture graph refused");
    const planned = await planForSession(
      registry,
      { captureSnapshot: async () => sandboxSnapshot() },
      session.key,
      encoded.token,
    );
    if (!planned.ok) throw new Error("fixture plan refused");
    return { registry, session, planHash: planned.planHash, plan: planned.plan };
  }

  it("executes deposit → approve → wrap with one resolution per attributed pair (D1)", async () => {
    const { registry, session, planHash } = await plannedFixture();
    const recorded = session.plan!;
    const predictedDeposit = recorded.predictedOutputs.get("stake1:deposit")!;
    const predictedWrap = recorded.predictedOutputs.get("wrap1:wrap")!;
    const wrapStep = recorded.plan.steps[2]!;
    const sharesMinted = 9_092_267_716_600_505_494n;
    const chain = scriptedChain({
      shares: [0n, sharesMinted],
      amountForShare: () => predictedDeposit,
      allowances: [0n, 0n],
      sends: [
        {},
        {},
        { logs: [transferLog(wrapStep.to, LP, SANDBOX_USER, predictedWrap)] },
      ],
    });
    const chainFor = () => chain;

    const first = await executeSandboxStep(registry, chainFor, session.key, planHash, 0);
    if (!first.ok) throw new Error(`step 0 refused: ${JSON.stringify(first)}`);
    if (first.result.status !== "attributed") throw new Error(`step 0: ${first.result.status}`);
    expect(first.result.sharesDelta).toBe(sharesMinted);
    expect(first.result.output).toEqual({
      mechanism: "share-delta",
      predictedWei: predictedDeposit,
      attributedWei: predictedDeposit,
      toleranceWei: predictedDeposit / 10n ** 6n,
    });
    expect(chain.dispatches[0]!.value).toBe(10n * WAD);

    const second = await executeSandboxStep(registry, chainFor, session.key, planHash, 1);
    if (!second.ok) throw new Error("step 1 refused");
    if (second.result.status !== "attributed") throw new Error(`step 1: ${second.result.status}`);
    expect(second.result.approval).toEqual({
      spender: getAddress(wrapStep.to),
      priorAllowanceWei: 0n,
      approvedWei: predictedDeposit,
    });

    const third = await executeSandboxStep(registry, chainFor, session.key, planHash, 2);
    if (!third.ok) throw new Error("step 2 refused");
    if (third.result.status !== "attributed") throw new Error(`step 2: ${third.result.status}`);
    // D1: the wrap's calldata amount IS the approve's figure, reused off the executed
    // record — amountForShare ran once for the pair's resolution (plus once for the
    // deposit's own settlement comparison), never a third time.
    expect(third.result.resolvedAmountWei).toBe(second.result.resolvedAmountWei);
    expect(chain.amountForShareCalls).toBe(2);
    expect(third.result.output?.attributedWei).toBe(predictedWrap);
    expect(third.result.consumedApproval).toEqual({
      spender: getAddress(wrapStep.to),
      residualAllowanceWei: 0n,
    });

    expect(registry.summaryOf(session).executed).toHaveLength(3);
    expect(session.txCount).toBe(3);
  });

  it("replays an executed index idempotently without a second transaction (A4)", async () => {
    const { registry, session, planHash } = await plannedFixture();
    const predictedDeposit = session.plan!.predictedOutputs.get("stake1:deposit")!;
    const chain = scriptedChain({
      shares: [0n, 100n],
      amountForShare: () => predictedDeposit,
      sends: [{}],
    });
    const first = await executeSandboxStep(registry, () => chain, session.key, planHash, 0);
    if (!first.ok) throw new Error("step 0 refused");
    const replay = await executeSandboxStep(registry, () => chain, session.key, planHash, 0);
    if (!replay.ok) throw new Error("replay refused");
    expect(replay.result).toBe(first.result);
    expect(chain.dispatches).toHaveLength(1);
    expect(chain.landed).toHaveLength(1);
  });

  it("enforces strict sequencing: out-of-order indexes are designed refusals", async () => {
    const { registry, session, planHash } = await plannedFixture();
    const chain = scriptedChain({});
    const outcome = await executeSandboxStep(registry, () => chain, session.key, planHash, 5);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal).toEqual({ kind: "out-of-order", expectedIndex: 0 });
    expect(chain.dispatches).toHaveLength(0);
  });

  it("reconciles the presented planHash against its own rebuild (plan-changed)", async () => {
    const { registry, session } = await plannedFixture();
    const chain = scriptedChain({});
    const outcome = await executeSandboxStep(
      registry,
      () => chain,
      session.key,
      `0x${"11".repeat(32)}`,
      0,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("plan-changed");
  });

  it("refuses execution without a recorded plan", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const outcome = await executeSandboxStep(
      registry,
      () => scriptedChain({}),
      session.key,
      `0x${"11".repeat(32)}`,
      0,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("no-plan");
  });

  it("refuses a concurrent dispatch (per-session mutex)", async () => {
    const { registry, session, planHash } = await plannedFixture();
    registry.beginExecution(session);
    const outcome = await executeSandboxStep(registry, () => scriptedChain({}), session.key, planHash, 0);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("session-busy");
    registry.endExecution(session);
  });

  it("surfaces expiry as the designed session-expired state with the tombstone", async () => {
    const nowMs = { value: 0 };
    const registry = createSessionRegistry({
      maxSessions: 4,
      ttlMs: 1000,
      maxTxPerSession: 8,
      minExecuteIntervalMs: 0,
      now: () => nowMs.value,
      monotonicNow: () => nowMs.value,
    });
    const session = await activeSession(registry);
    nowMs.value = 2000;
    const outcome = await executeSandboxStep(
      registry,
      () => scriptedChain({}),
      session.key,
      `0x${"11".repeat(32)}`,
      0,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    if (outcome.refusal.kind !== "session-expired") throw new Error(`got ${outcome.refusal.kind}`);
    expect(outcome.refusal.executedSteps).toBe(0);
    expect(outcome.refusal.tombstone.recovery).toBeNull();
  });

  it("refuses indexes past the end of a completed plan", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const chain = scriptedChain({ shares: [0n, 1n], amountForShare: () => 10n * WAD, sends: [{}] });
    const hash = recordMini(registry, session, [depositStep()], new Map([["stake1:deposit", 10n * WAD]]));
    const first = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    expect(first.ok).toBe(true);
    const past = await executeSandboxStep(registry, () => chain, session.key, hash, 1);
    expect(past.ok).toBe(false);
    if (past.ok) throw new Error("unreachable");
    expect(past.refusal.kind).toBe("plan-complete");
  });
});

// ————————————————— failure axes on mini plans —————————————————

describe("revert handling", () => {
  it("decodes the revert, preserves raw bytes, fails the session, and blocks the suffix", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const chain = scriptedChain({
      shares: [0n],
      sends: [{ revert: true }],
      revertData: "0xdeadbeef",
    });
    const hash = recordMini(registry, session, [depositStep()]);
    const outcome = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!outcome.ok) throw new Error("revert should be a result, not a refusal");
    if (outcome.result.status !== "failed") throw new Error(`got ${outcome.result.status}`);
    expect(outcome.result.failure.raw).toBe("0xdeadbeef");
    expect(outcome.result.failure.decoded).not.toBeNull();
    expect(session.phase.kind).toBe("failed");
    // The reverted transaction still mined — it spends session budget (charged at submission).
    expect(session.txCount).toBe(1);
    expect(session.pendingDispatch).toBeNull();

    const after = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    expect(after.ok).toBe(false);
    if (after.ok) throw new Error("unreachable");
    expect(after.refusal.kind).toBe("failed");
  });
});

describe("divergence (§6.2)", () => {
  it("halts beyond tolerance with the full evidence pair and blocks all dispatch", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const predicted = 10n * WAD;
    const attributed = predicted + predicted / 10n ** 5n; // 10× the 1e-6 bound
    const chain = scriptedChain({
      shares: [0n, 100n],
      amountForShare: () => attributed,
      sends: [{}],
    });
    const hash = recordMini(registry, session, [depositStep()], new Map([["stake1:deposit", predicted]]));
    const outcome = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!outcome.ok) throw new Error("divergence should be a result");
    if (outcome.result.status !== "halted") throw new Error(`got ${outcome.result.status}`);
    expect(outcome.result.halt).toMatchObject({
      kind: "output-divergence",
      mechanism: "share-delta",
      predictedWei: predicted,
      attributedWei: attributed,
      toleranceWei: predicted / 10n ** 6n,
    });
    // The receipt survives on the halted record: the tx confirmed, and both truths render.
    expect(outcome.result.receipt.txHash).toMatch(/^0x/);
    expect(session.phase.kind).toBe("halted");

    const next = await executeSandboxStep(registry, () => chain, session.key, hash, 1);
    expect(next.ok).toBe(false);
    if (next.ok) throw new Error("unreachable");
    expect(next.refusal.kind).toBe("halted");

    // Idempotent replay of the halted index returns the same recorded evidence.
    const replay = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!replay.ok) throw new Error("replay refused");
    expect(replay.result).toBe(outcome.result);
    expect(chain.dispatches).toHaveLength(1);
  });

  it("converts a zero-Transfer attribution throw into divergence, never a silent 0n (A9)", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const { approve, wrap } = wrapPairSteps();
    const steps = [depositStep(), approve, wrap];
    const predicted = new Map([
      ["stake1:deposit", 10n * WAD],
      ["wrap1:wrap", 9n * WAD],
    ]);
    const chain = scriptedChain({
      shares: [0n, 100n],
      amountForShare: () => 10n * WAD,
      allowances: [0n],
      sends: [{}, {}, { logs: [] }], // wrap receipt carries NO Transfer logs
    });
    const hash = recordMini(registry, session, steps, predicted);
    expect((await executeSandboxStep(registry, () => chain, session.key, hash, 0)).ok).toBe(true);
    expect((await executeSandboxStep(registry, () => chain, session.key, hash, 1)).ok).toBe(true);
    const outcome = await executeSandboxStep(registry, () => chain, session.key, hash, 2);
    if (!outcome.ok) throw new Error("should be a result");
    if (outcome.result.status !== "halted") throw new Error(`got ${outcome.result.status}`);
    if (outcome.result.halt.kind !== "output-divergence") throw new Error("wrong halt kind");
    expect(outcome.result.halt.attributedWei).toBeNull();
    expect(outcome.result.halt.detail).toMatch(/no Transfer/);
  });
});

describe("allowance hygiene (§3.1/§3.3)", () => {
  it("halts as a data error when the consuming step leaves a nonzero allowance", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const { approve, wrap } = wrapPairSteps();
    const steps = [depositStep(), approve, wrap];
    const wrapOut = 9n * WAD;
    const predicted = new Map([
      ["stake1:deposit", 10n * WAD],
      ["wrap1:wrap", wrapOut],
    ]);
    const chain = scriptedChain({
      shares: [0n, 100n],
      amountForShare: () => 10n * WAD,
      allowances: [0n, 5n], // approve prior read, then the residual after consume
      sends: [{}, {}, { logs: [transferLog(WEETH, LP, TEST_ACTOR, wrapOut)] }],
    });
    const hash = recordMini(registry, session, steps, predicted);
    expect((await executeSandboxStep(registry, () => chain, session.key, hash, 0)).ok).toBe(true);
    const approveOutcome = await executeSandboxStep(registry, () => chain, session.key, hash, 1);
    if (!approveOutcome.ok || approveOutcome.result.status !== "attributed") {
      throw new Error("approve should attribute");
    }
    expect(approveOutcome.result.approval?.priorAllowanceWei).toBe(0n);

    const outcome = await executeSandboxStep(registry, () => chain, session.key, hash, 2);
    if (!outcome.ok) throw new Error("should be a result");
    if (outcome.result.status !== "halted") throw new Error(`got ${outcome.result.status}`);
    expect(outcome.result.halt).toMatchObject({
      kind: "residual-allowance",
      spender: WEETH,
      residualAllowanceWei: 5n,
    });
    expect(session.phase.kind).toBe("halted");
  });
});

describe("per-step HF cross-check (§6.3)", () => {
  it("agrees within 1e-6 relative and records both readings", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const hfWad = (15n * WAD) / 10n;
    const chain = scriptedChain({ sends: [{}], healthFactors: [hfWad + hfWad / 10n ** 6n] });
    const hash = recordMini(
      registry,
      session,
      [supplyStep()],
      new Map(),
      new Map([["supply1:supply", { status: "healthy", hfWad }]]),
    );
    const outcome = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!outcome.ok || outcome.result.status !== "attributed") throw new Error("should attribute");
    expect(outcome.result.risk).toEqual({
      expected: { status: "healthy", hfWad },
      chainHfWad: hfWad + hfWad / 10n ** 6n,
    });
  });

  it("halts through the data-error identity when chain and prediction disagree", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const hfWad = (15n * WAD) / 10n;
    const chain = scriptedChain({ sends: [{}], healthFactors: [3n * WAD] });
    const hash = recordMini(
      registry,
      session,
      [supplyStep()],
      new Map(),
      new Map([["supply1:supply", { status: "healthy", hfWad }]]),
    );
    const outcome = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!outcome.ok) throw new Error("should be a result");
    if (outcome.result.status !== "halted") throw new Error(`got ${outcome.result.status}`);
    expect(outcome.result.halt).toMatchObject({
      kind: "hf-disagreement",
      expected: { status: "healthy", hfWad },
      chainHfWad: 3n * WAD,
    });
  });

  it("holds the no-debt sentinel exactly", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const chain = scriptedChain({ sends: [{}], healthFactors: [HF_NO_DEBT] });
    const hash = recordMini(
      registry,
      session,
      [supplyStep()],
      new Map(),
      new Map([["supply1:supply", { status: "no-debt" }]]),
    );
    const outcome = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!outcome.ok || outcome.result.status !== "attributed") throw new Error("should attribute");

    const registry2 = testRegistry();
    const session2 = await activeSession(registry2);
    const chain2 = scriptedChain({ sends: [{}], healthFactors: [HF_NO_DEBT - 1n] });
    const hash2 = recordMini(
      registry2,
      session2,
      [supplyStep()],
      new Map(),
      new Map([["supply1:supply", { status: "no-debt" }]]),
    );
    const halted = await executeSandboxStep(registry2, () => chain2, session2.key, hash2, 0);
    if (!halted.ok) throw new Error("should be a result");
    expect(halted.result.status).toBe("halted");
  });
});

describe("attribution-unavailable re-entry (D3)", () => {
  it("takes the post-read immediately, retains beforeShares, and re-enters without re-sending", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const predicted = 10n * WAD;
    const chain = scriptedChain({
      shares: [0n, "throw", 500n], // before ok, post-read fails once, re-entry read succeeds
      amountForShare: () => predicted,
      sends: [{}],
    });
    const hash = recordMini(registry, session, [depositStep()], new Map([["stake1:deposit", predicted]]));
    const first = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!first.ok) throw new Error("should be a result");
    if (first.result.status !== "attribution-unavailable") throw new Error(`got ${first.result.status}`);
    expect(first.result.beforeShares).toBe(0n);
    expect(first.result.receipt.txHash).toMatch(/^0x/);
    expect(session.phase).toEqual({ kind: "attribution-pending", stepIndex: 0 });

    // Strict sequencing still holds while pending: another index is refused.
    const wrongIndex = await executeSandboxStep(registry, () => chain, session.key, hash, 1);
    expect(wrongIndex.ok).toBe(false);
    if (wrongIndex.ok) throw new Error("unreachable");
    expect(wrongIndex.refusal).toEqual({ kind: "out-of-order", expectedIndex: 0 });

    const resumed = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!resumed.ok) throw new Error("re-entry refused");
    if (resumed.result.status !== "attributed") throw new Error(`got ${resumed.result.status}`);
    expect(resumed.result.sharesDelta).toBe(500n);
    expect(session.phase).toEqual({ kind: "active" });
    expect(chain.dispatches).toHaveLength(1);
  });
});

describe("persistence failure and reconciliation (D3, treatment §9.9 unit half)", () => {
  function failingAppendStore(store: SessionRegistry): SessionRegistry {
    return {
      ...store,
      appendConfirmed: () => {
        throw new Error("registry append failed (injected)");
      },
    };
  }

  it("returns the receipt AND the measurement, gates all dispatch, reconciles without re-sending", async () => {
    const store = testRegistry();
    const session = await activeSession(store);
    const predicted = 10n * WAD;
    const chain = scriptedChain({
      shares: [0n, 500n],
      amountForShare: () => predicted,
      sends: [{}],
    });
    const hash = recordMini(store, session, [depositStep()], new Map([["stake1:deposit", predicted]]));

    const outcome = await executeSandboxStep(failingAppendStore(store), () => chain, session.key, hash, 0);
    if (!outcome.ok) throw new Error("should be a result");
    if (outcome.result.status !== "persistence-failed") throw new Error(`got ${outcome.result.status}`);
    // The receipt is never the casualty, and neither is the measurement (rev 3.1).
    expect(outcome.result.receipt.txHash).toMatch(/^0x/);
    expect(outcome.result.measurement).toEqual({
      status: "measured",
      beforeShares: 0n,
      sharesDelta: 500n,
    });
    expect(session.phase.kind).toBe("reconcile-required");

    // No dispatch of ANY kind until reconciliation — same index or next.
    const retry = await executeSandboxStep(store, () => chain, session.key, hash, 0);
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error("unreachable");
    expect(retry.refusal.kind).toBe("reconcile-required");
    expect(chain.dispatches).toHaveLength(1);

    // A fork that does not corroborate the retained receipt refuses to reconcile: a
    // FRESH scripted chain has an empty ledger, standing in for a fork that lost it.
    const blankChain = scriptedChain({});
    const mismatch = await reconcileSession(store, () => blankChain, session.key);
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error("unreachable");
    expect(mismatch.refusal.kind).toBe("reconcile-mismatch");
    expect(session.phase.kind).toBe("reconcile-required");

    // The real fork corroborates: the record is restored WITHOUT re-sending.
    const reconciled = await reconcileSession(store, () => chain, session.key);
    if (!reconciled.ok) throw new Error(`reconcile refused: ${JSON.stringify(reconciled)}`);
    if (reconciled.result.status !== "attributed") throw new Error(`got ${reconciled.result.status}`);
    expect(reconciled.result.sharesDelta).toBe(500n);
    expect(session.phase).toEqual({ kind: "active" });
    expect(chain.dispatches).toHaveLength(1);
    expect(chain.landed).toHaveLength(1);

    // The dispatch gate is lifted: the next index now answers as plan-complete,
    // not reconcile-required.
    const next = await executeSandboxStep(store, () => chain, session.key, hash, 1);
    expect(next.ok).toBe(false);
    if (next.ok) throw new Error("unreachable");
    expect(next.refusal.kind).toBe("plan-complete");
  });

  it("recovers a both-axes failure from the retained beforeShares (rev 3.1 amendment)", async () => {
    const store = testRegistry();
    const session = await activeSession(store);
    const predicted = 10n * WAD;
    const chain = scriptedChain({
      shares: [0n, "throw", 700n], // post-read fails too; reconcile re-reads
      amountForShare: () => predicted,
      sends: [{}],
    });
    const hash = recordMini(store, session, [depositStep()], new Map([["stake1:deposit", predicted]]));

    const outcome = await executeSandboxStep(failingAppendStore(store), () => chain, session.key, hash, 0);
    if (!outcome.ok) throw new Error("should be a result");
    if (outcome.result.status !== "persistence-failed") throw new Error(`got ${outcome.result.status}`);
    expect(outcome.result.measurement).toMatchObject({ status: "unavailable", beforeShares: 0n });

    const reconciled = await reconcileSession(store, () => chain, session.key);
    if (!reconciled.ok) throw new Error("reconcile refused");
    if (reconciled.result.status !== "attributed") throw new Error(`got ${reconciled.result.status}`);
    expect(reconciled.result.sharesDelta).toBe(700n);
    expect(chain.dispatches).toHaveLength(1);
  });

  it("reconcile on a healthy session is a designed refusal", async () => {
    const store = testRegistry();
    const session = await activeSession(store);
    const outcome = await reconcileSession(store, () => scriptedChain({}), session.key);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("nothing-to-reconcile");
  });
});

describe("post-dispatch transport failures (Codex finding 2)", () => {
  it("classifies a lost response whose tx never landed, vacates on reconcile, then re-dispatches cleanly", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const predicted = 10n * WAD;
    const chain = scriptedChain({
      shares: [0n, 0n, 500n], // attempt 1 before-read; attempt 2 before-read + post-read
      amountForShare: () => predicted,
      sends: [{ dispatchError: "socket hung up" }, {}],
    });
    const hash = recordMini(registry, session, [depositStep()], new Map([["stake1:deposit", predicted]]));

    const first = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!first.ok) throw new Error("should be a result");
    if (first.result.status !== "dispatch-unresolved") throw new Error(`got ${first.result.status}`);
    expect(first.result.txHash).toBeNull();
    expect(session.phase.kind).toBe("reconcile-required");
    // The budget was charged at submission, before the outcome was knowable.
    expect(session.txCount).toBe(1);

    // No retry license: the same index is refused until reconciliation.
    const retry = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error("unreachable");
    expect(retry.refusal.kind).toBe("reconcile-required");
    expect(chain.dispatches).toHaveLength(1);

    // Reconcile: the nonce never moved, so the dispatch provably never landed.
    const vacated = await reconcileSession(registry, () => chain, session.key);
    if (!vacated.ok) throw new Error("reconcile refused");
    if (vacated.result.status !== "dispatch-vacated") throw new Error(`got ${vacated.result.status}`);
    expect(session.phase).toEqual({ kind: "active" });
    expect(chain.landed).toHaveLength(0);

    // A NEW executeStep call may now re-dispatch — this is not a blind retry, it is a
    // post-reconciliation dispatch of a step the fork proved was never sent.
    const second = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!second.ok) throw new Error("re-dispatch refused");
    if (second.result.status !== "attributed") throw new Error(`got ${second.result.status}`);
    expect(chain.dispatches).toHaveLength(2);
    expect(chain.landed).toHaveLength(1);
  });

  it("discovers a lost response whose tx DID land via the nonce pin — never re-sending", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const predicted = 10n * WAD;
    const chain = scriptedChain({
      shares: [0n, 500n], // attempt before-read; adoption after-read
      amountForShare: () => predicted,
      sends: [{ loseResponse: true }],
    });
    const hash = recordMini(registry, session, [depositStep()], new Map([["stake1:deposit", predicted]]));

    const first = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!first.ok) throw new Error("should be a result");
    if (first.result.status !== "dispatch-unresolved") throw new Error(`got ${first.result.status}`);
    expect(first.result.txHash).toBeNull();
    expect(chain.landed).toHaveLength(1);

    const reconciled = await reconcileSession(registry, () => chain, session.key);
    if (!reconciled.ok) throw new Error(`reconcile refused: ${JSON.stringify(reconciled)}`);
    if (reconciled.result.status !== "attributed") throw new Error(`got ${reconciled.result.status}`);
    expect(reconciled.result.sharesDelta).toBe(500n);
    expect(reconciled.result.receipt.txHash).toBe(chain.landed[0]!.txHash);
    // Discovery, never dispatch: one attempt, one landed transaction, one record.
    expect(chain.dispatches).toHaveLength(1);
    expect(chain.landed).toHaveLength(1);
    expect(session.entries).toHaveLength(1);
  });

  it("classifies a confirmation failure (poll error / receipt timeout) and adopts the receipt by hash", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const predicted = 10n * WAD;
    const chain = scriptedChain({
      shares: [0n, 500n],
      amountForShare: () => predicted,
      sends: [{ confirmError: "receipt polling timed out" }],
    });
    const hash = recordMini(registry, session, [depositStep()], new Map([["stake1:deposit", predicted]]));

    const first = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!first.ok) throw new Error("should be a result");
    if (first.result.status !== "dispatch-unresolved") throw new Error(`got ${first.result.status}`);
    // The hash was noted at submission, so recovery starts from it.
    expect(first.result.txHash).toBe(chain.landed[0]!.txHash);
    expect(session.phase.kind).toBe("reconcile-required");

    const reconciled = await reconcileSession(registry, () => chain, session.key);
    if (!reconciled.ok) throw new Error("reconcile refused");
    if (reconciled.result.status !== "attributed") throw new Error(`got ${reconciled.result.status}`);
    expect(reconciled.result.sharesDelta).toBe(500n);
    expect(chain.dispatches).toHaveLength(1);
    expect(chain.landed).toHaveLength(1);
  });

  it("refuses to guess when the nonce moved but the transaction cannot be found", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const chain = scriptedChain({
      shares: [0n],
      sends: [{ dispatchError: "socket hung up" }],
    });
    const hash = recordMini(registry, session, [depositStep()]);
    const first = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!first.ok || first.result.status !== "dispatch-unresolved") throw new Error("fixture");

    // A fork whose nonce moved without a findable transaction is a state the engine
    // must refuse to interpret — never vacate (that would license a double-send).
    const inscrutable = { ...chain, actorNonce: async () => 1n, transactionByNonce: async () => null };
    const outcome = await reconcileSession(registry, () => inscrutable, session.key);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.kind).toBe("reconcile-mismatch");
    expect(session.phase.kind).toBe("reconcile-required");
  });

  it("vacates a hash-known dispatch whose receipt vanished with the nonce unmoved, refuses if it moved", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const chain = scriptedChain({
      shares: [0n],
      sends: [{ confirmError: "poll failed" }],
    });
    const hash = recordMini(registry, session, [depositStep()]);
    const first = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!first.ok || first.result.status !== "dispatch-unresolved") throw new Error("fixture");

    // The fork lost the receipt AND the nonce moved: refuse to interpret.
    const moved = { ...scriptedChain({}), actorNonce: async () => 1n };
    const mismatch = await reconcileSession(registry, () => moved, session.key);
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error("unreachable");
    expect(mismatch.refusal.kind).toBe("reconcile-mismatch");
    expect(session.phase.kind).toBe("reconcile-required");

    // The fork lost the receipt and the nonce never moved: the dispatch is vacated.
    const unmoved = scriptedChain({});
    const vacated = await reconcileSession(registry, () => unmoved, session.key);
    if (!vacated.ok) throw new Error("reconcile refused");
    expect(vacated.result.status).toBe("dispatch-vacated");
    expect(session.phase).toEqual({ kind: "active" });
  });

  it("adopts a dispatched step that landed as a REVERT into the failed state", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const chain = scriptedChain({
      shares: [0n],
      sends: [{ revert: true, confirmError: "poll died before the status was read" }],
      revertData: "0xdeadbeef",
    });
    const hash = recordMini(registry, session, [depositStep()]);
    const first = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!first.ok) throw new Error("should be a result");
    if (first.result.status !== "dispatch-unresolved") throw new Error(`got ${first.result.status}`);

    const reconciled = await reconcileSession(registry, () => chain, session.key);
    if (!reconciled.ok) throw new Error("reconcile refused");
    if (reconciled.result.status !== "failed") throw new Error(`got ${reconciled.result.status}`);
    expect(reconciled.result.failure.raw).toBe("0xdeadbeef");
    expect(session.phase.kind).toBe("failed");
    expect(chain.dispatches).toHaveLength(1);
  });
});

describe("bounded stalls and diagnostic failures (Codex round 2)", () => {
  it("bounds a stalled confirmation, classifies it, and releases the mutex with evidence retained (finding 1)", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const predicted = 10n * WAD;
    const base = scriptedChain({
      shares: [0n, 500n], // attempt before-read; adoption after-read
      amountForShare: () => predicted,
      sends: [{}],
    });
    // The REAL policy wrapper over a transport that never answers: the await must fail,
    // bounded, and the engine must classify it — this is the composed stall drill.
    const stalled: typeof base = {
      ...base,
      confirmTransaction: (txHash) =>
        withDeadline(`receipt confirmation for ${txHash}`, 25, () => new Promise<never>(() => {})),
    };
    const hash = recordMini(registry, session, [depositStep()], new Map([["stake1:deposit", predicted]]));

    const first = await executeSandboxStep(registry, () => stalled, session.key, hash, 0);
    if (!first.ok) throw new Error("should be a result");
    if (first.result.status !== "dispatch-unresolved") throw new Error(`got ${first.result.status}`);
    // Mutex released, evidence retained, dispatch charged — the stall is a STATE.
    expect(session.inFlight).toBe(false);
    expect(session.phase.kind).toBe("reconcile-required");
    expect(session.txCount).toBe(1);
    const recovery = registry.summaryOf(session).recovery;
    if (recovery === null || recovery.kind !== "reconcile-dispatch") {
      throw new Error("expected dispatch recovery evidence");
    }
    expect(recovery.txHash).toBe(base.landed[0]!.txHash);

    // Recovery is discovery against the (now answering) fork — never a re-send.
    const reconciled = await reconcileSession(registry, () => base, session.key);
    if (!reconciled.ok) throw new Error("reconcile refused");
    expect(reconciled.result.status).toBe("attributed");
    expect(base.dispatches).toHaveLength(1);
    expect(base.landed).toHaveLength(1);
  });

  it("records the failed state BEFORE the diagnostic replay; a rejecting replay cannot re-license dispatch (finding 2)", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const base = scriptedChain({
      shares: [0n],
      sends: [{ revert: true }],
    });
    const brokenDiagnostics: typeof base = {
      ...base,
      revertDataOf: async () => {
        throw new Error("replay RPC rejected");
      },
    };
    const hash = recordMini(registry, session, [depositStep()]);
    const outcome = await executeSandboxStep(registry, () => brokenDiagnostics, session.key, hash, 0);
    if (!outcome.ok) throw new Error("revert should be a result");
    if (outcome.result.status !== "failed") throw new Error(`got ${outcome.result.status}`);
    // Raw bytes absent is acceptable; a second send is not.
    expect(outcome.result.failure.raw).toBeNull();
    expect(outcome.result.failure.decoded).toBeNull();
    expect(outcome.result.failure.txHash).toBe(base.landed[0]!.txHash);
    expect(session.phase.kind).toBe("failed");
    expect(session.txCount).toBe(1);

    // No retry license: the failed state is durable and dispatch stays refused.
    const retry = await executeSandboxStep(registry, () => brokenDiagnostics, session.key, hash, 0);
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error("unreachable");
    expect(retry.refusal.kind).toBe("failed");
    expect(base.dispatches).toHaveLength(1);
    expect(base.landed).toHaveLength(1);
  });

  it("keeps the recorded failure when the replay rejects during dispatch-reconciliation too", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const base = scriptedChain({
      shares: [0n],
      sends: [{ revert: true, confirmError: "poll died before the status was read" }],
    });
    const brokenDiagnostics: typeof base = {
      ...base,
      revertDataOf: async () => {
        throw new Error("replay RPC rejected");
      },
    };
    const hash = recordMini(registry, session, [depositStep()]);
    const first = await executeSandboxStep(registry, () => brokenDiagnostics, session.key, hash, 0);
    if (!first.ok || first.result.status !== "dispatch-unresolved") throw new Error("fixture");

    const reconciled = await reconcileSession(registry, () => brokenDiagnostics, session.key);
    if (!reconciled.ok) throw new Error("reconcile refused");
    if (reconciled.result.status !== "failed") throw new Error(`got ${reconciled.result.status}`);
    expect(reconciled.result.failure.raw).toBeNull();
    expect(session.phase.kind).toBe("failed");
    expect(base.dispatches).toHaveLength(1);
  });
});

describe("settle-time read failures (D3: the record survives, settlement re-enters)", () => {
  it("keeps the measured delta and re-settles on the next call without re-reading shares", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const predicted = 10n * WAD;
    let settleReads = 0;
    const chain = scriptedChain({
      shares: [0n, 500n],
      amountForShare: () => {
        settleReads += 1;
        if (settleReads === 1) throw new Error("settle-time conversion read failed");
        return predicted;
      },
      sends: [{}],
    });
    const hash = recordMini(registry, session, [depositStep()], new Map([["stake1:deposit", predicted]]));
    const first = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!first.ok) throw new Error("should be a result");
    if (first.result.status !== "attribution-unavailable") throw new Error(`got ${first.result.status}`);
    expect(session.phase).toEqual({ kind: "attribution-pending", stepIndex: 0 });
    // The measurement already happened; only settlement failed.
    expect(session.entries[0]!.sharesDelta).toBe(500n);

    const resumed = await executeSandboxStep(registry, () => chain, session.key, hash, 0);
    if (!resumed.ok) throw new Error("re-entry refused");
    if (resumed.result.status !== "attributed") throw new Error(`got ${resumed.result.status}`);
    expect(resumed.result.sharesDelta).toBe(500n);
    // The re-entry converted again but never re-read shares and never re-sent.
    expect(chain.sharesCalls).toBe(2);
    expect(chain.dispatches).toHaveLength(1);
  });
});

describe("pre-dispatch failures are errors, not states", () => {
  it("propagates a read failure that precedes the dispatch intent; nothing is charged or recorded", async () => {
    const registry = testRegistry();
    const session = await activeSession(registry);
    const chain = scriptedChain({ shares: [], sends: [{}] }); // before-read exhausts immediately
    const hash = recordMini(registry, session, [depositStep()]);
    await expect(
      executeSandboxStep(registry, () => chain, session.key, hash, 0),
    ).rejects.toThrow("scripted sharesOf exhausted");
    // No intent was recorded, so no state was invented and no budget charged: the
    // machine can classify nothing here — nothing left the building.
    expect(session.phase).toEqual({ kind: "active" });
    expect(session.entries).toHaveLength(0);
    expect(session.txCount).toBe(0);
    expect(session.pendingDispatch).toBeNull();
  });
});
