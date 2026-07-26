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
 * A bursty SETUP call, retried with backoff.
 *
 * `anvil_reset` re-forks, which makes anvil re-fetch state from the upstream provider in one
 * burst. On a free-tier endpoint that reliably trips the provider's rate limiter, and anvil
 * surfaces it as an RPC error — so the suite failed for an ENVIRONMENT reason wearing the
 * costume of a fixture failure (2 of the last 3 CI runs). Retrying is correct here and only
 * here: a reset is idempotent, so a second attempt is the same request, not a different one.
 *
 * Deliberately NOT applied to `rpc` in general. Retrying a `eth_sendTransaction` could send a
 * transaction twice, and retrying a read that failed for a real reason would turn a fixture
 * bug into a timeout. Assertions are untouched: this only decides whether the fork was
 * successfully placed in its starting state.
 */
const RESET_ATTEMPTS = 5;
const RESET_BACKOFF_MS = 2_000;

export async function rpcWithRetry<T>(
  method: string,
  params: readonly unknown[] = [],
  attempts = RESET_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await rpc<T>(method, params);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      // Linear backoff: the limiter's window is seconds, and an exponential ramp would
      // overshoot the suite's budget without buying a better chance of success.
      const waitMs = RESET_BACKOFF_MS * attempt;
      record(`${method} attempt ${attempt}/${attempts} failed (${String(error)}); retrying in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error(
    `${method} failed after ${attempts} attempts — the upstream endpoint is rate-limiting the re-fork; ` +
      `raise ANVIL_CUPS or use a paid endpoint. Last error: ${String(lastError)}`,
  );
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
