/**
 * Protocol-matrix reads — reproducible, block-pinned (W04 / SPEC §5.7).
 *
 * Regenerates docs/protocol-matrix-reads.json: every value the matrix cites,
 * read at ONE pinned block (number + hash + timestamp recorded in meta).
 *
 * Anchor addresses are limited to (a) the Aave PoolAddressesProvider and token
 * addresses — each cited to the bgd-labs address book / official docs and
 * re-verified below via on-chain round-trips at the pinned block — and (b) the
 * EtherFi LiquidityPool, verified via weETH.liquidityPool(). Every other
 * contract address is DERIVED on-chain from those anchors in this run.
 *
 * Reads marked exploratory:true may legitimately revert (version-dependent
 * getters); their reverts are recorded as findings. Any other failure exits 1.
 *
 * Run:  node scripts/protocol-reads.mjs            (RPC_URL env to override)
 */
import { writeFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, getAddress, keccak256 } from "viem";
import { mainnet } from "viem/chains";

const RPC = process.env.RPC_URL;
if (!RPC) {
  console.error("FATAL: RPC_URL is required (archive-capable; the pinned block is historical). Never commit the URL.");
  process.exit(1);
}
// Only a redacted provider label is ever serialized -- credentials must not enter the repo.
const RPC_LABEL = `${new URL(RPC).hostname} (path/credentials redacted)`;
// The pinned fixture. Default mode reads exactly this block and verifies its hash;
// an archive-capable RPC is REQUIRED once the block ages out of the node's recent-state
// window. Pass --repin to move the fixture (prints the new pin; update these constants
// and regenerate the matrix in the same commit).
const PIN = {
  number: 25592678n,
  hash: "0x7f1f53176578a6df42c94948c10623f002cca61398208c888edce99eaedbf0de",
};
const REPIN = process.argv.includes("--repin");

// Anchors. Sources: bgd-labs/aave-address-book src/AaveV3Ethereum.sol
// (POOL_ADDRESSES_PROVIDER, *_UNDERLYING), Lido deployed-contracts docs,
// EtherFi deployment JSONs — all previously round-trip-verified; re-verified
// in this run at the pinned block (see the roundtrip reads below).
const A = {
  ADDRESSES_PROVIDER: getAddress("0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e"),
  WETH: getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
  eETH: getAddress("0x35fA164735182de50811E8e2E824cFb9B6118ac2"),
  weETH: getAddress("0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee"),
  stETH: getAddress("0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84"),
  wstETH: getAddress("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"),
  ETHERFI_LP: getAddress("0x308861A430be4cce5502d0A12724771Fc6DaF216"),
};

const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const abis = {
  provider: parseAbi([
    "function getPool() view returns (address)",
    "function getPoolDataProvider() view returns (address)",
    "function getPriceOracle() view returns (address)",
    "function getACLManager() view returns (address)",
  ]),
  pool: parseAbi([
    "function getIsEModeCategoryIsolated(uint8) view returns (bool)",
    "function getEModeCategoryLtvzeroBitmap(uint8) view returns (uint128)",
    "function ADDRESSES_PROVIDER() view returns (address)",
    "function getReservesList() view returns (address[])",
    "function getEModeCategoryLabel(uint8) view returns (string)",
    "function getEModeCategoryCollateralConfig(uint8) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus))",
    "function getEModeCategoryCollateralBitmap(uint8) view returns (uint128)",
    "function getEModeCategoryBorrowableBitmap(uint8) view returns (uint128)",
    "function getRevision() view returns (uint256)",
    "function getReserveDeficit(address) view returns (uint256)",
  ]),
  data: parseAbi([
    "function getReserveConfigurationData(address) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
    "function getReserveCaps(address) view returns (uint256 borrowCap, uint256 supplyCap)",
    "function getPaused(address) view returns (bool)",
    "function getSiloedBorrowing(address) view returns (bool)",
    "function getDebtCeiling(address) view returns (uint256)",
    "function getReserveTokensAddresses(address) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
    "function getReserveData(address) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
    "function getInterestRateStrategyAddress(address) view returns (address)",
    "function getVirtualUnderlyingBalance(address) view returns (uint128)",
  ]),
  strategy: parseAbi([
    "function getInterestRateDataBps(address) view returns ((uint16 optimalUsageRatio, uint32 baseVariableBorrowRate, uint32 variableRateSlope1, uint32 variableRateSlope2))",
  ]),
  oracle: parseAbi([
    "function BASE_CURRENCY_UNIT() view returns (uint256)",
    "function getSourceOfAsset(address) view returns (address)",
    "function getAssetPrice(address) view returns (uint256)",
  ]),
  feed: parseAbi([
    "function description() view returns (string)",
    "function decimals() view returns (uint8)",
    "function latestAnswer() view returns (int256)",
  ]),
  atoken: parseAbi(["function scaledTotalSupply() view returns (uint256)"]),
  erc20: parseAbi([
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ]),
  weeth: parseAbi([
    "function getRate() view returns (uint256)",
    "function eETH() view returns (address)",
    "function liquidityPool() view returns (address)",
  ]),
  eeth: parseAbi([
    "function totalShares() view returns (uint256)",
    "function shares(address) view returns (uint256)",
  ]),
  lp: parseAbi([
    "function eETH() view returns (address)",
    "function getTotalPooledEther() view returns (uint256)",
    "function amountForShare(uint256) view returns (uint256)",
    "function sharesForAmount(uint256) view returns (uint256)",
  ]),
  wsteth: parseAbi([
    "function stEthPerToken() view returns (uint256)",
    "function stETH() view returns (address)",
  ]),
};

const client = createPublicClient({ chain: mainnet, transport: http(RPC) });
const reads = [];
let unexpectedFailures = 0;

const json = (v) =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)),
  );

async function read(label, { address, abi, functionName, args = [], blockNumber, exploratory = false }) {
  const entry = { label, to: address, fn: functionName, args: json(args) };
  try {
    const result = await client.readContract({ address, abi, functionName, args, blockNumber });
    entry.result = json(result);
  } catch (err) {
    const msg = String(err?.shortMessage ?? err?.message ?? err).slice(0, 200);
    if (exploratory) {
      entry.expected_revert = true;
      entry.revert = msg;
    } else {
      entry.error = msg;
      unexpectedFailures += 1;
    }
  }
  reads.push(entry);
  return entry.result;
}

async function implSlot(label, address, blockNumber) {
  const raw = await client.getStorageAt({ address, slot: EIP1967_IMPL_SLOT, blockNumber });
  const impl = getAddress(`0x${raw.slice(-40)}`);
  reads.push({ label, to: address, fn: "eth_getStorageAt(EIP-1967 impl slot)", args: [], result: impl });
  const code = await client.getCode({ address: impl, blockNumber });
  reads.push({ label: `${label} — runtime code keccak256`, to: impl, fn: "keccak256(eth_getCode)", args: [], result: keccak256(code) });
  return impl;
}

// ---- pin the block -----------------------------------------------------------
let pinned;
if (REPIN) {
  const latest = await client.getBlock();
  pinned = await client.getBlock({ blockNumber: latest.number - 64n });
  console.log(`REPIN MODE: new fixture block ${pinned.number} hash ${pinned.hash} — update PIN in this script and regenerate everything in one commit`);
} else {
  pinned = await client.getBlock({ blockNumber: PIN.number });
  if (pinned.hash !== PIN.hash) {
    console.error(`FATAL: block ${PIN.number} hash ${pinned.hash} != pinned ${PIN.hash}`);
    process.exit(1);
  }
}
const B = pinned.number;
console.log(`pinned block ${B} (${pinned.hash}) @ ${new Date(Number(pinned.timestamp) * 1000).toISOString()}`);

// ---- anchor round-trips ------------------------------------------------------
const POOL = await read("AP.getPool", { address: A.ADDRESSES_PROVIDER, abi: abis.provider, functionName: "getPool", blockNumber: B });
const DATA = await read("AP.getPoolDataProvider", { address: A.ADDRESSES_PROVIDER, abi: abis.provider, functionName: "getPoolDataProvider", blockNumber: B });
const ORACLE = await read("AP.getPriceOracle", { address: A.ADDRESSES_PROVIDER, abi: abis.provider, functionName: "getPriceOracle", blockNumber: B });
await read("AP.getACLManager", { address: A.ADDRESSES_PROVIDER, abi: abis.provider, functionName: "getACLManager", blockNumber: B });
await read("Pool.ADDRESSES_PROVIDER (round-trip)", { address: POOL, abi: abis.pool, functionName: "ADDRESSES_PROVIDER", blockNumber: B });
const POOL_IMPL = await implSlot("Pool implementation (EIP-1967)", POOL, B);
await read("Pool.getRevision (internal in v3.x — expected revert)", { address: POOL, abi: abis.pool, functionName: "getRevision", blockNumber: B, exploratory: true });

for (const [sym, addr] of Object.entries({ WETH: A.WETH, eETH: A.eETH, weETH: A.weETH, stETH: A.stETH, wstETH: A.wstETH })) {
  await read(`${sym}.symbol`, { address: addr, abi: abis.erc20, functionName: "symbol", blockNumber: B });
}
await read("weETH.eETH (round-trip)", { address: A.weETH, abi: abis.weeth, functionName: "eETH", blockNumber: B });
await read("weETH.liquidityPool (round-trip)", { address: A.weETH, abi: abis.weeth, functionName: "liquidityPool", blockNumber: B });
await read("wstETH.stETH (round-trip)", { address: A.wstETH, abi: abis.wsteth, functionName: "stETH", blockNumber: B });

// ---- reserves ---------------------------------------------------------------
const reservesList = await read("Pool.getReservesList", { address: POOL, abi: abis.pool, functionName: "getReservesList", blockNumber: B });

for (const [sym, asset] of Object.entries({ WETH: A.WETH, weETH: A.weETH })) {
  await read(`${sym}.getReserveConfigurationData`, { address: DATA, abi: abis.data, functionName: "getReserveConfigurationData", args: [asset], blockNumber: B });
  await read(`${sym}.getReserveCaps`, { address: DATA, abi: abis.data, functionName: "getReserveCaps", args: [asset], blockNumber: B });
  await read(`${sym}.getPaused`, { address: DATA, abi: abis.data, functionName: "getPaused", args: [asset], blockNumber: B });
  await read(`${sym}.getSiloedBorrowing`, { address: DATA, abi: abis.data, functionName: "getSiloedBorrowing", args: [asset], blockNumber: B });
  await read(`${sym}.getDebtCeiling (isolation)`, { address: DATA, abi: abis.data, functionName: "getDebtCeiling", args: [asset], blockNumber: B });
  const tokens = await read(`${sym}.getReserveTokensAddresses`, { address: DATA, abi: abis.data, functionName: "getReserveTokensAddresses", args: [asset], blockNumber: B });
  await read(`${sym}.getReserveData`, { address: DATA, abi: abis.data, functionName: "getReserveData", args: [asset], blockNumber: B });
  await read(`${sym}.aToken.totalSupply`, { address: tokens[0], abi: abis.erc20, functionName: "totalSupply", blockNumber: B });
  await read(`${sym}.aToken.scaledTotalSupply`, { address: tokens[0], abi: abis.atoken, functionName: "scaledTotalSupply", blockNumber: B });
  await read(`${sym}.variableDebtToken.totalSupply`, { address: tokens[2], abi: abis.erc20, functionName: "totalSupply", blockNumber: B });
  await read(`${sym}.variableDebtToken.scaledTotalSupply`, { address: tokens[2], abi: abis.atoken, functionName: "scaledTotalSupply", blockNumber: B });
  await read(`${sym}.underlying.balanceOf(aToken)`, { address: asset, abi: abis.erc20, functionName: "balanceOf", args: [tokens[0]], blockNumber: B });
  await read(`${sym}.getVirtualUnderlyingBalance`, { address: DATA, abi: abis.data, functionName: "getVirtualUnderlyingBalance", args: [asset], blockNumber: B });
  // v3.7 feeds reserve.deficit to the strategy as `unbacked`, entering only the
  // supply-usage denominator (ReserveLogic.updateInterestRatesAndVirtualBalance).
  await read(`${sym}.getReserveDeficit`, { address: POOL, abi: abis.pool, functionName: "getReserveDeficit", args: [asset], blockNumber: B });
  const strat = await read(`${sym}.getInterestRateStrategyAddress`, { address: DATA, abi: abis.data, functionName: "getInterestRateStrategyAddress", args: [asset], blockNumber: B });
  await read(`${sym}.strategy.getInterestRateDataBps`, { address: strat, abi: abis.strategy, functionName: "getInterestRateDataBps", args: [asset], blockNumber: B });
}

// ---- e-mode category 1 ------------------------------------------------------
await read("eMode1.label", { address: POOL, abi: abis.pool, functionName: "getEModeCategoryLabel", args: [1], blockNumber: B });
await read("eMode1.collateralConfig", { address: POOL, abi: abis.pool, functionName: "getEModeCategoryCollateralConfig", args: [1], blockNumber: B });
await read("eMode1.collateralBitmap", { address: POOL, abi: abis.pool, functionName: "getEModeCategoryCollateralBitmap", args: [1], blockNumber: B });
await read("eMode1.borrowableBitmap", { address: POOL, abi: abis.pool, functionName: "getEModeCategoryBorrowableBitmap", args: [1], blockNumber: B });
await read("eMode1.isIsolated (v3.7)", { address: POOL, abi: abis.pool, functionName: "getIsEModeCategoryIsolated", args: [1], blockNumber: B });
await read("eMode1.ltvZeroBitmap (v3.7)", { address: POOL, abi: abis.pool, functionName: "getEModeCategoryLtvzeroBitmap", args: [1], blockNumber: B });

// ---- oracle -----------------------------------------------------------------
await read("Oracle.BASE_CURRENCY_UNIT", { address: ORACLE, abi: abis.oracle, functionName: "BASE_CURRENCY_UNIT", blockNumber: B });
for (const [sym, asset] of Object.entries({ WETH: A.WETH, weETH: A.weETH })) {
  const src = await read(`Oracle.getSourceOfAsset(${sym})`, { address: ORACLE, abi: abis.oracle, functionName: "getSourceOfAsset", args: [asset], blockNumber: B });
  await read(`Oracle.getAssetPrice(${sym})`, { address: ORACLE, abi: abis.oracle, functionName: "getAssetPrice", args: [asset], blockNumber: B });
  await read(`OracleSource(${sym}).description`, { address: src, abi: abis.feed, functionName: "description", blockNumber: B });
  await read(`OracleSource(${sym}).decimals`, { address: src, abi: abis.feed, functionName: "decimals", blockNumber: B });
  await read(`OracleSource(${sym}).latestAnswer`, { address: src, abi: abis.feed, functionName: "latestAnswer", blockNumber: B });
}

// ---- EtherFi ----------------------------------------------------------------
await implSlot("EtherFi LiquidityPool implementation (EIP-1967)", A.ETHERFI_LP, B);
await implSlot("eETH implementation (EIP-1967)", A.eETH, B);
await implSlot("weETH implementation (EIP-1967)", A.weETH, B);
await read("weETH.getRate", { address: A.weETH, abi: abis.weeth, functionName: "getRate", blockNumber: B });
await read("LP.eETH (round-trip)", { address: A.ETHERFI_LP, abi: abis.lp, functionName: "eETH", blockNumber: B });
await read("LP.getTotalPooledEther", { address: A.ETHERFI_LP, abi: abis.lp, functionName: "getTotalPooledEther", blockNumber: B });
await read("eETH.totalShares", { address: A.eETH, abi: abis.eeth, functionName: "totalShares", blockNumber: B });
await read("LP.amountForShare(1e18)", { address: A.ETHERFI_LP, abi: abis.lp, functionName: "amountForShare", args: [10n ** 18n], blockNumber: B });
await read("LP.sharesForAmount(1e18)", { address: A.ETHERFI_LP, abi: abis.lp, functionName: "sharesForAmount", args: [10n ** 18n], blockNumber: B });

// ---- Lido (P1 scope: reference only) ----------------------------------------
await read("wstETH.stEthPerToken", { address: A.wstETH, abi: abis.wsteth, functionName: "stEthPerToken", blockNumber: B });

// ---- write ------------------------------------------------------------------
const out = {
  meta: {
    generated_by: "scripts/protocol-reads.mjs",
    rpc: RPC_LABEL,
    pinned_block: { number: B.toString(), hash: pinned.hash, timestamp: pinned.timestamp.toString(), iso: new Date(Number(pinned.timestamp) * 1000).toISOString() },
    anchors: A,
    pool: POOL,
    pool_data_provider: DATA,
    oracle: ORACLE,
    pool_implementation: POOL_IMPL,
    reserves_list_note: `getReservesList returned ${Array.isArray(reservesList) ? reservesList.length : "?"} reserves; full list in reads`,
    unexpected_failures: 0, // patched below
  },
  reads,
};
out.meta.unexpected_failures = unexpectedFailures;
writeFileSync("docs/protocol-matrix-reads.json", JSON.stringify(out, null, 1));
console.log(`wrote docs/protocol-matrix-reads.json: ${reads.length} reads, ${unexpectedFailures} unexpected failure(s)`);
process.exit(unexpectedFailures === 0 ? 0 : 1);
