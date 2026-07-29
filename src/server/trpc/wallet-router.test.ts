/**
 * The wallet readiness router's contract: typed refusal payloads for the designed states
 * (no live RPC configured, capture refused by the chain), the strict address gate, and the
 * pass-through of a successful capture. The capture itself is proven by the snapshot-wire
 * round trip and the fork e2e suite; here the service is injected — the router's job is the
 * transport contract, not the chain.
 */
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import type { Hex } from "viem";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import { wireLiveCaptureOf, type WireLiveReadiness } from "../../lib/live/snapshot-wire";
import type { LiveReadinessService } from "../chain/live-readiness";
import { createWalletCaller } from "./wallet-router";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const HASH: Hex = `0x${"cd".repeat(32)}`;

function stubReadiness(): WireLiveReadiness {
  return { code: { status: "clear" }, capture: wireLiveCaptureOf(fixtureSnapshot(), HASH) };
}

describe("walletRouter.readiness", () => {
  it("answers the stated-absence refusal when no live chain source is configured", async () => {
    const caller = createWalletCaller({ readiness: null });
    const response = await caller.readiness({ address: ADDRESS });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("unreachable");
    expect(response.refusal.kind).toBe("live-chain-unconfigured");
    expect(response.refusal.reason).toContain("LIVE_CHAIN_RPC_URL");
  });

  it("returns the capture verbatim, checksumming the address before the service sees it", async () => {
    const seen: string[] = [];
    const service: LiveReadinessService = {
      capture: (user) => {
        seen.push(user);
        return Promise.resolve(stubReadiness());
      },
    };
    const caller = createWalletCaller({ readiness: service });
    const response = await caller.readiness({ address: ADDRESS.toLowerCase() });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error("unreachable");
    expect(response.readiness.capture.blockHash).toBe(HASH);
    expect(seen).toEqual([getAddress(ADDRESS)]);
  });

  it("maps a failed capture to a typed refusal carrying the reason — never a bare 500", async () => {
    const service: LiveReadinessService = {
      capture: () => Promise.reject(new Error("upstream refused eth_getBlockByNumber")),
    };
    const caller = createWalletCaller({ readiness: service });
    const response = await caller.readiness({ address: ADDRESS });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("unreachable");
    expect(response.refusal).toEqual({
      kind: "capture-failed",
      reason: "upstream refused eth_getBlockByNumber",
    });
  });

  it("scrubs URLs from a relayed capture failure — viem embeds the keyed RPC URL in transport errors", async () => {
    const service: LiveReadinessService = {
      capture: () =>
        Promise.reject(
          new Error(
            "HTTP request failed.\nURL: https://eth-mainnet.example.com/v2/secret-key-material\nRequest body: {}",
          ),
        ),
    };
    const caller = createWalletCaller({ readiness: service });
    const response = await caller.readiness({ address: ADDRESS });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("unreachable");
    expect(response.refusal.kind).toBe("capture-failed");
    expect(response.refusal.reason).not.toContain("secret-key-material");
    expect(response.refusal.reason).toContain("[configured rpc]");
  });

  it("scrubs a non-Error rejection the same way", async () => {
    const service: LiveReadinessService = {
      capture: () => Promise.reject("wss://keyed.example.com/ws/secret went away"),
    };
    const caller = createWalletCaller({ readiness: service });
    const response = await caller.readiness({ address: ADDRESS });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("unreachable");
    expect(response.refusal.reason).not.toContain("secret");
    expect(response.refusal.reason).toContain("[configured rpc]");
  });

  it("refuses a malformed address at the schema, before any service is consulted", async () => {
    const caller = createWalletCaller({ readiness: null });
    await expect(caller.readiness({ address: "0x123" })).rejects.toThrow();
  });

  it("refuses unknown keys — no field exists for calldata to ride in", async () => {
    const caller = createWalletCaller({ readiness: null });
    await expect(
      caller.readiness({ address: ADDRESS, data: "0xdeadbeef" } as never),
    ).rejects.toThrow();
  });
});
