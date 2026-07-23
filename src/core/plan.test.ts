import { describe, expect, it } from "vitest";
import { decodeFunctionData, toFunctionSelector, type Address } from "viem";
import type { Block, StrategyGraph } from "./graph";
import { observedBlocks, provenanceTrail } from "./provenance";
import {
  buildPlan,
  encodeStep,
  type AmountAttribution,
  type ChainSnapshot,
  type PlanError,
  type PlanResult,
  type TransactionStep,
} from "./plan";
import {
  PINNED_BLOCK,
  PINNED_TS,
  addressOf,
  anchorAddr,
  addrRead,
  bigRead,
  readResult,
  readsMeta,
  tupleBig,
  tupleBool,
  tupleRead,
} from "../../tests/helpers/protocol-reads";
import { observationMinter } from "./provenance";

// ————————————————————————— fixture graphs —————————————————————————

function linearEdges(chain: readonly string[]): StrategyGraph["edges"] {
  return chain.slice(0, -1).map((source, i) => ({
    id: `e${i}`,
    source,
    target: chain[i + 1]!,
    allocationBps: 10_000,
  }));
}

/** SPEC §2 Leveraged Restake Loop — the canonical 13-step fixture graph. */
function flagshipGraph(amount: string | number = "10", allocationBps = 7000): StrategyGraph {
  const blocks: Block[] = [
    { id: "in", type: "input", params: { asset: "ETH", amount } },
    { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
    { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
    { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    { id: "borrow", type: "borrow", params: { protocol: "aave-v3", asset: "WETH", allocationBps } },
    { id: "unwrap", type: "unwrap", params: { from: "WETH", to: "ETH" } },
    { id: "stake2", type: "stake", params: { protocol: "etherfi" } },
    { id: "wrap2", type: "wrap", params: { from: "eETH", to: "weETH" } },
    { id: "supply2", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
  ];
  const chain = ["in", "stake1", "wrap1", "supply1", "borrow", "unwrap", "stake2", "wrap2", "supply2"];
  return { blocks, edges: linearEdges(chain) };
}

function chainOf(blocks: Block[]): StrategyGraph {
  return { blocks, edges: linearEdges(blocks.map((b) => b.id)) };
}

// ————————————————————————— fixture snapshot —————————————————————————

const USER = "0x1111111111111111111111111111111111111111" as Address;

interface RawReserve {
  underlying: Address;
  aToken: Address;
  variableDebtToken: Address;
  reserveIndex: number;
  decimals: number;
  active: boolean;
  frozen: boolean;
  paused: boolean;
  borrowingEnabled: boolean;
  usageAsCollateralAllowed: boolean;
  supplyCap: bigint;
  borrowCap: bigint;
  aTokenScaledTotalSupply: bigint;
  variableDebtScaledTotalSupply: bigint;
  accruedToTreasury: bigint;
  liquidityRateRay: bigint;
  variableBorrowRateRay: bigint;
  liquidityIndexRay: bigint;
  variableBorrowIndexRay: bigint;
  lastUpdateTimestamp: bigint;
  virtualUnderlyingBalance: bigint;
  priceBase: bigint;
}

interface RawEMode {
  id: number;
  label: string;
  ltvBps: number;
  liquidationThresholdBps: number;
  collateralBitmap: bigint;
  borrowableBitmap: bigint;
  isIsolated: boolean;
  ltvZeroBitmap: bigint;
}

interface RawFixture {
  pool: Address;
  weETH: RawReserve;
  WETH: RawReserve;
  eModes: RawEMode[];
  etherfi: {
    liquidityPool: Address;
    eETH: Address;
    weETH: Address;
    totalPooledEther: bigint;
    totalShares: bigint;
  };
  user: { address: Address; eModeCategoryId: number; hasAaveFootprint: boolean };
}

function rawReserve(sym: "WETH" | "weETH"): RawReserve {
  const cfg = `${sym}.getReserveConfigurationData`;
  const toks = tupleRead(`${sym}.getReserveTokensAddresses`);
  const rd = `${sym}.getReserveData`;
  const underlying = anchorAddr(sym);
  const list = tupleRead("Pool.getReservesList");
  const reserveIndex = list.findIndex(
    (a) => typeof a === "string" && a.toLowerCase() === underlying.toLowerCase(),
  );
  if (reserveIndex < 0) throw new Error(`${sym} not in reserves list`);
  return {
    underlying,
    aToken: addressOf(toks[0], `${sym} aToken`),
    variableDebtToken: addressOf(toks[2], `${sym} variableDebtToken`),
    reserveIndex,
    decimals: Number(tupleBig(cfg, 0)),
    usageAsCollateralAllowed: tupleBool(cfg, 5),
    borrowingEnabled: tupleBool(cfg, 6),
    active: tupleBool(cfg, 8),
    frozen: tupleBool(cfg, 9),
    paused: readResult(`${sym}.getPaused`) === true,
    borrowCap: tupleBig(`${sym}.getReserveCaps`, 0),
    supplyCap: tupleBig(`${sym}.getReserveCaps`, 1),
    aTokenScaledTotalSupply: bigRead(`${sym}.aToken.scaledTotalSupply`),
    variableDebtScaledTotalSupply: bigRead(`${sym}.variableDebtToken.scaledTotalSupply`),
    accruedToTreasury: tupleBig(rd, 1),
    liquidityRateRay: tupleBig(rd, 5),
    variableBorrowRateRay: tupleBig(rd, 6),
    liquidityIndexRay: tupleBig(rd, 9),
    variableBorrowIndexRay: tupleBig(rd, 10),
    lastUpdateTimestamp: tupleBig(rd, 11),
    virtualUnderlyingBalance: bigRead(`${sym}.getVirtualUnderlyingBalance`),
    priceBase: bigRead(`Oracle.getAssetPrice(${sym})`),
  };
}

function rawFixture(): RawFixture {
  const cc = readResult("eMode1.collateralConfig");
  if (
    typeof cc !== "object" ||
    cc === null ||
    typeof (cc as Record<string, unknown>).ltv !== "number" ||
    typeof (cc as Record<string, unknown>).liquidationThreshold !== "number"
  ) {
    throw new Error("eMode1.collateralConfig has an unexpected shape");
  }
  const collateralConfig = cc as { ltv: number; liquidationThreshold: number };
  const label = readResult("eMode1.label");
  if (typeof label !== "string") throw new Error("eMode1.label is not a string");
  return {
    pool: addressOf(readsMeta.pool, "pool"),
    weETH: rawReserve("weETH"),
    WETH: rawReserve("WETH"),
    eModes: [
      {
        id: 1,
        label,
        ltvBps: collateralConfig.ltv,
        liquidationThresholdBps: collateralConfig.liquidationThreshold,
        collateralBitmap: bigRead("eMode1.collateralBitmap"),
        borrowableBitmap: bigRead("eMode1.borrowableBitmap"),
        isIsolated: readResult("eMode1.isIsolated (v3.7)") === true,
        ltvZeroBitmap: bigRead("eMode1.ltvZeroBitmap (v3.7)"),
      },
    ],
    etherfi: {
      liquidityPool: addrRead("weETH.liquidityPool (round-trip)"),
      eETH: addrRead("LP.eETH (round-trip)"),
      weETH: anchorAddr("weETH"),
      totalPooledEther: bigRead("LP.getTotalPooledEther"),
      totalShares: bigRead("eETH.totalShares"),
    },
    user: { address: USER, eModeCategoryId: 0, hasAaveFootprint: false },
  };
}

function snapshotFrom(raw: RawFixture): ChainSnapshot {
  const mint = observationMinter(PINNED_BLOCK, Number(PINNED_TS));
  const reserve = (sym: "WETH" | "weETH", r: RawReserve) => ({
    underlying: r.underlying,
    aToken: r.aToken,
    variableDebtToken: r.variableDebtToken,
    reserveIndex: mint.observe(r.reserveIndex, `Pool.getReservesList.indexOf(${sym})`),
    decimals: mint.observe(r.decimals, `${sym}.getReserveConfigurationData.decimals`),
    active: mint.observe(r.active, `${sym}.getReserveConfigurationData.isActive`),
    frozen: mint.observe(r.frozen, `${sym}.getReserveConfigurationData.isFrozen`),
    paused: mint.observe(r.paused, `${sym}.getPaused`),
    borrowingEnabled: mint.observe(r.borrowingEnabled, `${sym}.getReserveConfigurationData.borrowingEnabled`),
    usageAsCollateralAllowed: mint.observe(
      r.usageAsCollateralAllowed,
      `${sym}.getReserveConfigurationData.usageAsCollateralEnabled`,
    ),
    supplyCap: mint.observe(r.supplyCap, `${sym}.getReserveCaps.supplyCap`),
    borrowCap: mint.observe(r.borrowCap, `${sym}.getReserveCaps.borrowCap`),
    aTokenScaledTotalSupply: mint.observe(r.aTokenScaledTotalSupply, `${sym}.aToken.scaledTotalSupply`),
    variableDebtScaledTotalSupply: mint.observe(
      r.variableDebtScaledTotalSupply,
      `${sym}.variableDebtToken.scaledTotalSupply`,
    ),
    accruedToTreasury: mint.observe(r.accruedToTreasury, `${sym}.getReserveData.accruedToTreasury`),
    liquidityRateRay: mint.observe(r.liquidityRateRay, `${sym}.getReserveData.liquidityRate`),
    variableBorrowRateRay: mint.observe(r.variableBorrowRateRay, `${sym}.getReserveData.variableBorrowRate`),
    liquidityIndexRay: mint.observe(r.liquidityIndexRay, `${sym}.getReserveData.liquidityIndex`),
    variableBorrowIndexRay: mint.observe(r.variableBorrowIndexRay, `${sym}.getReserveData.variableBorrowIndex`),
    lastUpdateTimestamp: mint.observe(r.lastUpdateTimestamp, `${sym}.getReserveData.lastUpdateTimestamp`),
    virtualUnderlyingBalance: mint.observe(r.virtualUnderlyingBalance, `${sym}.getVirtualUnderlyingBalance`),
    priceBase: mint.observe(r.priceBase, `Oracle.getAssetPrice(${sym})`),
  });
  return {
    block: PINNED_BLOCK,
    blockTimestamp: PINNED_TS,
    pool: raw.pool,
    reserves: { weETH: reserve("weETH", raw.weETH), WETH: reserve("WETH", raw.WETH) },
    eModeCategories: raw.eModes.map((m) => ({
      id: m.id,
      label: mint.observe(m.label, `eMode${m.id}.label`),
      ltvBps: mint.observe(m.ltvBps, `eMode${m.id}.collateralConfig.ltv`),
      liquidationThresholdBps: mint.observe(
        m.liquidationThresholdBps,
        `eMode${m.id}.collateralConfig.liquidationThreshold`,
      ),
      collateralBitmap: mint.observe(m.collateralBitmap, `eMode${m.id}.collateralBitmap`),
      borrowableBitmap: mint.observe(m.borrowableBitmap, `eMode${m.id}.borrowableBitmap`),
      isIsolated: mint.observe(m.isIsolated, `eMode${m.id}.isIsolated`),
      ltvZeroBitmap: mint.observe(m.ltvZeroBitmap, `eMode${m.id}.ltvZeroBitmap`),
    })),
    etherfi: {
      liquidityPool: raw.etherfi.liquidityPool,
      eETH: raw.etherfi.eETH,
      weETH: raw.etherfi.weETH,
      totalPooledEther: mint.observe(raw.etherfi.totalPooledEther, "LP.getTotalPooledEther"),
      totalShares: mint.observe(raw.etherfi.totalShares, "eETH.totalShares"),
    },
    user: {
      address: raw.user.address,
      eModeCategoryId: mint.observe(raw.user.eModeCategoryId, "Pool.getUserEMode(user)"),
      hasAaveFootprint: mint.observe(raw.user.hasAaveFootprint, "user aave footprint predicate"),
    },
  };
}

function fixtureSnapshot(mutate?: (raw: RawFixture) => void): ChainSnapshot {
  const raw = rawFixture();
  mutate?.(raw);
  return snapshotFrom(raw);
}

// ————————————————————————— pinned expectations —————————————————————————

// Derivation chain for E = 10 ETH, b = 7000 bps, computed independently from the
// committed reads log (floor at every division; matrix §7 share model):
//   s1  = floor(E·S0/P0)                            = 9092267716600505494
//   b1  = floor(s1·(P0+E)/(S0+s1))                  = 9999999999999999999
//   w1  = floor(b1·(S0+s1)/(P0+E))                  = 9092267716600505493
//   collateralBase = floor(w1·priceWeETH/1e18)      = 1923866861999
//   borrowBase     = floor(collateralBase·7000/1e4) = 1346706803399
//   borrowWei      = floor(borrowBase·1e18/priceWETH) = 6999999999994802135
const EXPECTED_BORROW_WEI = 6999999999994802135n;

// Real weETH supply-cap boundary for the flagship at b=7000 (v3.7 formula over
// the recorded scaled values; crossing block is supply2 — the cumulative check):
const CAP_BOUNDARY_E_PASS = "27860.88917679683996625";
const CAP_BOUNDARY_E_FAIL = "27860.889176796839966251";

// WETH borrow-cap boundary for the flagship borrow (existing scaled debt plus
// rayDivCeil(borrowWei) at the accrued index, rayMulCeil display, ceil tokens):
const BORROW_CAP_MIN_PASSING = 1686984n;

const WAD_WEI = 10n ** 18n;

// ————————————————————————— helpers —————————————————————————

function expectOk(result: PlanResult): asserts result is Extract<PlanResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`plan unexpectedly failed: ${JSON.stringify(result.errors, bigintJson, 2)}`);
  }
}

function expectFail(result: PlanResult): asserts result is Extract<PlanResult, { ok: false }> {
  if (result.ok) throw new Error("plan unexpectedly succeeded");
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function constraintErrors(errors: readonly PlanError[]) {
  return errors.filter(
    (e): e is Extract<PlanError, { kind: "constraint" }> => e.kind === "constraint",
  );
}

function stepById(steps: readonly TransactionStep[], id: string): TransactionStep {
  const hit = steps.find((s) => s.id === id);
  if (!hit) throw new Error(`step ${id} not found`);
  return hit;
}

function selectorOfStep(step: TransactionStep): string {
  const item = step.abi.find((e) => e.type === "function" && e.name === step.functionName);
  if (!item || item.type !== "function") throw new Error(`abi item missing for ${step.id}`);
  return toFunctionSelector(item);
}

// ————————————————————————— tests —————————————————————————

describe("buildPlan — flagship 13-step canonical fixture (SPEC §2)", () => {
  const snapshot = fixtureSnapshot();
  const addresses = {
    LP: addrRead("weETH.liquidityPool (round-trip)"),
    eETH: addrRead("LP.eETH (round-trip)"),
    weETH: anchorAddr("weETH"),
    WETH: anchorAddr("WETH"),
    pool: addressOf(readsMeta.pool, "pool"),
  };

  interface Row {
    index: number;
    id: string;
    blockId: string;
    to: Address;
    functionName: string;
    signature: string;
    valueSpec: "none" | "amount";
    amount:
      | { kind: "literal"; wei: bigint }
      | { kind: "none" }
      | { kind: "derived" }
      | { kind: "step-output"; producer: string; attribution: AmountAttribution };
  }

  const rows: Row[] = [
    { index: 1, id: "stake1:deposit", blockId: "stake1", to: addresses.LP, functionName: "deposit", signature: "function deposit()", valueSpec: "amount", amount: { kind: "literal", wei: 10n * WAD_WEI } },
    { index: 2, id: "wrap1:approve", blockId: "wrap1", to: addresses.eETH, functionName: "approve", signature: "function approve(address,uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "stake1:deposit", attribution: "share-delta" } },
    { index: 3, id: "wrap1:wrap", blockId: "wrap1", to: addresses.weETH, functionName: "wrap", signature: "function wrap(uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "stake1:deposit", attribution: "share-delta" } },
    { index: 4, id: "supply1:set-emode", blockId: "supply1", to: addresses.pool, functionName: "setUserEMode", signature: "function setUserEMode(uint8)", valueSpec: "none", amount: { kind: "none" } },
    { index: 5, id: "supply1:approve", blockId: "supply1", to: addresses.weETH, functionName: "approve", signature: "function approve(address,uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "wrap1:wrap", attribution: "transfer-event" } },
    { index: 6, id: "supply1:supply", blockId: "supply1", to: addresses.pool, functionName: "supply", signature: "function supply(address,uint256,address,uint16)", valueSpec: "none", amount: { kind: "step-output", producer: "wrap1:wrap", attribution: "transfer-event" } },
    { index: 7, id: "borrow:borrow", blockId: "borrow", to: addresses.pool, functionName: "borrow", signature: "function borrow(address,uint256,uint256,uint16,address)", valueSpec: "none", amount: { kind: "derived" } },
    { index: 8, id: "unwrap:withdraw", blockId: "unwrap", to: addresses.WETH, functionName: "withdraw", signature: "function withdraw(uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "borrow:borrow", attribution: "transfer-event" } },
    { index: 9, id: "stake2:deposit", blockId: "stake2", to: addresses.LP, functionName: "deposit", signature: "function deposit()", valueSpec: "amount", amount: { kind: "step-output", producer: "unwrap:withdraw", attribution: "withdraw-argument" } },
    { index: 10, id: "wrap2:approve", blockId: "wrap2", to: addresses.eETH, functionName: "approve", signature: "function approve(address,uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "stake2:deposit", attribution: "share-delta" } },
    { index: 11, id: "wrap2:wrap", blockId: "wrap2", to: addresses.weETH, functionName: "wrap", signature: "function wrap(uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "stake2:deposit", attribution: "share-delta" } },
    { index: 12, id: "supply2:approve", blockId: "supply2", to: addresses.weETH, functionName: "approve", signature: "function approve(address,uint256)", valueSpec: "none", amount: { kind: "step-output", producer: "wrap2:wrap", attribution: "transfer-event" } },
    { index: 13, id: "supply2:supply", blockId: "supply2", to: addresses.pool, functionName: "supply", signature: "function supply(address,uint256,address,uint16)", valueSpec: "none", amount: { kind: "step-output", producer: "wrap2:wrap", attribution: "transfer-event" } },
  ];

  it("emits exactly the 13 enumerated steps in canonical order", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.steps).toHaveLength(13);
    expect(result.targetEModeCategoryId).toBe(1);
    for (const row of rows) {
      const step = result.steps[row.index - 1]!;
      expect(step.index, row.id).toBe(row.index);
      expect(step.id, row.id).toBe(row.id);
      expect(step.blockId, row.id).toBe(row.blockId);
      expect(step.to, row.id).toBe(row.to);
      expect(step.functionName, row.id).toBe(row.functionName);
      expect(step.valueSpec, row.id).toBe(row.valueSpec);
      expect(selectorOfStep(step), row.id).toBe(toFunctionSelector(row.signature));
      const amount = step.amount;
      if (row.amount.kind === "literal") {
        if (amount.kind !== "literal") throw new Error(`${row.id}: expected literal amount`);
        expect(amount.amount.kind).toBe("entered");
        expect(amount.amount.value).toBe(row.amount.wei);
      } else if (row.amount.kind === "step-output") {
        if (amount.kind !== "step-output") throw new Error(`${row.id}: expected step-output`);
        expect(amount.producerStepId, row.id).toBe(row.amount.producer);
        expect(amount.attribution, row.id).toBe(row.amount.attribution);
        expect(amount.allocationBps, row.id).toBe(10_000);
      } else {
        expect(amount.kind, row.id).toBe(row.amount.kind);
      }
    }
  });

  it("derives the borrow amount with floor-at-every-division bigint math", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    const borrow = stepById(result.steps, "borrow:borrow");
    if (borrow.amount.kind !== "derived") throw new Error("borrow amount must be derived");
    expect(borrow.amount.amount.value).toBe(EXPECTED_BORROW_WEI);
    expect(borrow.amount.amount.expression).toMatch(/floor/);
    // Every observed leaf in the derivation sits at the pinned block.
    expect([...observedBlocks(borrow.amount.amount)]).toEqual([PINNED_BLOCK]);
    const trail = provenanceTrail(borrow.amount.amount).join("\n");
    expect(trail).toContain("Oracle.getAssetPrice(weETH)");
    expect(trail).toContain("Oracle.getAssetPrice(WETH)");
    expect(trail).toContain("entered by user");
  });

  it("orders every approval after its producer and binds it to the attributed output", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    for (const step of result.steps) {
      if (step.amount.kind !== "step-output") continue;
      const producer = stepById(result.steps, step.amount.producerStepId);
      expect(producer.index, step.id).toBeLessThan(step.index);
    }
  });

  it("encodes calldata whose selector and args round-trip through the ABI", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);

    const deposit = encodeStep(stepById(result.steps, "stake1:deposit"));
    expect(deposit.to).toBe(addresses.LP);
    expect(deposit.value).toBe(10n * WAD_WEI);
    expect(deposit.data).toBe(toFunctionSelector("function deposit()"));

    const approve = stepById(result.steps, "wrap1:approve");
    const approveEncoded = encodeStep(approve, 12_345n);
    const approveDecoded = decodeFunctionData({ abi: approve.abi, data: approveEncoded.data });
    expect(approveDecoded.functionName).toBe("approve");
    expect(approveDecoded.args).toEqual([addresses.weETH, 12_345n]);

    const supply = stepById(result.steps, "supply1:supply");
    const supplyEncoded = encodeStep(supply, 777n);
    const supplyDecoded = decodeFunctionData({ abi: supply.abi, data: supplyEncoded.data });
    expect(supplyDecoded.args).toEqual([addresses.weETH, 777n, USER, 0]);

    const borrow = stepById(result.steps, "borrow:borrow");
    const borrowEncoded = encodeStep(borrow);
    const borrowDecoded = decodeFunctionData({ abi: borrow.abi, data: borrowEncoded.data });
    expect(borrowDecoded.args).toEqual([addresses.WETH, EXPECTED_BORROW_WEI, 2n, 0, USER]);

    const emode = stepById(result.steps, "supply1:set-emode");
    const emodeDecoded = decodeFunctionData({ abi: emode.abi, data: encodeStep(emode).data });
    expect(emodeDecoded.args).toEqual([1]);

    const withdraw = stepById(result.steps, "unwrap:withdraw");
    const withdrawDecoded = decodeFunctionData({
      abi: withdraw.abi,
      data: encodeStep(withdraw, EXPECTED_BORROW_WEI).data,
    });
    expect(withdrawDecoded.args).toEqual([EXPECTED_BORROW_WEI]);
  });

  it("encodeStep demands a resolved amount exactly when the step's amount is attributed later", () => {
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(() => encodeStep(stepById(result.steps, "wrap1:approve"))).toThrow(/resolved/);
    expect(() => encodeStep(stepById(result.steps, "borrow:borrow"), 1n)).toThrow(/fixed/);
    expect(() => encodeStep(stepById(result.steps, "supply1:set-emode"), 1n)).toThrow(/fixed/);
  });

  it("never emits an address that is not in the snapshot — attacker params are inert", () => {
    const attacker = "0x6666666666666666666666666666666666666666";
    const g = flagshipGraph();
    // Keys chosen not to collide with real params (wrap/unwrap use `to`/`from`
    // semantically and graph.ts already rejects tampering with those).
    const poisoned: StrategyGraph = {
      blocks: g.blocks.map((b) => ({
        ...b,
        params: { ...b.params, spender: attacker, recipient: attacker, onBehalfOf: attacker },
      })),
      edges: g.edges,
    };
    const result = buildPlan(poisoned, snapshot);
    expectOk(result);
    const legal = new Set<string>([
      addresses.LP,
      addresses.eETH,
      addresses.weETH,
      addresses.WETH,
      addresses.pool,
    ]);
    for (const step of result.steps) {
      expect(legal.has(step.to), step.id).toBe(true);
      for (const arg of step.args) {
        if (arg.kind === "value" && typeof arg.value === "string") {
          expect(arg.value.toLowerCase()).not.toBe(attacker.toLowerCase());
        }
      }
    }
  });
});

describe("e-mode policy (SPEC §5.4, matrix §3)", () => {
  it("skips setUserEMode when the wallet is already in the target category", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.user.eModeCategoryId = 1;
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.targetEModeCategoryId).toBe(1);
    expect(result.steps).toHaveLength(12);
    expect(result.steps.some((s) => s.functionName === "setUserEMode")).toBe(false);
    expect(result.steps.map((s) => s.index)).toEqual(result.steps.map((_, i) => i + 1));
  });

  it("rejects a wallet parked in a category the snapshot does not describe", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.user.eModeCategoryId = 5;
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectFail(result);
    const hits = constraintErrors(result.errors).filter((e) => e.constraint === "emode-unknown-category");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.blockId).toBe("borrow");
  });

  it("builds without e-mode when no category admits the pair (borrowable bitmap)", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.eModes[0]!.borrowableBitmap = 0n;
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.targetEModeCategoryId).toBeNull();
    expect(result.steps).toHaveLength(12);
    expect(result.steps.some((s) => s.functionName === "setUserEMode")).toBe(false);
  });

  it("builds without e-mode when the collateral is not a category member", () => {
    const snapshot = fixtureSnapshot((raw) => {
      const idx = BigInt(raw.weETH.reserveIndex);
      raw.eModes[0]!.collateralBitmap &= ~(1n << idx);
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.targetEModeCategoryId).toBeNull();
  });

  it("refuses a category whose LTV-zero bitmap covers the plan collateral", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.eModes[0]!.ltvZeroBitmap = 1n << BigInt(raw.weETH.reserveIndex);
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.targetEModeCategoryId).toBeNull();
  });

  it("an isolated category still admits a fresh wallet whose collateral is all in-category", () => {
    const snapshot = fixtureSnapshot((raw) => {
      raw.eModes[0]!.isIsolated = true;
    });
    const result = buildPlan(flagshipGraph(), snapshot);
    expectOk(result);
    expect(result.targetEModeCategoryId).toBe(1);
    expect(result.steps.some((s) => s.functionName === "setUserEMode")).toBe(true);
  });

  it("a borrow-free plan never touches e-mode", () => {
    const g = chainOf([
      { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
      { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
      { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
      { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
    ]);
    const result = buildPlan(g, fixtureSnapshot());
    expectOk(result);
    expect(result.targetEModeCategoryId).toBeNull();
    expect(result.steps.map((s) => s.functionName)).toEqual(["deposit", "approve", "wrap", "approve", "supply"]);
  });
});

describe("phase support — EtherFi flagship only (W03)", () => {
  const snapshot = () => fixtureSnapshot();

  function expectUnsupported(g: StrategyGraph, blockId: string) {
    const result = buildPlan(g, snapshot());
    expectFail(result);
    const hits = result.errors.filter(
      (e): e is Extract<PlanError, { kind: "unsupported-in-phase" }> =>
        e.kind === "unsupported-in-phase" && e.blockId === blockId,
    );
    expect(hits.length, `unsupported-in-phase for ${blockId}`).toBeGreaterThan(0);
  }

  it("lido staking is schema-valid but unsupported in P1", () => {
    expectUnsupported(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "lido" } },
      ]),
      "stake1",
    );
  });

  it("stETH wrapping is unsupported in P1", () => {
    expectUnsupported(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
        { id: "wrap1", type: "wrap", params: { from: "stETH", to: "wstETH" } },
      ]),
      "wrap1",
    );
  });

  it("weETH→eETH unwrapping is unsupported in P1", () => {
    expectUnsupported(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
        { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
        { id: "unwrap1", type: "unwrap", params: { from: "weETH", to: "eETH" } },
      ]),
      "unwrap1",
    );
  });

  it("ETH→WETH wrapping is unsupported in P1", () => {
    expectUnsupported(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "wrap1", type: "wrap", params: { from: "ETH", to: "WETH" } },
      ]),
      "wrap1",
    );
  });

  it("lending anything but weETH is unsupported in P1", () => {
    expectUnsupported(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "wrap1", type: "wrap", params: { from: "ETH", to: "WETH" } },
        { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "WETH" } },
      ]),
      "supply1",
    );
  });
});

describe("asset flow (graph.ts boundary note: computed and validated in plan.ts)", () => {
  function expectFlowError(g: StrategyGraph, blockId: string) {
    const result = buildPlan(g, fixtureSnapshot());
    expectFail(result);
    const hits = result.errors.filter(
      (e): e is Extract<PlanError, { kind: "asset-flow" }> =>
        e.kind === "asset-flow" && e.blockId === blockId,
    );
    expect(hits.length, `asset-flow for ${blockId}`).toBeGreaterThan(0);
  }

  it("a stake fed anything but ETH is a flow error", () => {
    expectFlowError(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
        { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
        { id: "stake2", type: "stake", params: { protocol: "etherfi" } },
      ]),
      "stake2",
    );
  });

  it("a borrow without an aave lend producer is a flow error", () => {
    expectFlowError(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
        { id: "wrap1", type: "wrap", params: { from: "eETH", to: "weETH" } },
        { id: "borrow", type: "borrow", params: { protocol: "aave-v3", asset: "WETH", allocationBps: 5000 } },
      ]),
      "borrow",
    );
  });

  it("a lend fed the wrong asset is a flow error", () => {
    expectFlowError(
      chainOf([
        { id: "in", type: "input", params: { asset: "ETH", amount: "1" } },
        { id: "stake1", type: "stake", params: { protocol: "etherfi" } },
        { id: "supply1", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
      ]),
      "supply1",
    );
  });
});

describe("graph gate — structural validation runs before any plan is built (§5.6)", () => {
  it("a cyclic graph is rejected as graph-invalid", () => {
    const g = flagshipGraph();
    const cyclic: StrategyGraph = {
      blocks: g.blocks,
      edges: [...g.edges, { id: "back", source: "supply2", target: "in", allocationBps: 10_000 }],
    };
    const result = buildPlan(cyclic, fixtureSnapshot());
    expectFail(result);
    expect(result.errors[0]!.kind).toBe("graph-invalid");
  });

  it("duplicate block ids are rejected as graph-invalid", () => {
    const g = flagshipGraph();
    const dup: StrategyGraph = { blocks: [...g.blocks, g.blocks[1]!], edges: g.edges };
    const result = buildPlan(dup, fixtureSnapshot());
    expectFail(result);
    expect(result.errors[0]!.kind).toBe("graph-invalid");
  });
});

describe("validation matrix (SPEC §5.7 — the recorded v3.7 constraint set)", () => {
  function expectConstraint(
    result: PlanResult,
    constraint: string,
    blockId: string,
  ) {
    expectFail(result);
    const hits = constraintErrors(result.errors).filter(
      (e) => e.constraint === constraint && e.blockId === blockId,
    );
    expect(hits.length, `${constraint} on ${blockId}`).toBeGreaterThan(0);
  }

  it("frozen supply reserve rejects the supply", () => {
    const s = fixtureSnapshot((raw) => {
      raw.weETH.frozen = true;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "reserve-frozen", "supply1");
  });

  it("paused supply reserve rejects the supply", () => {
    const s = fixtureSnapshot((raw) => {
      raw.weETH.paused = true;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "reserve-paused", "supply1");
  });

  it("inactive supply reserve rejects the supply", () => {
    const s = fixtureSnapshot((raw) => {
      raw.weETH.active = false;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "reserve-inactive", "supply1");
  });

  it("borrowing-disabled reserve rejects the borrow", () => {
    const s = fixtureSnapshot((raw) => {
      raw.WETH.borrowingEnabled = false;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "borrowing-disabled", "borrow");
  });

  it("paused borrow reserve rejects the borrow", () => {
    const s = fixtureSnapshot((raw) => {
      raw.WETH.paused = true;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "reserve-paused", "borrow");
  });

  it("collateral-disabled supply reserve rejects a borrowing plan", () => {
    const s = fixtureSnapshot((raw) => {
      raw.weETH.usageAsCollateralAllowed = false;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "collateral-not-allowed", "supply1");
  });

  it("an existing aave footprint is refused (SPEC §2 predicate)", () => {
    const s = fixtureSnapshot((raw) => {
      raw.user.hasAaveFootprint = true;
    });
    expectConstraint(buildPlan(flagshipGraph(), s), "existing-footprint", "supply1");
  });

  it("supply cap: the flagship passes at the real weETH headroom boundary and fails one wei above", () => {
    expectOk(buildPlan(flagshipGraph(CAP_BOUNDARY_E_PASS), fixtureSnapshot()));
    // The crossing supply is the SECOND one — cumulative in-plan tracking, not
    // per-step-versus-snapshot.
    expectConstraint(
      buildPlan(flagshipGraph(CAP_BOUNDARY_E_FAIL), fixtureSnapshot()),
      "supply-cap",
      "supply2",
    );
  });

  it("borrow cap: exact v3.7 scaled-debt formula at the boundary", () => {
    const pass = fixtureSnapshot((raw) => {
      raw.WETH.borrowCap = BORROW_CAP_MIN_PASSING;
    });
    expectOk(buildPlan(flagshipGraph(), pass));
    const fail = fixtureSnapshot((raw) => {
      raw.WETH.borrowCap = BORROW_CAP_MIN_PASSING - 1n;
    });
    expectConstraint(buildPlan(flagshipGraph(), fail), "borrow-cap", "borrow");
  });

  it("virtual liquidity bounds the borrow exactly", () => {
    const pass = fixtureSnapshot((raw) => {
      raw.WETH.virtualUnderlyingBalance = EXPECTED_BORROW_WEI;
    });
    expectOk(buildPlan(flagshipGraph(), pass));
    const fail = fixtureSnapshot((raw) => {
      raw.WETH.virtualUnderlyingBalance = EXPECTED_BORROW_WEI - 1n;
    });
    expectConstraint(buildPlan(flagshipGraph(), fail), "insufficient-liquidity", "borrow");
  });
});

describe("input amount parsing — exact, or an explicit error", () => {
  it("parses a decimal string exactly", () => {
    const result = buildPlan(flagshipGraph("1.5"), fixtureSnapshot());
    expectOk(result);
    const deposit = stepById(result.steps, "stake1:deposit");
    if (deposit.amount.kind !== "literal") throw new Error("expected literal");
    expect(deposit.amount.amount.value).toBe(1_500_000_000_000_000_000n);
  });

  it("accepts a whole-number amount", () => {
    const result = buildPlan(flagshipGraph(10), fixtureSnapshot());
    expectOk(result);
    const deposit = stepById(result.steps, "stake1:deposit");
    if (deposit.amount.kind !== "literal") throw new Error("expected literal");
    expect(deposit.amount.amount.value).toBe(10n * WAD_WEI);
  });

  it("rejects more than 18 decimals instead of silently truncating", () => {
    const result = buildPlan(flagshipGraph("0.1234567890123456789"), fixtureSnapshot());
    expectFail(result);
    const hits = constraintErrors(result.errors).filter((e) => e.constraint === "input-amount");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.blockId).toBe("in");
  });

  it("rejects a fractional number param — binary floats cannot carry money exactly", () => {
    const result = buildPlan(flagshipGraph(0.1), fixtureSnapshot());
    expectFail(result);
    const hits = constraintErrors(result.errors).filter((e) => e.constraint === "input-amount");
    expect(hits).toHaveLength(1);
  });
});
