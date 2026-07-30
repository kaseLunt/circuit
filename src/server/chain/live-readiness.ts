/**
 * The live readiness capture (Codex D-011 F2): everything SPEC §3 step 7 needs to know
 * about the connected address, read in ONE place through OUR configured RPC — never the
 * injected provider (seam A1, treatment §1.1).
 *
 * One call produces the three facts the wallet router returns together, all pinned to the
 * SAME block so no frame can pair one moment's footprint with another moment's prices:
 *
 *  1. `eth_getCode(address)` — the code reading the WETH-withdraw stipend gate consumes.
 *  2. The SPEC §2 footprint predicate — NOT a second predicate: it is
 *     `captureChainSnapshot`'s own `hasAaveFootprint` sweep, exactly as
 *     `docs/live-execution-checklist.md` §1 requires ("one definition, or the two will
 *     disagree").
 *  3. The block-pinned `ChainSnapshot` for the address — the live replacement for the
 *     sandbox's `Configured` user pair, hash-verified via `expectBlockHash` so the wire
 *     carries an identity the F3 standing can bind to.
 *
 * CAPTURE IDENTITY IS BRACKETED, NOT MERELY PINNED (Codex round-2 finding 1). Both reads
 * address the block by NUMBER, and a number is not an identity: a reorg landing mid-capture
 * replaces the block that number names, so `getCode` and the snapshot sweep can answer from
 * two different histories while the wire still claims the hash read at the start. So the hash
 * is read before the capture and RE-READ after it, and a capture whose block was replaced is
 * refused rather than shipped. `captureChainSnapshot`'s own `expectBlockHash` pre-check stays
 * — it catches a replacement that had already happened when the snapshot began; this POST
 * check is what closes the window between the two reads.
 *
 * The refusal is a throw, which the wallet router maps to its typed `capture-failed` payload
 * with URLs scrubbed; the message therefore stays URL-free by construction, carrying only
 * block number and hashes.
 *
 * The RPC is server-only configuration (`LIVE_CHAIN_RPC_URL`) — never `NEXT_PUBLIC_*`
 * (A6, lint-gated in src/server). A deployment without it has NO live chain source, and
 * `liveReadinessFromEnv` returns null so the router answers with a stated refusal and the
 * gate refuses — the SPEC §5 explicit-absence posture, not a bug to route around.
 *
 * Lazy and memoized like `sandboxServiceFromEnv`: importing this module demands no env and
 * opens nothing; only a request does.
 */
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { captureChainSnapshot } from "./snapshot";
import { wireLiveCaptureOf, type WireLiveReadiness } from "../../lib/live/snapshot-wire";

/** Generous: a readiness capture is hundreds of multicalled reads against a cold upstream. */
const READ_TIMEOUT_MS = 30_000;

export interface LiveReadinessService {
  capture(user: Address): Promise<WireLiveReadiness>;
}

/**
 * The snapshot read, injected rather than imported at the call site, so the identity bracket
 * above is provable without a chain: `live-readiness.test.ts` drives the block reads that
 * bracket the window and hands in a snapshot, which is the only part of this composition that
 * is not already proven elsewhere (the snapshot itself by the wire round-trip and the fork
 * suite). The default IS `captureChainSnapshot` — there is no configuration that substitutes
 * another reader in a running deployment.
 */
export type SnapshotCapture = typeof captureChainSnapshot;

/**
 * The pinned block's hash, or a refusal. A pending block has no hash and therefore no
 * identity to bracket a capture with — reading its number would name a block that does not
 * exist yet.
 */
async function pinnedHashOf(client: PublicClient, blockNumber: bigint): Promise<Hex> {
  const block = await client.getBlock({ blockNumber });
  if (block.hash === null) {
    throw new Error(`block ${blockNumber} has no hash — a pending block cannot pin a capture`);
  }
  return block.hash;
}

export function liveReadinessService(
  client: PublicClient,
  capture: SnapshotCapture = captureChainSnapshot,
): LiveReadinessService {
  return {
    async capture(user) {
      const blockNumber = await client.getBlockNumber();
      const blockHash = await pinnedHashOf(client, blockNumber);
      const [code, snapshot] = await Promise.all([
        client.getCode({ address: user, blockNumber }),
        capture(client, { user, blockNumber, expectBlockHash: blockHash }),
      ]);
      // The post-check, after BOTH reads: if the block that `blockNumber` names is no longer
      // the block the capture began against, the two reads may have come from different
      // histories and nothing here can tell which. Refuse — a capture is either one moment's
      // state or it is not a capture.
      const settledHash = await pinnedHashOf(client, blockNumber);
      if (settledHash !== blockHash) {
        throw new Error(
          `the chain reorganized during the capture: block ${blockNumber} was ${blockHash} when the capture began and is ${settledHash} now, so the readings may straddle two histories`,
        );
      }
      return {
        code:
          code === undefined || code === "0x"
            ? { status: "clear" }
            : { status: "code-bearing", code },
        capture: wireLiveCaptureOf(snapshot, blockHash),
      };
    },
  };
}

let envService: LiveReadinessService | null | undefined;

/** Null — a stated absence, never a default endpoint — when no live RPC is configured. */
export function liveReadinessFromEnv(): LiveReadinessService | null {
  if (envService !== undefined) return envService;
  const url = process.env.LIVE_CHAIN_RPC_URL;
  if (url === undefined || url.trim() === "") {
    envService = null;
    return envService;
  }
  const client = createPublicClient({
    chain: mainnet,
    transport: http(url, { timeout: READ_TIMEOUT_MS }),
  }) as unknown as PublicClient;
  envService = liveReadinessService(client);
  return envService;
}
