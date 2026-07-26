/**
 * The block-pinned `ChainSnapshot` unit fixture.
 *
 * The construction moved to `src/lib/recorded-reads/recorded-snapshot.ts` in W05 P2: the
 * running sandbox needs the same builder, and `src/**` must not import from `tests/**`, so
 * the dependency runs one way. What stays here is what is genuinely test-only — the fixture
 * USER, and the canonical step-target map that reads `./graphs`.
 *
 * The fixture user is minted `Observed` on purpose, and that is not a contradiction of the
 * sandbox's `Configured` user: this fixture models a chain that WAS read for an account
 * with no e-mode and no footprint, which is what the fork suite verifies against a real
 * anvil state (`tests/fork/flagship-plan.test.ts` asserts both). `observationMinter` is
 * still the only thing that constructs an `Observed`.
 *
 * `mutate` edits the RAW reads BEFORE they are minted, which is how a test says "the same
 * block, with this one reserve frozen" without forging provenance.
 *
 * Scope note: this is the READS-LOG fixture. `tests/fork/flagship-plan.test.ts` builds its
 * `pristine`/`seeded` snapshots from live anvil reads and must NOT adopt this helper — only
 * `./graphs` applies there.
 */
import type { Address } from "viem";
import { observationMinter } from "../../src/core/provenance";
import type { ChainSnapshot } from "../../src/core/plan";
import { PINNED_BLOCK, PINNED_TS, addressOf, addrRead, anchorAddr, readsMeta } from "./protocol-reads";
import {
  recordedProtocol,
  snapshotFrom,
  type RecordedProtocol,
} from "../../src/lib/recorded-reads/recorded-snapshot";
import { SANDBOX_USER } from "../../src/lib/recorded-reads/sandbox-snapshot";

export type { RawReserve, RawEMode, RecordedProtocol } from "../../src/lib/recorded-reads/recorded-snapshot";
export { snapshotFrom } from "../../src/lib/recorded-reads/recorded-snapshot";

/**
 * One address, one definition site, shared with the sandbox actor rather than copied:
 * two placeholder users would be two things to keep in step for no gain.
 */
export const FIXTURE_USER: Address = SANDBOX_USER;

export interface RawUser {
  address: Address;
  eModeCategoryId: number;
  hasAaveFootprint: boolean;
}

export type RawFixture = RecordedProtocol & { user: RawUser };

export function rawFixture(): RawFixture {
  return {
    ...recordedProtocol(),
    user: { address: FIXTURE_USER, eModeCategoryId: 0, hasAaveFootprint: false },
  };
}

export function fixtureSnapshot(mutate?: (raw: RawFixture) => void): ChainSnapshot {
  const raw = rawFixture();
  mutate?.(raw);
  const mint = observationMinter(PINNED_BLOCK, Number(PINNED_TS));
  return snapshotFrom(raw, {
    address: raw.user.address,
    eModeCategoryId: mint.observe(raw.user.eModeCategoryId, "Pool.getUserEMode(user)"),
    hasAaveFootprint: mint.observe(raw.user.hasAaveFootprint, "user aave footprint predicate"),
  });
}

/**
 * Address resolution for CANONICAL_STEPS.to symbols — one map, every consumer.
 * plan.test.ts and templates.test.ts must agree on what "LP" means, and the
 * answer comes from the committed reads log, never from memory.
 */
export function canonicalStepAddresses(): Record<import("./graphs").StepTarget, Address> {
  return {
    LP: addrRead("weETH.liquidityPool (round-trip)"),
    eETH: addrRead("LP.eETH (round-trip)"),
    weETH: anchorAddr("weETH"),
    WETH: anchorAddr("WETH"),
    pool: addressOf(readsMeta.pool, "pool"),
  };
}
