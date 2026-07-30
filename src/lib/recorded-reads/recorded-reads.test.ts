/**
 * The sandbox read set is the SAME read set the evidence is pinned to, and it says so in
 * its provenance. These are the assertions that keep it honest as the app grows: a screen
 * showing a number the fork suite never verified is the failure this suite exists to catch.
 */
import { describe, expect, it, vi } from "vitest";
import { simulate } from "../../core/risk";
import { buildPlan } from "../../core/plan";
import { hfWadValue } from "../../core/health-factor";
import { setLogSink } from "../log";
import { observedBlocks, valueOf, type AnyProvenanced } from "../../core/provenance";
import {
  CANONICAL_STEPS,
  EXPECTED_BORROW_WEI,
  FORK_PROVEN_BORROW_BPS,
  flagshipGraph,
} from "../../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import { PINNED_BLOCK, PINNED_TS } from "./reads-log";
import { recordedProtocol, snapshotFrom } from "./recorded-snapshot";
import { SANDBOX_USER, sandboxSnapshot, sandboxUser } from "./sandbox-snapshot";

describe("the sandbox snapshot is the committed read set", () => {
  it("pins to the block and the source-block timestamp the reads log records", () => {
    const snapshot = sandboxSnapshot();
    expect(snapshot.block).toBe(PINNED_BLOCK);
    expect(snapshot.blockTimestamp).toBe(PINNED_TS);
  });

  it("carries the pinned block on every observation it mints, and mints no other block", () => {
    const snapshot = sandboxSnapshot();
    const probes: AnyProvenanced[] = [
      snapshot.reserves.weETH.priceBase,
      snapshot.reserves.weETH.liquidityRateRay,
      snapshot.reserves.WETH.variableBorrowRateRay,
      snapshot.reserves.WETH.liquidationThresholdBps,
      snapshot.etherfi.totalPooledEther,
      snapshot.eModeCategories[0]!.liquidationThresholdBps,
    ];
    for (const probe of probes) {
      expect([...observedBlocks(probe)]).toEqual([PINNED_BLOCK]);
    }
  });

});

/**
 * Golden values for the flagship at `FORK_PROVEN_BORROW_BPS`, bound to the pinned block.
 *
 * Written down, not computed here — that is the whole point. Comparing two products of the
 * same builder proves only that the builder is deterministic; it passes just as happily when
 * the builder mis-parses the log, because both sides mis-parse it identically. These literals
 * cannot move unless a number moves.
 *
 * `borrowWei` and `eModeCategoryId` are not merely regression pins: they are the values
 * `tests/fork/flagship-plan.test.ts` proves against a real anvil fork of this exact block
 * (`EXPECTED_PRISTINE_BORROW_WEI` at :436, `expect(emode).toBe(1n)` at :605). Anything that
 * changes them changes what the fork suite executed. The rest are derived at the same block
 * by tested math over those same reads.
 */
const GOLDEN = {
  borrowWei: EXPECTED_BORROW_WEI,
  eModeCategoryId: 1,
  stepCount: 13,
  initialAmountWei: 10_000_000_000_000_000_000n,
  minHealthFactorWad: 1_357_142_857_143_159_467n,
  finalHealthFactorWad: 2_307_142_857_142_454_043n,
  liquidationRatioWad: 810_405_201_682_850_969n,
  leverageWad: 1_699_999_999_998_440_640n,
  /** SPEC §5.1's trailing staking APR, over the window's two recorded blocks. */
  stakingAprWad: 23_614_925_307_064_831n,
  grossApyWad: 23_615_196_239_051_092n,
  netApyWad: 25_065_397_570_968_204n,
  /** §5.2 exposure weights: the collateral legs share (1 + b), the debt leg carries −b. */
  yieldWeightsBps: [16_999, 1, -7_000],
  /** Gas needs a provider (P3a); it is the one thing still absent by design. */
  absentByTheCompleteOrNothingRule: ["gasCostBase"],
} as const;

/** Both snapshots must satisfy the SAME independent goldens — that is what makes the
 *  sandbox's agreement with the fixture evidence rather than a tautology. */
describe.each([
  ["the sandbox snapshot", () => sandboxSnapshot()],
  ["the fork-suite fixture", () => fixtureSnapshot()],
])("%s reproduces the fork-proven flagship", (_name, build) => {
  const graph = flagshipGraph("10", FORK_PROVEN_BORROW_BPS);

  it("derives the complete SimulationResult surface to the pinned values", () => {
    const result = simulate(graph, build());

    expect(result.isValid).toBe(true);
    expect(result.errorMessage).toBeUndefined();
    expect(valueOf(result.initialAmountWei!)).toBe(GOLDEN.initialAmountWei);
    expect(hfWadValue(valueOf(result.minHealthFactor))).toBe(GOLDEN.minHealthFactorWad);
    expect(hfWadValue(valueOf(result.finalHealthFactor))).toBe(GOLDEN.finalHealthFactorWad);
    expect(valueOf(result.liquidationRatioWad!)).toBe(GOLDEN.liquidationRatioWad);
    expect(valueOf(result.leverageWad!)).toBe(GOLDEN.leverageWad);

    // Absent, and absent for a stated reason — asserted so a future source cannot quietly
    // start filling these without anyone revisiting the honesty rule.
    for (const field of GOLDEN.absentByTheCompleteOrNothingRule) {
      expect(result[field], field).toBeNull();
    }

    // The §5.2 composition, complete: the staking leg's trailing APR over the window's two
    // blocks, compounded with the supply leg, then levered against the debt leg.
    expect(valueOf(result.blockValues["stake1"]!.rate!.wad)).toBe(GOLDEN.stakingAprWad);
    expect(valueOf(result.grossApyWad!)).toBe(GOLDEN.grossApyWad);
    expect(valueOf(result.netApyWad!)).toBe(GOLDEN.netApyWad);
    expect(result.yieldSources.map((y) => `${y.protocol}/${y.type}`)).toEqual([
      "etherfi/stake",
      "aave-v3/supply",
      "aave-v3/borrow",
    ]);
    expect(result.yieldSources.map((y) => y.weightBps)).toEqual([...GOLDEN.yieldWeightsBps]);
    expect(result.yieldSources.reduce((total, y) => total + y.weightBps, 0)).toBe(10_000);

    // The block the fork suite's borrow assertion is about, reached through `simulate`.
    expect(valueOf(result.blockValues["borrow"]!.outputAmountWei!)).toBe(GOLDEN.borrowWei);
    expect(Object.keys(result.blockValues).sort()).toEqual(
      graph.blocks.map((b) => b.id).sort(),
    );
  });

  it("plans the 13 enumerated steps, in order, against the fork-proven e-mode category", () => {
    const plan = buildPlan(graph, build());
    if (!plan.ok) throw new Error(`expected a plan: ${plan.errors.map((e) => e.kind).join(", ")}`);

    expect(plan.steps).toHaveLength(GOLDEN.stepCount);
    expect(plan.targetEModeCategoryId).toBe(GOLDEN.eModeCategoryId);

    // Step-for-step against the SPEC §2 enumeration — id, owning block and the function
    // each one calls. A mis-parsed reserve or e-mode read changes this shape.
    expect(plan.steps.map((s) => ({ id: s.id, blockId: s.blockId, fn: s.functionName }))).toEqual(
      CANONICAL_STEPS.map((s) => ({ id: s.id, blockId: s.blockId, fn: s.functionName })),
    );

    // The step that only exists because the sandbox user's e-mode is 0 and the flagship
    // needs category 1 — the difference between a 13-step plan and a 12-step one.
    const emodeStep = plan.steps.find((s) => s.functionName === "setUserEMode");
    if (emodeStep === undefined) throw new Error("expected a setUserEMode step");
    expect(emodeStep.id).toBe("supply1:set-emode");
    expect(emodeStep.args).toContainEqual({ kind: "value", value: GOLDEN.eModeCategoryId });

    const borrow = plan.steps.find((s) => s.id === "borrow:borrow");
    if (borrow?.amount.kind !== "derived") throw new Error("expected a derived borrow amount");
    expect(borrow.amount.amount.value).toBe(GOLDEN.borrowWei);
  });
});

describe("malformed safety reads fail CLOSED, never into a fabricated observation", () => {
  /**
   * Rebuilds the module graph over a reads log with ONE read corrupted, which is the only
   * way to assert the guard at the field rather than at the helper. The values below are the
   * dangerous shapes: `"false"` and `0` both coerce to `false` under `=== true`, so a
   * malformed read would have sailed past the planner's reserve-paused refusal and then been
   * minted `Observed` — a chain citation for something the chain never said.
   */
  async function withCorruptedRead<T>(
    label: string,
    corrupt: unknown,
    inspect: (mod: typeof import("./recorded-snapshot")) => T,
  ): Promise<T> {
    vi.resetModules();
    const actual = (await vi.importActual("../../../docs/protocol-matrix-reads.json")) as {
      default: { reads: { label: string; result?: unknown }[] };
    };
    const log = structuredClone(actual.default);
    const hit = log.reads.find((r) => r.label === label);
    if (hit === undefined) throw new Error(`the fixture assumes a '${label}' read exists`);
    hit.result = corrupt;
    vi.doMock("../../../docs/protocol-matrix-reads.json", () => ({ default: log }));
    try {
      return inspect(await import("./recorded-snapshot"));
    } finally {
      vi.doUnmock("../../../docs/protocol-matrix-reads.json");
      vi.resetModules();
    }
  }

  for (const corrupt of ['"false"', "0", "null"] as const) {
    it(`refuses a getPaused read of ${corrupt} instead of reading it as not-paused`, async () => {
      await withCorruptedRead("weETH.getPaused", JSON.parse(corrupt), (mod) => {
        expect(() => mod.recordedProtocol()).toThrow(/weETH\.getPaused is not a boolean/);
      });
    });
  }

  it("refuses a malformed eMode isIsolated read", async () => {
    await withCorruptedRead("eMode1.isIsolated (v3.7)", "false", (mod) => {
      expect(() => mod.recordedProtocol()).toThrow(/isIsolated .* is not a boolean/);
    });
  });

  it("keeps a well-formed false a real false — the guard rejects shape, not value", async () => {
    await withCorruptedRead("weETH.getPaused", false, (mod) => {
      expect(mod.recordedProtocol().weETH.paused).toBe(false);
    });
    await withCorruptedRead("weETH.getPaused", true, (mod) => {
      expect(mod.recordedProtocol().weETH.paused).toBe(true);
    });
  });

  it("surfaces the refusal as the designed unavailable state, not a crashed composer", async () => {
    // The whole point of failing closed: the host turns the throw into a labelled
    // `unavailable` snapshot, so the screen says the read set could not be loaded rather
    // than rendering numbers derived from a coerced safety flag.
    vi.resetModules();
    const actual = (await vi.importActual("../../../docs/protocol-matrix-reads.json")) as {
      default: { reads: { label: string; result?: unknown }[] };
    };
    const log = structuredClone(actual.default);
    log.reads.find((r) => r.label === "weETH.getPaused")!.result = "false";
    vi.doMock("../../../docs/protocol-matrix-reads.json", () => ({ default: log }));
    setLogSink(() => undefined);
    try {
      const { loadSandboxSnapshot } = await import("../../components/composer/sandbox-composer");
      const loaded = loadSandboxSnapshot();
      expect(loaded.status).toBe("unavailable");
    } finally {
      setLogSink(null);
      vi.doUnmock("../../../docs/protocol-matrix-reads.json");
      vi.resetModules();
    }
  });
});

describe("the sandbox actor is configured, never observed", () => {
  it("wraps both user facts as Configured with a definition site", () => {
    const user = sandboxUser();
    expect(user.address).toBe(SANDBOX_USER);
    for (const field of [user.eModeCategoryId, user.hasAaveFootprint]) {
      // The reads log captured protocol state, not an account. Minting these as Observed
      // would attach a block and a source to a value nothing read — a forged citation in
      // the one field the log cannot back.
      expect(field.kind).toBe("configured");
      expect(observedBlocks(field).size).toBe(0);
    }
    expect(valueOf(user.eModeCategoryId)).toBe(0);
    expect(valueOf(user.hasAaveFootprint)).toBe(false);
  });

  it("names the definition site, so the constant can be found from a tooltip", () => {
    const user = sandboxUser();
    if (user.eModeCategoryId.kind !== "configured") throw new Error("expected Configured");
    expect(user.eModeCategoryId.name).toBe("SANDBOX_USER_EMODE_CATEGORY");
    expect(user.eModeCategoryId.definedAt).toContain("sandbox-snapshot.ts");
  });

  it("keeps the user out of the protocol builder — the log's shape has no account in it", () => {
    // `recordedProtocol()` is exactly what the log carries. If a user field ever appears on
    // it, something started inventing an account from protocol reads.
    expect(Object.keys(recordedProtocol()).sort()).toEqual([
      "USDC",
      "WETH",
      "eModes",
      "etherfi",
      "pool",
      "weETH",
    ]);
  });

  it("lets the caller state the provenance it can honestly claim", () => {
    // The same protocol reads, a different actor: the builder never decides this.
    const snapshot = snapshotFrom(recordedProtocol(), sandboxUser());
    expect(snapshot.user.eModeCategoryId.kind).toBe("configured");
    expect(fixtureSnapshot().user.eModeCategoryId.kind).toBe("observed");
    expect(snapshot.reserves.weETH.priceBase).toEqual(fixtureSnapshot().reserves.weETH.priceBase);
  });
});
