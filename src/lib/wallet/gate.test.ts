import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import type { PlanSuccess } from "../../core/plan";
import { canonicalFlagshipPlan } from "../../../tests/helpers/plans";
import { LIVE_SIMULATION_MAX_AGE_MS } from "../execution/tolerance";
import {
  LIVE_CHAIN_ID,
  liveConnectRefusalOf,
  liveExecuteRefusalOf,
  planRequiresCodeFreeActor,
  simulationCanClear,
  walletDeparted,
  type LiveExecuteRefusal,
} from "./gate";
import type { WalletSeamReadings, WalletSession } from "./types";

/** The canonical 13-step flagship — the plan every live gate in the product runs against.
 *  Built OUTSIDE the wallet directory (tests/helpers/plans.ts): the F5b quarantine bans
 *  core money-math value imports here, tests included, and the fixture respects it. */
const canonicalPlan: PlanSuccess = canonicalFlagshipPlan();

/** The same plan with the WETH withdrawal removed — no stipend send, so no code gate. */
const noWithdrawPlan: PlanSuccess = {
  ...canonicalPlan,
  steps: canonicalPlan.steps.filter((step) => step.functionName !== "withdraw"),
};

const WALLET: Address = getAddress("0x1111111111111111111111111111111111111111");
const OTHER: Address = getAddress("0x2222222222222222222222222222222222222222");

const session = (overrides: Partial<WalletSession> = {}): WalletSession => ({
  address: WALLET,
  chainId: LIVE_CHAIN_ID,
  connectorId: "mock",
  ...overrides,
});

const CLEAR: WalletSeamReadings = { code: { status: "clear" }, footprint: { status: "clear" } };

describe("planRequiresCodeFreeActor", () => {
  it("is true for the flagship — step 8 is the WETH withdrawal whose ETH send carries the stipend", () => {
    expect(planRequiresCodeFreeActor(canonicalPlan)).toBe(true);
  });

  it("is false for a plan with no WETH withdrawal — the gate is about the mechanism", () => {
    expect(planRequiresCodeFreeActor(noWithdrawPlan)).toBe(false);
  });

  it("is false for a three-argument withdraw — Aave Pool's shape, ERC-20 transfer, no stipend send", () => {
    const weth = canonicalPlan.steps.find((step) => step.functionName === "withdraw");
    if (weth === undefined) throw new Error("flagship plan lost its WETH withdrawal");
    const poolShaped: PlanSuccess = {
      ...noWithdrawPlan,
      steps: [
        ...noWithdrawPlan.steps,
        {
          ...weth,
          args: [
            { kind: "value", value: weth.to },
            { kind: "amount" },
            { kind: "value", value: WALLET },
          ],
        },
      ],
    };
    expect(planRequiresCodeFreeActor(poolShaped)).toBe(false);
  });
});

describe("liveConnectRefusalOf", () => {
  it("admits a mainnet EOA with no footprint", () => {
    expect(liveConnectRefusalOf(session(), CLEAR, canonicalPlan)).toBeNull();
  });

  it("refuses any chain but mainnet, before anything else is even consulted", () => {
    const unreadable: WalletSeamReadings = {
      code: { status: "unknown", reason: "not read" },
      footprint: { status: "unknown", reason: "not read" },
    };
    expect(liveConnectRefusalOf(session({ chainId: 8453 }), unreadable, canonicalPlan)).toEqual({
      kind: "wrong-chain",
      chainId: 8453,
      expected: LIVE_CHAIN_ID,
    });
  });

  it("refuses a code-bearing wallet for a plan containing WETH.withdraw", () => {
    const readings: WalletSeamReadings = {
      code: { status: "code-bearing", code: "0xef0100" },
      footprint: { status: "clear" },
    };
    expect(liveConnectRefusalOf(session(), readings, canonicalPlan)).toEqual({
      kind: "code-bearing-wallet",
    });
  });

  it("admits the same code-bearing wallet for a plan with no stipend send", () => {
    const readings: WalletSeamReadings = {
      code: { status: "code-bearing", code: "0xef0100" },
      footprint: { status: "clear" },
    };
    expect(liveConnectRefusalOf(session(), readings, noWithdrawPlan)).toBeNull();
  });

  it("refuses when the code check did not resolve — a pending read is not a clear one", () => {
    const readings: WalletSeamReadings = {
      code: { status: "unknown", reason: "no RPC configured" },
      footprint: { status: "clear" },
    };
    expect(liveConnectRefusalOf(session(), readings, canonicalPlan)).toEqual({
      kind: "code-unknown",
      reason: "no RPC configured",
    });
  });

  it("refuses a wallet already holding an Aave Core position (SPEC §2 predicate)", () => {
    const readings: WalletSeamReadings = {
      code: { status: "clear" },
      footprint: { status: "occupied" },
    };
    expect(liveConnectRefusalOf(session(), readings, canonicalPlan)).toEqual({
      kind: "existing-footprint",
    });
  });

  it("refuses when the footprint predicate could not be evaluated", () => {
    const readings: WalletSeamReadings = {
      code: { status: "clear" },
      footprint: { status: "unknown", reason: "the reserve sweep failed" },
    };
    expect(liveConnectRefusalOf(session(), readings, canonicalPlan)).toEqual({
      kind: "footprint-unknown",
      reason: "the reserve sweep failed",
    });
  });
});

describe("liveExecuteRefusalOf", () => {
  /** The hash the composer computed when the gating simulation ran (planHashOf's shape). */
  const SIMULATED_HASH = `0x${"ab".repeat(32)}` as const;
  /** A different document's hash — one byte moved. */
  const EDITED_HASH = `0x${"ab".repeat(31)}cd` as const;
  const PINNED = { block: 22_000_000n, blockHash: `0x${"11".repeat(32)}` } as const;
  const OTHER_BLOCK = { block: 22_000_010n, blockHash: `0x${"22".repeat(32)}` } as const;

  const standing = (atMs: number, simulatedFor: Address = WALLET) => ({
    simulatedFor,
    simulatedAtMonotonicMs: atMs,
    planHash: SIMULATED_HASH,
    snapshot: PINNED,
  });

  /** The inputs of the happy path; each test states only what it breaks. */
  const inputs = (overrides: Partial<Parameters<typeof liveExecuteRefusalOf>[0]> = {}) => ({
    session: session(),
    readings: CLEAR,
    plan: canonicalPlan,
    simulation: standing(0),
    currentPlanHash: SIMULATED_HASH as `0x${string}` | null,
    currentSnapshot: PINNED as (typeof PINNED) | null,
    nowMonotonicMs: 0,
    ...overrides,
  });

  it("refuses with no wallet at all", () => {
    expect(liveExecuteRefusalOf(inputs({ session: null }))).toEqual({ kind: "not-connected" });
  });

  it("propagates the connect refusal rather than inventing a second vocabulary", () => {
    expect(liveExecuteRefusalOf(inputs({ session: session({ chainId: 10 }) }))).toEqual({
      kind: "wrong-chain",
      chainId: 10,
      expected: LIVE_CHAIN_ID,
    });
  });

  it("refuses until a simulation exists — SPEC §3 step 7's fresh-simulation gate", () => {
    expect(liveExecuteRefusalOf(inputs({ simulation: null }))).toEqual({
      kind: "no-fresh-simulation",
    });
  });

  it("refuses a simulation captured for a different wallet's balances", () => {
    expect(liveExecuteRefusalOf(inputs({ simulation: standing(0, OTHER) }))).toEqual({
      kind: "simulation-address-drift",
      simulatedFor: OTHER,
      connected: WALLET,
    });
  });

  it("admits a fresh simulation for the connected wallet over the same plan and capture", () => {
    expect(
      liveExecuteRefusalOf(
        inputs({
          simulation: standing(1_000),
          nowMonotonicMs: 1_000 + LIVE_SIMULATION_MAX_AGE_MS,
        }),
      ),
    ).toBeNull();
  });

  it("refuses when the allocation is edited after simulating — plan drift, address and clock unchanged (Codex D-011 F3)", () => {
    // The exact hole the finding names: simulate plan A, edit the allocation, press Execute
    // on plan B inside the freshness window. Address identical, zero milliseconds elapsed —
    // only the document moved, and the gate must refuse on THAT.
    expect(liveExecuteRefusalOf(inputs({ currentPlanHash: EDITED_HASH }))).toEqual({
      kind: "plan-drift",
      simulated: SIMULATED_HASH,
      current: EDITED_HASH,
    });
  });

  it("refuses as plan drift when the current document no longer plans over the capture at all", () => {
    expect(liveExecuteRefusalOf(inputs({ currentPlanHash: null }))).toEqual({
      kind: "plan-drift",
      simulated: SIMULATED_HASH,
      current: null,
    });
  });

  it("refuses when the capture in hand is a different pinned block — snapshot drift", () => {
    expect(liveExecuteRefusalOf(inputs({ currentSnapshot: OTHER_BLOCK }))).toEqual({
      kind: "snapshot-drift",
      simulatedAt: PINNED,
      current: OTHER_BLOCK,
    });
  });

  it("refuses as snapshot drift when a hash mismatch impersonates the pinned block number", () => {
    const reorged = { block: PINNED.block, blockHash: OTHER_BLOCK.blockHash };
    expect(liveExecuteRefusalOf(inputs({ currentSnapshot: reorged }))).toEqual({
      kind: "snapshot-drift",
      simulatedAt: PINNED,
      current: reorged,
    });
  });

  it("compares block hashes case-insensitively — a checksum casing is not a reorg", () => {
    const uppercased = {
      block: PINNED.block,
      blockHash: PINNED.blockHash.toUpperCase() as `0x${string}`,
    };
    expect(liveExecuteRefusalOf(inputs({ currentSnapshot: uppercased }))).toBeNull();
  });

  it("refuses as snapshot drift when the capture the standing pinned is gone", () => {
    expect(liveExecuteRefusalOf(inputs({ currentSnapshot: null }))).toEqual({
      kind: "snapshot-drift",
      simulatedAt: PINNED,
      current: null,
    });
  });

  it("reports drift, never staleness, when both apply — drift is a different question, not an old one", () => {
    const refusal = liveExecuteRefusalOf(
      inputs({
        currentPlanHash: EDITED_HASH,
        simulation: standing(0),
        nowMonotonicMs: LIVE_SIMULATION_MAX_AGE_MS + 60_000,
      }),
    );
    expect(refusal).toEqual({ kind: "plan-drift", simulated: SIMULATED_HASH, current: EDITED_HASH });
  });

  it("regates one millisecond past the named max age, and names the bound it applied", () => {
    expect(
      liveExecuteRefusalOf(
        inputs({
          simulation: standing(1_000),
          nowMonotonicMs: 1_001 + LIVE_SIMULATION_MAX_AGE_MS,
        }),
      ),
    ).toEqual({
      kind: "stale-simulation",
      ageMs: LIVE_SIMULATION_MAX_AGE_MS + 1,
      maxAgeMs: LIVE_SIMULATION_MAX_AGE_MS,
    });
  });
});

describe("simulationCanClear", () => {
  const PINNED = { block: 1n, blockHash: `0x${"11".repeat(32)}` } as const;

  it("offers the simulate control against every refusal a fresh simulation can answer", () => {
    const clearable: LiveExecuteRefusal[] = [
      { kind: "no-fresh-simulation" },
      { kind: "stale-simulation", ageMs: 1, maxAgeMs: 0 },
      { kind: "simulation-address-drift", simulatedFor: OTHER, connected: WALLET },
      { kind: "plan-drift", simulated: `0x${"ab".repeat(32)}`, current: null },
      { kind: "snapshot-drift", simulatedAt: PINNED, current: null },
    ];
    for (const refusal of clearable) {
      expect(simulationCanClear(refusal), refusal.kind).toBe(true);
    }
  });

  it("never offers it against a connect-level refusal — a simulation cannot answer those", () => {
    const connectLevel: LiveExecuteRefusal[] = [
      { kind: "not-connected" },
      { kind: "wrong-chain", chainId: 10, expected: LIVE_CHAIN_ID },
      { kind: "code-bearing-wallet" },
      { kind: "code-unknown", reason: "not read" },
      { kind: "existing-footprint" },
      { kind: "footprint-unknown", reason: "not read" },
    ];
    for (const refusal of connectLevel) {
      expect(simulationCanClear(refusal), refusal.kind).toBe(false);
    }
  });
});

describe("walletDeparted", () => {
  it("treats losing the account as a departure — nothing further may be signed", () => {
    expect(walletDeparted(session(), null)).toBe(true);
  });

  it("treats a chain switch as a departure", () => {
    expect(walletDeparted(session(), { address: WALLET, chainId: 10 })).toBe(true);
  });

  it("treats a different account as a departure", () => {
    expect(walletDeparted(session(), { address: OTHER, chainId: LIVE_CHAIN_ID })).toBe(true);
  });

  it("does not fire on a re-announcement of the same account in any casing", () => {
    const lowercase = WALLET.toLowerCase() as Address;
    expect(walletDeparted(session(), { address: lowercase, chainId: LIVE_CHAIN_ID })).toBe(false);
  });
});
