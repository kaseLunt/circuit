/**
 * The wallet boundary's type surface (P3 treatment §1.1).
 *
 * CLAUDE.md: "transaction-transport observation (receipts, nonces, wallet state) is the
 * client's and never feeds money-math." This module is that sentence as a module boundary.
 *
 * `WalletSession` is the ONLY shape connect produces, and `address` is the ONE field that
 * ever crosses toward money-math — exclusively as `captureChainSnapshot(client, { user })`
 * (`src/server/chain/snapshot.ts`), which mints `eModeCategoryId`/`hasAaveFootprint` as
 * `Observed` and replaces the sandbox's `Configured` pair
 * (`src/lib/recorded-reads/sandbox-snapshot.ts`). The wallet's own reported balances, its
 * provider's reads, and its gas estimates never enter `core/` and never become
 * `Provenanced`: no `ObservationMinter` exists outside `server/chain`, and the
 * `{ kind: "observed" }` literal ban lint-enforces the shape.
 *
 * `chainId` and `connectorId` are gate and display facts respectively. `connectorId` exists
 * so the chrome can name what is connected and so the mock connector is IDENTIFIABLE without
 * being SPECIAL — no money-math anywhere branches on it (treatment §1.2, last row).
 */
import type { Address, Hex } from "viem";

/** The only shape connect produces (treatment §1.1, verbatim). */
export interface WalletSession {
  /** The ONE field that ever crosses toward money-math. */
  readonly address: Address;
  readonly chainId: number;
  /** Display + mock-connector detection only. */
  readonly connectorId: string;
}

/**
 * `eth_getCode(address)` at connect, as a three-valued reading rather than a boolean.
 *
 * "Unknown" is a first-class state because a missing source renders an explicit unavailable
 * state and never a permissive default (SPEC §5): a code check that did not resolve must not
 * read as "clear". `code` is retained on the code-bearing arm because the evidence is what
 * the refusal card renders — the bytes are the reason, not a claim about them.
 */
export type WalletCodeReading =
  | { readonly status: "clear" }
  | { readonly status: "code-bearing"; readonly code: Hex }
  | { readonly status: "unknown"; readonly reason: string };

/**
 * The SPEC §2 footprint predicate as the live path observes it: any debt or any aToken
 * balance, collateral-enabled or not. Read through `server/chain`'s configured RPC as part
 * of the live snapshot — never asked of the injected provider (A1).
 */
export type WalletFootprintReading =
  | { readonly status: "clear" }
  | { readonly status: "occupied" }
  | { readonly status: "unknown"; readonly reason: string };

/** What the connect surface is doing, as a state rather than a pair of booleans. */
export type WalletConnection =
  | { readonly kind: "disconnected" }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected"; readonly session: WalletSession }
  | { readonly kind: "connect-failed"; readonly detail: string };

/**
 * The connect-time seam readings a live gate consumes, assembled by the wallet host and
 * consumed by the pure gate in `gate.ts`. Every field is a READING, not a conclusion: the
 * decisions live in covered pure code (doctrine D10), and this type is what crosses.
 */
export interface WalletSeamReadings {
  readonly code: WalletCodeReading;
  readonly footprint: WalletFootprintReading;
}
