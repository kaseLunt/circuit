/**
 * W09 carry-leg fork gate: the USDC carry executed end to end on the real session
 * composition, plus the hand-built revert receipts the product path cannot produce by design.
 *
 * WHAT ONLY THIS FILE CAN PROVE. The unit suite pins the arithmetic against the committed
 * reads log; what it cannot do is show that the six-decimal generalization agrees with the
 * CHAIN rather than with itself. So the HF cross-check below runs at `cat = null` with
 * mixed-decimals debt — the first time `getUserAccountData` has been asked to confirm a
 * valuation that divides one leg by 1e18 and the other by 1e6 — and the attribution
 * comparison demands EXACT equality on the USDC leg, because for a borrow the prediction and
 * the calldata are the same figure and the pool's `Transfer` echoes it.
 *
 * THE NEGATIVE CONTROLS ARE HAND-CONSTRUCTED, AND THAT IS THE DESIGN. `buildPlan` refuses an
 * in-category wallet before any calldata exists, so there is no product path that reaches
 * `NotBorrowableInEMode` — a drill that went through the compiler would prove only that the
 * compiler agrees with itself. These drills therefore build their own `borrow(USDC, …)` and
 * their own `setUserEMode(1)` and assert what the DEPLOYED revision does with them, which is
 * what turns the source citation into a receipt. Same shape as the P2 accrual negative
 * control in `flagship-plan.test.ts`.
 *
 * THE LTV BOUNDARY IS DRILLED FROM BOTH SIDES, and that is not belt-and-braces. A refusal one
 * bp past the ceiling passes for ANY client ceiling at or below the protocol's, because
 * everything past the real line reverts; only executing AT the ceiling — settled, attributed,
 * read back off the chain — says where the line is. The two drills below pin 7749 accepted and
 * 7750 refused, each on a fork of its own so neither subsidizes the other.
 *
 * WHAT IS NOT PROVEN HERE: nothing below claims USDC will not be upgraded, or that Circle
 * will not blacklist an address. The tolerance comparison is the standing answer to both —
 * an introduced fee or a changed transfer would surface as a divergence halt, which is the
 * honest outcome. The fork pins today's revision; live inherits the comparison.
 *
 * Fork topology mirrors `execution-drills.test.ts` (see its header for the anvil
 * historical-state wedge): the session forks are children of the SHARED pristine upstream
 * `tests/fork/global-setup.ts` boots, whose head never moves. This file used to spawn its own;
 * the wedge argument requires the upstream to be pristine, not private (R-3a74989b). The port
 * map lives in `tests/fork/anvil.ts`; this suite's session children take 9665–9669.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  concatHex,
  encodeFunctionData,
  keccak256,
  padHex,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { PINNED_BLOCK, readsMeta } from "../helpers/protocol-reads";
import { FORK_PROVEN_CARRY_BPS, carryGraph, flagshipGraph } from "../helpers/graphs";
import { encodeShareGraph } from "../../src/lib/share/encode";
import { borrowLimitVerdict } from "../../src/core/borrow-limit";
import { decodeRevert } from "../../src/core/errors";
import { riskLedger } from "../../src/core/risk";
import { hfWadValue } from "../../src/core/health-factor";
import {
  SANDBOX_HF_REL_POW,
  SANDBOX_OUTPUT_TOLERANCE,
  relWithin,
  withinOutputTolerance,
} from "../../src/lib/execution/tolerance";
import {
  createSessionRegistry,
  type Session,
  type SessionFork,
} from "../../src/server/sandbox/session-registry";
import type { SandboxChain } from "../../src/server/sandbox/execute-step";
import {
  captureSessionSnapshot,
  spawnSessionFork,
  type ForkSessionConfig,
} from "../../src/server/sandbox/fork-session";
import { createSandboxCaller, type SandboxContext } from "../../src/server/trpc/sandbox-router";
import { SESSION_UPSTREAM_URL } from "./anvil";
import { assertSharedUpstreamPristine, hexQuantity, hexWord, record } from "./harness";

const PINNED_HASH = readsMeta.pinned_block.hash as Hex;

const config: ForkSessionConfig = {
  upstreamUrl: SESSION_UPSTREAM_URL,
  baseBlock: PINNED_BLOCK,
  expectBlockHash: PINNED_HASH,
  anvilPath: process.env.ANVIL_PATH ?? "anvil",
  portBase: 9665,
  portCount: 5,
  computeUnitsPerSecond: "100",
  forkRetries: "10",
  forkRetryBackoffMs: "2000",
};

const CARRY_STEP_COUNT = 6;
/** The flagship prefix that lands weETH collateral INSIDE category 1: through supply1:supply. */
const FLAGSHIP_PREFIX_STEPS = 6;

/**
 * THE BOUNDARY, PINNED ON BOTH SIDES — 7749 accepted, 7750 refused.
 *
 * These two numbers do not feed anything: `core/borrow-limit.ts` DERIVES the ceiling from the
 * session's own snapshot, and the drills below assert its derivation lands here. Without the
 * pin, a ceiling that silently moved would still be "one bp past the ceiling" and both drills
 * would still pass — while quietly proving a boundary nobody had reviewed. With it, a shift in
 * either direction fails at the assertion rather than re-aiming the evidence.
 *
 * `CEILING_BPS + 1` is also the weETH reserve's own LTV (7750 bps, read — not typed): the
 * protocol's ceil-rounded debt chain costs exactly one bp against a borrower who asks for the
 * whole of it, which is the fact `maxAllocationBpsOf`'s search exists to find and the reason
 * the ceiling is not `ceilingBase × 1e4 / collateralBase`.
 */
const CEILING_BPS = 7749;
const OVER_CEILING_BPS = 7750;

/**
 * THE TWO SIGNED MARGINS, in oracle base units (8-dec), at the pinned block.
 *
 * `relWithin` at 1e-6 over a base figure of 1.49e12 tolerates roughly 1.5 MILLION units — four
 * orders of magnitude more than the 97-unit excess that decides this boundary. A GenericLogic
 * rounding regression far larger than the thing under test would pass a tolerance check, which
 * is why the accepted side asserts EXACT integer equality against `borrow-limit.ts`'s own
 * prediction and pins both margins as integers rather than as fractions of anything.
 *
 * Both are deterministic functions of the fork's base block: the fixture block is fixed, every
 * input is a read at that block, and the arithmetic is integer end to end. They are stated as
 * literals here so a shift in the protocol's rounding chain fails LOUDLY rather than sliding
 * inside a tolerance band.
 *
 *   headroom = ceilingBase − debtBase(7749) = 1490996818049 − 1490804431402 = 192386647
 *   excess   = debtBase(7750) − ceilingBase = 1490996818146 − 1490996818049 =        97
 */
const CEILING_HEADROOM_BASE = 192_386_647n;
const OVER_CEILING_EXCESS_BASE = 97n;

/** Balance-mapping scan bound, the `findAllowanceSlotAt` discipline. */
const BALANCE_SCAN_SLOTS = 32n;
/** Pre-existing USDC seeded on the actor, in the reserve's own six-decimal units. */
const SEEDED_USDC = 1_234_567_890n;
const RAW_GAS_LIMIT = 3_000_000n;

const ABI = {
  pool: parseAbi([
    "function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
    "function getUserEMode(address) view returns (uint256)",
    "function setUserEMode(uint8 categoryId)",
    "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  ]),
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
  ]),
};

let rpcId = 0;
async function rpcAt<T>(url: string, method: string, params: readonly unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: (rpcId += 1), method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error !== undefined) {
    throw new Error(`${method} failed: ${body.error.message ?? "rpc error"}`);
  }
  return body.result as T;
}

const blockNumberAt = async (url: string): Promise<bigint> =>
  BigInt(await rpcAt<string>(url, "eth_blockNumber"));

/**
 * `block` pins the read to a specific height. Default "latest" is right for a probe; a
 * comparison that claims EXACT equality against a prediction has to name the block it is
 * exact AT, because every index-bearing figure the pool reports accrues with block timestamp.
 */
async function callAt(url: string, to: Address, data: Hex, block?: bigint): Promise<Hex> {
  return rpcAt<Hex>(url, "eth_call", [{ to, data }, block === undefined ? "latest" : hexQuantity(block)]);
}

async function balanceOfAt(url: string, token: Address, who: Address): Promise<bigint> {
  return BigInt(
    await callAt(url, token, encodeFunctionData({ abi: ABI.erc20, functionName: "balanceOf", args: [who] })),
  );
}

async function allowanceAt(
  url: string,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return BigInt(
    await callAt(
      url,
      token,
      encodeFunctionData({ abi: ABI.erc20, functionName: "allowance", args: [owner, spender] }),
    ),
  );
}

async function userAccountDataAt(
  url: string,
  pool: Address,
  who: Address,
  block?: bigint,
): Promise<{
  collateralBase: bigint;
  debtBase: bigint;
  availableBorrowsBase: bigint;
  ltv: bigint;
  healthFactor: bigint;
}> {
  const raw = await callAt(
    url,
    pool,
    encodeFunctionData({ abi: ABI.pool, functionName: "getUserAccountData", args: [who] }),
    block,
  );
  const words = raw.slice(2).match(/.{64}/g);
  if (words === null || words.length < 6) throw new Error("getUserAccountData returned no tuple");
  return {
    collateralBase: BigInt(`0x${words[0]!}`),
    debtBase: BigInt(`0x${words[1]!}`),
    // The protocol's OWN headroom figure — `percentMul(collateral, ltv) - debt`, floored at
    // zero (GenericLogic.calculateAvailableBorrows). The boundary drill reads its remaining
    // room off the chain rather than recomputing it.
    availableBorrowsBase: BigInt(`0x${words[2]!}`),
    ltv: BigInt(`0x${words[4]!}`),
    healthFactor: BigInt(`0x${words[5]!}`),
  };
}

async function userEModeAt(url: string, pool: Address, who: Address): Promise<bigint> {
  return BigInt(
    await callAt(url, pool, encodeFunctionData({ abi: ABI.pool, functionName: "getUserEMode", args: [who] })),
  );
}

interface RawOutcome {
  readonly txHash: Hex;
  readonly status: bigint;
  readonly blockNumber: bigint;
}

/**
 * Send a HAND-BUILT transaction as the session actor and return its mined outcome WITHOUT
 * throwing on a revert — a reverted drill transaction is the datum, not a failure.
 */
async function sendRaw(url: string, from: Address, to: Address, data: Hex): Promise<RawOutcome> {
  const txHash = await rpcAt<Hex>(url, "eth_sendTransaction", [
    { from, to, data, gas: hexQuantity(RAW_GAS_LIMIT) },
  ]);
  for (let i = 0; i < 200; i += 1) {
    const receipt = await rpcAt<Record<string, unknown> | null>(url, "eth_getTransactionReceipt", [
      txHash,
    ]);
    if (receipt !== null) {
      return {
        txHash,
        status: BigInt(receipt["status"] as string),
        blockNumber: BigInt(receipt["blockNumber"] as string),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no receipt for hand-built transaction ${txHash}`);
}

/**
 * Replay a mined transaction at its parent block so the CHAIN yields the revert payload.
 * Throws unless the replay reverts with data: a drill that cannot obtain the deployed
 * revision's own bytes has nothing to decode and must not pass quietly.
 */
async function revertBytesOf(url: string, outcome: RawOutcome): Promise<Hex> {
  const tx = await rpcAt<Record<string, unknown> | null>(url, "eth_getTransactionByHash", [
    outcome.txHash,
  ]);
  if (tx === null) throw new Error(`revert replay: ${outcome.txHash} is not in the fork's history`);
  const payload: Record<string, string> = {
    from: tx["from"] as string,
    to: tx["to"] as string,
    gas: tx["gas"] as string,
    data: (tx["input"] ?? tx["data"]) as string,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: (rpcId += 1),
      method: "eth_call",
      params: [payload, hexQuantity(outcome.blockNumber - 1n)],
    }),
  });
  const body = (await res.json()) as { error?: { message?: string; data?: unknown } };
  if (body.error === undefined) {
    throw new Error(`revert replay: ${outcome.txHash} succeeded at its parent block`);
  }
  const direct = body.error.data;
  if (typeof direct === "string") return direct as Hex;
  if (typeof direct === "object" && direct !== null) {
    const nested = (direct as { data?: unknown }).data;
    if (typeof nested === "string") return nested as Hex;
  }
  throw new Error(`revert replay: no revert data (${body.error.message ?? "no message"})`);
}

/**
 * Locate the ERC-20 balance mapping's base slot EMPIRICALLY, the same exactly-one discipline
 * the drills suite uses for allowances: for base slots 0..N compute `keccak(holder ++ base)`
 * and match the stored word against a balance the token itself reports. No hand-typed storage
 * layout claim — a seeding drill that asserted "USDC keeps balances at slot 9" would be
 * exactly the docs-trusting move this repo refuses, and would fail silently after an upgrade.
 *
 * The probe holder is the aUSDC token, whose USDC balance is large, nonzero and readable.
 */
async function findBalanceSlotBase(
  url: string,
  token: Address,
  probeHolder: Address,
): Promise<bigint> {
  const expected = await balanceOfAt(url, token, probeHolder);
  if (expected === 0n) throw new Error("balance-slot scan needs a nonzero probe balance");
  const matches: bigint[] = [];
  for (let base = 0n; base < BALANCE_SCAN_SLOTS; base += 1n) {
    const slot = keccak256(
      concatHex([padHex(probeHolder, { size: 32 }), toHex(base, { size: 32 })]),
    );
    const word = BigInt(await rpcAt<string>(url, "eth_getStorageAt", [token, slot, "latest"]));
    if (word === expected) matches.push(base);
  }
  if (matches.length !== 1) {
    throw new Error(`balance-slot scan must find exactly one base; found ${matches.length}`);
  }
  return matches[0]!;
}

async function seedBalance(
  url: string,
  token: Address,
  base: bigint,
  holder: Address,
  amount: bigint,
): Promise<void> {
  const slot = keccak256(concatHex([padHex(holder, { size: 32 }), toHex(base, { size: 32 })]));
  await rpcAt(url, "anvil_setStorageAt", [token, slot, hexWord(amount)]);
}

describe("W09 fork gate — the USDC carry on the real session composition", () => {
  const registry = createSessionRegistry({
    // One per drill, and the drills retire their own (see `closeSession`) — the capacity is
    // headroom for a failing drill's leaked session, not a licence to hold four forks open.
    maxSessions: 4,
    ttlMs: 30 * 60_000,
    maxTxPerSession: 32,
    minExecuteIntervalMs: 0,
  });
  const chains = new WeakMap<SessionFork, SandboxChain>();
  const ctx: SandboxContext = {
    store: registry,
    spawnFork: async () => {
      const handle = await spawnSessionFork(config);
      chains.set(handle, handle.chain);
      return handle;
    },
    chainFor: (session) => {
      const chain = chains.get(session.fork);
      if (chain === undefined) throw new Error("session fork has no chain binding");
      return chain;
    },
    captureSnapshot: (session) => captureSessionSnapshot(session.fork, session.actor),
  };
  const caller = createSandboxCaller(ctx);
  const openKeys = new Set<string>();

  async function sessionOf(key: string): Promise<Session> {
    const looked = await registry.lookup(key);
    if (!looked.ok) throw new Error(`session lookup refused: ${looked.refusal.kind}`);
    return looked.session;
  }

  async function createSession(): Promise<{ key: string; session: Session }> {
    const created = await caller.create();
    if (!created.ok) throw new Error(`session creation refused: ${created.refusal.kind}`);
    openKeys.add(created.session.sessionKey);
    return {
      key: created.session.sessionKey,
      session: await sessionOf(created.session.sessionKey),
    };
  }

  /**
   * Retire a drill's session as soon as its evidence is complete.
   *
   * Every drill here wants a FORK OF ITS OWN — an earlier drill's collateral, debt or e-mode
   * membership must never subsidize a later one's claim, and that is the whole reason each
   * calls `createSession()` rather than sharing. Retiring on the way out keeps at most one
   * session anvil alive beside the upstream, which is what makes a fourth drill free. The
   * `afterAll` sweep stays: a drill that throws leaks its session, and the sweep collects it.
   */
  async function closeSession(key: string): Promise<void> {
    const destroyed = await caller.destroy({ sessionKey: key });
    if (!destroyed.ok) {
      throw new Error(`session destroy refused: ${JSON.stringify(destroyed.refusal)}`);
    }
    openKeys.delete(key);
  }

  beforeAll(async () => {
    await assertSharedUpstreamPristine("before usdc-carry ran");
  });

  afterAll(async () => {
    for (const key of [...openKeys]) {
      await caller.destroy({ sessionKey: key }).catch(() => undefined);
    }
    // Six steps of real execution ran on this suite's session forks — children, which mine by
    // design. The shared upstream they were forked from must be exactly where it started.
    await assertSharedUpstreamPristine("after usdc-carry ran");
  });

  /**
   * The carry, end to end through the SAME `sandbox.plan` → `sandbox.executeStep` path the
   * product ships — with pre-existing USDC on the actor before a single step runs.
   *
   * The seed is the point of SPEC §5.5's no-sweep clause made concrete for the first
   * six-decimal asset: if any leg attributed a `balanceOf` rather than the Transfer value,
   * the borrow's attributed output would come back as seed + borrowed and the comparison
   * below would be off by exactly `SEEDED_USDC`.
   */
  it("plans and executes the carry, attributing the USDC leg to the Transfer and not to a balance", async () => {
    const { key, session } = await createSession();
    const url = session.fork.rpcUrl;
    const snapshot = await captureSessionSnapshot(session.fork, session.actor);
    const usdc = snapshot.reserves.USDC.underlying;
    const weETH = snapshot.reserves.weETH.underlying;

    // Seed pre-existing USDC through an empirically located balance slot.
    const base = await findBalanceSlotBase(url, usdc, snapshot.reserves.USDC.aToken);
    await seedBalance(url, usdc, base, session.actor, SEEDED_USDC);
    expect(await balanceOfAt(url, usdc, session.actor)).toBe(SEEDED_USDC);
    record(`seeded ${SEEDED_USDC} USDC on the actor via balance-mapping base slot ${base}`);

    const encoded = encodeShareGraph(carryGraph());
    if (!encoded.ok) throw new Error("carry fixture refused by the share codec");
    const planned = await caller.plan({ sessionKey: key, document: encoded.token });
    if (!planned.ok) throw new Error(`plan refused: ${JSON.stringify(planned.refusal)}`);
    expect(planned.plan.stepCount).toBe(CARRY_STEP_COUNT);
    const stepIds = planned.plan.steps.map((step) => step.id);
    expect(stepIds).toEqual([
      "stake1:deposit",
      "wrap1:approve",
      "wrap1:wrap",
      "supply1:approve",
      "supply1:supply",
      "borrow:borrow",
    ]);
    // The absences, asserted on the SERVER-BUILT plan rather than on a local rebuild.
    expect(stepIds.some((id) => id.endsWith(":set-emode"))).toBe(false);
    const planHash = planned.plan.planHash as Hex;

    const ledger = riskLedger(carryGraph(), snapshot);
    expect(ledger.ok).toBe(true);
    const checkpointByStep = new Map(
      ledger.checkpoints.map((cp) => [
        cp.cause === "supply" ? `${cp.blockId}:supply` : `${cp.blockId}:borrow`,
        cp,
      ]),
    );

    let borrowedWei = 0n;
    let compared = 0;
    for (let index = 0; index < CARRY_STEP_COUNT; index += 1) {
      const outcome = await caller.executeStep({ sessionKey: key, planHash, stepIndex: index });
      if (!outcome.ok) throw new Error(`executeStep refused: ${JSON.stringify(outcome.refusal)}`);
      if (outcome.result.status !== "attributed") {
        throw new Error(`step ${index} settled as ${outcome.result.status}`);
      }
      const stepId = outcome.result.stepId;
      const output = outcome.result.output;

      if (index === 0) {
        // STRICT SEQUENCE, probed while the cursor is genuinely behind the request. (After
        // the plan completes, the same call is an idempotent REPLAY of a settled step, which
        // is a different contract — proven below.)
        const ahead = await caller.executeStep({
          sessionKey: key,
          planHash,
          stepIndex: CARRY_STEP_COUNT - 1,
        });
        expect(ahead.ok).toBe(false);
        if (ahead.ok) throw new Error("unreachable");
        expect(ahead.refusal).toEqual({ kind: "out-of-order", expectedIndex: 1 });
      }

      if (stepId === "borrow:borrow") {
        if (output === null) throw new Error("the borrow must carry an attributed output");
        // W07's whitelist: the USDC leg is a TRANSFER-EVENT attribution, and nothing else.
        expect(output.mechanism).toBe("transfer-event");
        const predicted = BigInt(output.predictedWei);
        const attributed = BigInt(output.attributedWei);
        expect(
          withinOutputTolerance(predicted, attributed, SANDBOX_OUTPUT_TOLERANCE),
          "the carry's borrow breached the product tolerance",
        ).toBe(true);
        // EXACT, not merely within: the borrow amount is plan-time calldata and FiatToken
        // moves precisely that figure, so the drill demands the equality the product bound
        // only permits. A fee-on-transfer upgrade would break this line first.
        expect(attributed - predicted).toBe(0n);
        borrowedWei = attributed;
        record(`carry borrow attributed ${attributed} USDC, delta ${attributed - predicted}`);
      } else if (output !== null) {
        expect(
          withinOutputTolerance(
            BigInt(output.predictedWei),
            BigInt(output.attributedWei),
            SANDBOX_OUTPUT_TOLERANCE,
          ),
          `${stepId} breached tolerance`,
        ).toBe(true);
      }

      // SPEC §5.4's post-execution clause, at `cat = null` with mixed-decimals debt — the
      // comparison that checks the generalized valuation against the chain rather than
      // against the code that produced it.
      const checkpoint = checkpointByStep.get(stepId);
      if (checkpoint !== undefined) {
        const account = await userAccountDataAt(url, snapshot.pool, session.actor);
        const ours = hfWadValue(checkpoint.healthFactor);
        if (ours === null) throw new Error(`${stepId}: ledger health factor is unknown`);
        if (checkpoint.healthFactor.status === "no-debt") {
          expect(account.healthFactor, `${stepId}: no-debt sentinel`).toBe(2n ** 256n - 1n);
        } else {
          expect(
            relWithin(ours, account.healthFactor, SANDBOX_HF_REL_POW),
            `${stepId}: ledger ${ours} vs chain ${account.healthFactor}`,
          ).toBe(true);
          // …and the DEBT side agrees too, which is the six-decimal claim specifically.
          expect(
            relWithin(BigInt(checkpoint.totalDebtBase!), account.debtBase, SANDBOX_HF_REL_POW),
            `${stepId}: ledger debtBase ${checkpoint.totalDebtBase} vs chain ${account.debtBase}`,
          ).toBe(true);
        }
        record(`carry ${stepId}: ours ${ours} vs chain ${account.healthFactor}`);
        compared += 1;
      }
    }
    expect(compared, "every risk-changing checkpoint was compared").toBe(2);

    // NO SWEEP: the seed is provably untouched, and the actor holds exactly seed + borrowed.
    const finalUsdc = await balanceOfAt(url, usdc, session.actor);
    expect(finalUsdc).toBe(SEEDED_USDC + borrowedWei);
    expect(finalUsdc - borrowedWei).toBe(SEEDED_USDC);

    // ZERO AFTER CONSUME: the weETH approve pair resolved once and left no standing allowance.
    expect(await allowanceAt(url, weETH, session.actor, snapshot.pool)).toBe(0n);
    // …and NO USDC allowance was ever granted, so there is nothing to leave standing.
    expect(await allowanceAt(url, usdc, session.actor, snapshot.pool)).toBe(0n);

    // The position really did execute at the reserve regime: the actor is in no category, and
    // the chain's own `ltv` for the account is the weETH reserve's, not category 1's.
    expect(await userEModeAt(url, snapshot.pool, session.actor)).toBe(0n);
    const account = await userAccountDataAt(url, snapshot.pool, session.actor);
    expect(account.ltv).toBe(BigInt(snapshot.reserves.weETH.ltvBps.value));
    expect(account.ltv).not.toBe(BigInt(snapshot.eModeCategories[0]!.ltvBps.value));
    record(
      `carry final: eMode 0, chain ltv ${account.ltv}, debtBase ${account.debtBase}, ` +
        `HF ${account.healthFactor}`,
    );

    // IDEMPOTENT REPLAY of the final step: same answer, and provably no second transaction.
    const blockBefore = await blockNumberAt(url);
    const replay = await caller.executeStep({
      sessionKey: key,
      planHash,
      stepIndex: CARRY_STEP_COUNT - 1,
    });
    expect(replay.ok).toBe(true);
    expect(await blockNumberAt(url)).toBe(blockBefore);

    /**
     * ORDER B, for free while this actor holds USDC debt: a wallet carrying debt the target
     * category cannot borrow may not ENTER that category at all
     * (`validateSetUserEMode`'s debt loop). This is why "borrow first, then enter e-mode" is
     * not an alternative sequencing the compiler could have chosen.
     */
    const enter = await sendRaw(
      url,
      session.actor,
      snapshot.pool,
      encodeFunctionData({ abi: ABI.pool, functionName: "setUserEMode", args: [1] }),
    );
    expect(enter.status).toBe(0n);
    const decoded = decodeRevert(await revertBytesOf(url, enter));
    expect(decoded.source).toBe("custom-error");
    expect(decoded.message).toContain("not borrowable in that e-mode category");
    record(`order-B receipt: setUserEMode(1) with USDC debt reverts ${decoded.raw}`);
    await closeSession(key);
  });

  /**
   * THE eMODE-CONSTRAINT NEGATIVE CONTROL — the deployed-revision receipt behind the
   * compiler's refusal.
   *
   * The compiler refuses an in-category wallet at plan time, so the product NEVER emits this
   * calldata; the drill builds its own. The setup (deposit, wrap, enter category 1, supply) is
   * the flagship's own prefix through the product path, so the position is real; the BORROW is
   * hand-constructed here, which is precisely the arm `buildPlan` cannot supply.
   */
  it("proves NotBorrowableInEMode on the deployed revision, from calldata buildPlan never emits", async () => {
    const { key, session } = await createSession();
    const url = session.fork.rpcUrl;
    const snapshot = await captureSessionSnapshot(session.fork, session.actor);

    const encoded = encodeShareGraph(flagshipGraph());
    if (!encoded.ok) throw new Error("flagship fixture refused by the share codec");
    const planned = await caller.plan({ sessionKey: key, document: encoded.token });
    if (!planned.ok) throw new Error(`plan refused: ${JSON.stringify(planned.refusal)}`);
    expect(planned.plan.steps[3]!.id).toBe("supply1:set-emode");
    const planHash = planned.plan.planHash as Hex;
    for (let index = 0; index < FLAGSHIP_PREFIX_STEPS; index += 1) {
      const outcome = await caller.executeStep({ sessionKey: key, planHash, stepIndex: index });
      if (!outcome.ok || outcome.result.status !== "attributed") {
        throw new Error(`flagship prefix step ${index} did not settle attributed`);
      }
    }
    // The position the drill needs: real collateral, standing inside category 1.
    expect(await userEModeAt(url, snapshot.pool, session.actor)).toBe(1n);
    const account = await userAccountDataAt(url, snapshot.pool, session.actor);
    expect(account.collateralBase).toBeGreaterThan(0n);
    expect(account.debtBase).toBe(0n);
    // Category 1's borrowable bitmap excludes USDC's reserve index — the recorded fact the
    // revert below turns into a receipt.
    const usdcIndex = BigInt(snapshot.reserves.USDC.reserveIndex.value);
    const bitmap = snapshot.eModeCategories[0]!.borrowableBitmap.value;
    expect((bitmap >> usdcIndex) & 1n).toBe(0n);

    // A modest borrow the position could easily afford at ANY threshold — so a refusal here
    // cannot be mistaken for an LTV or health-factor failure.
    const tiny = 1_000_000n; // 1 USDC, in the reserve's own units
    const attempt = await sendRaw(
      url,
      session.actor,
      snapshot.pool,
      encodeFunctionData({
        abi: ABI.pool,
        functionName: "borrow",
        args: [snapshot.reserves.USDC.underlying, tiny, 2n, 0, session.actor],
      }),
    );
    expect(attempt.status).toBe(0n);
    const decoded = decodeRevert(await revertBytesOf(url, attempt));
    expect(decoded.source).toBe("custom-error");
    expect(decoded.message).toBe("Asset is not borrowable in the selected e-mode category");
    // The eMode gate fires BEFORE the LTV/HF machinery, so neither of those errors may appear.
    expect(decoded.message).not.toContain("Collateral cannot cover");
    expect(decoded.message).not.toContain("Health factor");
    // Nothing was written: the check is pre-mint, so the position is untouched.
    const after = await userAccountDataAt(url, snapshot.pool, session.actor);
    expect(after.debtBase).toBe(0n);
    record(`negative control: hand-built borrow(USDC) under eMode 1 reverts ${decoded.raw}`);
    await closeSession(key);
  });

  /**
   * THE RESERVE-REGIME LTV BOUNDARY, ACCEPTED SIDE — the ceiling's own value, executed and
   * SETTLED on a fork of its own.
   *
   * The refusal drill below drives one bp PAST the ceiling and watches the chain reject it.
   * On its own that proves less than it looks: a client ceiling set anywhere below the
   * protocol's — off by one bp, off by a hundred — produces exactly the same passing refusal,
   * because everything past the real line reverts. The half that pins the line is this one:
   * the ceiling's own value has to MINE. So the carry runs at exactly `maxAllocationBps`
   * through the product path, settles, and the position is read back off the chain.
   *
   * The margin is not decorative. At the pin the ceiling's debt lands 192,386,647 base units
   * under the limit and one bp more lands 97 base units OVER it — 6e-11 of the position. A
   * client that reproduced the protocol's rounding chain even slightly differently would miss
   * by more than that, which is why both sides are drilled rather than one.
   *
   * A FRESH SESSION, for the reason every drill here takes one: an earlier drill's collateral
   * or debt would move the very ceiling this one is testing.
   */
  it("executes and settles the carry at exactly the ceiling — the last allocation the chain admits", async () => {
    const { key, session } = await createSession();
    const url = session.fork.rpcUrl;
    const snapshot = await captureSessionSnapshot(session.fork, session.actor);

    const verdict = borrowLimitVerdict(carryGraph(), snapshot);
    if (verdict.status !== "within") throw new Error(`carry is not within: ${verdict.status}`);
    const { maxAllocationBps } = verdict.ceiling;
    // BOTH SIDES PINNED. The ceiling is derived from the session's own snapshot; these
    // assertions state where that derivation lands, so a silent shift cannot re-aim the
    // drill at some other boundary while still "passing".
    expect(maxAllocationBps).toBe(CEILING_BPS);
    expect(maxAllocationBps + 1).toBe(OVER_CEILING_BPS);
    // …and the refused side is the reserve's own LTV, READ off the snapshot: the protocol's
    // ceil-rounded debt chain costs a borrower exactly one bp of the LTV it advertises.
    expect(snapshot.reserves.weETH.ltvBps.value).toBe(OVER_CEILING_BPS);
    expect(verdict.ceiling.ltvBps).toBe(OVER_CEILING_BPS);

    // The client gate ACCEPTS the document at the ceiling — the claim the chain is about to
    // settle — and the plan it produces is the same six-step carry, still without a set-emode.
    // The verdict is RETAINED: its `ceiling.debtBase` is the prediction the chain has to match
    // to the unit, and its `ceilingBase` is the limit that prediction sits under.
    const atCeiling = carryGraph("10", CEILING_BPS);
    const atVerdict = borrowLimitVerdict(atCeiling, snapshot);
    if (atVerdict.status !== "within") {
      throw new Error(`the at-ceiling carry is not within: ${atVerdict.status}`);
    }
    const predicted = atVerdict.ceiling;

    // THE GEOMETRY OF THE BOUNDARY, as integers. `relWithin` at 1e-6 would tolerate ~1.5e6
    // base units here; the excess that decides the line is 97. Both margins are therefore
    // pinned exactly, from the client's own protocol-rounding chain.
    expect(predicted.ceilingBase - predicted.debtBase).toBe(CEILING_HEADROOM_BASE);
    const overVerdict = borrowLimitVerdict(carryGraph("10", OVER_CEILING_BPS), snapshot);
    if (overVerdict.status !== "over-limit") {
      throw new Error(`the over-ceiling carry is not over-limit: ${overVerdict.status}`);
    }
    expect(overVerdict.ceiling.debtBase - overVerdict.ceiling.ceilingBase).toBe(
      OVER_CEILING_EXCESS_BASE,
    );
    // Same collateral on both sides, so the two margins describe one line rather than two.
    expect(overVerdict.ceiling.ceilingBase).toBe(predicted.ceilingBase);

    const encoded = encodeShareGraph(atCeiling);
    if (!encoded.ok) throw new Error("at-ceiling carry refused by the share codec");
    const planned = await caller.plan({ sessionKey: key, document: encoded.token });
    if (!planned.ok) throw new Error(`plan refused: ${JSON.stringify(planned.refusal)}`);
    expect(planned.plan.stepCount).toBe(CARRY_STEP_COUNT);
    expect(planned.plan.steps.some((step) => step.id.endsWith(":set-emode"))).toBe(false);
    const planHash = planned.plan.planHash as Hex;

    const ledger = riskLedger(atCeiling, snapshot);
    expect(ledger.ok).toBe(true);
    const borrowCheckpoint = ledger.checkpoints.find((cp) => cp.cause === "borrow");
    if (borrowCheckpoint === undefined) {
      throw new Error("the at-ceiling carry produced no borrow checkpoint");
    }

    let borrowedWei = 0n;
    let borrowBlock = 0n;
    for (let index = 0; index < CARRY_STEP_COUNT; index += 1) {
      const outcome = await caller.executeStep({ sessionKey: key, planHash, stepIndex: index });
      if (!outcome.ok) throw new Error(`executeStep refused: ${JSON.stringify(outcome.refusal)}`);
      // SETTLED, not merely sent: the ceiling's borrow mines and attributes, or this drill
      // has proven nothing about the accepted side.
      if (outcome.result.status !== "attributed") {
        throw new Error(`at-ceiling step ${index} settled as ${outcome.result.status}`);
      }
      if (outcome.result.stepId === "borrow:borrow") {
        // The height the exact comparison below is exact AT — the pool's own receipt, not a
        // subsequent `eth_blockNumber` that another transaction could have moved.
        borrowBlock = BigInt(outcome.result.receipt.blockNumber);
      }
      const output = outcome.result.output;
      if (output === null) continue;
      expect(
        withinOutputTolerance(
          BigInt(output.predictedWei),
          BigInt(output.attributedWei),
          SANDBOX_OUTPUT_TOLERANCE,
        ),
        `${outcome.result.stepId} breached tolerance at the ceiling`,
      ).toBe(true);
      if (outcome.result.stepId === "borrow:borrow") {
        // The same two invariants the 6000-bps drill holds the borrow to, at the boundary:
        // a Transfer-event attribution, and EXACT agreement with the calldata amount.
        expect(output.mechanism).toBe("transfer-event");
        borrowedWei = BigInt(output.attributedWei);
        expect(borrowedWei - BigInt(output.predictedWei)).toBe(0n);
      }
    }
    expect(borrowedWei).toBeGreaterThan(0n);
    expect(borrowBlock).toBeGreaterThan(0n);

    /**
     * THE LOAD-BEARING COMPARISON, at the borrow's OWN block.
     *
     * Read at `latest` this would be exact only by luck: `getUserAccountData` values debt
     * through `getNormalizedDebt()`, which accrues with block timestamp, so one more mined
     * block moves the figure and an equality would have to be softened into a tolerance. Pinned
     * to the height the borrow settled at, the protocol's mint → read-back → base-conversion
     * chain and `borrow-limit.ts`'s reproduction of it are evaluated over the same index, and
     * EXACT equality is an honest claim rather than a lucky one.
     */
    const account = await userAccountDataAt(url, snapshot.pool, session.actor, borrowBlock);
    // EXACT, to the base unit, on both sides of the ledger the ceiling is computed from.
    expect(account.debtBase).toBe(predicted.debtBase);
    expect(account.collateralBase).toBe(predicted.collateralBase);
    // …and the chain's OWN headroom figure is the pinned margin — `percentMul(collateral,
    // ltv) - debt` computed by GenericLogic, not by us, landing on the same 192,386,647.
    expect(account.availableBorrowsBase).toBe(CEILING_HEADROOM_BASE);
    // The debt is REAL and the position is not liquidatable: the LTV line the borrow just
    // cleared sits below the LT line, so the ceiling is a borrowing limit and not a
    // liquidation. The two windows stay distinct here as well as in the refusal below.
    expect(account.debtBase).toBeGreaterThan(0n);
    expect(account.healthFactor).toBeGreaterThan(10n ** 18n);
    // The chain's own weighted LTV is the pinned refused-side number.
    expect(account.ltv).toBe(BigInt(OVER_CEILING_BPS));
    // The RISK ledger is a second, independent derivation of the same position — it values
    // debt straight off the amount rather than through the scaled-mint round trip — so it is
    // compared within tolerance rather than pinned. The exact claim above is the gate; this
    // one says the two derivations have not silently diverged.
    const ours = hfWadValue(borrowCheckpoint.healthFactor);
    if (ours === null) throw new Error("the at-ceiling ledger health factor is unknown");
    expect(
      relWithin(ours, account.healthFactor, SANDBOX_HF_REL_POW),
      `at-ceiling ledger HF ${ours} vs chain ${account.healthFactor}`,
    ).toBe(true);
    expect(
      relWithin(BigInt(borrowCheckpoint.totalDebtBase!), account.debtBase, SANDBOX_HF_REL_POW),
      `at-ceiling ledger debtBase ${borrowCheckpoint.totalDebtBase} vs chain ${account.debtBase}`,
    ).toBe(true);

    /**
     * LAST admissible, proven on the settled position itself: one more borrow — sized from
     * the chain's OWN headroom reading, five times over, so the drill cannot quietly stop
     * exceeding it — is refused with the LTV window's error. The plan-time drill below shows
     * the same line from the product path; this shows it standing on the accepted point.
     */
    const usdc = snapshot.reserves.USDC.underlying;
    // The actor holds exactly what the ceiling's borrow paid out and nothing else — which is
    // also the statement that this fork is fresh.
    const usdcBefore = await balanceOfAt(url, usdc, session.actor);
    expect(usdcBefore).toBe(borrowedWei);

    const usdcUnit = 10n ** BigInt(snapshot.reserves.USDC.decimals.value);
    const overshootWei =
      (account.availableBorrowsBase * 5n * usdcUnit) /
        BigInt(snapshot.reserves.USDC.priceBase.value) +
      1n;
    const extra = await sendRaw(
      url,
      session.actor,
      snapshot.pool,
      encodeFunctionData({
        abi: ABI.pool,
        functionName: "borrow",
        args: [usdc, overshootWei, 2n, 0, session.actor],
      }),
    );
    expect(extra.status).toBe(0n);
    const refused = decodeRevert(await revertBytesOf(url, extra));
    expect(refused.source).toBe("custom-error");
    expect(refused.message).toBe("Collateral cannot cover the requested borrow");
    // The LTV line, not the LT line — the same non-conflation the plan-time drill asserts.
    expect(refused.message).not.toContain("liquidation threshold");
    // NOTHING LANDED. The token balance is the exact witness — unlike the pool's base-currency
    // debt figure, an ERC-20 balance does not accrue between blocks, so this stays an equality
    // rather than a tolerance. The debt reading beside it is bounded rather than pinned for the
    // same reason: it must not have taken on even the HEADROOM, let alone five times it.
    expect(await balanceOfAt(url, usdc, session.actor)).toBe(usdcBefore);
    const after = await userAccountDataAt(url, snapshot.pool, session.actor);
    expect(after.debtBase).toBeLessThan(account.debtBase + account.availableBorrowsBase);

    record(
      `ceiling receipt: allocation ${CEILING_BPS} SETTLED at block ${borrowBlock} — borrowed ` +
        `${borrowedWei} USDC; chain debtBase ${account.debtBase} == predicted ` +
        `${predicted.debtBase} (delta ${account.debtBase - predicted.debtBase}), collateral ` +
        `${account.collateralBase}, ceiling ${predicted.ceilingBase}, chain headroom ` +
        `${account.availableBorrowsBase}, HF ${account.healthFactor}; one bp more predicts ` +
        `${overVerdict.ceiling.debtBase} = ceiling + ` +
        `${overVerdict.ceiling.debtBase - overVerdict.ceiling.ceilingBase}; +${overshootWei} ` +
        `USDC on the settled position reverts ${refused.raw}`,
    );
    await closeSession(key);
  });

  /**
   * THE RESERVE-REGIME LTV BOUNDARY, REFUSED SIDE — one bp past the ceiling the drill above
   * settled at.
   *
   * `core/borrow-limit.ts` computes the largest admissible allocation from the pinned
   * snapshot; this drives the plan one bp ABOVE it and asserts the chain refuses with
   * `CollateralCannotCoverNewBorrow` — the `(LTV, LT]` window's error, distinct from the
   * `> LT` window's `HealthFactorLowerThanLiquidationThreshold`. Conflating the two is a
   * copy bug this drill exists to make impossible.
   */
  it("refuses one bp past the reserve-regime ceiling, with the LTV window's own error", async () => {
    const { key, session } = await createSession();
    const url = session.fork.rpcUrl;
    const snapshot = await captureSessionSnapshot(session.fork, session.actor);

    const verdict = borrowLimitVerdict(carryGraph(), snapshot);
    if (verdict.status !== "within") throw new Error(`carry is not within: ${verdict.status}`);
    const { maxAllocationBps } = verdict.ceiling;
    expect(maxAllocationBps).toBeGreaterThan(FORK_PROVEN_CARRY_BPS);
    // The same two pinned numbers the accepted-side drill settles at: this is the bp AFTER
    // the one that mined, on a fork where nothing else has happened.
    expect(maxAllocationBps).toBe(CEILING_BPS);
    const over = maxAllocationBps + 1;
    expect(over).toBe(OVER_CEILING_BPS);
    // The client gate agrees the over-ceiling document is over the ceiling — and by HOW MUCH,
    // as an integer. 97 base units out of 1.49e12 is the whole margin the chain is about to
    // refuse on; a drill that only checked the verdict's status would pass just as happily if
    // the rounding chain had moved the debt by a million.
    const overVerdict = borrowLimitVerdict(carryGraph("10", over), snapshot);
    if (overVerdict.status !== "over-limit") {
      throw new Error(`the over-ceiling carry is not over-limit: ${overVerdict.status}`);
    }
    expect(overVerdict.ceiling.debtBase - overVerdict.ceiling.ceilingBase).toBe(
      OVER_CEILING_EXCESS_BASE,
    );

    const encoded = encodeShareGraph(carryGraph("10", over));
    if (!encoded.ok) throw new Error("over-ceiling carry refused by the share codec");
    const planned = await caller.plan({ sessionKey: key, document: encoded.token });
    if (!planned.ok) throw new Error(`plan refused: ${JSON.stringify(planned.refusal)}`);
    const planHash = planned.plan.planHash as Hex;

    for (let index = 0; index < CARRY_STEP_COUNT - 1; index += 1) {
      const outcome = await caller.executeStep({ sessionKey: key, planHash, stepIndex: index });
      if (!outcome.ok || outcome.result.status !== "attributed") {
        throw new Error(`over-ceiling prefix step ${index} did not settle attributed`);
      }
    }
    const borrow = await caller.executeStep({
      sessionKey: key,
      planHash,
      stepIndex: CARRY_STEP_COUNT - 1,
    });
    if (!borrow.ok) throw new Error(`executeStep refused: ${JSON.stringify(borrow.refusal)}`);
    if (borrow.result.status !== "failed") {
      throw new Error(`the over-ceiling borrow settled as ${borrow.result.status}`);
    }
    const failure = borrow.result.failure;

    // The SERVICE's own decode of the chain's bytes — `failed-at(k)` renders this sentence.
    expect(failure.decoded).not.toBeNull();
    expect(failure.decoded!.source).toBe("custom-error");
    expect(failure.decoded!.message).toBe("Collateral cannot cover the requested borrow");
    // The two `validateHFAndLtv` windows stay distinct: this is the LTV line, not the LT line.
    expect(failure.decoded!.message).not.toContain("liquidation threshold");

    // …and an INDEPENDENT replay of the same transaction decodes identically, so the receipt
    // is evidence about the chain rather than about the code that recorded it.
    const mined = await rpcAt<Record<string, unknown> | null>(url, "eth_getTransactionReceipt", [
      failure.txHash,
    ]);
    if (mined === null) throw new Error("the failed borrow is not in the fork's history");
    const replayed = decodeRevert(
      await revertBytesOf(url, {
        txHash: failure.txHash,
        status: 0n,
        blockNumber: BigInt(mined["blockNumber"] as string),
      }),
    );
    expect(replayed.message).toBe(failure.decoded!.message);
    expect(replayed.raw).toBe(failure.decoded!.raw);

    // And the debt was never minted — the refusal is the chain's, before any state landed.
    const account = await userAccountDataAt(url, snapshot.pool, session.actor);
    expect(account.debtBase).toBe(0n);
    record(
      `boundary receipt: allocation ${over} (ceiling ${maxAllocationBps}) reverts ${replayed.raw}`,
    );
    await closeSession(key);
  });
});
