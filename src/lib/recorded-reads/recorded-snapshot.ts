/**
 * Builds a block-pinned `ChainSnapshot` by REPLAYING the committed protocol reads log
 * rather than reading a chain.
 *
 * Relationship to `server/chain/snapshot.ts`: that module owns LIVE reads and is the only
 * thing that talks to an RPC. This one replays a capture of that same read set — same
 * labels, same block, same `observationMinter` — so a sandbox screen and a live screen
 * cite provenance in one vocabulary. Nothing here observes anything; `observationMinter`
 * remains the only constructor of an `Observed`, and every value it mints comes out of
 * `./reads-log`. There is not one hand-typed protocol number in this file.
 *
 * Moved out of tests/helpers/chain-snapshot.ts (W05 P2) with its bodies unchanged, so the
 * sandbox host and the unit fixtures build the SAME object from the SAME log. Tests import
 * this; this never imports tests.
 *
 * The USER is not part of the log — the matrix run captured protocol state, not an
 * account — so it arrives as a parameter. Each caller states the provenance it can
 * honestly claim: the fixtures mint `Observed` because they model a chain that was read,
 * the sandbox mints `Configured` because no wallet exists to read (see ./sandbox-snapshot).
 * Manufacturing an `Observed` here would forge the one field the log cannot back.
 *
 * `RecordedProtocol` is the RAW pre-minting shape on purpose: a test says "the same block,
 * with this one reserve frozen" by editing raw reads BEFORE they are minted, which keeps
 * provenance honest instead of rewriting a minted wrapper.
 */
import type { Address } from "viem";
import { observationMinter } from "../../core/provenance";
import type { ChainSnapshot, UserSnapshot } from "../../core/plan";
import type { RateStrategyBps } from "../../core/rates";
import {
  PINNED_BLOCK,
  PINNED_TS,
  addressOf,
  anchorAddr,
  addrRead,
  bigRead,
  boolRead,
  readResult,
  readsMeta,
  tupleBig,
  tupleBool,
  tupleRead,
} from "./reads-log";

export interface RawReserve {
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
  reserveLtvBps: number;
  reserveLiquidationThresholdBps: number;
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
  rateStrategy: RateStrategyBps;
  reserveFactorBps: number;
  deficit: bigint;
}

export interface RawEMode {
  id: number;
  label: string;
  ltvBps: number;
  liquidationThresholdBps: number;
  collateralBitmap: bigint;
  borrowableBitmap: bigint;
  isIsolated: boolean;
  ltvZeroBitmap: bigint;
}

/** Everything the reads log actually carries — protocol state, no account. */
export interface RecordedProtocol {
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
}

/**
 * The interest-rate strategy struct, shape-checked rather than cast: the reads log is
 * generated, so a field that silently went missing must fail here instead of arriving in
 * the rate math as `undefined`.
 */
function rateStrategyRead(label: string): RateStrategyBps {
  const raw = readResult(label);
  if (typeof raw !== "object" || raw === null) throw new Error(`read ${label} is not a struct`);
  const record = raw as Record<string, unknown>;
  const field = (name: string): number => {
    const v: unknown = record[name];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new Error(`read ${label}.${name} is not an integer`);
    }
    return v;
  };
  return {
    optimalUsageRatio: field("optimalUsageRatio"),
    baseVariableBorrowRate: field("baseVariableBorrowRate"),
    variableRateSlope1: field("variableRateSlope1"),
    variableRateSlope2: field("variableRateSlope2"),
  };
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
    reserveLtvBps: Number(tupleBig(cfg, 1)),
    reserveLiquidationThresholdBps: Number(tupleBig(cfg, 2)),
    borrowingEnabled: tupleBool(cfg, 6),
    active: tupleBool(cfg, 8),
    frozen: tupleBool(cfg, 9),
    paused: boolRead(`${sym}.getPaused`),
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
    rateStrategy: rateStrategyRead(`${sym}.strategy.getInterestRateDataBps`),
    reserveFactorBps: Number(tupleBig(cfg, 4)),
    deficit: bigRead(`${sym}.getReserveDeficit`),
  };
}

export function recordedProtocol(): RecordedProtocol {
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
        isIsolated: boolRead("eMode1.isIsolated (v3.7)"),
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
  };
}

export function snapshotFrom(raw: RecordedProtocol, user: UserSnapshot): ChainSnapshot {
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
    ltvBps: mint.observe(r.reserveLtvBps, `${sym}.getReserveConfigurationData.ltv`),
    liquidationThresholdBps: mint.observe(
      r.reserveLiquidationThresholdBps,
      `${sym}.getReserveConfigurationData.liquidationThreshold`,
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
    rateStrategy: mint.observe(r.rateStrategy, `${sym}.strategy.getInterestRateDataBps`),
    reserveFactorBps: mint.observe(
      r.reserveFactorBps,
      `${sym}.getReserveConfigurationData.reserveFactor`,
    ),
    deficit: mint.observe(r.deficit, `${sym}.getReserveDeficit`),
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
    user,
  };
}
