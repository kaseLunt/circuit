/**
 * W03 fork gate: the 13-step SPEC §2 flagship plan executed end-to-end against
 * the pinned anvil fork (block 25,592,678), with:
 *   - snapshot capture reproducing the committed reads log byte-for-byte
 *   - the matrix §7 deposit share model pinned empirically (return value +
 *     share delta == floor formula)
 *   - the exact W03 rebase mutation contract between steps
 *   - HF asserted against Pool.getUserAccountData after every risk-changing
 *     step (no-debt sentinel exactly; 1e-8 relative once debt exists)
 *   - the full final-state assertion list (scaled balances, display balances,
 *     residuals, native accounting, e-mode, collateral flag)
 *   - post-action reserve rates reproduced via the §5.1 strategy formula
 *     (reading reserve deficits live — matrix §9 OPEN item 3)
 *
 * A SECOND run follows at the bottom of this file on a re-forked, un-seeded, un-rebased
 * chain: there the prediction and the execution are the same sequence, so every
 * `core/risk.ts` ledger checkpoint is compared NUMERICALLY against getUserAccountData, and
 * the predicted post-action rates are compared against the rates the protocol wrote.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionResult,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { captureChainSnapshot } from "../../src/server/chain/snapshot";
import {
  buildPlan,
  effectiveLiquidationThresholdBps,
  encodeStep,
  type ChainSnapshot,
  type PlanSuccess,
  type TransactionStep,
} from "../../src/core/plan";
import { computeHealthFactor, hfWadValue, type CollateralEntry } from "../../src/core/health-factor";
import { riskLedger, simulate, type RiskCheckpoint } from "../../src/core/risk";
import {
  accruedVariableBorrowIndexRay,
  currentRatesRay,
  rayAprToApyWad,
  rayDivCeil,
  rayDivFloor,
  rayMulCeil,
  rayMulFloor,
  vTokenBalance,
} from "../../src/core/rates";
import { PINNED_BLOCK, PINNED_TS, bigRead, readResult, readsMeta, tupleBig } from "../helpers/protocol-reads";
import { flagshipGraph } from "../helpers/graphs";
import { ANVIL_URL } from "./anvil";
import { TxRevertedError, getStorageWord, nativeBalance, record, replayRevert, rpc, rpcWithRetry, sendTx, setStorageWord, hexQuantity, type Receipt } from "./harness";
import { decodeRevert } from "../../src/core/errors";

// ————————————————————————— constants (named per W03) —————————————————————————

const INPUT_ETH = "10";
const INPUT_WEI = 10n * 10n ** 18n;
const BORROW_BPS = 7000;
/** buildPlan on the PRISTINE pinned state must equal the unit fixture. */
const EXPECTED_PRISTINE_BORROW_WEI = 6999999999994802135n;
const MAX_UINT256 = 2n ** 256n - 1n;
/** Aggregate wrap-round-trip dust bound: 2 wraps × ≤1 integer share each. */
const EETH_DUST_SHARES_AGGREGATE_MAX = 2n;
const WEETH_RESIDUAL_MAX = 0n;
const WETH_RESIDUAL_MAX = 0n;
/** HF agreement bound: 1 part in 1e8, relative (W03 acceptance). */
const HF_REL_POW = 10n ** 8n;
/** Post-action rate agreement bound: 1e-6 relative (W03 acceptance). */
const RATE_REL_POW = 10n ** 6n;
const SCALED_SUPPLY_BOUND = 2n;
const SCALED_DEBT_BOUND = 1n;
const DISPLAY_BOUND = 1n;
/** Induced rebase: +1.0000% of totalPooledEther (W03 mutation contract). */
const REBASE_DIVISOR = 100n;
const STORAGE_SCAN_SLOTS = 256n;
const U128 = 1n << 128n;

const ABI = {
  pool: parseAbi([
    "function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
    "function getUserEMode(address) view returns (uint256)",
    "function getReserveNormalizedIncome(address) view returns (uint256)",
    "function getReserveNormalizedVariableDebt(address) view returns (uint256)",
    "function getReserveDeficit(address) view returns (uint256)",
  ]),
  data: parseAbi([
    "function getUserReserveData(address,address) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
    "function getReserveData(address) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
    "function getInterestRateStrategyAddress(address) view returns (address)",
    "function getVirtualUnderlyingBalance(address) view returns (uint128)",
    "function getReserveConfigurationData(address) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  ]),
  strategy: parseAbi([
    "function getInterestRateDataBps(address) view returns ((uint16 optimalUsageRatio, uint32 baseVariableBorrowRate, uint32 variableRateSlope1, uint32 variableRateSlope2))",
  ]),
  scaledToken: parseAbi(["function scaledBalanceOf(address) view returns (uint256)"]),
  erc20: parseAbi(["function balanceOf(address) view returns (uint256)"]),
  eeth: parseAbi([
    "function shares(address) view returns (uint256)",
    "function totalShares() view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ]),
  lp: parseAbi([
    "function deposit() payable returns (uint256)",
    "function getTotalPooledEther() view returns (uint256)",
    "function amountForShare(uint256) view returns (uint256)",
  ]),
  weeth: parseAbi(["function wrap(uint256) returns (uint256)"]),
  weth: parseAbi(["function deposit() payable"]),
  oracle: parseAbi(["function getAssetPrice(address) view returns (uint256)"]),
  transfer: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]),
};

const TRANSFER_TOPIC = encodeEventTopics({ abi: ABI.transfer, eventName: "Transfer" })[0];

// ————————————————————————— shared state —————————————————————————

let client: PublicClient;
let wallet: Address;
let pristine: ChainSnapshot;
let seeded: ChainSnapshot;
let plan: PlanSuccess;
let dataProvider: Address;

interface ExecutedStep {
  readonly step: TransactionStep;
  readonly receipt: Receipt;
  readonly resolvedAmount: bigint | null;
  /** eETH share delta for deposit steps. */
  readonly sharesDelta: bigint | null;
}
const executed = new Map<string, ExecutedStep>();
const supplyRecords: Array<{ stepId: string; amountWei: bigint; blockNumber: bigint }> = [];
let borrowRecord: { amountWei: bigint; blockNumber: bigint } | null = null;
const hfWithDebt: bigint[] = [];
let planGasPaid = 0n;
let seedShares = 0n;
let seedWeETH = 0n;
let seedWETH = 0n;
let nativeAfterSeeding = 0n;

function relWithin(actual: bigint, expected: bigint, pow: bigint): boolean {
  const diff = actual > expected ? actual - expected : expected - actual;
  return diff * pow <= expected;
}

function read<T>(args: {
  address: Address;
  abi: typeof ABI[keyof typeof ABI];
  functionName: string;
  fnArgs?: readonly unknown[];
  blockNumber?: bigint;
}): Promise<T> {
  return client.readContract({
    address: args.address,
    abi: args.abi as never,
    functionName: args.functionName as never,
    args: (args.fnArgs ?? []) as never,
    ...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {}),
  }) as Promise<T>;
}

function transferValueTo(receipt: Receipt, token: Address, to: Address): bigint {
  let total = 0n;
  let matches = 0;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(token)) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const decoded = decodeEventLog({
      abi: ABI.transfer,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
    if (getAddress(decoded.args.to) === getAddress(to)) {
      total += decoded.args.value;
      matches += 1;
    }
  }
  if (matches === 0) {
    throw new Error(`no Transfer(→wallet) on ${token} in tx ${receipt.txHash}`);
  }
  return total;
}

/** Token whose Transfer event attributes a producer step's output. */
function outputTokenOf(step: TransactionStep): Address {
  if (step.functionName === "wrap") return step.to;
  if (step.functionName === "borrow") {
    const asset = step.args[0];
    if (asset !== undefined && asset.kind === "value" && typeof asset.value === "string") {
      return getAddress(asset.value);
    }
  }
  throw new Error(`no transfer-event output token for step ${step.id}`);
}

async function resolveAmount(step: TransactionStep): Promise<bigint | null> {
  const spec = step.amount;
  if (spec.kind === "none") return null;
  if (spec.kind === "literal" || spec.kind === "derived") return spec.amount.value;
  const producer = executed.get(spec.producerStepId);
  if (producer === undefined) throw new Error(`producer ${spec.producerStepId} not executed`);
  let output: bigint;
  switch (spec.attribution) {
    case "share-delta": {
      if (producer.sharesDelta === null) throw new Error(`${spec.producerStepId} has no share delta`);
      // Convert rebase-invariant shares to an amount at CONSUMPTION time — this
      // is what survives the induced rebase between producer and consumer.
      output = await read<bigint>({
        address: seeded.etherfi.liquidityPool,
        abi: ABI.lp,
        functionName: "amountForShare",
        fnArgs: [producer.sharesDelta],
      });
      break;
    }
    case "transfer-event":
      output = transferValueTo(producer.receipt, outputTokenOf(producer.step), wallet);
      break;
    case "withdraw-argument":
      if (producer.resolvedAmount === null) throw new Error(`${spec.producerStepId} has no amount`);
      output = producer.resolvedAmount;
      break;
    case "return-value":
      throw new Error("return-value attribution is not used by the flagship plan");
  }
  if (spec.allocationBps === 10_000) return output;
  return (output * BigInt(spec.allocationBps)) / 10_000n;
}

async function executeStep(step: TransactionStep): Promise<ExecutedStep> {
  const resolved = await resolveAmount(step);
  const encoded =
    step.amount.kind === "step-output" ? encodeStep(step, resolved!) : encodeStep(step);
  const preShares =
    step.functionName === "deposit"
      ? await read<bigint>({ address: seeded.etherfi.eETH, abi: ABI.eeth, functionName: "shares", fnArgs: [wallet] })
      : null;
  let receipt: Receipt;
  try {
    receipt = await sendTx({ from: wallet, to: encoded.to, data: encoded.data, value: encoded.value });
  } catch (cause) {
    if (cause instanceof TxRevertedError) {
      const revertData = await replayRevert(cause.txHash);
      const decoded =
        revertData !== null && revertData.startsWith("0x") ? decodeRevert(revertData) : null;
      throw new Error(
        `step ${step.id} reverted (${cause.txHash}): ${
          decoded !== null ? `${decoded.message} [${decoded.raw}]` : String(revertData)
        }`,
      );
    }
    throw cause;
  }
  const sharesDelta =
    preShares !== null
      ? (await read<bigint>({ address: seeded.etherfi.eETH, abi: ABI.eeth, functionName: "shares", fnArgs: [wallet] })) - preShares
      : null;
  const record: ExecutedStep = { step, receipt, resolvedAmount: resolved, sharesDelta };
  executed.set(step.id, record);
  planGasPaid += receipt.gasUsed * receipt.effectiveGasPrice;
  if (step.functionName === "supply") {
    supplyRecords.push({ stepId: step.id, amountWei: resolved!, blockNumber: receipt.blockNumber });
  }
  if (step.functionName === "borrow") {
    borrowRecord = { amountWei: resolved!, blockNumber: receipt.blockNumber };
  }
  return record;
}

/** Our accounting reconstruction of the position, priced like Aave does. */
async function ourHealthFactor(): Promise<ReturnType<typeof computeHealthFactor>> {
  const weETH = seeded.reserves.weETH.underlying;
  const WETH = seeded.reserves.WETH.underlying;
  const oracle = await oracleAddress();
  let scaledCollateral = 0n;
  for (const s of supplyRecords) {
    const normAtSupply = await read<bigint>({
      address: seeded.pool,
      abi: ABI.pool,
      functionName: "getReserveNormalizedIncome",
      fnArgs: [weETH],
      blockNumber: s.blockNumber,
    });
    scaledCollateral += rayDivFloor(s.amountWei, normAtSupply);
  }
  const normNow = await read<bigint>({ address: seeded.pool, abi: ABI.pool, functionName: "getReserveNormalizedIncome", fnArgs: [weETH] });
  const priceWeETH = await read<bigint>({ address: oracle, abi: ABI.oracle, functionName: "getAssetPrice", fnArgs: [weETH] });
  const collateralDisplay = rayMulFloor(scaledCollateral, normNow);
  const collateralBase = (collateralDisplay * priceWeETH) / 10n ** 18n;

  let debtBase: bigint | null = 0n;
  if (borrowRecord !== null) {
    const normDebtAtBorrow = await read<bigint>({
      address: seeded.pool,
      abi: ABI.pool,
      functionName: "getReserveNormalizedVariableDebt",
      fnArgs: [WETH],
      blockNumber: borrowRecord.blockNumber,
    });
    const debtScaled = rayDivCeil(borrowRecord.amountWei, normDebtAtBorrow);
    const normDebtNow = await read<bigint>({ address: seeded.pool, abi: ABI.pool, functionName: "getReserveNormalizedVariableDebt", fnArgs: [WETH] });
    const priceWETH = await read<bigint>({ address: oracle, abi: ABI.oracle, functionName: "getAssetPrice", fnArgs: [WETH] });
    debtBase = (rayMulCeil(debtScaled, normDebtNow) * priceWETH) / 10n ** 18n;
  }
  // Matrix §3 (GenericLogic.calculateUserAccountData): the CATEGORY threshold applies only to
  // collateral-bitmap members, otherwise the reserve's own. Read the category LIVE — `seeded`
  // was captured before the plan's setUserEMode step ran, so its user category is still 0 and
  // using it would silently fall back to the reserve threshold mid-sequence.
  const liveCategoryId = Number(
    await read<bigint>({ address: seeded.pool, abi: ABI.pool, functionName: "getUserEMode", fnArgs: [wallet] }),
  );
  let activeCategory = null;
  if (liveCategoryId !== 0) {
    const found = seeded.eModeCategories.find((c) => c.id === liveCategoryId);
    // Never fall back to the reserve threshold for an undescribed category: that would quietly
    // weaken the assertion instead of surfacing a fixture gap.
    if (found === undefined) {
      throw new Error(`live e-mode category ${liveCategoryId} is absent from the snapshot`);
    }
    activeCategory = found;
  }
  const ltBps = effectiveLiquidationThresholdBps(seeded.reserves.weETH, activeCategory);
  const entries: CollateralEntry[] = collateralBase > 0n ? [{ base: collateralBase, ltBps }] : [];
  return computeHealthFactor(entries, debtBase);
}

async function chainHealthFactor(): Promise<bigint> {
  const acct = await read<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>({
    address: seeded.pool,
    abi: ABI.pool,
    functionName: "getUserAccountData",
    fnArgs: [wallet],
  });
  return acct[5];
}

async function assertHfAgreement(label: string): Promise<void> {
  const ours = await ourHealthFactor();
  const chain = await chainHealthFactor();
  if (ours.status === "no-debt") {
    expect(chain, `${label}: no-debt sentinel`).toBe(MAX_UINT256);
    return;
  }
  if (ours.status !== "healthy") throw new Error(`${label}: HF unexpectedly ${ours.status}`);
  expect(
    relWithin(ours.hfWad, chain, HF_REL_POW),
    `${label}: |${ours.hfWad} - ${chain}| beyond 1e-8 relative`,
  ).toBe(true);
  hfWithDebt.push(ours.hfWad);
}

let cachedOracle: Address | null = null;
async function oracleAddress(): Promise<Address> {
  if (cachedOracle !== null) return cachedOracle;
  const anchors = (readsMeta as { oracle?: string }).oracle;
  if (typeof anchors !== "string") throw new Error("reads log meta.oracle missing");
  cachedOracle = getAddress(anchors);
  return cachedOracle;
}

// ————————————————————————— suite —————————————————————————

describe("W03 fork gate — SPEC §2 flagship on the pinned fork", () => {
  beforeAll(async () => {
    // The fork IS mainnet state, so mainnet's Multicall3 deployment applies.
    client = createPublicClient({ chain: mainnet, transport: http(ANVIL_URL, { timeout: 120_000 }) }) as unknown as PublicClient;
    // NOT an anvil default account: their public dev keys mean mainnet carries
    // EIP-7702 delegations on those addresses, and delegated fallbacks OOG the
    // 2300-gas stipend of WETH9.withdraw's ETH send. A fresh impersonated EOA,
    // verified code-free, sidesteps that entire class.
    wallet = getAddress("0x1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c");
    const code = await rpc<string>("eth_getCode", [wallet, "latest"]);
    if (code !== "0x") {
      throw new Error(`test wallet ${wallet} unexpectedly has code (${code.length} bytes) — pick an empty EOA`);
    }
    await rpc("anvil_setBalance", [wallet, hexQuantity(100_000n * 10n ** 18n)]);
    await rpc("anvil_impersonateAccount", [wallet]);
    pristine = await captureChainSnapshot(client, {
      user: wallet,
      blockNumber: PINNED_BLOCK,
      expectBlockHash: readsMeta.pinned_block.hash as `0x${string}`,
    });
    dataProvider = getAddress(
      (readsMeta as unknown as { pool_data_provider: string }).pool_data_provider,
    );
  });

  it("snapshot capture pins the fixture and reproduces the committed log exactly", () => {
    expect(pristine.block).toBe(PINNED_BLOCK);
    expect(pristine.blockTimestamp).toBe(PINNED_TS);
    expect(pristine.reserves.weETH.aTokenScaledTotalSupply.value).toBe(bigRead("weETH.aToken.scaledTotalSupply"));
    expect(pristine.reserves.weETH.variableDebtScaledTotalSupply.value).toBe(bigRead("weETH.variableDebtToken.scaledTotalSupply"));
    expect(pristine.reserves.WETH.aTokenScaledTotalSupply.value).toBe(bigRead("WETH.aToken.scaledTotalSupply"));
    expect(pristine.reserves.WETH.variableDebtScaledTotalSupply.value).toBe(bigRead("WETH.variableDebtToken.scaledTotalSupply"));
    expect(pristine.reserves.weETH.priceBase.value).toBe(bigRead("Oracle.getAssetPrice(weETH)"));
    expect(pristine.reserves.WETH.priceBase.value).toBe(bigRead("Oracle.getAssetPrice(WETH)"));
    expect(pristine.reserves.weETH.virtualUnderlyingBalance.value).toBe(bigRead("weETH.getVirtualUnderlyingBalance"));
    expect(pristine.reserves.WETH.virtualUnderlyingBalance.value).toBe(bigRead("WETH.getVirtualUnderlyingBalance"));
    expect(pristine.eModeCategories[0]!.collateralBitmap.value).toBe(bigRead("eMode1.collateralBitmap"));
    expect(pristine.eModeCategories[0]!.borrowableBitmap.value).toBe(bigRead("eMode1.borrowableBitmap"));
    // The §5.1 rate-strategy family: the strategy ADDRESS is read per reserve and the bps
    // struct is read off it, so a market that re-pointed a reserve at a new strategy shows
    // up here rather than silently changing every post-action rate.
    for (const key of ["weETH", "WETH"] as const) {
      const reserve = pristine.reserves[key];
      expect(reserve.deficit.value, `${key} deficit`).toBe(bigRead(`${key}.getReserveDeficit`));
      expect(reserve.reserveFactorBps.value, `${key} reserveFactor`).toBe(
        Number(tupleBig(`${key}.getReserveConfigurationData`, 4)),
      );
      expect(reserve.rateStrategy.value, `${key} rateStrategy`).toEqual(
        readResult(`${key}.strategy.getInterestRateDataBps`),
      );
    }
    expect(pristine.etherfi.totalPooledEther.value).toBe(bigRead("LP.getTotalPooledEther"));
    expect(pristine.etherfi.totalShares.value).toBe(bigRead("eETH.totalShares"));
    expect(pristine.user.eModeCategoryId.value).toBe(0);
    expect(pristine.user.hasAaveFootprint.value).toBe(false);
  });

  it("buildPlan on the pristine snapshot reproduces the unit fixture", () => {
    const result = buildPlan(flagshipGraph(INPUT_ETH, BORROW_BPS), pristine);
    if (!result.ok) throw new Error(`pristine plan failed: ${JSON.stringify(result.errors)}`);
    expect(result.steps).toHaveLength(13);
    expect(result.targetEModeCategoryId).toBe(1);
    const borrow = result.steps.find((s) => s.id === "borrow:borrow")!;
    if (borrow.amount.kind !== "derived") throw new Error("borrow amount must be derived");
    expect(borrow.amount.amount.value).toBe(EXPECTED_PRISTINE_BORROW_WEI);
  });

  it("seeds pre-existing eETH shares, weETH and WETH, then re-plans from the seeded state", async () => {
    const lp = pristine.etherfi.liquidityPool;
    const eETH = pristine.etherfi.eETH;
    const weETH = pristine.etherfi.weETH;
    const WETH = pristine.reserves.WETH.underlying;
    await sendTx({ from: wallet, to: lp, data: encodeFunctionData({ abi: ABI.lp, functionName: "deposit" }), value: 2n * 10n ** 18n });
    await sendTx({ from: wallet, to: eETH, data: encodeFunctionData({ abi: ABI.eeth, functionName: "approve", args: [weETH, 10n ** 18n] }) });
    await sendTx({ from: wallet, to: weETH, data: encodeFunctionData({ abi: ABI.weeth, functionName: "wrap", args: [10n ** 18n] }) });
    await sendTx({ from: wallet, to: WETH, data: encodeFunctionData({ abi: ABI.weth, functionName: "deposit" }), value: 10n ** 18n });

    seedShares = await read<bigint>({ address: eETH, abi: ABI.eeth, functionName: "shares", fnArgs: [wallet] });
    seedWeETH = await read<bigint>({ address: weETH, abi: ABI.erc20, functionName: "balanceOf", fnArgs: [wallet] });
    seedWETH = await read<bigint>({ address: WETH, abi: ABI.erc20, functionName: "balanceOf", fnArgs: [wallet] });
    nativeAfterSeeding = await nativeBalance(wallet);
    expect(seedShares > 0n).toBe(true);
    expect(seedWeETH > 0n).toBe(true);
    expect(seedWETH).toBe(10n ** 18n);

    seeded = await captureChainSnapshot(client, { user: wallet });
    // Wallet tokens are NOT an Aave footprint — the predicate must stay false.
    expect(seeded.user.hasAaveFootprint.value).toBe(false);
    const result = buildPlan(flagshipGraph(INPUT_ETH, BORROW_BPS), seeded);
    if (!result.ok) throw new Error(`seeded plan failed: ${JSON.stringify(result.errors)}`);
    plan = result;
    expect(plan.steps).toHaveLength(13);
  });

  it("step 1 (deposit): return value and share delta both equal the matrix §7 floor formula", async () => {
    const step = plan.steps[0]!;
    expect(step.id).toBe("stake1:deposit");
    const lp = seeded.etherfi.liquidityPool;
    const [totalShares, totalPooled] = await Promise.all([
      read<bigint>({ address: seeded.etherfi.eETH, abi: ABI.eeth, functionName: "totalShares" }),
      read<bigint>({ address: lp, abi: ABI.lp, functionName: "getTotalPooledEther" }),
    ]);
    const predicted = (INPUT_WEI * totalShares) / totalPooled;

    // Pin the deposit RETURN VALUE via eth_call at the pre-state (OPEN item 1).
    const call = await client.call({
      account: wallet,
      to: lp,
      data: encodeFunctionData({ abi: ABI.lp, functionName: "deposit" }),
      value: INPUT_WEI,
    });
    const returned = decodeFunctionResult({ abi: ABI.lp, functionName: "deposit", data: call.data! });
    expect(returned).toBe(predicted);

    const record = await executeStep(step);
    expect(record.sharesDelta).toBe(predicted);
  });

  it("induces the exact W03 rebase between steps via the packed-accounting storage word", async () => {
    const lp = seeded.etherfi.liquidityPool;
    const totalBefore = await read<bigint>({ address: lp, abi: ABI.lp, functionName: "getTotalPooledEther" });
    const sharesBefore = await read<bigint>({ address: seeded.etherfi.eETH, abi: ABI.eeth, functionName: "totalShares" });

    const matches: Array<{ slot: bigint; word: bigint }> = [];
    for (let slot = 0n; slot < STORAGE_SCAN_SLOTS; slot += 1n) {
      const word = await getStorageWord(lp, slot);
      if (word === 0n) continue;
      const low = word & (U128 - 1n);
      const high = word >> 128n;
      if (low + high === totalBefore) matches.push({ slot, word });
    }
    if (matches.length !== 1) {
      throw new Error(
        `packed-accounting scan must find exactly one slot; found ${matches.length}: ${JSON.stringify(
          matches.map((m) => ({ slot: m.slot.toString(), word: m.word.toString(16) })),
        )}`,
      );
    }
    const { slot, word } = matches[0]!;
    const delta = totalBefore / REBASE_DIVISOR;
    const low = word & (U128 - 1n);
    expect(low + delta < U128, "low half must not overflow into the high half").toBe(true);
    const neighborBefore = await Promise.all([getStorageWord(lp, slot - 1n), getStorageWord(lp, slot + 1n)]);
    await setStorageWord(lp, slot, word + delta);

    const totalAfter = await read<bigint>({ address: lp, abi: ABI.lp, functionName: "getTotalPooledEther" });
    expect(totalAfter).toBe(totalBefore + delta);
    const neighborAfter = await Promise.all([getStorageWord(lp, slot - 1n), getStorageWord(lp, slot + 1n)]);
    expect(neighborAfter[0]).toBe(neighborBefore[0]);
    expect(neighborAfter[1]).toBe(neighborBefore[1]);
    const sharesAfter = await read<bigint>({ address: seeded.etherfi.eETH, abi: ABI.eeth, functionName: "totalShares" });
    expect(sharesAfter).toBe(sharesBefore);
    const rate = await read<bigint>({ address: lp, abi: ABI.lp, functionName: "amountForShare", fnArgs: [10n ** 18n] });
    expect(rate).toBe((10n ** 18n * totalAfter) / sharesAfter);
    // Recorded per the W03 mutation contract: slot id + pre/post words.
    record(
      `rebase: slot ${slot} word ${word.toString(16)} -> ${(word + delta).toString(16)} (delta ${delta})`,
    );
  });

  it("executes steps 2–13 green, asserting HF against the chain after every risk-changing step", async () => {
    const riskStepIds = new Set(["supply1:set-emode", "supply1:supply", "borrow:borrow", "supply2:supply"]);
    for (const step of plan.steps.slice(1)) {
      await executeStep(step);
      if (riskStepIds.has(step.id)) {
        await assertHfAgreement(`after ${step.id}`);
      }
    }
    expect(executed.size).toBe(13);
    expect(hfWithDebt.length).toBe(2); // borrow + resupply carry debt
  });

  /**
   * The §5.4 cross-check `riskLedger` exists for: the minimum health factor is a claim about
   * a moment DURING execution, and a single reading taken afterwards cannot check it.
   *
   * The chain-verified readings above are the evidence. `hfWithDebt` holds the two
   * debt-bearing health factors in execution order, each already asserted to within 1e-8 of
   * `Pool.getUserAccountData().healthFactor`; the ledger must agree about which of them is
   * the minimum and about where it sits.
   *
   * Deliberately NOT a byte-exact numeric comparison: this suite induces a rebase between
   * steps 1 and 2, so the executed amounts differ from the block-pinned prediction by
   * design. Pinning the digits is the unit suite's job over the reads log; what only the
   * fork can prove is that the shape of the claim survives real execution.
   */
  it("riskLedger agrees with the chain about where the minimum health factor sits", () => {
    const ledger = riskLedger(flagshipGraph(INPUT_ETH, BORROW_BPS), seeded);
    expect(ledger.ok).toBe(true);
    expect(ledger.errors).toEqual([]);

    // One checkpoint per risk-changing step, in plan order.
    expect(ledger.checkpoints.map((c) => `${c.blockId}:${c.cause}`)).toEqual([
      "supply1:supply",
      "borrow:borrow",
      "supply2:supply",
    ]);
    // The pre-borrow checkpoint carries no debt — the same thing the chain reported as the
    // no-debt sentinel after supply1.
    expect(ledger.checkpoints[0]!.healthFactor).toEqual({ status: "no-debt" });

    const min = ledger.min;
    const final = ledger.final;
    if (min === null || final === null) throw new Error("ledger produced no checkpoints");
    if (min.healthFactor.status !== "healthy") throw new Error("min HF is not healthy");
    if (final.healthFactor.status !== "healthy") throw new Error("final HF is not healthy");

    // The minimum is mid-execution: debt opens against the first supply alone, before the
    // loop's second collateral lands.
    expect(min.blockId).toBe("borrow");
    expect(final.blockId).toBe("supply2");
    expect(min.healthFactor.hfWad).toBeLessThan(final.healthFactor.hfWad);

    // …and the chain said exactly that, in the same order.
    const [afterBorrow, afterResupply] = hfWithDebt as [bigint, bigint];
    expect(afterBorrow).toBeLessThan(afterResupply);
    record(
      `ledger min at ${min.blockId} (${min.healthFactor.hfWad}) < final at ${final.blockId} ` +
        `(${final.healthFactor.hfWad}); chain-verified ${afterBorrow} < ${afterResupply}`,
    );

    // The correlated pair the liquidation ratio is defined over is the position at the
    // minimum, not at the end — one collateral reserve against one debt reserve.
    expect(min.collateralWei).not.toBeNull();
    expect(min.debtWei).not.toBeNull();
    expect(min.supplies).toHaveLength(1);
    expect(min.debts).toHaveLength(1);
  });

  it("final state: e-mode, collateral flag, scaled balances, display balances", async () => {
    const weETH = seeded.reserves.weETH;
    const WETH = seeded.reserves.WETH;
    const emode = await read<bigint>({ address: seeded.pool, abi: ABI.pool, functionName: "getUserEMode", fnArgs: [wallet] });
    expect(emode).toBe(1n);

    const userReserve = await read<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean]>({
      address: dataProvider,
      abi: ABI.data,
      functionName: "getUserReserveData",
      fnArgs: [weETH.underlying, wallet],
    });
    expect(userReserve[8], "weETH usageAsCollateralEnabledOnUser").toBe(true);

    let expectedScaledCollateral = 0n;
    for (const s of supplyRecords) {
      const norm = await read<bigint>({
        address: seeded.pool,
        abi: ABI.pool,
        functionName: "getReserveNormalizedIncome",
        fnArgs: [weETH.underlying],
        blockNumber: s.blockNumber,
      });
      expectedScaledCollateral += rayDivFloor(s.amountWei, norm);
    }
    const chainScaledCollateral = await read<bigint>({ address: weETH.aToken, abi: ABI.scaledToken, functionName: "scaledBalanceOf", fnArgs: [wallet] });
    const scaledCollateralDiff =
      chainScaledCollateral > expectedScaledCollateral
        ? chainScaledCollateral - expectedScaledCollateral
        : expectedScaledCollateral - chainScaledCollateral;
    expect(scaledCollateralDiff <= SCALED_SUPPLY_BOUND, `scaled collateral diff ${scaledCollateralDiff}`).toBe(true);

    const normDebtAtBorrow = await read<bigint>({
      address: seeded.pool,
      abi: ABI.pool,
      functionName: "getReserveNormalizedVariableDebt",
      fnArgs: [WETH.underlying],
      blockNumber: borrowRecord!.blockNumber,
    });
    const expectedScaledDebt = rayDivCeil(borrowRecord!.amountWei, normDebtAtBorrow);
    const chainScaledDebt = await read<bigint>({ address: WETH.variableDebtToken, abi: ABI.scaledToken, functionName: "scaledBalanceOf", fnArgs: [wallet] });
    const scaledDebtDiff =
      chainScaledDebt > expectedScaledDebt ? chainScaledDebt - expectedScaledDebt : expectedScaledDebt - chainScaledDebt;
    expect(scaledDebtDiff <= SCALED_DEBT_BOUND, `scaled debt diff ${scaledDebtDiff}`).toBe(true);

    // Display-level recomputation from the final block's indices vs balanceOf.
    const normNow = await read<bigint>({ address: seeded.pool, abi: ABI.pool, functionName: "getReserveNormalizedIncome", fnArgs: [weETH.underlying] });
    const aBal = await read<bigint>({ address: weETH.aToken, abi: ABI.erc20, functionName: "balanceOf", fnArgs: [wallet] });
    // Recompute from the CHAIN's scaled balance, not the expected one: the scaled amounts are
    // already asserted against expectation above with their own bounds, so recomputing from
    // expectation here would sum both error sources and slacken this to 3 wei. Driving it from
    // chain scaled isolates display-index rounding, which is what W03 bounds at 1 wei.
    const aDisplay = rayMulFloor(chainScaledCollateral, normNow);
    const aDiff = aBal > aDisplay ? aBal - aDisplay : aDisplay - aBal;
    expect(aDiff <= DISPLAY_BOUND, `aToken display diff ${aDiff}`).toBe(true);

    const normDebtNow = await read<bigint>({ address: seeded.pool, abi: ABI.pool, functionName: "getReserveNormalizedVariableDebt", fnArgs: [WETH.underlying] });
    const vBal = await read<bigint>({ address: WETH.variableDebtToken, abi: ABI.erc20, functionName: "balanceOf", fnArgs: [wallet] });
    const vDisplay = rayMulCeil(chainScaledDebt, normDebtNow);
    const vDiff = vBal > vDisplay ? vBal - vDisplay : vDisplay - vBal;
    expect(vDiff <= DISPLAY_BOUND, `debt display diff ${vDiff}`).toBe(true);
  });

  it("no-sweep residuals and exact native accounting", async () => {
    const weETH = seeded.etherfi.weETH;
    const WETH = seeded.reserves.WETH.underlying;
    const eETH = seeded.etherfi.eETH;

    const weETHFinal = await read<bigint>({ address: weETH, abi: ABI.erc20, functionName: "balanceOf", fnArgs: [wallet] });
    const wethFinal = await read<bigint>({ address: WETH, abi: ABI.erc20, functionName: "balanceOf", fnArgs: [wallet] });
    const sharesFinal = await read<bigint>({ address: eETH, abi: ABI.eeth, functionName: "shares", fnArgs: [wallet] });

    const weETHDiff = weETHFinal > seedWeETH ? weETHFinal - seedWeETH : seedWeETH - weETHFinal;
    expect(weETHDiff <= WEETH_RESIDUAL_MAX, `weETH residual ${weETHDiff}`).toBe(true);
    const wethDiff = wethFinal > seedWETH ? wethFinal - seedWETH : seedWETH - wethFinal;
    expect(wethDiff <= WETH_RESIDUAL_MAX, `WETH residual ${wethDiff}`).toBe(true);

    // Plan deposits mint shares; wraps consume all but ≤1 integer share each.
    const shareResidual = sharesFinal - seedShares;
    expect(shareResidual >= 0n, `share residual ${shareResidual} went negative`).toBe(true);
    expect(
      shareResidual <= EETH_DUST_SHARES_AGGREGATE_MAX,
      `share residual ${shareResidual} beyond the aggregate wrap-dust bound`,
    ).toBe(true);

    const nativeFinal = await nativeBalance(wallet);
    expect(nativeAfterSeeding - nativeFinal).toBe(INPUT_WEI + planGasPaid);
  });

  it("post-action reserve rates reproduce via the §5.1 strategy formula (deficits read live)", async () => {
    for (const key of ["weETH", "WETH"] as const) {
      const reserve = seeded.reserves[key];
      const rd = await read<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, number]>({
        address: dataProvider,
        abi: ABI.data,
        functionName: "getReserveData",
        fnArgs: [reserve.underlying],
      });
      const cfg = await read<readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean]>({
        address: dataProvider,
        abi: ABI.data,
        functionName: "getReserveConfigurationData",
        fnArgs: [reserve.underlying],
      });
      const strategyAddr = await read<Address>({ address: dataProvider, abi: ABI.data, functionName: "getInterestRateStrategyAddress", fnArgs: [reserve.underlying] });
      const strat = await read<{ optimalUsageRatio: number; baseVariableBorrowRate: number; variableRateSlope1: number; variableRateSlope2: number }>({
        address: strategyAddr,
        abi: ABI.strategy,
        functionName: "getInterestRateDataBps",
        fnArgs: [reserve.underlying],
      });
      const virtual = await read<bigint>({ address: dataProvider, abi: ABI.data, functionName: "getVirtualUnderlyingBalance", fnArgs: [reserve.underlying] });
      const deficit = await read<bigint>({ address: seeded.pool, abi: ABI.pool, functionName: "getReserveDeficit", fnArgs: [reserve.underlying] });
      const scaledTotal = await client.readContract({
        address: reserve.variableDebtToken,
        abi: parseAbi(["function scaledTotalSupply() view returns (uint256)"]),
        functionName: "scaledTotalSupply",
      });

      const predicted = currentRatesRay({
        strategy: {
          optimalUsageRatio: strat.optimalUsageRatio,
          baseVariableBorrowRate: strat.baseVariableBorrowRate,
          variableRateSlope1: strat.variableRateSlope1,
          variableRateSlope2: strat.variableRateSlope2,
        },
        reserveFactorBps: Number(cfg[4]),
        totalDebtWei: rayMulCeil(scaledTotal, rd[10]),
        virtualUnderlyingBalance: virtual,
        liquidityAddedWei: 0n,
        liquidityTakenWei: 0n,
        deficitWei: deficit,
      });
      record(`${key}: reserve deficit (live read) = ${deficit}`);
      expect(
        relWithin(predicted.variableBorrowRateRay, rd[6], RATE_REL_POW),
        `${key} variable rate: predicted ${predicted.variableBorrowRateRay} vs stored ${rd[6]}`,
      ).toBe(true);
      expect(
        relWithin(predicted.liquidityRateRay, rd[5], RATE_REL_POW),
        `${key} liquidity rate: predicted ${predicted.liquidityRateRay} vs stored ${rd[5]}`,
      ).toBe(true);
    }
  });
});

/**
 * A SECOND fork run, deliberately without the seeding and without the induced rebase above.
 *
 * Those two exist to prove that attribution survives adversarial state, and they make the
 * executed amounts differ from the block-pinned prediction ON PURPOSE. The minimum-health-
 * factor claim is a claim about the prediction, so checking it numerically needs a run where
 * the prediction and the execution are the same sequence — which is what this is.
 *
 * What only the fork can prove, and what this asserts:
 *   - every `riskLedger` checkpoint against `Pool.getUserAccountData().healthFactor`, taken
 *     immediately after the step that produced it, and
 *   - the post-action rate `core/risk.ts` PREDICTS against the rate the protocol actually
 *     wrote once the action executed (Codex finding 1's model, end to end).
 */
describe("W03 fork gate — riskLedger against the chain on a clean, un-rebased fork", () => {
  /**
   * Declared bound: 1 part in 1e6, relative. It covers the only differences that can exist
   * between a block-pinned prediction and this execution — index accrual over the ~12 blocks
   * the plan takes (aToken and vToken both, dominated by WETH debt at ~2.1% APR, i.e. ~1e-8
   * relative), plus the sub-wei directional rounding on the scaled mints. It does NOT cover a
   * modelling error: at 1e-6 the stale-debt model finding 1 corrected would still fail here.
   */
  const LEDGER_HF_REL_POW = 10n ** 6n;

  let cleanWallet: Address;
  let cleanSnapshot: ChainSnapshot;
  let cleanPlan: PlanSuccess;
  let cleanLedger: ReturnType<typeof riskLedger>;
  const cleanExecuted = new Map<string, ExecutedStep>();
  let actualBorrowRateRay: bigint | null = null;
  let actualLiquidityRateRay: bigint | null = null;

  async function resolveCleanAmount(step: TransactionStep): Promise<bigint | null> {
    const spec = step.amount;
    if (spec.kind === "none") return null;
    if (spec.kind === "literal" || spec.kind === "derived") return spec.amount.value;
    const producer = cleanExecuted.get(spec.producerStepId);
    if (producer === undefined) throw new Error(`producer ${spec.producerStepId} not executed`);
    let output: bigint;
    switch (spec.attribution) {
      case "share-delta": {
        if (producer.sharesDelta === null) {
          throw new Error(`${spec.producerStepId} has no share delta`);
        }
        output = await read<bigint>({
          address: cleanSnapshot.etherfi.liquidityPool,
          abi: ABI.lp,
          functionName: "amountForShare",
          fnArgs: [producer.sharesDelta],
        });
        break;
      }
      case "transfer-event":
        output = transferValueTo(producer.receipt, outputTokenOf(producer.step), cleanWallet);
        break;
      case "withdraw-argument":
        if (producer.resolvedAmount === null) {
          throw new Error(`${spec.producerStepId} has no amount`);
        }
        output = producer.resolvedAmount;
        break;
      case "return-value":
        throw new Error("return-value attribution is not used by the flagship plan");
    }
    if (spec.allocationBps === 10_000) return output;
    return (output * BigInt(spec.allocationBps)) / 10_000n;
  }

  async function executeClean(step: TransactionStep): Promise<void> {
    const resolved = await resolveCleanAmount(step);
    const encoded =
      step.amount.kind === "step-output" ? encodeStep(step, resolved!) : encodeStep(step);
    const shares = (): Promise<bigint> =>
      read<bigint>({
        address: cleanSnapshot.etherfi.eETH,
        abi: ABI.eeth,
        functionName: "shares",
        fnArgs: [cleanWallet],
      });
    const preShares = step.functionName === "deposit" ? await shares() : null;
    const receipt = await sendTx({
      from: cleanWallet,
      to: encoded.to,
      data: encoded.data,
      value: encoded.value,
    });
    cleanExecuted.set(step.id, {
      step,
      receipt,
      resolvedAmount: resolved,
      sharesDelta: preShares === null ? null : (await shares()) - preShares,
    });
  }

  async function reserveRatesOf(
    sym: "weETH" | "WETH",
  ): Promise<{ liquidity: bigint; borrow: bigint }> {
    const rd = await read<
      readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, number]
    >({
      address: dataProvider,
      abi: ABI.data,
      functionName: "getReserveData",
      fnArgs: [cleanSnapshot.reserves[sym].underlying],
    });
    return { liquidity: rd[5], borrow: rd[6] };
  }

  beforeAll(async () => {
    // Re-fork at the pin so this run starts from clean fixture state. Identity is re-verified
    // by hash: a reset that silently landed elsewhere would measure every assertion below
    // against the wrong history.
    await rpcWithRetry("anvil_reset", [{ forking: { blockNumber: Number(PINNED_BLOCK) } }]);
    const pinned = await rpc<{ hash?: string } | null>("eth_getBlockByNumber", [
      hexQuantity(PINNED_BLOCK),
      false,
    ]);
    if (pinned === null || pinned.hash !== readsMeta.pinned_block.hash) {
      throw new Error(
        `fork identity mismatch after reset at ${PINNED_BLOCK}: ${pinned?.hash ?? "null"}`,
      );
    }

    client = createPublicClient({
      chain: mainnet,
      transport: http(ANVIL_URL, { timeout: 120_000 }),
    }) as unknown as PublicClient;
    dataProvider = getAddress(
      (readsMeta as unknown as { pool_data_provider: string }).pool_data_provider,
    );
    // A different empty EOA from the run above, verified code-free for the same EIP-7702
    // reason documented there.
    cleanWallet = getAddress("0x2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c");
    const code = await rpc<string>("eth_getCode", [cleanWallet, "latest"]);
    if (code !== "0x") {
      throw new Error(`clean wallet ${cleanWallet} unexpectedly has code — pick an empty EOA`);
    }
    await rpc("anvil_setBalance", [cleanWallet, hexQuantity(100_000n * 10n ** 18n)]);
    await rpc("anvil_impersonateAccount", [cleanWallet]);

    cleanSnapshot = await captureChainSnapshot(client, {
      user: cleanWallet,
      blockNumber: PINNED_BLOCK,
      expectBlockHash: readsMeta.pinned_block.hash as `0x${string}`,
    });
    const built = buildPlan(flagshipGraph(INPUT_ETH, BORROW_BPS), cleanSnapshot);
    if (!built.ok) throw new Error(`clean plan failed: ${JSON.stringify(built.errors)}`);
    cleanPlan = built;
    cleanLedger = riskLedger(flagshipGraph(INPUT_ETH, BORROW_BPS), cleanSnapshot);
    expect(cleanPlan.steps).toHaveLength(13);
    expect(cleanLedger.ok).toBe(true);
  });

  it("matches EVERY ledger checkpoint against getUserAccountData, step by step", async () => {
    const finalStepOf = (cp: RiskCheckpoint): string =>
      cp.cause === "supply" ? `${cp.blockId}:supply` : `${cp.blockId}:borrow`;
    const checkpointByStep = new Map(cleanLedger.checkpoints.map((cp) => [finalStepOf(cp), cp]));
    expect([...checkpointByStep.keys()]).toEqual([
      "supply1:supply",
      "borrow:borrow",
      "supply2:supply",
    ]);

    let compared = 0;
    for (const step of cleanPlan.steps) {
      await executeClean(step);

      // Finding 1's end-to-end evidence: read the rate the protocol WROTE, at the moment the
      // action wrote it, so the prediction can be checked against it below.
      if (step.id === "borrow:borrow") actualBorrowRateRay = (await reserveRatesOf("WETH")).borrow;
      if (step.id === "supply2:supply") {
        actualLiquidityRateRay = (await reserveRatesOf("weETH")).liquidity;
      }

      const checkpoint = checkpointByStep.get(step.id);
      if (checkpoint === undefined) continue;
      const chainHf = (
        await read<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>({
          address: cleanSnapshot.pool,
          abi: ABI.pool,
          functionName: "getUserAccountData",
          fnArgs: [cleanWallet],
        })
      )[5];
      const ours = hfWadValue(checkpoint.healthFactor);
      if (ours === null) throw new Error(`${step.id}: ledger health factor is unknown`);
      if (checkpoint.healthFactor.status === "no-debt") {
        expect(chainHf, `${step.id}: no-debt sentinel`).toBe(MAX_UINT256);
      } else {
        expect(
          relWithin(ours, chainHf, LEDGER_HF_REL_POW),
          `${step.id}: ledger ${ours} vs chain ${chainHf} beyond 1e-6 relative`,
        ).toBe(true);
      }
      record(`ledger ${step.id}: ours ${ours} vs chain ${chainHf}`);
      compared += 1;
    }

    expect(compared, "every risk-changing checkpoint was compared").toBe(3);
    expect(cleanExecuted.size).toBe(13);

    // The claim the whole module exists to make, now measured against the chain: the minimum
    // is DURING execution, and a reading taken afterwards would have missed it.
    const min = cleanLedger.min;
    const final = cleanLedger.final;
    if (min === null || final === null) throw new Error("ledger produced no checkpoints");
    expect(min.blockId).toBe("borrow");
    expect(final.blockId).toBe("supply2");
    expect(hfWadValue(min.healthFactor)!).toBeLessThan(hfWadValue(final.healthFactor)!);
  });

  /**
   * The WETH borrow leg, compared at the borrow transaction's OWN block timestamp — and
   * therefore compared EXACTLY.
   *
   * Why exact is available here: nothing between the pinned block and this transaction
   * touches the WETH reserve. The only Aave writes before it are `setUserEMode` (which
   * writes no reserve state) and the weETH supply. So the state the protocol fed its own
   * strategy — scaled debt, borrow index, last-update timestamp, virtual balance, deficit,
   * reserve factor, strategy params — IS the pinned snapshot's state. Re-running the model
   * at the transaction's timestamp is not an approximation of the protocol's arithmetic; it
   * is the protocol's arithmetic, so the bound is equality and there is no residual to cover.
   *
   * This replaces a relative bound that could not do the job. At 1e-6 relative the stale
   * stored-index model this suite exists to rule out sits ~149× INSIDE the bound
   * (6.7e-9 relative at the pin, and never worse than ~4e-8 at any plausible block), so the
   * old assertion passed whether or not the debt input was accrued. The negative control
   * below pins that fact rather than leaving it as a claim.
   */
  it("reproduces the WETH post-action borrow rate EXACTLY at the borrow's own timestamp", async () => {
    if (actualBorrowRateRay === null) throw new Error("the execution test must run first");
    const borrow = cleanExecuted.get("borrow:borrow");
    if (borrow === undefined || borrow.resolvedAmount === null) {
      throw new Error("the borrow step did not execute");
    }
    const borrowWei = borrow.resolvedAmount;
    const block = await rpc<{ timestamp?: string } | null>("eth_getBlockByNumber", [
      hexQuantity(borrow.receipt.blockNumber),
      false,
    ]);
    if (block === null || typeof block.timestamp !== "string") {
      throw new Error(`could not read the timestamp of block ${borrow.receipt.blockNumber}`);
    }
    const borrowTs = BigInt(block.timestamp);
    expect(borrowTs).toBeGreaterThanOrEqual(cleanSnapshot.blockTimestamp);

    const W = cleanSnapshot.reserves.WETH;
    const rateOver = (totalDebtWei: bigint): bigint =>
      currentRatesRay({
        strategy: W.rateStrategy.value,
        reserveFactorBps: W.reserveFactorBps.value,
        totalDebtWei,
        virtualUnderlyingBalance: W.virtualUnderlyingBalance.value,
        liquidityAddedWei: 0n,
        liquidityTakenWei: borrowWei,
        deficitWei: W.deficit.value,
      }).variableBorrowRateRay;

    // The corrected model: accrue the index to THIS block, mint the borrow's scaled debt at
    // that index with the protocol's ceiling rounding, total at the same index.
    const nextIndex = accruedVariableBorrowIndexRay(
      W.variableBorrowRateRay.value,
      W.variableBorrowIndexRay.value,
      W.lastUpdateTimestamp.value,
      borrowTs,
    );
    const correctedRay = rateOver(
      rayMulCeil(W.variableDebtScaledTotalSupply.value + rayDivCeil(borrowWei, nextIndex), nextIndex),
    );

    record(
      `matched-timestamp WETH borrow rate @ ts ${borrowTs}: model ${correctedRay} vs chain ${actualBorrowRateRay}`,
    );
    expect(
      correctedRay,
      `matched-timestamp borrow rate: model ${correctedRay} vs chain ${actualBorrowRateRay}`,
    ).toBe(actualBorrowRateRay);

    // ————— negative control: the stale stored-index model must FAIL this comparison —————
    const staleRay = rateOver(
      vTokenBalance(W.variableDebtScaledTotalSupply.value, W.variableBorrowIndexRay.value) +
        borrowWei,
    );
    expect(staleRay).not.toBe(actualBorrowRateRay);
    expect(staleRay).toBeLessThan(actualBorrowRateRay);
    // The understatement is monotone in elapsed time, so the pinned-block delta is its floor
    // — this is Codex finding 1's own number, asserted as a lower bound.
    const staleDelta = actualBorrowRateRay - staleRay;
    expect(staleDelta).toBeGreaterThanOrEqual(143_098_107_621_621_733n);
    record(`stale stored-index model understates the borrow rate by ${staleDelta} ray`);

    // And the reason this test had to be tightened: the previous relative bound ACCEPTS the
    // stale model. Pinning that keeps the bound from being loosened back.
    expect(
      relWithin(rayAprToApyWad(staleRay), rayAprToApyWad(actualBorrowRateRay), RATE_REL_POW),
      "a 1e-6 relative APY bound cannot discriminate the stale model — hence the exact check above",
    ).toBe(true);

    // core/risk.ts must implement exactly that model: same snapshot, timestamp moved to the
    // borrow's block, and its published APY is the conversion of the rate just proven.
    const atBorrowBlock = simulate(flagshipGraph(INPUT_ETH, BORROW_BPS), {
      ...cleanSnapshot,
      blockTimestamp: borrowTs,
    });
    const publishedApy = atBorrowBlock.blockValues["borrow"]?.rate;
    if (publishedApy === null || publishedApy === undefined) {
      throw new Error("borrow APY was not predicted");
    }
    expect(publishedApy.wad.value).toBe(rayAprToApyWad(actualBorrowRateRay));
    // Aave rates are compounded to a yearly figure, so the debt leg is an APY.
    expect(publishedApy.kind).toBe("apy");
  });

  /**
   * The weETH supply leg keeps a relative bound, and unlike the borrow leg it is entitled to
   * one: the protocol wrote this reserve's rate TWICE (once per supply), accruing the index
   * in two steps at two different rates, while `core/risk.ts` makes a single post-action
   * claim about the finished position. That difference is real and is what the bound covers
   * — it is ~1e-8 relative here, two orders inside 1e-6.
   *
   * The bound is still discriminating for this leg, which is why it survives: the stale
   * stored-index model is 3.7e-6 relative away (weETH's index is 3h16m stale at the pin,
   * against WETH's 60s), i.e. OUTSIDE it. The negative control asserts that directly.
   */
  it("predicts the weETH post-action supply rate the protocol wrote, and rejects the stale model", () => {
    if (actualLiquidityRateRay === null || actualBorrowRateRay === null) {
      throw new Error("the execution test must run first");
    }
    const result = simulate(flagshipGraph(INPUT_ETH, BORROW_BPS), cleanSnapshot);
    const predictedSupply = result.blockValues["supply1"]?.rate;
    if (predictedSupply === null || predictedSupply === undefined) {
      throw new Error("supply APY was not predicted");
    }

    // Both legs moved in the direction their action implies, against the pre-action rates.
    expect(actualBorrowRateRay).toBeGreaterThan(
      cleanSnapshot.reserves.WETH.variableBorrowRateRay.value,
    );
    expect(actualLiquidityRateRay).toBeLessThan(
      cleanSnapshot.reserves.weETH.liquidityRateRay.value,
    );

    const chainApy = rayAprToApyWad(actualLiquidityRateRay);
    record(
      `post-action weETH liquidity: predicted APY ${predictedSupply.wad.value} vs chain APY ${chainApy} (ray ${actualLiquidityRateRay})`,
    );
    expect(
      relWithin(predictedSupply.wad.value, chainApy, RATE_REL_POW),
      `supply APY: predicted ${predictedSupply.wad.value} vs chain ${chainApy}`,
    ).toBe(true);

    // Negative control: the stale stored-index debt input lands OUTSIDE the same bound.
    const E = cleanSnapshot.reserves.weETH;
    const suppliedTotal = cleanPlan.flows
      .filter((f) => f.type === "lend")
      .reduce((total, f) => total + f.inputWei!.value, 0n);
    const staleSupplyRay = currentRatesRay({
      strategy: E.rateStrategy.value,
      reserveFactorBps: E.reserveFactorBps.value,
      totalDebtWei: vTokenBalance(
        E.variableDebtScaledTotalSupply.value,
        E.variableBorrowIndexRay.value,
      ),
      virtualUnderlyingBalance: E.virtualUnderlyingBalance.value,
      liquidityAddedWei: suppliedTotal,
      liquidityTakenWei: 0n,
      deficitWei: E.deficit.value,
    }).liquidityRateRay;
    record(`stale stored-index weETH supply rate: ${staleSupplyRay} vs chain ${actualLiquidityRateRay}`);
    expect(
      relWithin(rayAprToApyWad(staleSupplyRay), chainApy, RATE_REL_POW),
      `the stale model must fail this bound: stale ${staleSupplyRay} vs chain ${actualLiquidityRateRay}`,
    ).toBe(false);
  });
});
