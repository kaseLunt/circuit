/**
 * The live readiness capture's IDENTITY CONTRACT (Codex round-2 finding 1).
 *
 * What is proven here is the bracket, not the chain: both reads inside a capture address the
 * block by NUMBER, so the service reads the block's hash before them and re-reads it after,
 * and refuses when the two disagree. That refusal is the only thing standing between a
 * mid-capture reorg and a wire that claims an identity its data does not come from — so it is
 * asserted rather than described.
 *
 * The snapshot read is injected (`SnapshotCapture`); the capture itself is proven by the
 * snapshot-wire round trip and the fork e2e suite against a real upstream. The client is a
 * fake that answers exactly the three reads this service performs and throws on anything else
 * — a test client that invented a plausible block would be the defect this repo's
 * recorded-reads discipline exists to refuse.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import type { CaptureOptions } from "./snapshot";
import { liveReadinessService, type SnapshotCapture } from "./live-readiness";

const USER: Address = "0x1111111111111111111111111111111111111111";
const PINNED: Hex = `0x${"ab".repeat(32)}`;
const REPLACEMENT: Hex = `0x${"cd".repeat(32)}`;

const SNAPSHOT = fixtureSnapshot();

/**
 * A client whose `getBlock` answers from a SCRIPT — one entry per read, in order — because
 * "the block at this number was X when the capture began and is Y now" is precisely the
 * situation under test. Running off the end of the script throws: an unscripted read means the
 * service performed one the test did not account for, which is a finding, not a default.
 */
function fakeClient(script: {
  readonly blockNumber: bigint;
  readonly hashes: readonly (Hex | null)[];
  readonly code?: Hex | undefined;
}): {
  readonly client: PublicClient;
  readonly blockReads: bigint[];
  readonly codeReads: { readonly address: Address; readonly blockNumber: bigint }[];
} {
  const blockReads: bigint[] = [];
  const codeReads: { readonly address: Address; readonly blockNumber: bigint }[] = [];
  let reads = 0;
  const client = {
    getBlockNumber: () => Promise.resolve(script.blockNumber),
    getBlock: ({ blockNumber }: { blockNumber: bigint }) => {
      blockReads.push(blockNumber);
      const scripted = reads < script.hashes.length ? script.hashes[reads] : undefined;
      reads += 1;
      if (scripted === undefined) {
        throw new Error(`the fake chain has no scripted answer for block read ${reads}`);
      }
      return Promise.resolve({ hash: scripted, number: blockNumber, timestamp: 1_700_000_000n });
    },
    getCode: ({ address, blockNumber }: { address: Address; blockNumber: bigint }) => {
      codeReads.push({ address, blockNumber });
      return Promise.resolve(script.code);
    },
  };
  return { client: client as unknown as PublicClient, blockReads, codeReads };
}

/** The injected snapshot read, recording the client and the options it was pinned with. */
function fakeCapture(): {
  readonly capture: SnapshotCapture;
  readonly seen: CaptureOptions[];
  readonly clients: PublicClient[];
} {
  const seen: CaptureOptions[] = [];
  const clients: PublicClient[] = [];
  const capture: SnapshotCapture = (client, options) => {
    clients.push(client);
    seen.push(options);
    return Promise.resolve(SNAPSHOT);
  };
  return { capture, seen, clients };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("liveReadinessService.capture", () => {
  it("returns the wire shape for a stable block, pinning both reads to the same identity", async () => {
    const { client, blockReads, codeReads } = fakeClient({
      blockNumber: SNAPSHOT.block,
      hashes: [PINNED, PINNED],
    });
    const { capture, seen, clients } = fakeCapture();

    const readiness = await liveReadinessService(client, capture).capture(USER);

    expect(readiness.code).toEqual({ status: "clear" });
    expect(readiness.capture.blockHash).toBe(PINNED);
    expect(readiness.capture.block).toBe(SNAPSHOT.block.toString());
    expect(readiness.capture.user.address).toBe(SNAPSHOT.user.address);
    // The snapshot read carried the pinned hash INTO the capture (its own pre-check) …
    expect(seen).toEqual([
      { user: USER, blockNumber: SNAPSHOT.block, expectBlockHash: PINNED },
    ]);
    // … through OUR client, never a second one (seam A1: one configured RPC, or the two reads
    // are not about one chain) …
    expect(clients).toEqual([client]);
    // … and the service bracketed the whole window with two reads of the same block number.
    expect(blockReads).toEqual([SNAPSHOT.block, SNAPSHOT.block]);
    expect(codeReads).toEqual([{ address: USER, blockNumber: SNAPSHOT.block }]);
  });

  it("reports deployed code as code-bearing, and an empty account as clear", async () => {
    const bearing = fakeClient({
      blockNumber: SNAPSHOT.block,
      hashes: [PINNED, PINNED],
      code: "0xef01005a17",
    });
    const withCode = await liveReadinessService(bearing.client, fakeCapture().capture).capture(USER);
    expect(withCode.code).toEqual({ status: "code-bearing", code: "0xef01005a17" });

    // viem answers an empty account with `undefined` on some transports and `0x` on others;
    // both mean the same thing and neither may read as code-bearing.
    const empty = fakeClient({ blockNumber: SNAPSHOT.block, hashes: [PINNED, PINNED], code: "0x" });
    const noCode = await liveReadinessService(empty.client, fakeCapture().capture).capture(USER);
    expect(noCode.code).toEqual({ status: "clear" });
  });

  it("refuses the capture when the block was replaced between the pin and the post-read", async () => {
    const { client } = fakeClient({
      blockNumber: SNAPSHOT.block,
      hashes: [PINNED, REPLACEMENT],
    });
    const service = liveReadinessService(client, fakeCapture().capture);

    await expect(service.capture(USER)).rejects.toThrow(
      /the chain reorganized during the capture/,
    );
  });

  it("names both hashes in the reorg refusal, and carries no URL for the router to scrub", async () => {
    const { client } = fakeClient({
      blockNumber: SNAPSHOT.block,
      hashes: [PINNED, REPLACEMENT],
    });
    const service = liveReadinessService(client, fakeCapture().capture);

    const error = await service.capture(USER).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain(PINNED);
    expect(message).toContain(REPLACEMENT);
    expect(message).toContain(SNAPSHOT.block.toString());
    // The router relays this text to the browser; a URL in it would be the RPC credential.
    expect(message).not.toMatch(/:\/\//);
  });

  it("refuses a pending block — a block with no hash cannot pin a capture", async () => {
    const { client, codeReads } = fakeClient({ blockNumber: SNAPSHOT.block, hashes: [null] });
    const service = liveReadinessService(client, fakeCapture().capture);

    await expect(service.capture(USER)).rejects.toThrow(
      /has no hash — a pending block cannot pin a capture/,
    );
    // Refused BEFORE any reading was taken: nothing was read for an identity that does not exist.
    expect(codeReads).toEqual([]);
  });

  it("refuses when the post-capture re-read finds a pending block", async () => {
    const { client } = fakeClient({ blockNumber: SNAPSHOT.block, hashes: [PINNED, null] });
    const service = liveReadinessService(client, fakeCapture().capture);

    await expect(service.capture(USER)).rejects.toThrow(
      /has no hash — a pending block cannot pin a capture/,
    );
  });
});

describe("liveReadinessFromEnv", () => {
  /** A fresh module per case: the service is memoized at module scope on purpose. */
  async function freshModule() {
    vi.resetModules();
    return import("./live-readiness");
  }

  it("is null — a stated absence — when no live RPC is configured", async () => {
    vi.stubEnv("LIVE_CHAIN_RPC_URL", undefined);
    const mod = await freshModule();
    expect(mod.liveReadinessFromEnv()).toBeNull();
  });

  it("is null for a blank setting rather than treating it as an endpoint", async () => {
    vi.stubEnv("LIVE_CHAIN_RPC_URL", "   ");
    const mod = await freshModule();
    expect(mod.liveReadinessFromEnv()).toBeNull();
  });

  it("composes one memoized service when the RPC is configured", async () => {
    vi.stubEnv("LIVE_CHAIN_RPC_URL", "https://rpc.example.invalid/key");
    const mod = await freshModule();
    const service = mod.liveReadinessFromEnv();
    expect(service).not.toBeNull();
    // Memoized: a per-request client would open a new connection pool per capture.
    expect(mod.liveReadinessFromEnv()).toBe(service);
  });
});
