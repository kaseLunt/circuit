/**
 * Port leases for session anvils (Codex round-2 finding 3). A port is a LEASE, not a
 * set entry: it is acquired before the child spawns and released only after the child's
 * exit has been OBSERVED — never merely requested — so a concurrent create during a
 * destroy, an expiry cleanup, or a failed reset can never be handed a port whose old
 * anvil still holds the socket. This module is the covered, pure home of that decision
 * structure; `fork-session.ts` only ties `release()` to the observed process exit.
 */

export interface PortLease {
  readonly port: number;
  /** Idempotent. Call ONLY once the previous holder's exit has been observed. */
  release(): void;
}

export interface PortLeaseRegistry {
  /** Throws when every port in the range is leased — the registry capacity should
   *  bound sessions below the port budget, so exhaustion is a configuration error. */
  acquire(): PortLease;
  leasedCount(): number;
  isLeased(port: number): boolean;
}

/** The TCP port ceiling. A range must fit entirely below it (round-3 finding 3): a base
 *  of 65535 with a count of 2 would otherwise "allocate" port 65536, and an unsafe
 *  integer base would stop `port += 1` from advancing at all — an infinite spin. */
const MAX_TCP_PORT = 65_535;

export function createPortLeaseRegistry(portBase: number, portCount: number): PortLeaseRegistry {
  if (!Number.isSafeInteger(portBase) || portBase < 1) {
    throw new Error(`port lease registry: bad base port ${portBase}`);
  }
  if (!Number.isSafeInteger(portCount) || portCount < 1) {
    throw new Error(`port lease registry: bad port count ${portCount}`);
  }
  if (portBase + portCount - 1 > MAX_TCP_PORT) {
    throw new Error(
      `port lease registry: range [${portBase}, ${portBase + portCount}) exceeds the TCP port ceiling ${MAX_TCP_PORT}`,
    );
  }
  const leased = new Set<number>();
  return {
    acquire() {
      for (let port = portBase; port < portBase + portCount; port += 1) {
        if (!leased.has(port)) {
          leased.add(port);
          let released = false;
          return {
            port,
            release() {
              if (released) return;
              released = true;
              leased.delete(port);
            },
          };
        }
      }
      throw new Error(
        `no free sandbox fork port in [${portBase}, ${portBase + portCount}) — ` +
          "the registry capacity should bound sessions below the port budget",
      );
    },
    leasedCount() {
      return leased.size;
    },
    isLeased(port) {
      return leased.has(port);
    },
  };
}
