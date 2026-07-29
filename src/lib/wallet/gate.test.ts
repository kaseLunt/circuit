import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { buildPlan, type PlanSuccess } from "../../core/plan";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import { LIVE_SIMULATION_MAX_AGE_MS } from "../execution/tolerance";
import {
  LIVE_CHAIN_ID,
  liveConnectRefusalOf,
  liveExecuteRefusalOf,
  planRequiresCodeFreeActor,
  walletDeparted,
} from "./gate";
import type { WalletSeamReadings, WalletSession } from "./types";

/** The canonical 13-step flagship — the plan every live gate in the product runs against. */
const canonicalPlan: PlanSuccess = (() => {
  const result = buildPlan(flagshipGraph(), fixtureSnapshot());
  if (!result.ok) throw new Error("canonical flagship plan failed to build");
  return result;
})();

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
  const standing = (atMs: number, simulatedFor: Address = WALLET) => ({
    simulatedFor,
    simulatedAtMonotonicMs: atMs,
  });

  it("refuses with no wallet at all", () => {
    expect(
      liveExecuteRefusalOf({
        session: null,
        readings: CLEAR,
        plan: canonicalPlan,
        simulation: standing(0),
        nowMonotonicMs: 0,
      }),
    ).toEqual({ kind: "not-connected" });
  });

  it("propagates the connect refusal rather than inventing a second vocabulary", () => {
    expect(
      liveExecuteRefusalOf({
        session: session({ chainId: 10 }),
        readings: CLEAR,
        plan: canonicalPlan,
        simulation: standing(0),
        nowMonotonicMs: 0,
      }),
    ).toEqual({ kind: "wrong-chain", chainId: 10, expected: LIVE_CHAIN_ID });
  });

  it("refuses until a simulation exists — SPEC §3 step 7's fresh-simulation gate", () => {
    expect(
      liveExecuteRefusalOf({
        session: session(),
        readings: CLEAR,
        plan: canonicalPlan,
        simulation: null,
        nowMonotonicMs: 0,
      }),
    ).toEqual({ kind: "no-fresh-simulation" });
  });

  it("refuses a simulation captured for a different wallet's balances", () => {
    expect(
      liveExecuteRefusalOf({
        session: session(),
        readings: CLEAR,
        plan: canonicalPlan,
        simulation: standing(0, OTHER),
        nowMonotonicMs: 0,
      }),
    ).toEqual({ kind: "simulation-address-drift", simulatedFor: OTHER, connected: WALLET });
  });

  it("admits a fresh simulation for the connected wallet", () => {
    expect(
      liveExecuteRefusalOf({
        session: session(),
        readings: CLEAR,
        plan: canonicalPlan,
        simulation: standing(1_000),
        nowMonotonicMs: 1_000 + LIVE_SIMULATION_MAX_AGE_MS,
      }),
    ).toBeNull();
  });

  it("regates one millisecond past the named max age, and names the bound it applied", () => {
    expect(
      liveExecuteRefusalOf({
        session: session(),
        readings: CLEAR,
        plan: canonicalPlan,
        simulation: standing(1_000),
        nowMonotonicMs: 1_001 + LIVE_SIMULATION_MAX_AGE_MS,
      }),
    ).toEqual({
      kind: "stale-simulation",
      ageMs: LIVE_SIMULATION_MAX_AGE_MS + 1,
      maxAgeMs: LIVE_SIMULATION_MAX_AGE_MS,
    });
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
