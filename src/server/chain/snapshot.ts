/**
 * Sole owner of finance reads (SPEC §4): produces block-pinned ChainSnapshot
 * objects for core/. Transaction-transport observation (receipts, nonces,
 * wallet state) is the client's and never passes through here.
 *
 * Anchor addresses come from the committed protocol reads log
 * (docs/protocol-matrix-reads.json — generated, hash-guarded, nothing
 * hand-typed) and are re-verified on-chain at every capture via symbol and
 * round-trip reads; every other address is derived from the
 * PoolAddressesProvider anchor at the pinned block, mirroring
 * scripts/protocol-reads.mjs. Any verification mismatch throws — there is no
 * fallback state.
 */
import { getAddress, parseAbi, type Address, type PublicClient } from "viem";
import { observationMinter, type ObservationMinter } from "../../core/provenance";
import type {
  ChainSnapshot,
  EModeCategorySnapshot,
  ReserveSnapshot,
  StakingRateWindow,
} from "../../core/plan";
import readsLog from "../../../docs/protocol-matrix-reads.json";

const LOG_ANCHORS = (
  readsLog as unknown as { meta: { anchors: Record<string, string> } }
).meta.anchors;

function anchor(name: string): Address {
  const raw = LOG_ANCHORS[name];
  if (typeof raw !== "string") throw new Error(`reads log is missing anchor ${name}`);
  return getAddress(raw);
}

/** The e-mode categories the protocol matrix records (§3). */
const RECORDED_EMODE_CATEGORY_IDS = [1] as const;

const ABI = {
  provider: parseAbi([
    "function getPool() view returns (address)",
    "function getPoolDataProvider() view returns (address)",
    "function getPriceOracle() view returns (address)",
  ]),
  pool: parseAbi([
    "function ADDRESSES_PROVIDER() view returns (address)",
    "function getReservesList() view returns (address[])",
    "function getUserEMode(address) view returns (uint256)",
    "function getEModeCategoryLabel(uint8) view returns (string)",
    "function getEModeCategoryCollateralConfig(uint8) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus))",
    "function getEModeCategoryCollateralBitmap(uint8) view returns (uint128)",
    "function getEModeCategoryBorrowableBitmap(uint8) view returns (uint128)",
    "function getIsEModeCategoryIsolated(uint8) view returns (bool)",
    "function getEModeCategoryLtvzeroBitmap(uint8) view returns (uint128)",
    "function getReserveDeficit(address) view returns (uint256)",
  ]),
  data: parseAbi([
    "function getReserveConfigurationData(address) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
    "function getReserveCaps(address) view returns (uint256 borrowCap, uint256 supplyCap)",
    "function getPaused(address) view returns (bool)",
    "function getReserveTokensAddresses(address) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
    "function getReserveData(address) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
    "function getVirtualUnderlyingBalance(address) view returns (uint128)",
    "function getInterestRateStrategyAddress(address) view returns (address)",
  ]),
  strategy: parseAbi([
    "function getInterestRateDataBps(address) view returns ((uint16 optimalUsageRatio, uint32 baseVariableBorrowRate, uint32 variableRateSlope1, uint32 variableRateSlope2))",
  ]),
  oracle: parseAbi(["function getAssetPrice(address) view returns (uint256)"]),
  scaled: parseAbi(["function scaledTotalSupply() view returns (uint256)"]),
  erc20: parseAbi([
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
  ]),
  weeth: parseAbi([
    "function eETH() view returns (address)",
    "function liquidityPool() view returns (address)",
    "function getRate() view returns (uint256)",
  ]),
  eeth: parseAbi(["function totalShares() view returns (uint256)"]),
  lp: parseAbi([
    "function eETH() view returns (address)",
    "function getTotalPooledEther() view returns (uint256)",
  ]),
};

export interface CaptureOptions {
  readonly user: Address;
  /** Pin to a specific block; defaults to the client's current block. */
  readonly blockNumber?: bigint;
  /** Fail the capture unless the pinned block's hash matches (fixture identity). */
  readonly expectBlockHash?: `0x${string}`;
}

/**
 * Seven days of 12-second slots. The APR annualizes the span the two block HEADERS report,
 * not this count — missed slots make a block offset an approximation, and the rate must be
 * about the time that actually elapsed.
 */
const STAKING_WINDOW_BLOCKS = 50_400n;

/**
 * The trailing staking-APR window (SPEC §5.1), or `null` when the earlier endpoint cannot be
 * read.
 *
 * The second read is HISTORICAL, so it needs an archive-capable endpoint; a node with a short
 * state window answers it with an error rather than a number. That is a designed degradation
 * and not a silent fallback: the field goes null, `core/risk.ts` drops the staking leg, and
 * §5.2's complete-or-nothing rule takes gross APY, net APY and the whole yield breakdown with
 * it. Nothing is invented, and the failure is visible on screen as an unavailable slot.
 *
 * The catch is deliberately narrow — it wraps only the two archive calls, so a bug in the
 * minting below still throws rather than being reported as "no archive endpoint".
 */
async function captureStakingWindow(
  client: PublicClient,
  weETH: Address,
  blockNumber: bigint,
  blockTimestamp: bigint,
  mint: ObservationMinter,
): Promise<StakingRateWindow | null> {
  const windowNumber = blockNumber - STAKING_WINDOW_BLOCKS;
  if (windowNumber <= 0n) return null;
  let windowBlock;
  let rateBefore: bigint;
  let rateNow: bigint;
  try {
    [rateNow, windowBlock, rateBefore] = await Promise.all([
      client.readContract({ address: weETH, abi: ABI.weeth, functionName: "getRate", blockNumber }),
      client.getBlock({ blockNumber: windowNumber }),
      client.readContract({
        address: weETH,
        abi: ABI.weeth,
        functionName: "getRate",
        blockNumber: windowNumber,
      }),
    ]);
  } catch {
    return null;
  }
  const secondsElapsed = blockTimestamp - windowBlock.timestamp;
  if (secondsElapsed <= 0n) return null;
  const windowMint = observationMinter(windowNumber, Number(windowBlock.timestamp));
  return {
    rateNow: mint.observe(rateNow, "weETH.getRate"),
    // Minted against the block it was READ at, never against the snapshot's block: the
    // quantity is a claim about the span between two blocks, so a wrapper that named one
    // block twice would erase the only thing it says.
    rateBefore: windowMint.observe(rateBefore, "weETH.getRate"),
    secondsElapsed: windowMint.observe(
      secondsElapsed,
      "eth_getBlockByNumber.timestampDelta(pinned,window)",
    ),
  };
}

interface ReadCtx {
  readonly client: PublicClient;
  readonly blockNumber: bigint;
  readonly mint: ObservationMinter;
}

function verified(what: string, got: Address, expected: Address): Address {
  if (getAddress(got) !== getAddress(expected)) {
    throw new Error(`anchor verification failed: ${what} is ${got}, expected ${expected}`);
  }
  return getAddress(got);
}

async function captureReserve(
  ctx: ReadCtx,
  sym: "WETH" | "weETH",
  underlying: Address,
  dataProvider: Address,
  oracle: Address,
  pool: Address,
  reservesList: readonly Address[],
): Promise<ReserveSnapshot> {
  const { client, blockNumber, mint } = ctx;
  const reserveIndex = reservesList.findIndex((a) => getAddress(a) === underlying);
  if (reserveIndex < 0) throw new Error(`${sym} is not in Pool.getReservesList`);

  const [config, caps, paused, tokens, reserveData, virtualBalance, strategyAddress, deficit] =
    await client.multicall({
      allowFailure: false,
      blockNumber,
      contracts: [
        { address: dataProvider, abi: ABI.data, functionName: "getReserveConfigurationData", args: [underlying] },
        { address: dataProvider, abi: ABI.data, functionName: "getReserveCaps", args: [underlying] },
        { address: dataProvider, abi: ABI.data, functionName: "getPaused", args: [underlying] },
        { address: dataProvider, abi: ABI.data, functionName: "getReserveTokensAddresses", args: [underlying] },
        { address: dataProvider, abi: ABI.data, functionName: "getReserveData", args: [underlying] },
        { address: dataProvider, abi: ABI.data, functionName: "getVirtualUnderlyingBalance", args: [underlying] },
        { address: dataProvider, abi: ABI.data, functionName: "getInterestRateStrategyAddress", args: [underlying] },
        { address: pool, abi: ABI.pool, functionName: "getReserveDeficit", args: [underlying] },
      ],
    });
  const aToken = getAddress(tokens[0]);
  const variableDebtToken = getAddress(tokens[2]);
  const [aScaled, vScaled, price, rateData] = await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: [
      { address: aToken, abi: ABI.scaled, functionName: "scaledTotalSupply" },
      { address: variableDebtToken, abi: ABI.scaled, functionName: "scaledTotalSupply" },
      { address: oracle, abi: ABI.oracle, functionName: "getAssetPrice", args: [underlying] },
      // The strategy ADDRESS is read (above), never assumed — two reserves sharing one
      // strategy contract is an observation about this market, not a fact to hard-code.
      { address: getAddress(strategyAddress), abi: ABI.strategy, functionName: "getInterestRateDataBps", args: [underlying] },
    ],
  });

  return {
    underlying,
    aToken,
    variableDebtToken,
    reserveIndex: mint.observe(reserveIndex, `Pool.getReservesList.indexOf(${sym})`),
    decimals: mint.observe(Number(config[0]), `${sym}.getReserveConfigurationData.decimals`),
    active: mint.observe(config[8], `${sym}.getReserveConfigurationData.isActive`),
    frozen: mint.observe(config[9], `${sym}.getReserveConfigurationData.isFrozen`),
    paused: mint.observe(paused, `${sym}.getPaused`),
    borrowingEnabled: mint.observe(config[6], `${sym}.getReserveConfigurationData.borrowingEnabled`),
    usageAsCollateralAllowed: mint.observe(
      config[5],
      `${sym}.getReserveConfigurationData.usageAsCollateralEnabled`,
    ),
    // Reserve-level fallbacks the protocol uses when an active e-mode category does not
    // supply LTV/LT (matrix §3 four-branch rule).
    ltvBps: mint.observe(Number(config[1]), `${sym}.getReserveConfigurationData.ltv`),
    liquidationThresholdBps: mint.observe(
      Number(config[2]),
      `${sym}.getReserveConfigurationData.liquidationThreshold`,
    ),
    borrowCap: mint.observe(caps[0], `${sym}.getReserveCaps.borrowCap`),
    supplyCap: mint.observe(caps[1], `${sym}.getReserveCaps.supplyCap`),
    aTokenScaledTotalSupply: mint.observe(aScaled, `${sym}.aToken.scaledTotalSupply`),
    variableDebtScaledTotalSupply: mint.observe(vScaled, `${sym}.variableDebtToken.scaledTotalSupply`),
    accruedToTreasury: mint.observe(reserveData[1], `${sym}.getReserveData.accruedToTreasury`),
    liquidityRateRay: mint.observe(reserveData[5], `${sym}.getReserveData.liquidityRate`),
    variableBorrowRateRay: mint.observe(reserveData[6], `${sym}.getReserveData.variableBorrowRate`),
    liquidityIndexRay: mint.observe(reserveData[9], `${sym}.getReserveData.liquidityIndex`),
    variableBorrowIndexRay: mint.observe(reserveData[10], `${sym}.getReserveData.variableBorrowIndex`),
    lastUpdateTimestamp: mint.observe(BigInt(reserveData[11]), `${sym}.getReserveData.lastUpdateTimestamp`),
    virtualUnderlyingBalance: mint.observe(virtualBalance, `${sym}.getVirtualUnderlyingBalance`),
    priceBase: mint.observe(price, `Oracle.getAssetPrice(${sym})`),
    rateStrategy: mint.observe(
      {
        optimalUsageRatio: rateData.optimalUsageRatio,
        baseVariableBorrowRate: rateData.baseVariableBorrowRate,
        variableRateSlope1: rateData.variableRateSlope1,
        variableRateSlope2: rateData.variableRateSlope2,
      },
      `${sym}.strategy.getInterestRateDataBps`,
    ),
    reserveFactorBps: mint.observe(
      Number(config[4]),
      `${sym}.getReserveConfigurationData.reserveFactor`,
    ),
    deficit: mint.observe(deficit, `${sym}.getReserveDeficit`),
  };
}

async function captureEModeCategory(
  ctx: ReadCtx,
  pool: Address,
  id: number,
): Promise<EModeCategorySnapshot> {
  const { client, blockNumber, mint } = ctx;
  const [label, collateralConfig, collateralBitmap, borrowableBitmap, isIsolated, ltvZeroBitmap] =
    await client.multicall({
      allowFailure: false,
      blockNumber,
      contracts: [
        { address: pool, abi: ABI.pool, functionName: "getEModeCategoryLabel", args: [id] },
        { address: pool, abi: ABI.pool, functionName: "getEModeCategoryCollateralConfig", args: [id] },
        { address: pool, abi: ABI.pool, functionName: "getEModeCategoryCollateralBitmap", args: [id] },
        { address: pool, abi: ABI.pool, functionName: "getEModeCategoryBorrowableBitmap", args: [id] },
        { address: pool, abi: ABI.pool, functionName: "getIsEModeCategoryIsolated", args: [id] },
        { address: pool, abi: ABI.pool, functionName: "getEModeCategoryLtvzeroBitmap", args: [id] },
      ],
    });
  return {
    id,
    label: mint.observe(label, `eMode${id}.label`),
    ltvBps: mint.observe(collateralConfig.ltv, `eMode${id}.collateralConfig.ltv`),
    liquidationThresholdBps: mint.observe(
      collateralConfig.liquidationThreshold,
      `eMode${id}.collateralConfig.liquidationThreshold`,
    ),
    collateralBitmap: mint.observe(collateralBitmap, `eMode${id}.collateralBitmap`),
    borrowableBitmap: mint.observe(borrowableBitmap, `eMode${id}.borrowableBitmap`),
    isIsolated: mint.observe(isIsolated, `eMode${id}.isIsolated`),
    ltvZeroBitmap: mint.observe(ltvZeroBitmap, `eMode${id}.ltvZeroBitmap`),
  };
}

/**
 * SPEC §2 footprint predicate, read exhaustively: any aToken or variable-debt
 * balance on any listed reserve. One multicall per read family.
 */
async function captureFootprint(
  ctx: ReadCtx,
  dataProvider: Address,
  reservesList: readonly Address[],
  user: Address,
): Promise<boolean> {
  const { client, blockNumber } = ctx;
  const tokenAddresses = await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: reservesList.map((asset) => ({
      address: dataProvider,
      abi: ABI.data,
      functionName: "getReserveTokensAddresses" as const,
      args: [asset] as const,
    })),
  });
  const ZERO = "0x0000000000000000000000000000000000000000";
  const balanceTargets: Address[] = [];
  for (const tokens of tokenAddresses) {
    for (const raw of [tokens[0], tokens[2]]) {
      const token = getAddress(raw);
      if (token !== ZERO) balanceTargets.push(token);
    }
  }
  const balances = await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: balanceTargets.map((token) => ({
      address: token,
      abi: ABI.erc20,
      functionName: "balanceOf" as const,
      args: [user] as const,
    })),
  });
  return balances.some((b) => b > 0n);
}

export async function captureChainSnapshot(
  client: PublicClient,
  options: CaptureOptions,
): Promise<ChainSnapshot> {
  const blockNumber =
    options.blockNumber !== undefined ? options.blockNumber : await client.getBlockNumber();
  const block = await client.getBlock({ blockNumber });
  if (options.expectBlockHash !== undefined && block.hash !== options.expectBlockHash) {
    throw new Error(
      `fixture identity mismatch: block ${blockNumber} has hash ${block.hash}, expected ${options.expectBlockHash}`,
    );
  }
  const mint = observationMinter(blockNumber, Number(block.timestamp));
  const ctx: ReadCtx = { client, blockNumber, mint };

  const AP = anchor("ADDRESSES_PROVIDER");
  const WETH = anchor("WETH");
  const eETH = anchor("eETH");
  const weETH = anchor("weETH");
  const LP = anchor("ETHERFI_LP");

  const [pool, dataProvider, oracle] = await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: [
      { address: AP, abi: ABI.provider, functionName: "getPool" },
      { address: AP, abi: ABI.provider, functionName: "getPoolDataProvider" },
      { address: AP, abi: ABI.provider, functionName: "getPriceOracle" },
    ],
  });

  // Anchor re-verification — symbols and round-trips, exactly as the matrix run.
  const [apRoundTrip, wethSymbol, eethSymbol, weethSymbol, weethEeth, weethLp, lpEeth] =
    await client.multicall({
      allowFailure: false,
      blockNumber,
      contracts: [
        { address: getAddress(pool), abi: ABI.pool, functionName: "ADDRESSES_PROVIDER" },
        { address: WETH, abi: ABI.erc20, functionName: "symbol" },
        { address: eETH, abi: ABI.erc20, functionName: "symbol" },
        { address: weETH, abi: ABI.erc20, functionName: "symbol" },
        { address: weETH, abi: ABI.weeth, functionName: "eETH" },
        { address: weETH, abi: ABI.weeth, functionName: "liquidityPool" },
        { address: LP, abi: ABI.lp, functionName: "eETH" },
      ],
    });
  verified("Pool.ADDRESSES_PROVIDER round-trip", getAddress(apRoundTrip), AP);
  for (const [sym, got, expected] of [
    ["WETH.symbol", wethSymbol, "WETH"],
    ["eETH.symbol", eethSymbol, "eETH"],
    ["weETH.symbol", weethSymbol, "weETH"],
  ] as const) {
    if (got !== expected) throw new Error(`anchor verification failed: ${sym} is '${got}'`);
  }
  verified("weETH.eETH round-trip", getAddress(weethEeth), eETH);
  verified("weETH.liquidityPool round-trip", getAddress(weethLp), LP);
  verified("LP.eETH round-trip", getAddress(lpEeth), eETH);

  const reservesList = (
    await client.readContract({
      address: getAddress(pool),
      abi: ABI.pool,
      functionName: "getReservesList",
      blockNumber,
    })
  ).map((a) => getAddress(a));

  const [weETHReserve, wethReserve, eModeCategories] = await Promise.all([
    captureReserve(ctx, "weETH", weETH, getAddress(dataProvider), getAddress(oracle), getAddress(pool), reservesList),
    captureReserve(ctx, "WETH", WETH, getAddress(dataProvider), getAddress(oracle), getAddress(pool), reservesList),
    Promise.all(
      RECORDED_EMODE_CATEGORY_IDS.map((id) => captureEModeCategory(ctx, getAddress(pool), id)),
    ),
  ]);

  const [totalPooledEther, totalShares, userEMode] = await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: [
      { address: LP, abi: ABI.lp, functionName: "getTotalPooledEther" },
      { address: eETH, abi: ABI.eeth, functionName: "totalShares" },
      { address: getAddress(pool), abi: ABI.pool, functionName: "getUserEMode", args: [options.user] },
    ],
  });
  const stakingWindow = await captureStakingWindow(
    client,
    weETH,
    blockNumber,
    block.timestamp,
    mint,
  );
  const hasFootprint = await captureFootprint(
    ctx,
    getAddress(dataProvider),
    reservesList,
    options.user,
  );

  return {
    block: blockNumber,
    blockTimestamp: block.timestamp,
    pool: getAddress(pool),
    reserves: { weETH: weETHReserve, WETH: wethReserve },
    eModeCategories,
    etherfi: {
      liquidityPool: LP,
      eETH,
      weETH,
      totalPooledEther: mint.observe(totalPooledEther, "LP.getTotalPooledEther"),
      totalShares: mint.observe(totalShares, "eETH.totalShares"),
      rateWindow: stakingWindow,
    },
    user: {
      address: options.user,
      eModeCategoryId: mint.observe(Number(userEMode), "Pool.getUserEMode(user)"),
      hasAaveFootprint: mint.observe(hasFootprint, "aToken/variableDebt balanceOf sweep over getReservesList"),
    },
  };
}
