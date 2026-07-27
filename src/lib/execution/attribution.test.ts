import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, type Address, type Hex } from "viem";
import { buildPlan, type AmountSpec, type TransactionStep } from "../../core/plan";
import type { StrategyGraph } from "../../core/graph";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import { FORK_PROVEN_BORROW_BPS, flagshipGraph } from "../../../tests/helpers/graphs";
import {
  applyAllocation,
  confirmationOf,
  encodeResolvedStep,
  isConfirmedReceipt,
  measureShareDelta,
  outputTokenOf,
  producesShareDelta,
  receiptMinter,
  resolveStepAmount,
  sameAttributedSource,
  transferValueTo,
  type AttributionContext,
  type AttributionLog,
  type AttributionReads,
  type ConfirmedReceipt,
  type ExecutedStepRecord,
  type RawReceipt,
} from "./attribution";

/**
 * The steps under test are the REAL flagship steps — `buildPlan` over the committed reads
 * log — so every `AmountSpec` here is the spec the fork suite executes, not a hand-written
 * imitation of one. The receipts are synthesized, but they are minted through the same
 * `receiptMinter` boundary the fork suite uses, over Transfer logs carrying the wire
 * topics/data an RPC returns, on the snapshot's own token addresses.
 */
const snapshot = fixtureSnapshot();
const ACTOR: Address = snapshot.user.address;
const eETH = snapshot.etherfi.eETH;
const weETH = snapshot.etherfi.weETH;
const WETH = snapshot.reserves.WETH.underlying;

const built = buildPlan(flagshipGraph("10", FORK_PROVEN_BORROW_BPS), snapshot);
if (!built.ok) throw new Error(`fixture plan failed: ${JSON.stringify(built.errors)}`);
const STEPS = built.steps;

function step(id: string): TransactionStep {
  const hit = STEPS.find((s) => s.id === id);
  if (hit === undefined) throw new Error(`step ${id} absent from the fixture plan`);
  return hit;
}

/** Magnitudes taken from the fork run's own figures, so the arithmetic is life-sized. */
const DEPOSIT_SHARES = 9092267716600505494n;
const WRAP_OUT_WEI = 9092267716600505493n;
const BORROW_WEI = 6999999999994802135n;

const TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const ZERO: Address = getAddress("0x0000000000000000000000000000000000000000");
const STRANGER: Address = getAddress("0x9999999999999999999999999999999999999999");
const DECOY_TOKEN: Address = getAddress("0xdddddddddddddddddddddddddddddddddddddddd");

const TX_A: Hex = `0x${"a1".repeat(32)}`;
const TX_B: Hex = `0x${"b2".repeat(32)}`;
const BLOCK_HASH: Hex = `0x${"cc".repeat(32)}`;

/** The suite's stand-in for a configured RPC — the same boundary the fork suite mints through. */
const minter = receiptMinter("vitest://recorded-fixture");

/**
 * `encodeEventTopics` types unset indexed args as null; every fixture below sets both, so a
 * null here means the fixture is wrong rather than that the wire shape allows one.
 */
function topicWords(topics: readonly (Hex | readonly Hex[] | null)[]): readonly Hex[] {
  return topics.map((topic) => {
    if (typeof topic !== "string") throw new Error("fixture log left an indexed argument unset");
    return topic;
  });
}

function transferLog(token: Address, from: Address, to: Address, value: bigint): AttributionLog {
  return {
    address: token,
    topics: topicWords(
      encodeEventTopics({ abi: TRANSFER_ABI, eventName: "Transfer", args: { from, to } }),
    ),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

/** A log that is not a Transfer at all — an Approval-shaped topic on the same token. */
function noiseLog(token: Address): AttributionLog {
  return {
    address: token,
    topics: topicWords(
      encodeEventTopics({
        abi: parseAbi([
          "event Approval(address indexed owner, address indexed spender, uint256 value)",
        ]),
        eventName: "Approval",
        args: { owner: ACTOR, spender: STRANGER },
      }),
    ),
    data: encodeAbiParameters([{ type: "uint256" }], [1n]),
  };
}

function rawReceipt(over?: Partial<RawReceipt>): RawReceipt {
  return {
    txHash: TX_A,
    status: 1n,
    blockNumber: 25_592_679n,
    blockHash: BLOCK_HASH,
    logs: [],
    ...over,
  };
}

/** Mint a confirmed receipt the only way there is: through the source boundary. */
function confirmed(logs: readonly AttributionLog[] = [], txHash: Hex = TX_A): ConfirmedReceipt {
  return minter.confirm(rawReceipt({ txHash, logs }));
}

const NO_LOGS = confirmed();

function recordOf(over: {
  step: TransactionStep;
  receipt?: ConfirmedReceipt;
  resolvedAmount?: bigint | null;
  sharesDelta?: bigint | null;
}): ExecutedStepRecord {
  return {
    step: over.step,
    receipt: over.receipt ?? NO_LOGS,
    resolvedAmount: over.resolvedAmount ?? null,
    sharesDelta: over.sharesDelta ?? null,
  };
}

interface MockReads extends AttributionReads {
  readonly calls: string[];
}

function mockReads(over?: {
  shares?: readonly (bigint | Error)[];
  amountForShare?: (shares: bigint) => bigint;
}): MockReads {
  const calls: string[] = [];
  const queue = [...(over?.shares ?? [])];
  return {
    calls,
    sharesOf: (actor: Address) => {
      calls.push(`sharesOf(${actor})`);
      const next = queue.shift();
      if (next === undefined) throw new Error("sharesOf called more times than the script allows");
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
    amountForShare: (shares: bigint) => {
      calls.push(`amountForShare(${shares})`);
      const convert = over?.amountForShare;
      if (convert === undefined) throw new Error("amountForShare was not scripted");
      return Promise.resolve(convert(shares));
    },
  };
}

function contextOf(reads: AttributionReads, actor: Address = ACTOR): AttributionContext {
  return { actor, reads };
}

/** Clone a real step with a substituted amount spec — the spec varies, the step stays real. */
function withAmount(base: TransactionStep, amount: AmountSpec): TransactionStep {
  return { ...base, amount };
}

/**
 * Equal-split fan-out: one stake feeding two wrap→lend branches at 5000 bps each. The graph
 * model supports this (per-source allocation only has to stay within 100%), and it is the
 * shape that makes a structural spec comparison wrong — see the fan-out test below.
 */
const FAN_OUT_GRAPH: StrategyGraph = {
  blocks: [
    { id: "in", type: "input" as const, params: { asset: "ETH", amount: "10" } },
    { id: "stake1", type: "stake" as const, params: { protocol: "etherfi" } },
    { id: "wrapA", type: "wrap" as const, params: { from: "eETH", to: "weETH" } },
    { id: "wrapB", type: "wrap" as const, params: { from: "eETH", to: "weETH" } },
    { id: "lendA", type: "lend" as const, params: { protocol: "aave-v3", asset: "weETH" } },
    { id: "lendB", type: "lend" as const, params: { protocol: "aave-v3", asset: "weETH" } },
  ],
  edges: [
    { id: "e0", source: "in", target: "stake1", allocationBps: 10_000 },
    { id: "e1", source: "stake1", target: "wrapA", allocationBps: 5000 },
    { id: "e2", source: "stake1", target: "wrapB", allocationBps: 5000 },
    { id: "e3", source: "wrapA", target: "lendA", allocationBps: 10_000 },
    { id: "e4", source: "wrapB", target: "lendB", allocationBps: 10_000 },
  ],
};

describe("the SPEC §5.5 whitelist covers every flagship step and nothing else", () => {
  it("assigns each of the 13 steps an attribution the module implements", () => {
    const specs = STEPS.map((s) =>
      s.amount.kind === "step-output" ? s.amount.attribution : s.amount.kind,
    );
    expect(specs).toEqual([
      "literal", // stake1:deposit — the only plan-time figure, the input leg
      "share-delta",
      "share-delta",
      "none", // supply1:set-emode
      "transfer-event",
      "transfer-event",
      "derived", // borrow:borrow
      "transfer-event",
      "withdraw-argument",
      "share-delta",
      "share-delta",
      "transfer-event",
      "transfer-event",
    ]);
  });

  it("marks exactly the two deposit steps as share-delta producers", () => {
    expect(STEPS.filter(producesShareDelta).map((s) => s.id)).toEqual([
      "stake1:deposit",
      "stake2:deposit",
    ]);
  });
});

describe("receiptMinter — the construction boundary for confirmed receipts", () => {
  it("refuses a source that does not name the RPC it read through", () => {
    expect(() => receiptMinter("   ")).toThrow("must name the RPC");
  });

  it("records what it verified, readable back off the receipt", () => {
    expect(confirmationOf(confirmed([], TX_B))).toEqual({
      rpc: "vitest://recorded-fixture",
      txHash: TX_B,
      blockHash: BLOCK_HASH,
      blockNumber: 25_592_679n,
    });
  });

  it("refuses a reverted transaction", () => {
    expect(() => minter.confirm(rawReceipt({ status: 0n }))).toThrow("did not succeed");
  });

  it("accepts the numeric status shape some transports return", () => {
    expect(isConfirmedReceipt(minter.confirm(rawReceipt({ status: 1 })))).toBe(true);
  });

  it("refuses a receipt with no transaction hash", () => {
    expect(() => minter.confirm(rawReceipt({ txHash: "0x" as Hex }))).toThrow("no transaction hash");
  });

  it("refuses a transaction that is not mined", () => {
    expect(() => minter.confirm(rawReceipt({ blockHash: null as unknown as Hex }))).toThrow(
      "is not mined",
    );
  });

  it("refuses a receipt with no block number", () => {
    expect(() => minter.confirm(rawReceipt({ blockNumber: -1n }))).toThrow("no block number");
  });

  it("refuses malformed runtime values the declared types would have waved through", () => {
    // `undefined < 0n` and `NaN < 0n` are both FALSE, so a bare comparison accepts them.
    // These arrive wearing the declared type when an RPC answers with something unexpected.
    for (const blockNumber of [undefined, Number.NaN, 25_592_679, "0x1868f66", null]) {
      expect(
        () => minter.confirm(rawReceipt({ blockNumber: blockNumber as unknown as bigint })),
        `blockNumber ${String(blockNumber)}`,
      ).toThrow("no block number");
    }
    expect(() => minter.confirm(rawReceipt({ status: undefined as unknown as bigint }))).toThrow(
      "no usable status",
    );
    expect(() => minter.confirm(rawReceipt({ status: 1.5 }))).toThrow("no usable status");
    expect(() => minter.confirm(rawReceipt({ logs: undefined as unknown as [] }))).toThrow(
      "no log array",
    );
  });

  it("refuses a receipt that is not an object at all", () => {
    for (const notAReceipt of [null, undefined, "0xdeadbeef", 42]) {
      expect(
        () => minter.confirm(notAReceipt as unknown as RawReceipt),
        `confirm(${String(notAReceipt)})`,
      ).toThrow("receipt must be an object");
    }
  });

  it("refuses logs whose own fields are not bytes", () => {
    const good = transferLog(weETH, ZERO, ACTOR, 1n);
    expect(() =>
      minter.confirm(rawReceipt({ logs: [{ ...good, address: "nonsense" as Hex }] })),
    ).toThrow("bad address");
    expect(() =>
      minter.confirm(rawReceipt({ logs: [{ ...good, topics: undefined as unknown as Hex[] }] })),
    ).toThrow("bad topics");
    expect(() =>
      minter.confirm(rawReceipt({ logs: [{ ...good, data: 12 as unknown as Hex }] })),
    ).toThrow("bad data");
  });

  it("refuses a log slot that is not an object", () => {
    expect(() =>
      minter.confirm(rawReceipt({ logs: [null as unknown as AttributionLog] })),
    ).toThrow("log 0: not an object");
    expect(() =>
      minter.confirm(rawReceipt({ logs: ["0xdeadbeef" as unknown as AttributionLog] })),
    ).toThrow("log 0: not an object");
  });

  it("brands the FIRST-read value when an accessor answers differently on a re-read", () => {
    // TOCTOU bait: a getter that shows validation one value and any later read another. The
    // minter reads each property exactly once, so the validated first read is what is
    // branded and the switched value never surfaces.
    const goodLogs = [transferLog(weETH, ZERO, ACTOR, 5n)];
    const forgedLogs = [transferLog(weETH, ZERO, ACTOR, 10n ** 24n)];
    let txHashReads = 0;
    let logsReads = 0;
    const shifty: RawReceipt = {
      status: 1n,
      blockNumber: 25_592_679n,
      blockHash: BLOCK_HASH,
      get txHash(): Hex {
        txHashReads += 1;
        return txHashReads === 1 ? TX_A : TX_B;
      },
      get logs(): readonly AttributionLog[] {
        logsReads += 1;
        return logsReads === 1 ? goodLogs : forgedLogs;
      },
    };
    const receipt = minter.confirm(shifty);
    expect(txHashReads).toBe(1);
    expect(logsReads).toBe(1);
    expect(receipt.txHash).toBe(TX_A);
    expect(confirmationOf(receipt).txHash).toBe(TX_A);
    expect(transferValueTo(receipt, weETH, ACTOR)).toBe(5n);
  });

  it("brands the FIRST-read value when a log's own field is accessor-backed", () => {
    const honest = transferLog(weETH, ZERO, ACTOR, 5n);
    const forged = transferLog(weETH, ZERO, ACTOR, 10n ** 24n);
    let dataReads = 0;
    const shiftyLog: AttributionLog = {
      address: honest.address,
      topics: honest.topics,
      get data(): Hex {
        dataReads += 1;
        return dataReads === 1 ? honest.data : forged.data;
      },
    };
    const receipt = minter.confirm(rawReceipt({ logs: [shiftyLog] }));
    expect(dataReads).toBe(1);
    expect(receipt.logs[0]!.data).toBe(honest.data);
    expect(transferValueTo(receipt, weETH, ACTOR)).toBe(5n);
  });

  it("defeats a Proxy that swaps values between validation and construction", () => {
    const genuine = rawReceipt({ logs: [transferLog(weETH, ZERO, ACTOR, 5n)] });
    const readCounts = new Map<PropertyKey, number>();
    const bait = new Proxy(genuine, {
      get(target, prop, receiver) {
        const prior = readCounts.get(prop);
        const count = prior === undefined ? 1 : prior + 1;
        readCounts.set(prop, count);
        if (count > 1 && prop === "txHash") return TX_B;
        if (count > 1 && prop === "logs") return [transferLog(weETH, ZERO, ACTOR, 10n ** 24n)];
        return Reflect.get(target, prop, receiver);
      },
    });
    const receipt = minter.confirm(bait);
    expect(readCounts.get("txHash")).toBe(1);
    expect(readCounts.get("logs")).toBe(1);
    expect(receipt.txHash).toBe(TX_A);
    expect(confirmationOf(receipt).txHash).toBe(TX_A);
    expect(transferValueTo(receipt, weETH, ACTOR)).toBe(5n);
  });

  it("refuses a sparse log array instead of skipping the hole", () => {
    // `Array.prototype.map` skips holes, so a sparse slot would have sailed through
    // unvalidated; the minter walks the array index by index and refuses the gap.
    const sparse: AttributionLog[] = [];
    sparse[1] = transferLog(weETH, ZERO, ACTOR, 1n);
    expect(() => minter.confirm(rawReceipt({ logs: sparse }))).toThrow("log 0: hole in log array");
  });

  it("refuses a sparse topics array inside a log", () => {
    const good = transferLog(weETH, ZERO, ACTOR, 1n);
    const sparseTopics: Hex[] = [];
    sparseTopics[1] = good.topics[1]!;
    expect(() =>
      minter.confirm(rawReceipt({ logs: [{ ...good, topics: sparseTopics }] })),
    ).toThrow("hole in topics array");
  });

  it("enforces byte widths, not just hex-ness", () => {
    const good = transferLog(weETH, ZERO, ACTOR, 1n);
    const address21Bytes = `0x${"aa".repeat(21)}` as Hex;
    expect(() =>
      minter.confirm(rawReceipt({ logs: [{ ...good, address: address21Bytes }] })),
    ).toThrow("bad address");
    const topic31Bytes = `0x${"bb".repeat(31)}` as Hex;
    expect(() =>
      minter.confirm(
        rawReceipt({ logs: [{ ...good, topics: [topic31Bytes, ...good.topics.slice(1)] }] }),
      ),
    ).toThrow("bad topics");
    expect(() =>
      minter.confirm(rawReceipt({ logs: [{ ...good, data: "0xabc" }] })),
    ).toThrow("bad data");
    expect(() =>
      minter.confirm(rawReceipt({ logs: [{ ...good, data: "" as unknown as Hex }] })),
    ).toThrow("bad data");
  });

  it("accepts bare 0x data — a fully-indexed event carries no data bytes", () => {
    const good = transferLog(weETH, ZERO, ACTOR, 1n);
    const receipt = minter.confirm(rawReceipt({ logs: [{ ...good, data: "0x" }] }));
    expect(receipt.logs[0]!.data).toBe("0x");
  });

  it("REFUSES a spread copy, however faithfully it typechecks", () => {
    // The spread carries the brand property along, so this satisfies the TYPE. Confirmation
    // is bound to object identity precisely so a forged copy cannot inherit it.
    const genuine = confirmed([transferLog(weETH, ZERO, ACTOR, 1n)]);
    const forged: ConfirmedReceipt = {
      ...genuine,
      txHash: TX_B,
      logs: [transferLog(weETH, ZERO, ACTOR, 10n ** 24n)],
    };
    expect(isConfirmedReceipt(genuine)).toBe(true);
    expect(isConfirmedReceipt(forged)).toBe(false);
    expect(() => confirmationOf(forged)).toThrow("not a confirmed receipt");
    // …and it cannot be smuggled through the one function that consumes receipts.
    expect(transferValueTo(genuine, weETH, ACTOR)).toBe(1n);
  });

  it("keeps the verified facts when the caller mutates the object it handed over", () => {
    const mutableLogs: AttributionLog[] = [transferLog(weETH, ZERO, ACTOR, 100n)];
    const raw = { ...rawReceipt(), logs: mutableLogs } as RawReceipt & { txHash: Hex };
    const receipt = minter.confirm(raw);
    expect(transferValueTo(receipt, weETH, ACTOR)).toBe(100n);

    // Retro-edit everything the caller still holds a reference to.
    mutableLogs.push(transferLog(weETH, ZERO, ACTOR, 10n ** 24n));
    (raw as { txHash: Hex }).txHash = TX_B;

    expect(receipt.logs).toHaveLength(1);
    expect(transferValueTo(receipt, weETH, ACTOR)).toBe(100n);
    expect(confirmationOf(receipt).txHash).toBe(TX_A);
  });

  it("is deep-frozen, so the confirmed copy cannot be edited either", () => {
    const receipt = confirmed([transferLog(weETH, ZERO, ACTOR, 1n)]);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.logs)).toBe(true);
    expect(Object.isFrozen(receipt.logs[0])).toBe(true);
    expect(Object.isFrozen(receipt.logs[0]!.topics)).toBe(true);
    expect(() => {
      (receipt.logs as AttributionLog[]).push(transferLog(weETH, ZERO, ACTOR, 5n));
    }).toThrow();
  });

  it("refuses logs belonging to a different transaction", () => {
    const foreign: AttributionLog = { ...transferLog(weETH, ZERO, ACTOR, 1n), transactionHash: TX_B };
    expect(() => minter.confirm(rawReceipt({ txHash: TX_A, logs: [foreign] }))).toThrow(
      "a log from a different transaction",
    );
  });

  it("accepts logs that carry the receipt's own hash", () => {
    const own: AttributionLog = { ...transferLog(weETH, ZERO, ACTOR, 7n), transactionHash: TX_A };
    const receipt = minter.confirm(rawReceipt({ txHash: TX_A, logs: [own] }));
    expect(transferValueTo(receipt, weETH, ACTOR)).toBe(7n);
  });

  it("does not recognise a hand-built object as a confirmed receipt", () => {
    // The brand symbol is not exported, so this is unforgeable from outside the module —
    // the forged-Observed pattern (core/provenance.ts) applied to receipts.
    expect(isConfirmedReceipt({ txHash: TX_A, blockNumber: 1n, blockHash: BLOCK_HASH, logs: [] })).toBe(
      false,
    );
    expect(isConfirmedReceipt(null)).toBe(false);
    expect(isConfirmedReceipt("0xdeadbeef")).toBe(false);
    expect(isConfirmedReceipt(confirmed())).toBe(true);
  });
});

describe("resolveStepAmount — plan-time specs", () => {
  it("returns null for a step that takes no amount", async () => {
    const amount = await resolveStepAmount(
      step("supply1:set-emode"),
      new Map(),
      contextOf(mockReads()),
    );
    expect(amount).toBeNull();
  });

  it("returns the document figure for a literal spec, untouched", async () => {
    const input = step("stake1:deposit");
    if (input.amount.kind !== "literal") throw new Error("stake1:deposit must be literal");
    const amount = await resolveStepAmount(input, new Map(), contextOf(mockReads()));
    expect(amount).toBe(input.amount.amount.value);
    expect(amount).toBe(10n * 10n ** 18n);
  });

  it("returns the derived figure for the borrow leg, untouched", async () => {
    const borrow = step("borrow:borrow");
    if (borrow.amount.kind !== "derived") throw new Error("borrow:borrow must be derived");
    const amount = await resolveStepAmount(borrow, new Map(), contextOf(mockReads()));
    expect(amount).toBe(borrow.amount.amount.value);
  });

  it("refuses to resolve against a producer that has not executed", async () => {
    await expect(
      resolveStepAmount(step("wrap1:wrap"), new Map(), contextOf(mockReads())),
    ).rejects.toThrow("producer stake1:deposit not executed");
  });
});

describe("resolveStepAmount — share-delta (rebasing eETH)", () => {
  const deposit = step("stake1:deposit");
  const consumer = step("wrap1:wrap");

  it("converts the producer's share delta at CONSUMPTION time", async () => {
    const reads = mockReads({ amountForShare: (s) => s - 1n });
    const executed = new Map([
      [deposit.id, recordOf({ step: deposit, sharesDelta: DEPOSIT_SHARES })],
    ]);

    const amount = await resolveStepAmount(consumer, executed, contextOf(reads));

    expect(reads.calls).toEqual([`amountForShare(${DEPOSIT_SHARES})`]);
    expect(amount).toBe(DEPOSIT_SHARES - 1n);
  });

  it("tracks a rebase between producer and consumer, because the rate is read late", async () => {
    // The fork suite induces +1% on totalPooledEther between steps 1 and 2. A balance delta
    // captured at the producer would still read the pre-rebase amount; converting the shares
    // at consumption time is what moves with the rebase.
    const executed = new Map([
      [deposit.id, recordOf({ step: deposit, sharesDelta: DEPOSIT_SHARES })],
    ]);
    const preRebase = await resolveStepAmount(
      consumer,
      executed,
      contextOf(mockReads({ amountForShare: (s) => s })),
    );
    const postRebase = await resolveStepAmount(
      consumer,
      executed,
      contextOf(mockReads({ amountForShare: (s) => (s * 101n) / 100n })),
    );
    expect(postRebase).toBeGreaterThan(preRebase!);
    expect(postRebase).toBe((DEPOSIT_SHARES * 101n) / 100n);
  });

  it("refuses a producer that carries no share delta", async () => {
    const executed = new Map([[deposit.id, recordOf({ step: deposit, sharesDelta: null })]]);
    await expect(resolveStepAmount(consumer, executed, contextOf(mockReads()))).rejects.toThrow(
      "stake1:deposit has no share delta",
    );
  });
});

describe("resolveStepAmount — one resolution per approve/consumer pair", () => {
  const deposit = step("stake1:deposit");
  const approve = step("wrap1:approve");
  const wrap = step("wrap1:wrap");

  it("gives the approve and its consumer one identical amount spec", () => {
    expect(sameAttributedSource(approve.amount, wrap.amount)).toBe(true);
  });

  it("resolves the pair ONCE, so a rebase in between cannot outrun the allowance", async () => {
    // The defect this prevents: two independent resolutions straddling the approve
    // transaction. A +1% rebase between them makes the wrap's amount exceed the allowance
    // the approve just set, and WeETH.wrap's safeTransferFrom reverts mid-plan.
    let rate = (s: bigint): bigint => s;
    const reads = mockReads({ amountForShare: (s) => rate(s) });
    const executed = new Map<string, ExecutedStepRecord>([
      [deposit.id, recordOf({ step: deposit, sharesDelta: DEPOSIT_SHARES })],
    ]);

    const approved = await resolveStepAmount(approve, executed, contextOf(reads));
    executed.set(approve.id, recordOf({ step: approve, resolvedAmount: approved }));

    rate = (s) => (s * 101n) / 100n; // the rebase lands between approval and consumption
    const wrapped = await resolveStepAmount(wrap, executed, contextOf(reads));

    expect(wrapped).toBe(approved);
    expect(reads.calls).toEqual([`amountForShare(${DEPOSIT_SHARES})`]);
    // Proof the fixture is discriminating: a re-resolution really would have been larger.
    expect(rate(DEPOSIT_SHARES)).toBeGreaterThan(approved!);
  });

  it("reuses the pair's figure for transfer-event specs too", async () => {
    const supplyApprove = step("supply1:approve");
    const supply = step("supply1:supply");
    expect(sameAttributedSource(supplyApprove.amount, supply.amount)).toBe(true);
    const executed = new Map<string, ExecutedStepRecord>([
      [wrap.id, recordOf({ step: wrap, receipt: confirmed([transferLog(weETH, ZERO, ACTOR, 5n)]) })],
      [supplyApprove.id, recordOf({ step: supplyApprove, resolvedAmount: 5n })],
    ]);
    // The producer's receipt is not consulted a second time; the recorded figure answers.
    expect(await resolveStepAmount(supply, executed, contextOf(mockReads()))).toBe(5n);
  });

  it("pairs by REFERENCE, so a field-identical copy is not the same source", () => {
    const wrapSpec = wrap.amount;
    expect(sameAttributedSource(wrapSpec, step("supply1:supply").amount)).toBe(false);
    expect(sameAttributedSource(step("stake1:deposit").amount, wrapSpec)).toBe(false);
    expect(sameAttributedSource(wrapSpec, step("borrow:borrow").amount)).toBe(false);
    // A structural clone is equal in every field and is still NOT the pair's spec.
    expect(sameAttributedSource(wrapSpec, { ...wrapSpec })).toBe(false);
    // A plan-time spec compared with itself is not a pairing either.
    expect(sameAttributedSource(step("stake1:deposit").amount, step("stake1:deposit").amount)).toBe(
      false,
    );
  });

  it("keeps equal-split fan-out branches apart, each resolving its OWN amount", async () => {
    // One producer, two consumer blocks at 5000 bps each: `inflowSpecOf` runs once per
    // BLOCK, so the two pairs hold distinct spec objects whose fields are identical in every
    // position. Comparing fields would fuse the branches and make wrapB spend wrapA's
    // amount; comparing references keeps them separate. The rebase between the two pairs is
    // what makes the two correct answers differ, so the test can tell them apart.
    const fanOut = buildPlan(FAN_OUT_GRAPH, snapshot);
    if (!fanOut.ok) throw new Error(`fan-out plan failed: ${JSON.stringify(fanOut.errors)}`);
    const pick = (id: string): TransactionStep => {
      const hit = fanOut.steps.find((s) => s.id === id);
      if (hit === undefined) throw new Error(`fan-out plan has no ${id}`);
      return hit;
    };
    const [depositStep, approveA, wrapA, approveB, wrapB] = [
      pick("stake1:deposit"),
      pick("wrapA:approve"),
      pick("wrapA:wrap"),
      pick("wrapB:approve"),
      pick("wrapB:wrap"),
    ];
    // The premise, asserted rather than assumed: same fields, different objects.
    expect(JSON.stringify(approveA.amount)).toBe(JSON.stringify(approveB.amount));
    expect(sameAttributedSource(approveA.amount, wrapA.amount)).toBe(true);
    expect(sameAttributedSource(approveB.amount, wrapB.amount)).toBe(true);
    expect(sameAttributedSource(approveA.amount, approveB.amount)).toBe(false);

    let rate = (s: bigint): bigint => s;
    const reads = mockReads({ amountForShare: (s) => rate(s) });
    const executed = new Map<string, ExecutedStepRecord>([
      [depositStep.id, recordOf({ step: depositStep, sharesDelta: DEPOSIT_SHARES })],
    ]);

    const amountA = await resolveStepAmount(approveA, executed, contextOf(reads));
    executed.set(approveA.id, recordOf({ step: approveA, resolvedAmount: amountA }));
    const reusedA = await resolveStepAmount(wrapA, executed, contextOf(reads));
    executed.set(wrapA.id, recordOf({ step: wrapA, resolvedAmount: reusedA }));

    rate = (s) => (s * 101n) / 100n; // rebase lands between the two branches
    const amountB = await resolveStepAmount(approveB, executed, contextOf(reads));
    executed.set(approveB.id, recordOf({ step: approveB, resolvedAmount: amountB }));
    const reusedB = await resolveStepAmount(wrapB, executed, contextOf(reads));

    // Each pair is internally consistent…
    expect(reusedA).toBe(amountA);
    expect(reusedB).toBe(amountB);
    // …and the branches did NOT borrow each other's figure.
    expect(amountB).not.toBe(amountA);
    expect(amountB).toBeGreaterThan(amountA!);
    // Exactly two resolutions — one per pair, not one per step and not one for both pairs.
    // The read takes the whole share delta; the 5000 bps split is applied after attribution,
    // so each branch's amount is half of what its own reading returned.
    expect(reads.calls).toEqual([
      `amountForShare(${DEPOSIT_SHARES})`,
      `amountForShare(${DEPOSIT_SHARES})`,
    ]);
    expect(amountA).toBe(DEPOSIT_SHARES / 2n);
    expect(amountB).toBe(((DEPOSIT_SHARES * 101n) / 100n) / 2n);
  });

  it("ignores a prior step that resolved to nothing", async () => {
    const emode = step("supply1:set-emode");
    const executed = new Map<string, ExecutedStepRecord>([
      [emode.id, recordOf({ step: emode })],
      [deposit.id, recordOf({ step: deposit, sharesDelta: DEPOSIT_SHARES })],
    ]);
    const amount = await resolveStepAmount(
      wrap,
      executed,
      contextOf(mockReads({ amountForShare: (s) => s })),
    );
    expect(amount).toBe(DEPOSIT_SHARES);
  });
});

describe("resolveStepAmount — transfer-event", () => {
  const wrap = step("wrap1:wrap");
  const consumer = step("supply1:approve");

  it("attributes the wrap's weETH Transfer to the actor", async () => {
    const executed = new Map([
      [
        wrap.id,
        recordOf({
          step: wrap,
          receipt: confirmed([
            noiseLog(weETH),
            transferLog(eETH, ACTOR, weETH, DEPOSIT_SHARES),
            transferLog(weETH, ZERO, ACTOR, WRAP_OUT_WEI),
          ]),
        }),
      ],
    ]);
    const amount = await resolveStepAmount(consumer, executed, contextOf(mockReads()));
    expect(amount).toBe(WRAP_OUT_WEI);
  });

  it("attributes the borrow's WETH Transfer using the asset from the step's own args", async () => {
    const borrow = step("borrow:borrow");
    const withdraw = step("unwrap:withdraw");
    expect(outputTokenOf(borrow)).toBe(getAddress(WETH));
    const executed = new Map([
      [
        borrow.id,
        recordOf({ step: borrow, receipt: confirmed([transferLog(WETH, ZERO, ACTOR, BORROW_WEI)]) }),
      ],
    ]);
    const amount = await resolveStepAmount(withdraw, executed, contextOf(mockReads()));
    expect(amount).toBe(BORROW_WEI);
  });

  it("ignores a spoofed Transfer emitted by a different contract in the same transaction", async () => {
    const executed = new Map([
      [
        wrap.id,
        recordOf({
          step: wrap,
          receipt: confirmed([
            transferLog(DECOY_TOKEN, ZERO, ACTOR, 10n ** 24n),
            transferLog(weETH, ZERO, ACTOR, WRAP_OUT_WEI),
          ]),
        }),
      ],
    ]);
    expect(await resolveStepAmount(consumer, executed, contextOf(mockReads()))).toBe(WRAP_OUT_WEI);
  });

  it("ignores a Transfer of the right token to somebody else", async () => {
    const executed = new Map([
      [
        wrap.id,
        recordOf({
          step: wrap,
          receipt: confirmed([
            transferLog(weETH, ZERO, STRANGER, 10n ** 24n),
            transferLog(weETH, ZERO, ACTOR, WRAP_OUT_WEI),
          ]),
        }),
      ],
    ]);
    expect(await resolveStepAmount(consumer, executed, contextOf(mockReads()))).toBe(WRAP_OUT_WEI);
  });

  it("sums several Transfers of the same token to the actor", () => {
    const receipt = confirmed([
      transferLog(weETH, ZERO, ACTOR, 400n),
      transferLog(weETH, STRANGER, ACTOR, 600n),
    ]);
    expect(transferValueTo(receipt, weETH, ACTOR)).toBe(1000n);
  });

  it("throws rather than attributing zero when no Transfer matches", async () => {
    const executed = new Map([
      [wrap.id, recordOf({ step: wrap, receipt: confirmed([noiseLog(weETH)], TX_B) })],
    ]);
    await expect(resolveStepAmount(consumer, executed, contextOf(mockReads()))).rejects.toThrow(
      /no Transfer\(→wallet\) on .* in tx 0xb2/,
    );
  });

  it("compares token and recipient case-insensitively (checksum vs lowercase wire form)", () => {
    const receipt = confirmed([
      { ...transferLog(weETH, ZERO, ACTOR, WRAP_OUT_WEI), address: weETH.toLowerCase() as Hex },
    ]);
    expect(transferValueTo(receipt, weETH, ACTOR)).toBe(WRAP_OUT_WEI);
  });
});

describe("resolveStepAmount — withdraw-argument", () => {
  const withdraw = step("unwrap:withdraw");
  const consumer = step("stake2:deposit");

  it("takes the withdraw call's own resolved argument, with no gas reserve subtracted", async () => {
    const executed = new Map([
      [withdraw.id, recordOf({ step: withdraw, resolvedAmount: BORROW_WEI })],
    ]);
    const amount = await resolveStepAmount(consumer, executed, contextOf(mockReads()));
    expect(amount).toBe(BORROW_WEI);
  });

  it("refuses a producer with no resolved amount", async () => {
    const executed = new Map([[withdraw.id, recordOf({ step: withdraw, resolvedAmount: null })]]);
    await expect(resolveStepAmount(consumer, executed, contextOf(mockReads()))).rejects.toThrow(
      "unwrap:withdraw has no amount",
    );
  });
});

describe("resolveStepAmount — return-value stays reserved and erroring", () => {
  it("throws instead of inventing a fourth mechanism", async () => {
    const consumer = withAmount(step("wrap1:wrap"), {
      kind: "step-output",
      producerStepId: "stake1:deposit",
      attribution: "return-value",
      allocationBps: 10_000,
    });
    const deposit = step("stake1:deposit");
    const executed = new Map([[deposit.id, recordOf({ step: deposit, sharesDelta: 1n })]]);
    await expect(resolveStepAmount(consumer, executed, contextOf(mockReads()))).rejects.toThrow(
      "return-value attribution is not used by the flagship plan",
    );
  });
});

describe("applyAllocation", () => {
  it("returns the attributed output unchanged at full allocation", () => {
    expect(applyAllocation(BORROW_WEI, 10_000)).toBe(BORROW_WEI);
  });

  it("floors a partial allocation rather than rounding it up", () => {
    // 7 wei at 70% is 4.9 — the split may never hand out more than the chain produced.
    expect(applyAllocation(7n, 7000)).toBe(4n);
    expect(applyAllocation(BORROW_WEI, 7000)).toBe((BORROW_WEI * 7000n) / 10_000n);
    expect(applyAllocation(1n, 1)).toBe(0n);
  });

  it("is wired into resolveStepAmount, applied after attribution", async () => {
    const wrap = step("wrap1:wrap");
    const consumer = withAmount(step("supply1:supply"), {
      kind: "step-output",
      producerStepId: wrap.id,
      attribution: "transfer-event",
      allocationBps: 2500,
    });
    const executed = new Map([
      [
        wrap.id,
        recordOf({ step: wrap, receipt: confirmed([transferLog(weETH, ZERO, ACTOR, 4001n)]) }),
      ],
    ]);
    expect(await resolveStepAmount(consumer, executed, contextOf(mockReads()))).toBe(1000n);
  });
});

describe("outputTokenOf", () => {
  it("uses the wrap step's own target as its output token", () => {
    expect(outputTokenOf(step("wrap1:wrap"))).toBe(weETH);
  });

  it("reads the borrow's asset out of its first call argument", () => {
    expect(outputTokenOf(step("borrow:borrow"))).toBe(getAddress(WETH));
  });

  it("refuses a borrow whose asset slot is not a literal address", () => {
    const borrow = step("borrow:borrow");
    const opaque: TransactionStep = {
      ...borrow,
      args: [{ kind: "amount" }, ...borrow.args.slice(1)],
    };
    expect(() => outputTokenOf(opaque)).toThrow("no transfer-event output token");
  });

  it("refuses a step whose output no Transfer event attributes", () => {
    expect(() => outputTokenOf(step("supply1:supply"))).toThrow(
      "no transfer-event output token for step supply1:supply",
    );
  });
});

describe("encodeResolvedStep", () => {
  it("injects the attributed amount into a step-output step's calldata", () => {
    const wrap = step("wrap1:wrap");
    const encoded = encodeResolvedStep(wrap, WRAP_OUT_WEI);
    expect(encoded.to).toBe(wrap.to);
    expect(encoded.value).toBe(0n);
    expect(encoded.data.endsWith(WRAP_OUT_WEI.toString(16).padStart(64, "0"))).toBe(true);
  });

  it("encodes a plan-time step without offering it a resolved amount", () => {
    expect(encodeResolvedStep(step("stake1:deposit"), null).value).toBe(10n * 10n ** 18n);
  });

  it("ignores a resolved amount for a plan-time step instead of smuggling it in", () => {
    // `encodeStep` throws when handed a resolved amount for a fixed spec; routing every call
    // through here means no caller can trip that by accident.
    expect(encodeResolvedStep(step("stake1:deposit"), 123n).value).toBe(10n * 10n ** 18n);
  });

  it("refuses to encode a step-output step with no attributed amount", () => {
    expect(() => encodeResolvedStep(step("wrap1:wrap"), null)).toThrow(
      "step wrap1:wrap: a resolved attributed amount is required",
    );
  });
});

describe("measureShareDelta", () => {
  const deposit = step("stake1:deposit");

  it("reads shares before and after the send, and reports the difference", async () => {
    const reads = mockReads({ shares: [100n, 175n] });
    const receipt = confirmed();
    const outcome = await measureShareDelta(deposit, contextOf(reads), () => {
      reads.calls.push("send");
      return Promise.resolve(receipt);
    });
    expect(reads.calls).toEqual([`sharesOf(${ACTOR})`, "send", `sharesOf(${ACTOR})`]);
    expect(outcome.status).toBe("attributed");
    expect(outcome.receipt).toBe(receipt);
    if (outcome.status !== "attributed") throw new Error("expected an attributed outcome");
    expect(outcome.sharesDelta).toBe(75n);
  });

  it("takes no share readings for a step that mints no shares", async () => {
    const reads = mockReads();
    const outcome = await measureShareDelta(step("wrap1:wrap"), contextOf(reads), () => {
      reads.calls.push("send");
      return Promise.resolve(confirmed());
    });
    expect(reads.calls).toEqual(["send"]);
    if (outcome.status !== "attributed") throw new Error("expected an attributed outcome");
    expect(outcome.sharesDelta).toBeNull();
  });

  it("hands the confirmed receipt over BEFORE the post-read, so it is persisted first", async () => {
    const reads = mockReads({ shares: [0n, 1n] });
    const persisted: string[] = [];
    await measureShareDelta(
      deposit,
      contextOf(reads),
      () => Promise.resolve(confirmed()),
      (receipt) => {
        persisted.push(`persisted ${receipt.txHash}`);
        reads.calls.push("onConfirmed");
      },
    );
    expect(persisted).toEqual([`persisted ${TX_A}`]);
    expect(reads.calls).toEqual([`sharesOf(${ACTOR})`, "onConfirmed", `sharesOf(${ACTOR})`]);
  });

  it("AWAITS an async persistence hook before the post-read", async () => {
    const reads = mockReads({ shares: [0n, 1n] });
    const order: string[] = [];
    await measureShareDelta(
      deposit,
      contextOf(reads),
      () => Promise.resolve(confirmed()),
      async () => {
        order.push("persist:start");
        await Promise.resolve();
        await Promise.resolve();
        order.push("persist:done");
        reads.calls.push("persisted");
      },
    );
    expect(order).toEqual(["persist:start", "persist:done"]);
    // The post-read ran AFTER persistence settled, not merely after it was kicked off.
    expect(reads.calls).toEqual([`sharesOf(${ACTOR})`, "persisted", `sharesOf(${ACTOR})`]);
  });

  it("KEEPS the receipt when the persistence hook throws synchronously", async () => {
    const reads = mockReads({ shares: [0n, 75n] });
    const receipt = confirmed();
    const outcome = await measureShareDelta(
      deposit,
      contextOf(reads),
      () => Promise.resolve(receipt),
      () => {
        throw new Error("localStorage full");
      },
    );
    expect(outcome.status).toBe("persistence-failed");
    expect(outcome.receipt).toBe(receipt);
    if (outcome.status !== "persistence-failed") throw new Error("expected persistence-failed");
    expect(String(outcome.cause)).toContain("localStorage full");
    // The post-read is NOT skipped: the before/after pair is the only source of the step's
    // exact output, so the measurement is taken now and rides along with the failure.
    expect(reads.calls).toEqual([`sharesOf(${ACTOR})`, `sharesOf(${ACTOR})`]);
    expect(outcome.measurement).toEqual({ status: "measured", beforeShares: 0n, sharesDelta: 75n });
  });

  it("KEEPS the receipt when an async persistence hook rejects", async () => {
    const reads = mockReads({ shares: [0n, 75n] });
    const receipt = confirmed();
    const outcome = await measureShareDelta(
      deposit,
      contextOf(reads),
      () => Promise.resolve(receipt),
      () => Promise.reject(new Error("registry unreachable")),
    );
    expect(outcome.status).toBe("persistence-failed");
    expect(outcome.receipt).toBe(receipt);
    if (outcome.status !== "persistence-failed") throw new Error("expected persistence-failed");
    expect(String(outcome.cause)).toContain("registry unreachable");
    expect(outcome.measurement).toEqual({ status: "measured", beforeShares: 0n, sharesDelta: 75n });
  });

  it("measures the transaction's exact delta under a persistence failure, ahead of any drift", async () => {
    // Third scripted reading: the share balance the chain would report AFTER an intervening
    // transaction moved it. The measurement must come from the second reading — taken
    // immediately, before that drift — and the drifted figure must never be consumed.
    const reads = mockReads({ shares: [100n, 175n, 999n] });
    const receipt = confirmed();
    const outcome = await measureShareDelta(
      deposit,
      contextOf(reads),
      () => Promise.resolve(receipt),
      () => Promise.reject(new Error("registry unreachable")),
    );
    expect(outcome.status).toBe("persistence-failed");
    if (outcome.status !== "persistence-failed") throw new Error("expected persistence-failed");
    expect(outcome.receipt).toBe(receipt);
    expect(outcome.measurement).toEqual({
      status: "measured",
      beforeShares: 100n,
      sharesDelta: 75n,
    });
    expect(reads.calls).toEqual([`sharesOf(${ACTOR})`, `sharesOf(${ACTOR})`]);
  });

  it("retains beforeShares and the receipt when persistence AND the post-read both fail", async () => {
    // The four-cell floor: nothing re-observable remains, so the outcome must carry the two
    // pinning facts a recovery reconciler needs — the pre-send reading and the receipt.
    const reads = mockReads({ shares: [100n, new Error("rpc down")] });
    const receipt = confirmed();
    const outcome = await measureShareDelta(
      deposit,
      contextOf(reads),
      () => Promise.resolve(receipt),
      () => {
        throw new Error("localStorage full");
      },
    );
    expect(outcome.status).toBe("persistence-failed");
    if (outcome.status !== "persistence-failed") throw new Error("expected persistence-failed");
    expect(outcome.receipt).toBe(receipt);
    expect(String(outcome.cause)).toContain("localStorage full");
    if (outcome.measurement.status !== "unavailable") {
      throw new Error("expected an unavailable measurement");
    }
    expect(outcome.measurement.beforeShares).toBe(100n);
    expect(String(outcome.measurement.cause)).toContain("rpc down");
  });

  it("carries a trivially-measured outcome for a non-share step whose persistence failed", async () => {
    const reads = mockReads();
    const outcome = await measureShareDelta(
      step("wrap1:wrap"),
      contextOf(reads),
      () => Promise.resolve(confirmed()),
      () => Promise.reject(new Error("registry unreachable")),
    );
    expect(outcome.status).toBe("persistence-failed");
    if (outcome.status !== "persistence-failed") throw new Error("expected persistence-failed");
    expect(outcome.measurement).toEqual({ status: "measured", beforeShares: null, sharesDelta: null });
    expect(reads.calls).toEqual([]);
  });

  it("KEEPS the confirmed receipt when the post-read fails", async () => {
    // A transaction that landed must never be lost because a follow-up read failed: a caller
    // that dropped it and retried would send the transaction a second time.
    const reads = mockReads({ shares: [100n, new Error("rpc down")] });
    const receipt = confirmed();
    const outcome = await measureShareDelta(deposit, contextOf(reads), () =>
      Promise.resolve(receipt),
    );
    expect(outcome.status).toBe("attribution-unavailable");
    expect(outcome.receipt).toBe(receipt);
    if (outcome.status !== "attribution-unavailable") throw new Error("expected the failed state");
    expect(String(outcome.cause)).toContain("rpc down");
    // The pre-send reading survives: recovery is re-read `sharesOf`, difference against this.
    expect(outcome.beforeShares).toBe(100n);
  });

  it("propagates a failed send without taking the second reading", async () => {
    const reads = mockReads({ shares: [100n] });
    await expect(
      measureShareDelta(deposit, contextOf(reads), () => Promise.reject(new Error("reverted"))),
    ).rejects.toThrow("reverted");
    expect(reads.calls).toEqual([`sharesOf(${ACTOR})`]);
  });

  it("refuses a submission-time result at runtime as well as at the type level", async () => {
    const reads = mockReads({ shares: [100n] });
    const submitted = { txHash: TX_A, blockNumber: 0n, blockHash: BLOCK_HASH, logs: [] };
    await expect(
      measureShareDelta(deposit, contextOf(reads), () =>
        // @ts-expect-error a submitted transaction is not a ConfirmedReceipt; the brand is
        // unforgeable outside receiptMinter, so this is a compile error as well as a refusal.
        Promise.resolve(submitted),
      ),
    ).rejects.toThrow("needs a mined, successful receipt");
  });

  it("measures the actor named by the context, not an ambient wallet", async () => {
    const reads = mockReads({ shares: [0n, 5n] });
    await measureShareDelta(deposit, contextOf(reads, STRANGER), () => Promise.resolve(confirmed()));
    expect(reads.calls).toEqual([`sharesOf(${STRANGER})`, `sharesOf(${STRANGER})`]);
  });
});
