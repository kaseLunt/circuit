/**
 * Per-session anvil argument construction, as a covered TOPOLOGY DECISION
 * (PR #20 CI finding; D10/option-(a) discipline — decisions in pure code, fork-session
 * threads the strings).
 *
 * The R-3a74989b hardening flags (CUPS self-throttle, fork retries, backoff) exist for a
 * METERED REMOTE upstream: anvil bursts past a free Alchemy tier and gets 429s, so the
 * base suite anvil — which faces the real provider — self-throttles, correctly. Applied
 * to a child whose upstream is a LOCALHOST anvil, the same flags invert into a defect:
 * they rate-limit loopback traffic, and a session's freshly-minted random actor makes
 * every balance-slot read (keccak(actor, slot)) a cold miss on every run, so the
 * snapshot capture's ~28-token sweep queues hundreds of throttled upstream fetches and
 * anvil's default 45s fork-request timeout expires mid-chain — structurally, not
 * transiently (two identical CI failures). So:
 *
 *  - localhost upstream: NO self-throttle, NO retry ladder (a local upstream that
 *    fails is dead, not throttled), and a RAISED fork-request timeout so one large
 *    multicall's fetch chain cannot trip the 45s default.
 *  - remote upstream (the live-mode path): CUPS + retries + backoff, exactly the
 *    global-setup posture.
 */

export type UpstreamTopology = "localhost" | "remote";

/**
 * Loopback detection over the URL hostname: 127.0.0.0/8, `localhost`, and IPv6 `::1`
 * (WHATWG URL keeps the brackets on IPv6 hostnames). A malformed URL classifies as
 * remote — the conservative side keeps the throttles, and the spawn will surface the
 * real error.
 */
export function upstreamTopologyOf(upstreamUrl: string): UpstreamTopology {
  let hostname: string;
  try {
    hostname = new URL(upstreamUrl).hostname;
  } catch {
    return "remote";
  }
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return "localhost";
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return "localhost";
  return "remote";
}

/**
 * Fork-request timeout for a localhost upstream. Anvil's default is 45s PER upstream
 * request; a session snapshot capture funnels one multicall into hundreds of lazy
 * storage/code fetches, and the whole chain must clear before the aggregate read
 * returns. Two minutes matches the capture-side read budget (CAPTURE_READ_TIMEOUT_MS).
 */
export const LOCAL_UPSTREAM_FORK_TIMEOUT_MS = 120_000;

export interface SessionAnvilOptions {
  readonly upstreamUrl: string;
  readonly baseBlock: bigint;
  readonly port: number;
  readonly computeUnitsPerSecond: string;
  readonly forkRetries: string;
  readonly forkRetryBackoffMs: string;
}

export function sessionAnvilArgs(options: SessionAnvilOptions): string[] {
  const common = [
    "--fork-url",
    options.upstreamUrl,
    "--fork-block-number",
    options.baseBlock.toString(),
    "--host",
    "127.0.0.1",
    "--port",
    String(options.port),
  ];
  if (upstreamTopologyOf(options.upstreamUrl) === "localhost") {
    return [...common, "--timeout", String(LOCAL_UPSTREAM_FORK_TIMEOUT_MS)];
  }
  return [
    ...common,
    "--compute-units-per-second",
    options.computeUnitsPerSecond,
    "--retries",
    options.forkRetries,
    "--fork-retry-backoff",
    options.forkRetryBackoffMs,
  ];
}
