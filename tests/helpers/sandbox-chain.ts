/**
 * Scripted `SandboxChain` for the session-service unit suites (W07): every chain
 * interaction the execute path can make, injected and countable, with an internal
 * ledger of LANDED transactions so tests can assert not just outcomes but ABSENCES —
 * no second send on replay, no send at all on reconcile, exactly one resolution per
 * approve/consume pair — and can fault-inject the transport at every seam Codex
 * finding 2 names: lost dispatch response (tx landed or not), confirmation failure,
 * receipt timeout.
 */
import { encodeEventTopics, parseAbi, toHex, type Address, type Hex } from "viem";
import {
  SandboxTxRevertedError,
  type SandboxChain,
  type SandboxRawReceipt,
} from "../../src/server/sandbox/execute-step";

const TRANSFER_EVENT = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export function transferLog(
  token: Address,
  from: Address,
  to: Address,
  value: bigint,
): { address: Hex; topics: readonly Hex[]; data: Hex } {
  const topics = encodeEventTopics({
    abi: TRANSFER_EVENT,
    eventName: "Transfer",
    args: { from, to },
  }) as readonly Hex[];
  return { address: token as Hex, topics, data: toHex(value, { size: 32 }) };
}

export interface SendPlan {
  readonly logs?: readonly { address: Hex; topics: readonly Hex[]; data: Hex }[];
  /** The transaction mines with status 0; confirmation throws `SandboxTxRevertedError`. */
  readonly revert?: boolean;
  /** Dispatch throws AND the transaction never landed (request never reached the node). */
  readonly dispatchError?: string;
  /** Dispatch throws BUT the transaction landed (the response was lost in transit). */
  readonly loseResponse?: boolean;
  /** Dispatch succeeds; confirmation throws (poll failure / receipt timeout). */
  readonly confirmError?: string;
  /** Dispatch waits on this promise before returning — for concurrency drills. */
  readonly gate?: Promise<void>;
}

export interface ChainScript {
  readonly sends?: readonly SendPlan[];
  /** Consumed per sharesOf call; "throw" scripts a failed read. */
  readonly shares?: Array<bigint | "throw">;
  readonly amountForShare?: (shares: bigint) => bigint;
  /** Consumed per allowance call. */
  readonly allowances?: bigint[];
  /** Consumed per healthFactorOf call. */
  readonly healthFactors?: bigint[];
  readonly revertData?: string | null;
}

export interface LandedTx {
  readonly txHash: Hex;
  readonly nonce: bigint;
  readonly receipt: SandboxRawReceipt;
}

export interface ScriptedChain extends SandboxChain {
  /** Every dispatch ATTEMPT (including ones whose response was lost). */
  readonly dispatches: Array<{ to: Address; data: Hex; value: bigint }>;
  /** Every transaction that actually LANDED on the scripted fork. */
  readonly landed: LandedTx[];
  sharesCalls: number;
  amountForShareCalls: number;
}

export function scriptedChain(script: ChainScript): ScriptedChain {
  const sendPlans = [...(script.sends !== undefined ? script.sends : [])];
  const shares = [...(script.shares !== undefined ? script.shares : [])];
  const allowances = [...(script.allowances !== undefined ? script.allowances : [])];
  const healthFactors = [...(script.healthFactors !== undefined ? script.healthFactors : [])];
  let dispatchCount = 0;
  let nonce = 0n;

  function land(planItem: SendPlan | undefined, txHash: Hex): LandedTx {
    const receipt: SandboxRawReceipt = {
      txHash,
      status: planItem?.revert === true ? 0n : 1n,
      blockNumber: 100n + BigInt(chain.landed.length + 1),
      blockHash: `0x${"cd".repeat(32)}` as Hex,
      logs: planItem?.logs !== undefined ? planItem.logs : [],
      gasUsed: 21_000n,
    };
    const tx: LandedTx = { txHash, nonce, receipt };
    nonce += 1n;
    chain.landed.push(tx);
    return tx;
  }

  const chain: ScriptedChain = {
    dispatches: [],
    landed: [],
    sharesCalls: 0,
    amountForShareCalls: 0,

    async dispatchTransaction(tx) {
      const planItem = sendPlans.length > dispatchCount ? sendPlans[dispatchCount] : {};
      dispatchCount += 1;
      chain.dispatches.push({ to: tx.to, data: tx.data, value: tx.value });
      if (planItem?.gate !== undefined) await planItem.gate;
      const txHash = `0x${dispatchCount.toString(16).padStart(64, "0")}` as Hex;
      if (planItem?.dispatchError !== undefined) throw new Error(planItem.dispatchError);
      if (planItem?.loseResponse === true) {
        land(planItem, txHash);
        throw new Error("scripted response loss");
      }
      land(planItem, txHash);
      return txHash;
    },

    async confirmTransaction(txHash) {
      const planItem = sendPlans[dispatchCount - 1];
      if (planItem?.confirmError !== undefined) throw new Error(planItem.confirmError);
      const tx = chain.landed.find((t) => t.txHash === txHash);
      if (tx === undefined) throw new Error(`no landed transaction for ${txHash}`);
      if (tx.receipt.status !== 1n) throw new SandboxTxRevertedError(txHash);
      return tx.receipt;
    },

    async revertDataOf() {
      return script.revertData !== undefined ? script.revertData : null;
    },

    async receiptOf(txHash) {
      const tx = chain.landed.find((t) => t.txHash === txHash);
      return tx !== undefined ? tx.receipt : null;
    },

    async actorNonce() {
      return nonce;
    },

    async transactionByNonce(_actor, at) {
      const tx = chain.landed.find((t) => t.nonce === at);
      return tx !== undefined ? tx.txHash : null;
    },

    async sharesOf() {
      chain.sharesCalls += 1;
      const next = shares.shift();
      if (next === undefined) throw new Error("scripted sharesOf exhausted");
      if (next === "throw") throw new Error("scripted sharesOf failure");
      return next;
    },

    async amountForShare(_lp, sharesIn) {
      chain.amountForShareCalls += 1;
      if (script.amountForShare === undefined) throw new Error("amountForShare not scripted");
      return script.amountForShare(sharesIn);
    },

    async allowance() {
      const next = allowances.shift();
      if (next === undefined) throw new Error("scripted allowance exhausted");
      return next;
    },

    async healthFactorOf() {
      const next = healthFactors.shift();
      if (next === undefined) throw new Error("scripted healthFactor exhausted");
      return next;
    },
  };
  return chain;
}
