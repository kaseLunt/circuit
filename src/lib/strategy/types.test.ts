import { describe, expect, it } from "vitest";
import {
  validateGraph,
  type Asset as CoreAsset,
  type Block as CoreBlock,
  type Edge as CoreEdge,
  type LendProtocol as CoreLendProtocol,
  type StakeProtocol as CoreStakeProtocol,
  type StrategyGraph,
} from "../../core/graph";
import { riskState, type HealthFactor, type RiskState } from "../../core/health-factor";
import { entered } from "../../core/provenance";
import {
  FULL_ALLOCATION_BPS,
  type AssetType,
  type AutoWrapBlockData,
  type BaseBlockData,
  type BlockData,
  type BlockType,
  type BorrowBlockData,
  type ComputedBlockValue,
  type InputBlockData,
  type LendBlockData,
  type LendProtocol,
  type SimulationResult,
  type StakeBlockData,
  type StakeProtocol,
  type Strategy,
  type StrategyEdge,
  type StrategyTemplate,
  type SwapBlockData,
  type YieldSource,
} from "./types";

const base: BaseBlockData = { label: "block", isConfigured: true, isValid: true };

const inputData: InputBlockData = { ...base, type: "input", asset: "ETH", amount: "1.5" };
const stakeData: StakeBlockData = {
  ...base,
  type: "stake",
  protocol: "etherfi",
  inputAsset: "ETH",
  outputAsset: "eETH",
};
const wrapData: AutoWrapBlockData = {
  ...base,
  type: "auto-wrap",
  fromAsset: "eETH",
  toAsset: "weETH",
  isWrap: true,
  isAutoInserted: true,
};
const lendData: LendBlockData = { ...base, type: "lend", protocol: "aave-v3", asset: "weETH" };
const borrowData: BorrowBlockData = {
  ...base,
  type: "borrow",
  protocol: "aave-v3",
  asset: "WETH",
  allocationBps: 5_000,
};
const swapData: SwapBlockData = {
  ...base,
  type: "swap",
  fromAsset: "WETH",
  toAsset: "USDC",
  slippageBps: 50,
};

const coreInput: CoreBlock = {
  id: "in",
  type: "input",
  params: { asset: inputData.asset, amount: inputData.amount },
};

const simulation: SimulationResult = {
  isValid: true,
  grossApyWad: entered(30_000_000_000_000_000n),
  netApyWad: entered(41_000_000_000_000_000n),
  initialAmountWei: entered(1_000_000_000_000_000_000n),
  gasCostBase: entered(1_234_567_890n),
  minHealthFactor: { status: "healthy", hfWad: 1_420_000_000_000_000_000n },
  finalHealthFactor: { status: "healthy", hfWad: 1_500_000_000_000_000_000n },
  liquidationRatioWad: entered(880_000_000_000_000_000n),
  leverageWad: entered(1_500_000_000_000_000_000n),
  yieldSources: [
    {
      protocol: "etherfi",
      type: "stake",
      apyWad: entered(29_000_000_000_000_000n),
      weightBps: FULL_ALLOCATION_BPS + borrowData.allocationBps,
    },
    {
      protocol: "aave-v3",
      type: "borrow",
      apyWad: entered(26_000_000_000_000_000n),
      weightBps: -borrowData.allocationBps,
    },
  ],
  blockValues: {},
};

describe("vocabulary agrees with core/graph.ts", () => {
  it("represents every asset core can execute", () => {
    const coreAssetsAreComposerAssets: CoreAsset extends AssetType ? true : false = true;
    expect(coreAssetsAreComposerAssets).toBe(true);
  });

  it("pins the documented divergence: USDC/DAI exist here but core cannot execute them", () => {
    // Flips the day the palette is trimmed to core's asset set — at which point
    // this expectation is updated deliberately, not silently.
    const composerIsWiderThanCore: AssetType extends CoreAsset ? true : false = false;
    expect(composerIsWiderThanCore).toBe(false);
  });

  it("matches core's stake and lend protocol sets exactly", () => {
    const stakeMatches: [CoreStakeProtocol] extends [StakeProtocol]
      ? [StakeProtocol] extends [CoreStakeProtocol]
        ? true
        : false
      : false = true;
    const lendMatches: [CoreLendProtocol] extends [LendProtocol]
      ? [LendProtocol] extends [CoreLendProtocol]
        ? true
        : false
      : false = true;
    expect([stakeMatches, lendMatches]).toEqual([true, true]);
  });
});

describe("cut block types (manifest L19-20)", () => {
  it("rejects lp and loop", () => {
    // @ts-expect-error "loop" was cut from BlockType per SPEC §2 v1 block list
    const loop: BlockType = "loop";
    // @ts-expect-error "lp" was cut from BlockType per SPEC §2 v1 block list
    const lp: BlockType = "lp";
    expect([loop, lp]).toEqual(["loop", "lp"]);
  });

  it("keeps auto-wrap as the Wrap block", () => {
    const wrap: BlockType = "auto-wrap";
    expect(wrap).toBe("auto-wrap");
  });
});

describe("asset scope (manifest L23)", () => {
  it("adds WETH so the leveraged-loop borrow is representable", () => {
    const weth: AssetType = "WETH";
    expect(weth).toBe("WETH");
  });

  it("rejects the four out-of-scope assets", () => {
    // @ts-expect-error USDT is out of v1 scope
    const usdt: AssetType = "USDT";
    // @ts-expect-error rETH is out of v1 scope
    const reth: AssetType = "rETH";
    // @ts-expect-error cbETH is out of v1 scope
    const cbeth: AssetType = "cbETH";
    // @ts-expect-error sfrxETH is out of v1 scope
    const sfrxeth: AssetType = "sfrxETH";
    expect([usdt, reth, cbeth, sfrxeth]).toEqual(["USDT", "rETH", "cbETH", "sfrxETH"]);
  });
});

describe("block data schema", () => {
  it("declares isAutoInserted, so no Record<string, unknown> cast is needed (store.ts:928)", () => {
    const declared: unknown extends BaseBlockData["isAutoInserted"] ? false : true = true;
    const flag: boolean | undefined = wrapData.isAutoInserted;
    expect([declared, flag]).toEqual([true, true]);
  });

  it("carries no icon glyph on block data (deviation D-9; base-block takes icon as a prop)", () => {
    const iconUndeclared: unknown extends BaseBlockData["icon"] ? true : false = true;
    expect(iconUndeclared).toBe(true);
  });

  it("holds the input amount as a decimal string (input-block.tsx L47)", () => {
    const amount: string = inputData.amount;
    // @ts-expect-error the input amount is the raw decimal string, never a float
    const numeric: InputBlockData = { ...base, type: "input", asset: "ETH", amount: 1.5 };
    expect([amount, numeric.amount]).toEqual(["1.5", 1.5]);
  });

  it("carries no cached rate on stake, lend or borrow blocks (deviation D-9)", () => {
    const stakeApyUndeclared: unknown extends StakeBlockData["apy"] ? true : false = true;
    const supplyApyUndeclared: unknown extends LendBlockData["supplyApy"] ? true : false = true;
    const borrowApyUndeclared: unknown extends BorrowBlockData["borrowApy"] ? true : false = true;
    expect([stakeApyUndeclared, supplyApyUndeclared, borrowApyUndeclared]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("carries no chain field on lend blocks (mainnet-only, manifest L61)", () => {
    // The React Flow index signature swallows excess properties, so absence is
    // asserted as "resolves to unknown", i.e. undeclared.
    const chainUndeclared: unknown extends LendBlockData["chain"] ? true : false = true;
    expect([chainUndeclared, lendData.protocol]).toEqual([true, "aave-v3"]);
  });

  it("carries no reserve risk params on lend blocks (manifest L64-65, deviation D-1)", () => {
    const maxLtvUndeclared: unknown extends LendBlockData["maxLtv"] ? true : false = true;
    const ltUndeclared: unknown extends LendBlockData["liquidationThreshold"] ? true : false = true;
    expect([maxLtvUndeclared, ltUndeclared]).toEqual([true, true]);
  });

  it("has a borrow amount config, no rate mode and no ltvPercent (manifest L68-73)", () => {
    const rateModeUndeclared: unknown extends BorrowBlockData["interestRateMode"] ? true : false =
      true;
    const legacyLtvUndeclared: unknown extends BorrowBlockData["ltvPercent"] ? true : false = true;
    expect([borrowData.allocationBps, rateModeUndeclared, legacyLtvUndeclared]).toEqual([
      5_000,
      true,
      true,
    ]);
  });

  it("states swap slippage in bps and stores no quote (deviation D-9)", () => {
    const slippageUndeclared: unknown extends SwapBlockData["slippage"] ? true : false = true;
    const quoteUndeclared: unknown extends SwapBlockData["estimatedOutput"] ? true : false = true;
    expect([swapData.slippageBps, slippageUndeclared, quoteUndeclared]).toEqual([50, true, true]);
  });
});

describe("AutoWrapBlockData is the reconciled canonical definition (manifest L89-95)", () => {
  it("assigns to BlockData with no cast (route-optimizer L428-430)", () => {
    const wrap: BlockData = wrapData;
    expect(wrap.type).toBe("auto-wrap");
  });

  it("keeps the direction flag the view actually reads (auto-wrap-block L71/L177)", () => {
    const declared: unknown extends AutoWrapBlockData["isWrap"] ? false : true = true;
    const direction: boolean = wrapData.isWrap;
    expect([declared, direction ? "Wrap" : "Unwrap"]).toEqual([true, "Wrap"]);
  });

  it("drops wrapStep, the wrapper address and the three dead props (auto-wrap L38-40)", () => {
    const noWrapStep: unknown extends AutoWrapBlockData["wrapStep"] ? true : false = true;
    const noWrapper: unknown extends AutoWrapBlockData["wrapperContract"] ? true : false = true;
    const noIcon: unknown extends AutoWrapBlockData["icon"] ? true : false = true;
    const noSlippage: unknown extends AutoWrapBlockData["slippage"] ? true : false = true;
    const noEstimated: unknown extends AutoWrapBlockData["estimatedOutput"] ? true : false = true;
    expect([noWrapStep, noWrapper, noIcon, noSlippage, noEstimated]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("keeps asset identity as a symbol, never an address (SPEC §5.6)", () => {
    const lendAsset: LendBlockData["asset"] = "weETH";
    expect([lendAsset, wrapData.fromAsset, wrapData.toAsset]).toEqual(["weETH", "eETH", "weETH"]);
  });
});

describe("schema crosses to core/graph.ts without conversion", () => {
  it("accepts the input amount as the decimal string the composer stores", () => {
    const graph: StrategyGraph = { blocks: [coreInput], edges: [] };
    expect(validateGraph(graph).ok).toBe(true);
  });

  it("uses the same integer bps units core validates", () => {
    const blocks: CoreBlock[] = [
      coreInput,
      { id: "stake", type: "stake", params: { protocol: stakeData.protocol } },
    ];
    const full = validateGraph({
      blocks,
      edges: [{ id: "e1", source: "in", target: "stake", allocationBps: FULL_ALLOCATION_BPS }],
    });
    const over = validateGraph({
      blocks,
      edges: [{ id: "e1", source: "in", target: "stake", allocationBps: FULL_ALLOCATION_BPS + 1 }],
    });
    expect([FULL_ALLOCATION_BPS, full.ok, over.ok]).toEqual([10_000, true, false]);
  });

  it("hands a composer edge's allocation to a core edge unconverted", () => {
    const composerEdge: StrategyEdge = {
      id: "e1",
      source: "in",
      target: "stake",
      data: { allocationBps: 6_000 },
    };
    const data = composerEdge.data;
    if (data === undefined) throw new Error("composer edge lost its data");
    const coreEdge: CoreEdge = {
      id: composerEdge.id,
      source: composerEdge.source,
      target: composerEdge.target,
      allocationBps: data.allocationBps,
    };
    expect(coreEdge.allocationBps).toBe(6_000);
  });

  it("declares the borrow protocol core requires as a param (graph.ts:97, deviation D-3)", () => {
    const coreProtocol: CoreLendProtocol = borrowData.protocol;
    const edges: CoreEdge[] = [
      { id: "e1", source: "in", target: "borrow", allocationBps: FULL_ALLOCATION_BPS },
    ];
    const withProtocol = validateGraph({
      blocks: [
        coreInput,
        {
          id: "borrow",
          type: "borrow",
          params: {
            protocol: coreProtocol,
            asset: borrowData.asset,
            allocationBps: borrowData.allocationBps,
          },
        },
      ],
      edges,
    });
    const withoutProtocol = validateGraph({
      blocks: [
        coreInput,
        {
          id: "borrow",
          type: "borrow",
          params: { asset: borrowData.asset, allocationBps: borrowData.allocationBps },
        },
      ],
      edges,
    });
    expect(withProtocol.ok).toBe(true);
    expect(withoutProtocol.ok).toBe(false);
    expect(
      withoutProtocol.errors.some((e) => e.includes("borrow protocol must be aave-v3")),
    ).toBe(true);
  });
});

describe("persistence (manifest L128-129)", () => {
  it("round-trips a Strategy through JSON unchanged — a Date would not", () => {
    const strategy: Strategy = {
      id: "s1",
      name: "Leveraged Restake Loop",
      blocks: [],
      edges: [],
      createdAt: 1_753_000_000_000,
      updatedAt: 1_753_000_000_500,
    };
    const rehydrated: Strategy = JSON.parse(JSON.stringify(strategy)) as Strategy;
    expect(rehydrated).toEqual(strategy);
    expect(typeof rehydrated.createdAt).toBe("number");
    expect(rehydrated.updatedAt - rehydrated.createdAt).toBe(500);
  });
});

describe("simulation results (manifest L156-168)", () => {
  it("drops the five unsourceable fields", () => {
    const noProjectedValue: "projectedValue1Y" extends keyof SimulationResult ? false : true = true;
    const noProjectedYield: "projectedYield1Y" extends keyof SimulationResult ? false : true = true;
    const noProtocolFees: "protocolFees" extends keyof SimulationResult ? false : true = true;
    const noRiskScore: "riskScore" extends keyof SimulationResult ? false : true = true;
    const noMaxDrawdown: "maxDrawdown" extends keyof SimulationResult ? false : true = true;
    expect([
      noProjectedValue,
      noProjectedYield,
      noProtocolFees,
      noRiskScore,
      noMaxDrawdown,
    ]).toEqual([true, true, true, true, true]);
  });

  it("renames all six mandated keeps to core's representation (deviation D-6)", () => {
    const noGrossApy: "grossApy" extends keyof SimulationResult ? false : true = true;
    const noNetApy: "netApy" extends keyof SimulationResult ? false : true = true;
    const noGasCostUsd: "gasCostUsd" extends keyof SimulationResult ? false : true = true;
    const noHealthFactor: "healthFactor" extends keyof SimulationResult ? false : true = true;
    const noLiquidationPrice: "liquidationPrice" extends keyof SimulationResult ? false : true =
      true;
    const noLeverage: "leverage" extends keyof SimulationResult ? false : true = true;
    const renamed: Array<keyof SimulationResult> = [
      "grossApyWad",
      "netApyWad",
      "gasCostBase",
      "minHealthFactor",
      "finalHealthFactor",
      "liquidationRatioWad",
      "leverageWad",
    ];
    expect([
      noGrossApy,
      noNetApy,
      noGasCostUsd,
      noHealthFactor,
      noLiquidationPrice,
      noLeverage,
    ]).toEqual([true, true, true, true, true, true]);
    expect(renamed.every((k) => k in simulation)).toBe(true);
  });

  it("drops riskLevel and initialValue (deviation D-7)", () => {
    const noRiskLevel: "riskLevel" extends keyof SimulationResult ? false : true = true;
    const noInitialValue: "initialValue" extends keyof SimulationResult ? false : true = true;
    const noStoredRisk: "risk" extends keyof SimulationResult ? false : true = true;
    const equityWei: bigint | null =
      simulation.initialAmountWei === null ? null : simulation.initialAmountWei.value;
    expect([noRiskLevel, noInitialValue, noStoredRisk, equityWei]).toEqual([
      true,
      true,
      true,
      1_000_000_000_000_000_000n,
    ]);
  });

  it("derives risk from the health factor instead of storing a second scale", () => {
    const min: RiskState = riskState(simulation.minHealthFactor);
    const final: RiskState = riskState(simulation.finalHealthFactor);
    const unresolved: HealthFactor = { status: "unknown", reason: "no snapshot" };
    // A `number | null` healthFactor collapses this third state into a number.
    expect([min, final, riskState(unresolved)]).toEqual(["warning", "ok", "unknown"]);
  });

  it("keeps per-block values in core's units too (deviation D-10)", () => {
    const blockValue: ComputedBlockValue = {
      inputAsset: "eETH",
      inputAmountWei: entered(1_000_000_000_000_000_000n),
      inputValueBase: entered(300_000_000_000n),
      outputAsset: "weETH",
      outputAmountWei: entered(940_000_000_000_000_000n),
      outputValueBase: entered(300_000_000_000n),
      gasCostBase: entered(120_000_000n),
      apyWad: null,
    };
    const noUsd: "inputValueUsd" extends keyof ComputedBlockValue ? false : true = true;
    expect([noUsd, blockValue.apyWad]).toEqual([true, null]);
  });
});

describe("yield sources (manifest L140, deviation D-5)", () => {
  it("drops the lp member", () => {
    // @ts-expect-error "lp" was dropped from YieldSource.type
    const lp: YieldSource["type"] = "lp";
    expect(lp).toBe("lp");
  });

  it("states rate and weight in core units, with the §5.2 weight invariant", () => {
    const noApy: "apy" extends keyof YieldSource ? false : true = true;
    const noWeight: "weight" extends keyof YieldSource ? false : true = true;
    const weights = simulation.yieldSources.map((s) => s.weightBps);
    const sum = weights.reduce((a, b) => a + b, 0);
    expect([noApy, noWeight, weights, sum]).toEqual([
      true,
      true,
      [15_000, -5_000],
      FULL_ALLOCATION_BPS,
    ]);
  });
});

describe("templates (manifest L236)", () => {
  it("drops the hand-written APY claim but keeps the editorial risk label", () => {
    const noEstimatedApy: "estimatedApy" extends keyof StrategyTemplate ? false : true = true;
    const template: StrategyTemplate = {
      id: "t1",
      name: "Leveraged Restake",
      description: "stake · wrap · supply · borrow",
      riskLevel: "high",
      blocks: [],
      edges: [],
      tags: ["etherfi", "aave-v3"],
    };
    expect([noEstimatedApy, template.riskLevel]).toEqual([true, "high"]);
  });
});
