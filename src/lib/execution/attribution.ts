/**
 * SPEC §5.5 attribution, productized by EXTRACTION (P3 treatment §6.4).
 *
 * The bodies below came out of `tests/fork/flagship-plan.test.ts`, which carried two copies
 * of them (`resolveAmount`/`executeStep` and `resolveCleanAmount`/`executeClean`). That file
 * now imports this module and holds none of its own, so the attribution code the product
 * ships is the attribution code the fork gate proves — by identity, not by resemblance.
 * A parallel re-implementation of any function here is treatment §10.10, a blocking finding.
 *
 * The whitelist is the whole surface and there is no fourth mechanism: a share delta
 * converted at CONSUMPTION time (rebasing eETH), a Transfer log of a CONFIRMED transaction,
 * or the withdraw call's own resolved argument. `return-value` stays typed and throws.
 * There is no `balanceOf` sweep in this file and there must never be one.
 *
 * Pure by construction: every chain read is injected through `AttributionReads`, and every
 * confirmed-transaction fact arrives as a `ConfirmedReceipt`. Nothing here fetches, holds a
 * provider, or touches React — lint-enforced in `eslint.config.mjs` and regression-tested by
 * the fixtures under `tests/lint/fixtures/`. Only the CHAIN-RECORD facet of a receipt crosses
 * into this module; the transport facet — nonce, gas, replacement, pending-ness — is the
 * client's and never reaches money-math (treatment §1.1, A19).
 */
import {
  decodeEventLog,
  encodeEventTopics,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { encodeStep, type AmountSpec, type TransactionStep } from "../../core/plan";

const TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const TRANSFER_TOPIC = encodeEventTopics({ abi: TRANSFER_ABI, eventName: "Transfer" })[0];

const FULL_ALLOCATION_BPS = 10_000;
const BPS_DENOMINATOR = 10_000n;
const RECEIPT_STATUS_SUCCESS = 1n;

/**
 * A log of a confirmed transaction, in the shape an RPC returns it. Deliberately not viem's
 * `Log`: this module decodes bytes and must not acquire an opinion about which client
 * produced them beyond the §1.1 rule that it was OUR configured RPC.
 */
export interface AttributionLog {
  readonly address: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  /** Present on real RPC receipts; verified against the receipt's own hash when it is. */
  readonly transactionHash?: Hex;
}

/** The chain-record facet of a receipt: a mined transaction's identity and its logs. */
export interface ReceiptFacts {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly logs: readonly AttributionLog[];
}

export interface RawReceipt extends ReceiptFacts {
  /** EVM receipt status; anything but 1 means the transaction did not succeed. */
  readonly status: bigint | number;
}

/**
 * The construction boundary, mirroring `core/provenance.ts`'s `observationMinter`. TWO
 * mechanisms, because either alone is defeatable:
 *
 *  - the symbol brand is NOT exported, so `{ txHash, logs }` cannot TYPECHECK as a
 *    `ConfirmedReceipt`; this catches the mistake at compile time, where it belongs.
 *  - `confirmedReceipts` binds confirmation to OBJECT IDENTITY. A spread copy
 *    (`{ ...good, txHash: other, logs: forged }`) carries the symbol property along and so
 *    still typechecks — but it is a NEW object, absent from this set, and
 *    `isConfirmedReceipt` refuses it. The type says "shaped like a receipt"; the set says
 *    "IS the receipt this module verified".
 *
 * Confirmed receipts are deep-frozen at mint, so a caller holding the raw object cannot
 * retro-edit the facts that were verified: the logs attribution reads are this module's
 * copy, not the caller's array.
 *
 * The honest limit, stated the way provenance.ts states its own: TypeScript cannot prove a
 * given object came off a particular socket, and neither brand nor set proves more than that
 * this module minted it. What they DO buy is that every receipt reaching attribution passed
 * one verification function, at one place, which checked success, identity and shape — and
 * that the call site had to name the RPC it read through. Enforcing that the named RPC is
 * the configured one is the caller's job; the lint boundary keeps a client constructor out
 * of this module entirely.
 */
const CONFIRMED: unique symbol = Symbol("execution/confirmed-receipt");
const confirmedReceipts = new WeakSet<object>();

/** What the minter verified, readable back off any confirmed receipt. */
export interface ConfirmationMark {
  /** Identity of the configured RPC the receipt was read through. */
  readonly rpc: string;
  readonly txHash: Hex;
  readonly blockHash: Hex;
  readonly blockNumber: bigint;
}

export type Confirmed<T extends ReceiptFacts> = T & { readonly [CONFIRMED]: ConfirmationMark };
export type ConfirmedReceipt = Confirmed<ReceiptFacts>;

export interface ReceiptMinter {
  readonly rpc: string;
  /**
   * Brand a receipt this source already fetched. Deliberately does NOT re-fetch: the caller
   * holds the receipt its own send returned, and a second read could answer differently from
   * the one the execution sequence acted on. Verification, not re-observation.
   */
  confirm<T extends RawReceipt>(raw: T): Confirmed<T>;
}

function isHexWord(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isHexAddress(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isHexData(value: unknown): value is Hex {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
}

/**
 * Every field is type-checked at RUNTIME before anything is branded — TypeScript describes
 * what a caller INTENDED to hand over — and read EXACTLY ONCE. An accessor or Proxy on the
 * raw log could answer validation with one value and construction with another, so each
 * property is captured into a local on its single read, the locals are validated, and the
 * frozen clone is built from those locals alone. Widths are enforced, not just hex-ness:
 * a 20-byte address, 32-byte topic words, even-length data (`0x` alone is legal — a
 * fully-indexed event carries no data bytes). Topics are walked index by index because
 * `every`, like `map`, skips the holes of a sparse array.
 */
function verifiedLog(slot: unknown, txHash: Hex, index: number): AttributionLog {
  if (typeof slot !== "object" || slot === null) {
    throw new Error(`receipt ${txHash} log ${index}: not an object`);
  }
  const { address, topics, data, transactionHash } = slot as Partial<AttributionLog>;
  if (!isHexAddress(address)) throw new Error(`receipt ${txHash} log ${index}: bad address`);
  if (!Array.isArray(topics)) throw new Error(`receipt ${txHash} log ${index}: bad topics`);
  const words: Hex[] = [];
  for (let i = 0; i < topics.length; i += 1) {
    if (!(i in topics)) throw new Error(`receipt ${txHash} log ${index}: hole in topics array`);
    const word: unknown = topics[i];
    if (!isHexWord(word)) throw new Error(`receipt ${txHash} log ${index}: bad topics`);
    words.push(word);
  }
  if (!isHexData(data)) throw new Error(`receipt ${txHash} log ${index}: bad data`);
  if (transactionHash !== undefined && transactionHash !== txHash) {
    throw new Error(
      `receipt ${txHash} carries a log from a different transaction (${String(transactionHash)})`,
    );
  }
  const clone: { address: Hex; topics: readonly Hex[]; data: Hex; transactionHash?: Hex } = {
    address,
    topics: Object.freeze(words),
    data,
  };
  if (transactionHash !== undefined) clone.transactionHash = transactionHash;
  return Object.freeze(clone);
}

function successful(status: unknown, txHash: unknown): boolean {
  if (typeof status === "bigint") return status === RECEIPT_STATUS_SUCCESS;
  if (typeof status === "number" && Number.isInteger(status)) {
    return BigInt(status) === RECEIPT_STATUS_SUCCESS;
  }
  throw new Error(`receipt ${String(txHash)} has no usable status (${String(status)})`);
}

/**
 * The only constructor of a `ConfirmedReceipt`. `rpc` names the configured endpoint the
 * receipt was read through — never a wallet's injected provider (treatment A1: a malicious
 * extension can forge receipt logs, so money-bearing reads never transit it).
 *
 * Returns a DEEP-FROZEN COPY, not the argument. Mutating the raw object afterwards — or
 * mutating the log array a caller kept a reference to — cannot change what was verified.
 *
 * Every own property of `raw` is read EXACTLY ONCE, in a single `Object.entries` pass, and
 * both validation and construction consume that snapshot. Reading twice — once to check,
 * once to build — lets an accessor or Proxy show the checks one receipt and the branded
 * object another, and WeakSet membership would then vouch for values nothing verified. Only
 * the object built from the validated snapshot enters the set. `blockNumber` is the sharp
 * validation case: `undefined < 0n` and `NaN < 0n` are both false, so a bare comparison
 * would wave them through.
 */
export function receiptMinter(rpc: string): ReceiptMinter {
  if (rpc.trim() === "") throw new Error("a receipt source must name the RPC it read through");
  return {
    rpc,
    confirm<T extends RawReceipt>(raw: T): Confirmed<T> {
      if (typeof raw !== "object" || raw === null) throw new Error("receipt must be an object");
      const entries: ReadonlyArray<readonly [string, unknown]> = Object.entries(raw);
      const fields = new Map(entries);
      const status = fields.get("status");
      const txHash = fields.get("txHash");
      const blockHash = fields.get("blockHash");
      const blockNumber = fields.get("blockNumber");
      const rawLogs = fields.get("logs");
      if (!successful(status, txHash)) {
        throw new Error(`receipt ${String(txHash)} did not succeed (status ${String(status)})`);
      }
      if (!isHexWord(txHash)) {
        throw new Error(`receipt has no transaction hash: ${String(txHash)}`);
      }
      if (!isHexWord(blockHash)) {
        throw new Error(`receipt ${txHash} is not mined: no block hash`);
      }
      if (typeof blockNumber !== "bigint" || blockNumber < 0n) {
        throw new Error(`receipt ${txHash} has no block number (${String(blockNumber)})`);
      }
      if (!Array.isArray(rawLogs)) throw new Error(`receipt ${txHash} has no log array`);
      const verified: AttributionLog[] = [];
      for (let i = 0; i < rawLogs.length; i += 1) {
        // `Array.prototype.map` skips holes, which would leave a sparse slot unvalidated.
        if (!(i in rawLogs)) throw new Error(`receipt ${txHash} log ${i}: hole in log array`);
        verified.push(verifiedLog(rawLogs[i], txHash, i));
      }
      const logs = Object.freeze(verified);
      const mark: ConfirmationMark = Object.freeze({ rpc, txHash, blockHash, blockNumber });
      const branded: Record<PropertyKey, unknown> = {};
      for (const [key, value] of entries) branded[key] = value;
      branded.logs = logs;
      branded[CONFIRMED] = mark;
      const receipt = Object.freeze(branded) as unknown as Confirmed<T>;
      confirmedReceipts.add(receipt);
      return receipt;
    },
  };
}

/**
 * Membership, not shape. A spread copy of a confirmed receipt still satisfies the TYPE — the
 * symbol property comes along — so identity is what actually answers the question.
 */
export function isConfirmedReceipt(value: unknown): value is ConfirmedReceipt {
  return typeof value === "object" && value !== null && confirmedReceipts.has(value);
}

/** Read back what the minter verified — the receipt's provenance, for display and review. */
export function confirmationOf(receipt: ConfirmedReceipt): ConfirmationMark {
  if (!isConfirmedReceipt(receipt)) {
    throw new Error("not a confirmed receipt — mint it through receiptMinter");
  }
  return receipt[CONFIRMED];
}

/** What a step leaves behind for the steps that consume its output. */
export interface ExecutedStepRecord {
  readonly step: TransactionStep;
  readonly receipt: ConfirmedReceipt;
  readonly resolvedAmount: bigint | null;
  /** eETH share delta measured around the transaction; null unless the step mints shares. */
  readonly sharesDelta: bigint | null;
}

/** The narrow, injectable, mockable read surface attribution needs — nothing wider. */
export interface AttributionReads {
  sharesOf(actor: Address): Promise<bigint>;
  amountForShare(shares: bigint): Promise<bigint>;
}

export interface AttributionContext {
  /** The address the plan builds a position for; the Transfer-recipient filter. */
  readonly actor: Address;
  readonly reads: AttributionReads;
}

/**
 * Sum the Transfer value this token moved TO `to` in one confirmed transaction.
 *
 * Both filters are load-bearing (treatment A9): the token address pins which contract may
 * speak — a spoofed Transfer from some other contract in the same transaction cannot
 * contribute — and the recipient pins that the value actually landed on the actor. Zero
 * matches throws rather than returning 0n: a silent zero would flow into the next step's
 * calldata as a real amount.
 */
export function transferValueTo(tx: ConfirmedReceipt, token: Address, to: Address): bigint {
  let total = 0n;
  let matches = 0;
  for (const log of tx.logs) {
    if (getAddress(log.address) !== getAddress(token)) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const decoded = decodeEventLog({
      abi: TRANSFER_ABI,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
    if (getAddress(decoded.args.to) === getAddress(to)) {
      total += decoded.args.value;
      matches += 1;
    }
  }
  if (matches === 0) {
    throw new Error(`no Transfer(→wallet) on ${token} in tx ${tx.txHash}`);
  }
  return total;
}

/** Token whose Transfer event attributes a producer step's output. */
export function outputTokenOf(step: TransactionStep): Address {
  if (step.functionName === "wrap") return step.to;
  if (step.functionName === "borrow") {
    const asset = step.args[0];
    if (asset !== undefined && asset.kind === "value" && typeof asset.value === "string") {
      return getAddress(asset.value);
    }
  }
  throw new Error(`no transfer-event output token for step ${step.id}`);
}

/**
 * Partial allocations, in exactly one place (treatment §6.1): floor(output × bps / 1e4),
 * applied AFTER attribution so the split is taken from what the chain actually produced.
 */
export function applyAllocation(output: bigint, allocationBps: number): bigint {
  if (allocationBps === FULL_ALLOCATION_BPS) return output;
  return (output * BigInt(allocationBps)) / BPS_DENOMINATOR;
}

/**
 * Whether this step's output is attributed by a share delta, and therefore needs a
 * `shares(actor)` reading on both sides of its transaction.
 *
 * `deposit` is not a guess: `buildPlan` sets `share-delta` attribution for stake blocks
 * alone, and a stake block emits exactly one step, `<blockId>:deposit`
 * (`src/core/plan.ts`, stake emission). Every other producer is attributed from logs or
 * from its own argument and needs no measurement around the send.
 */
export function producesShareDelta(step: TransactionStep): boolean {
  return step.functionName === "deposit";
}

/**
 * Whether two steps draw on the SAME attributed output — by REFERENCE, deliberately.
 *
 * `buildPlan` evaluates `inflowSpecOf(block)` once per block and hands the resulting object
 * to both the approve and the step it authorises, so object identity IS the pair relation.
 * A structural comparison looks equivalent and is not: equal-split fan-out (one producer,
 * two consumer blocks at 5000 bps each) produces two DISTINCT spec objects whose fields are
 * identical in every position. Comparing fields would fuse those two pairs and make the
 * second consumer spend the first's amount — a silent cross-branch substitution. Reference
 * identity cannot false-positive that way, because `inflowSpecOf` never returns the same
 * object to two different blocks.
 */
export function sameAttributedSource(a: AmountSpec, b: AmountSpec): boolean {
  return a === b && a.kind === "step-output";
}

/**
 * Resolve the amount a step's calldata must carry, from the outputs already attributed to
 * the steps before it. Returns null only for steps that take no amount at all.
 *
 * ONE RESOLUTION PER ATTRIBUTED OUTPUT. An approve and the step it authorises share a spec,
 * and resolving that spec twice re-reads the chain twice. For rebasing eETH those two reads
 * straddle the approve transaction, so a positive rebase in between makes the consumer's
 * amount EXCEED the allowance the approve just set — `WeETH.wrap`'s `safeTransferFrom`
 * reverts mid-plan and leaves a residual allowance behind. So the first member of the pair
 * resolves and the second reuses that figure off the executed record: the approved amount
 * and the spent amount are one number by construction, which is also what makes the
 * zero-allowance-after-consumption invariant (treatment §3.3) structural rather than lucky.
 *
 * Sequencing follows from the signature: a `step-output` amount cannot be resolved until its
 * producer is in `executed`, so step k+1 is unconstructable before step k is attributed
 * (treatment A10).
 */
export async function resolveStepAmount(
  step: TransactionStep,
  executed: ReadonlyMap<string, ExecutedStepRecord>,
  context: AttributionContext,
): Promise<bigint | null> {
  const spec = step.amount;
  if (spec.kind === "none") return null;
  if (spec.kind === "literal" || spec.kind === "derived") return spec.amount.value;
  // Insertion order is execution order, so this finds the pair's FIRST member.
  for (const prior of executed.values()) {
    if (prior.resolvedAmount !== null && sameAttributedSource(prior.step.amount, spec)) {
      return prior.resolvedAmount;
    }
  }
  const producer = executed.get(spec.producerStepId);
  if (producer === undefined) throw new Error(`producer ${spec.producerStepId} not executed`);
  let output: bigint;
  switch (spec.attribution) {
    case "share-delta": {
      if (producer.sharesDelta === null) throw new Error(`${spec.producerStepId} has no share delta`);
      // Convert rebase-invariant shares to an amount at CONSUMPTION time — this
      // is what survives a rebase landing between producer and consumer.
      output = await context.reads.amountForShare(producer.sharesDelta);
      break;
    }
    case "transfer-event":
      output = transferValueTo(producer.receipt, outputTokenOf(producer.step), context.actor);
      break;
    case "withdraw-argument":
      if (producer.resolvedAmount === null) throw new Error(`${spec.producerStepId} has no amount`);
      output = producer.resolvedAmount;
      break;
    case "return-value":
      throw new Error("return-value attribution is not used by the flagship plan");
  }
  return applyAllocation(output, spec.allocationBps);
}

/**
 * The one call into the encoder. `encodeStep` refuses a resolved amount for a plan-time spec
 * and refuses its absence for a step-output spec; this keeps that contract satisfied from a
 * single site so no caller reinvents the branch (treatment §4.2, §10.1).
 */
export function encodeResolvedStep(
  step: TransactionStep,
  resolvedAmount: bigint | null,
): { to: Address; data: Hex; value: bigint } {
  if (step.amount.kind !== "step-output") return encodeStep(step);
  if (resolvedAmount === null) {
    throw new Error(`step ${step.id}: a resolved attributed amount is required`);
  }
  return encodeStep(step, resolvedAmount);
}

/**
 * What could be measured around one confirmed transaction, independent of whether the
 * caller's record of it stuck. `beforeShares` is retained on BOTH arms because it cannot be
 * re-observed after the fact: a deposit receipt carries no share figure and
 * `AttributionReads.sharesOf` is an unpinned current read, so the pre-send reading is half
 * of the ONLY measurement the step's exact output has. Dropping it would make that output
 * unrecoverable the moment any later transaction moves the balance.
 */
export type ShareDeltaMeasurement =
  | {
      readonly status: "measured";
      /** Null when the step mints no shares and no reading was needed. */
      readonly beforeShares: bigint | null;
      readonly sharesDelta: bigint | null;
    }
  | { readonly status: "unavailable"; readonly beforeShares: bigint; readonly cause: unknown };

/**
 * A confirmed transaction plus what could be measured and persisted about it. The receipt
 * is present in EVERY state — losing a confirmed receipt because a follow-up step failed is
 * how a retry-capable engine double-sends, so the receipt is never the casualty.
 *
 * Persistence and measurement are two INDEPENDENT axes, and all four cells are
 * distinguishable, because their recoveries differ and collapsing them would tell the
 * caller the wrong thing to do:
 *
 *  - `attributed` — persisted and measured.
 *  - `attribution-unavailable` — persisted, but the post-send share reading failed. The
 *    chain still holds the answer; recovery is to re-read `sharesOf` and difference it
 *    against the retained `beforeShares`.
 *  - `persistence-failed` — the caller's own record of the transaction did not stick. The
 *    chain moved and the durable record may not know it, so recovery must RECONCILE against
 *    the chain (or the session registry) BEFORE dispatching anything else — a redispatch on
 *    top of an unrecorded confirmed transaction is the double-send. The measurement rides
 *    along anyway, decoupled from the persistence failure: `measurement.status` splits the
 *    remaining two cells, and the retained `beforeShares` plus the receipt's own
 *    `blockNumber` are exactly the pinning facts a recovery reconciler needs to verify or
 *    re-derive the step's output after the fact.
 */
export type ShareDeltaOutcome<T extends ConfirmedReceipt> =
  | { readonly status: "attributed"; readonly receipt: T; readonly sharesDelta: bigint | null }
  | {
      readonly status: "attribution-unavailable";
      readonly receipt: T;
      readonly beforeShares: bigint;
      readonly cause: unknown;
    }
  | {
      readonly status: "persistence-failed";
      readonly receipt: T;
      readonly cause: unknown;
      readonly measurement: ShareDeltaMeasurement;
    };

/**
 * Run a step's send between the two `shares(actor)` readings its attribution needs.
 *
 * The ordering is the mechanism, so it lives here rather than in each caller:
 * read before → send → AWAIT `onConfirmed` → read after. The hook is awaited, and its
 * failures (synchronous throw or rejected promise alike) become a receipt-bearing outcome
 * rather than an exception, because a hook that throws while the transaction is already
 * mined must not be able to discard the transaction on its way out (treatment §2.2: the hash
 * is persisted at submit). When persistence fails the post-read is STILL taken, immediately:
 * the before/after pair is the only source of a deposit's exact output, and deferring the
 * after-read to reconciliation time would let any intervening share movement corrupt it.
 * What a persistence failure changes is the caller's next move — reconcile before
 * redispatching — never whether the measurement exists.
 *
 * `send` must resolve to a CONFIRMED receipt, never a submitted one. That is a type
 * constraint — the brand is unforgeable outside `receiptMinter` — and it is re-checked at
 * runtime so a JavaScript caller cannot slip a pending transaction past the compiler.
 * Attributing a submission means attributing an empty log set, which SPEC §5.5 has no honest
 * answer for: it would read as a zero output rather than as an unfinished one.
 */
export async function measureShareDelta<T extends ConfirmedReceipt>(
  step: TransactionStep,
  context: AttributionContext,
  send: () => Promise<T>,
  onConfirmed?: (receipt: T) => void | Promise<void>,
): Promise<ShareDeltaOutcome<T>> {
  const before = producesShareDelta(step) ? await context.reads.sharesOf(context.actor) : null;
  const receipt = await send();
  if (!isConfirmedReceipt(receipt)) {
    throw new Error(
      `step ${step.id}: attribution needs a mined, successful receipt — mint it through receiptMinter`,
    );
  }
  // Wrapped rather than held as a bare nullable, so a hook that throws `undefined` still
  // registers as a failure.
  let persistence: { readonly cause: unknown } | null = null;
  if (onConfirmed !== undefined) {
    try {
      await onConfirmed(receipt);
    } catch (cause) {
      persistence = { cause };
    }
  }
  let measurement: ShareDeltaMeasurement;
  if (before === null) {
    measurement = { status: "measured", beforeShares: null, sharesDelta: null };
  } else {
    try {
      const after = await context.reads.sharesOf(context.actor);
      measurement = { status: "measured", beforeShares: before, sharesDelta: after - before };
    } catch (cause) {
      measurement = { status: "unavailable", beforeShares: before, cause };
    }
  }
  if (persistence !== null) {
    return { status: "persistence-failed", receipt, cause: persistence.cause, measurement };
  }
  if (measurement.status === "unavailable") {
    return {
      status: "attribution-unavailable",
      receipt,
      beforeShares: measurement.beforeShares,
      cause: measurement.cause,
    };
  }
  return { status: "attributed", receipt, sharesDelta: measurement.sharesDelta };
}
