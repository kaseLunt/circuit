/**
 * Raw-RPC execution harness for the fork suite. Uses anvil's unlocked accounts
 * via eth_sendTransaction — no private keys anywhere in the repo.
 */
import type { Address, Hex } from "viem";
import { ANVIL_URL } from "./anvil";

export interface RawLog {
  readonly address: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface Receipt {
  readonly txHash: Hex;
  readonly status: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly blockNumber: bigint;
  readonly logs: readonly RawLog[];
}

export class TxRevertedError extends Error {
  constructor(readonly txHash: Hex) {
    super(`transaction reverted: ${txHash}`);
  }
}

let rpcId = 0;

export async function rpc<T>(method: string, params: readonly unknown[] = []): Promise<T> {
  const res = await fetch(ANVIL_URL, {
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

/**
 * Evidence output channel. W03's mutation contract requires the rebase slot id and pre/post
 * words to reach the test output, so this is contractual, not debug logging — it goes through
 * stdout directly so `no-console` can stay an error across the whole repository.
 */
export function record(line: string): void {
  process.stdout.write(`${line}\n`);
}

export const hexQuantity = (v: bigint): Hex => `0x${v.toString(16)}` as Hex;
export const hexWord = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}` as Hex;

export async function anvilAccounts(): Promise<readonly Address[]> {
  return rpc<Address[]>("eth_accounts");
}

/**
 * Explicit limit instead of node-side estimation: Aave txs cost more inside
 * the mined block than at the estimation state (interest-accrual SSTOREs turn
 * from no-ops into value changes as the timestamp advances), so estimated
 * limits can OutOfGas at the tail of validateHFAndLtv.
 */
const DEFAULT_GAS_LIMIT = 2_000_000n;

export async function sendTx(tx: {
  readonly from: Address;
  readonly to: Address;
  readonly data?: Hex;
  readonly value?: bigint;
  readonly gas?: bigint;
}): Promise<Receipt> {
  const payload: Record<string, string> = {
    from: tx.from,
    to: tx.to,
    gas: hexQuantity(tx.gas ?? DEFAULT_GAS_LIMIT),
  };
  if (tx.data !== undefined) payload["data"] = tx.data;
  if (tx.value !== undefined && tx.value > 0n) payload["value"] = hexQuantity(tx.value);
  const txHash = await rpc<Hex>("eth_sendTransaction", [payload]);
  for (let i = 0; i < 200; i += 1) {
    const r = await rpc<Record<string, unknown> | null>("eth_getTransactionReceipt", [txHash]);
    if (r !== null) {
      const receipt: Receipt = {
        txHash,
        status: BigInt(r["status"] as string),
        gasUsed: BigInt(r["gasUsed"] as string),
        effectiveGasPrice: BigInt(r["effectiveGasPrice"] as string),
        blockNumber: BigInt(r["blockNumber"] as string),
        logs: r["logs"] as RawLog[],
      };
      if (receipt.status !== 1n) throw new TxRevertedError(txHash);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no receipt for ${txHash}`);
}

/**
 * Replay a mined (reverted) tx faithfully — original gas limit, parent-block
 * state — to surface the revert data. Returns null if the replay succeeds.
 */
export async function replayRevert(txHash: Hex): Promise<string | null> {
  const tx = await rpc<Record<string, unknown> | null>("eth_getTransactionByHash", [txHash]);
  if (tx === null) return `tx ${txHash} not found`;
  const parent = BigInt(tx["blockNumber"] as string) - 1n;
  const payload: Record<string, string> = {
    from: tx["from"] as string,
    to: tx["to"] as string,
    gas: tx["gas"] as string,
    data: (tx["input"] ?? tx["data"]) as string,
  };
  const value = tx["value"] as string | undefined;
  if (value !== undefined && BigInt(value) > 0n) payload["value"] = value;
  const res = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: (rpcId += 1),
      method: "eth_call",
      params: [payload, hexQuantity(parent)],
    }),
  });
  const body = (await res.json()) as { error?: { message?: string; data?: unknown } };
  if (body.error === undefined) return null;
  const d = body.error.data;
  if (typeof d === "string") return d;
  if (typeof d === "object" && d !== null) {
    const nested = (d as { data?: unknown }).data;
    if (typeof nested === "string") return nested;
  }
  return body.error.message ?? "unknown revert";
}

export async function getStorageWord(address: Address, slot: bigint): Promise<bigint> {
  return BigInt(await rpc<string>("eth_getStorageAt", [address, hexWord(slot), "latest"]));
}

export async function setStorageWord(address: Address, slot: bigint, word: bigint): Promise<void> {
  await rpc("anvil_setStorageAt", [address, hexWord(slot), hexWord(word)]);
}

export async function nativeBalance(address: Address): Promise<bigint> {
  return BigInt(await rpc<string>("eth_getBalance", [address, "latest"]));
}
