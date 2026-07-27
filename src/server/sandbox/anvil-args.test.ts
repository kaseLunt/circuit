import { describe, expect, it } from "vitest";
import {
  LOCAL_UPSTREAM_FORK_TIMEOUT_MS,
  sessionAnvilArgs,
  upstreamTopologyOf,
  type SessionAnvilOptions,
} from "./anvil-args";

const options = (upstreamUrl: string): SessionAnvilOptions => ({
  upstreamUrl,
  baseBlock: 25_592_678n,
  port: 9645,
  computeUnitsPerSecond: "100",
  forkRetries: "10",
  forkRetryBackoffMs: "2000",
});

describe("upstreamTopologyOf", () => {
  it("classifies every loopback spelling as localhost", () => {
    expect(upstreamTopologyOf("http://127.0.0.1:8547")).toBe("localhost");
    expect(upstreamTopologyOf("http://127.9.9.9:8547")).toBe("localhost");
    expect(upstreamTopologyOf("http://localhost:8547")).toBe("localhost");
    expect(upstreamTopologyOf("http://LOCALHOST:8547")).toBe("localhost"); // URL lowercases
    expect(upstreamTopologyOf("http://[::1]:8547")).toBe("localhost");
  });

  it("classifies real providers and non-loopback hosts as remote", () => {
    expect(upstreamTopologyOf("https://eth-mainnet.g.alchemy.com/v2/key")).toBe("remote");
    expect(upstreamTopologyOf("http://10.0.0.5:8545")).toBe("remote");
    expect(upstreamTopologyOf("https://ethereum-rpc.publicnode.com")).toBe("remote");
    // A hostname that merely CONTAINS a loopback spelling is not loopback.
    expect(upstreamTopologyOf("http://127.0.0.1.evil.example")).toBe("remote");
    expect(upstreamTopologyOf("http://notlocalhost:8545")).toBe("remote");
  });

  it("classifies a malformed URL as remote — the conservative side keeps the throttles", () => {
    expect(upstreamTopologyOf("not a url")).toBe("remote");
    expect(upstreamTopologyOf("")).toBe("remote");
  });
});

describe("sessionAnvilArgs", () => {
  it("localhost upstream: no self-throttle, no retry ladder, raised fork-request timeout", () => {
    const args = sessionAnvilArgs(options("http://127.0.0.1:8547"));
    // A local upstream that fails is dead, not throttled (PR #20 CI finding): CUPS
    // against loopback starves the cold-miss storage sweep of a freshly-minted random
    // actor and trips anvil's default 45s fork-request timeout — structurally.
    expect(args).not.toContain("--compute-units-per-second");
    expect(args).not.toContain("--retries");
    expect(args).not.toContain("--fork-retry-backoff");
    const timeoutAt = args.indexOf("--timeout");
    expect(timeoutAt).toBeGreaterThan(-1);
    expect(args[timeoutAt + 1]).toBe(String(LOCAL_UPSTREAM_FORK_TIMEOUT_MS));
  });

  it("remote upstream: the full R-3a74989b posture, no timeout override", () => {
    const args = sessionAnvilArgs(options("https://eth-mainnet.g.alchemy.com/v2/key"));
    expect(args).not.toContain("--timeout");
    const cupsAt = args.indexOf("--compute-units-per-second");
    expect(args[cupsAt + 1]).toBe("100");
    const retriesAt = args.indexOf("--retries");
    expect(args[retriesAt + 1]).toBe("10");
    const backoffAt = args.indexOf("--fork-retry-backoff");
    expect(args[backoffAt + 1]).toBe("2000");
  });

  it("carries the fork pin, loopback bind, and port in both topologies", () => {
    for (const upstream of ["http://127.0.0.1:8547", "https://example-rpc.invalid"]) {
      const args = sessionAnvilArgs(options(upstream));
      expect(args[args.indexOf("--fork-url") + 1]).toBe(upstream);
      expect(args[args.indexOf("--fork-block-number") + 1]).toBe("25592678");
      expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
      expect(args[args.indexOf("--port") + 1]).toBe("9645");
    }
  });
});
