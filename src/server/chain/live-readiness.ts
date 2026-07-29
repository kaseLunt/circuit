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
 * The RPC is server-only configuration (`LIVE_CHAIN_RPC_URL`) — never `NEXT_PUBLIC_*`
 * (A6, lint-gated in src/server). A deployment without it has NO live chain source, and
 * `liveReadinessFromEnv` returns null so the router answers with a stated refusal and the
 * gate refuses — the SPEC §5 explicit-absence posture, not a bug to route around.
 *
 * Lazy and memoized like `sandboxServiceFromEnv`: importing this module demands no env and
 * opens nothing; only a request does.
 */
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { captureChainSnapshot } from "./snapshot";
import { wireLiveCaptureOf, type WireLiveReadiness } from "../../lib/live/snapshot-wire";

/** Generous: a readiness capture is hundreds of multicalled reads against a cold upstream. */
const READ_TIMEOUT_MS = 30_000;

export interface LiveReadinessService {
  capture(user: Address): Promise<WireLiveReadiness>;
}

export function liveReadinessService(client: PublicClient): LiveReadinessService {
  return {
    async capture(user) {
      const blockNumber = await client.getBlockNumber();
      const block = await client.getBlock({ blockNumber });
      if (block.hash === null) {
        throw new Error(`block ${blockNumber} has no hash — a pending block cannot pin a capture`);
      }
      const [code, snapshot] = await Promise.all([
        client.getCode({ address: user, blockNumber }),
        captureChainSnapshot(client, { user, blockNumber, expectBlockHash: block.hash }),
      ]);
      return {
        code:
          code === undefined || code === "0x"
            ? { status: "clear" }
            : { status: "code-bearing", code },
        capture: wireLiveCaptureOf(snapshot, block.hash),
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
