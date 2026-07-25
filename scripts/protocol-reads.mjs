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
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createPublicClient, http, parseAbi, getAddress, keccak256 } from "viem";
import { mainnet } from "viem/chains";

// CLI output channel. This is a command-line tool, so progress and fatal diagnostics are its
// product -- routed through stdout/stderr directly so `no-console` stays an error repo-wide.
const emit = (line) => process.stdout.write(`${line}\n`);
const fail = (line) => process.stderr.write(`${line}\n`);

/**
 * Anchor verification. A hand-typed address that happens to be callable could otherwise
 * produce an internally consistent fixture under a misleading symbol, and the exact-rate
 * reproductions would validate that mislabeled address. Every anchor below is therefore
 * checked against an independent on-chain source before any fixture value is written.
 */
const assertAnchor = (label, actual, expected) => {
  const got = getAddress(String(actual));
  const want = getAddress(String(expected));
  if (got !== want) {
    fail(`FATAL: anchor mismatch ${label}: on-chain ${got} != anchor ${want}`);
    process.exit(1);
  }
};
const assertSymbol = (actual, expected) => {
  if (String(actual) !== expected) {
    fail(`FATAL: symbol mismatch: address labelled ${expected} reports "${actual}"`);
    process.exit(1);
  }
};

const RPC = process.env.RPC_URL;
if (!RPC) {
  fail("FATAL: RPC_URL is required (archive-capable; the pinned block is historical). Never commit the URL.");
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

const VERIFY_ROOTS = process.argv.includes("--verify-roots");

/**
 * Address roots. Only these four are not on-chain reads; every other address in the fixture is
 * derived from them at the pinned block. They are loaded from docs/address-roots.json, which
 * records the upstream address-book file, its commit, and its sha256 — so the provenance is a
 * committed artifact rather than a literal typed into this script. `--verify-roots` re-fetches
 * that file, re-checks the hash, and re-extracts each address.
 */
const ROOTS_PATH = new URL("../docs/address-roots.json", import.meta.url);
const rootsDoc = JSON.parse(readFileSync(ROOTS_PATH, "utf8"));
const A = {
  ADDRESSES_PROVIDER: getAddress(rootsDoc.roots.ADDRESSES_PROVIDER.address),
  WETH: getAddress(rootsDoc.roots.WETH.address),
  weETH: getAddress(rootsDoc.roots.weETH.address),
  wstETH: getAddress(rootsDoc.roots.wstETH.address),
  // eETH, ETHERFI_LP and stETH are DERIVED on-chain below, never pinned.
};

async function verifyRootsAgainstUpstream() {
  const up = rootsDoc.meta.upstream;
  const res = await fetch(up.url);
  if (!res.ok) {
    fail(`FATAL: upstream root artifact fetch failed: HTTP ${res.status} ${up.url}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  if (buf.length !== up.bytes || sha !== up.sha256) {
    fail(
      `FATAL: upstream artifact does not match its pin\n` +
        `  expected ${up.bytes} bytes sha256 ${up.sha256}\n` +
        `  actual   ${buf.length} bytes sha256 ${sha}`,
    );
    process.exit(1);
  }
  const text = buf.toString("utf8");
  for (const [name, root] of Object.entries(rootsDoc.roots)) {
    const m = text.match(new RegExp(`${root.upstream_symbol}[^;]*?(0x[0-9a-fA-F]{40})`, "s"));
    if (m === null) {
      fail(`FATAL: ${root.upstream_symbol} not found in the pinned upstream artifact`);
      process.exit(1);
    }
    assertAnchor(`upstream ${name} (${root.upstream_symbol})`, m[1], root.address);
  }
  emit(
    `roots verified against ${up.repo}@${up.commit.slice(0, 12)} ${up.path} ` +
      `(${buf.length} bytes, sha256 ${sha.slice(0, 16)}…): ` +
      `${Object.keys(rootsDoc.roots).length} roots match`,
  );
}

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
  emit(`REPIN MODE: new fixture block ${pinned.number} hash ${pinned.hash} — update PIN in this script and regenerate everything in one commit`);
} else {
  pinned = await client.getBlock({ blockNumber: PIN.number });
  if (pinned.hash !== PIN.hash) {
    fail(`FATAL: block ${PIN.number} hash ${pinned.hash} != pinned ${PIN.hash}`);
    process.exit(1);
  }
}
const B = pinned.number;
emit(`pinned block ${B} (${pinned.hash}) @ ${new Date(Number(pinned.timestamp) * 1000).toISOString()}`);
if (VERIFY_ROOTS) await verifyRootsAgainstUpstream();

// ---- anchor round-trips ------------------------------------------------------
const POOL = await read("AP.getPool", { address: A.ADDRESSES_PROVIDER, abi: abis.provider, functionName: "getPool", blockNumber: B });
const DATA = await read("AP.getPoolDataProvider", { address: A.ADDRESSES_PROVIDER, abi: abis.provider, functionName: "getPoolDataProvider", blockNumber: B });
const ORACLE = await read("AP.getPriceOracle", { address: A.ADDRESSES_PROVIDER, abi: abis.provider, functionName: "getPriceOracle", blockNumber: B });
await read("AP.getACLManager", { address: A.ADDRESSES_PROVIDER, abi: abis.provider, functionName: "getACLManager", blockNumber: B });
// POOL was derived FROM the provider, so this closes the loop both ways.
assertAnchor(
  "Pool.ADDRESSES_PROVIDER",
  await read("Pool.ADDRESSES_PROVIDER (round-trip)", { address: POOL, abi: abis.pool, functionName: "ADDRESSES_PROVIDER", blockNumber: B }),
  A.ADDRESSES_PROVIDER,
);
const POOL_IMPL = await implSlot("Pool implementation (EIP-1967)", POOL, B);
await read("Pool.getRevision (internal in v3.x — expected revert)", { address: POOL, abi: abis.pool, functionName: "getRevision", blockNumber: B, exploratory: true });

// eETH, the EtherFi LiquidityPool and stETH are DERIVED from the pinned roots rather than
// pinned themselves: weETH is the EtherFi root, wstETH the Lido root. These reads must precede
// the symbol() checks below, which is why the round-trips come first.
A.eETH = getAddress(
  await read("weETH.eETH (round-trip)", { address: A.weETH, abi: abis.weeth, functionName: "eETH", blockNumber: B }),
);
A.ETHERFI_LP = getAddress(
  await read("weETH.liquidityPool (round-trip)", { address: A.weETH, abi: abis.weeth, functionName: "liquidityPool", blockNumber: B }),
);
A.stETH = getAddress(
  await read("wstETH.stETH (round-trip)", { address: A.wstETH, abi: abis.wsteth, functionName: "stETH", blockNumber: B }),
);

// symbol() is the check that catches a wrong-but-callable address: a typo is usually
// uncallable and fails loudly, so the dangerous case is one that happens to be a live token.
for (const [sym, addr] of Object.entries({ WETH: A.WETH, eETH: A.eETH, weETH: A.weETH, stETH: A.stETH, wstETH: A.wstETH })) {
  assertSymbol(await read(`${sym}.symbol`, { address: addr, abi: abis.erc20, functionName: "symbol", blockNumber: B }), sym);
}

// ---- reserves ---------------------------------------------------------------
const reservesList = await read("Pool.getReservesList", { address: POOL, abi: abis.pool, functionName: "getReservesList", blockNumber: B });
// Anchor every pinned token root to the pool's own reserve list. The market itself is the
// authority on which address is "the WETH reserve here", so this is an independent confirmation
// of the address-book pin rather than a restatement of it.
for (const [sym, asset] of Object.entries({ WETH: A.WETH, weETH: A.weETH, wstETH: A.wstETH })) {
  const member = Array.isArray(reservesList)
    && reservesList.some((a) => getAddress(String(a)) === getAddress(asset));
  if (!member) {
    fail(`FATAL: ${sym} ${asset} is not in Pool.getReservesList at block ${B}`);
    process.exit(1);
  }
}

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
assertAnchor(
  "LP.eETH",
  await read("LP.eETH (round-trip)", { address: A.ETHERFI_LP, abi: abis.lp, functionName: "eETH", blockNumber: B }),
  A.eETH,
);
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
emit(`wrote docs/protocol-matrix-reads.json: ${reads.length} reads, ${unexpectedFailures} unexpected failure(s)`);
process.exit(unexpectedFailures === 0 ? 0 : 1);
