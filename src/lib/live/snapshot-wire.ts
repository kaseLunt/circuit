/**
 * The live-capture wire codec (Codex D-011 F2): how a `ChainSnapshot` our server captured
 * for the connected address crosses to the client, and how the client rebuilds it.
 *
 * BOTH directions live in this one module so they cannot drift: `wireLiveReadinessOf`
 * unwraps the server's minted snapshot into raw values (bigint → decimal string, field by
 * field), and `parseLiveReadiness` strict-parses the same shape back into the
 * `RecordedProtocol` raw form and re-mints it through `snapshotFrom` — the SAME minting
 * definition the sandbox and the fixtures use, pinned to the CAPTURE's own block identity
 * rather than the reads log's (the `SnapshotPin` parameter exists for exactly this).
 *
 * Provenance stance: every value here was read by `captureChainSnapshot` through OUR
 * configured RPC (server/chain — never the injected provider, seam A1), and the wire
 * carries it verbatim; re-minting `Observed` client-side is the same replay the committed
 * reads log performs for the sandbox. Nothing is defaulted: a malformed field refuses with
 * its path named, because a mis-parsed price feeding money-math is precisely the class of
 * silent fallback SPEC §5 bans.
 *
 * Pure by construction: byte mapping and refusals only — no client, no transport, no React.
 * The transport that moves this shape lives in `./live-transport.ts`.
 */
import { getAddress, type Address, type Hex } from "viem";
import type { ChainSnapshot, ReserveSnapshot, UserSnapshot } from "../../core/plan";
import { observationMinter } from "../../core/provenance";
import {
  snapshotFrom,
  type RawEMode,
  type RawReserve,
  type RecordedProtocol,
} from "../recorded-reads/recorded-snapshot";
import type { LiveSnapshotIdentity } from "../wallet/gate";
import type { WalletCodeReading, WalletFootprintReading } from "../wallet/types";

// ————————————————————————— wire shapes —————————————————————————

export interface WireRateStrategy {
  readonly optimalUsageRatio: number;
  readonly baseVariableBorrowRate: number;
  readonly variableRateSlope1: number;
  readonly variableRateSlope2: number;
}

/** `RawReserve` with every bigint as a decimal string — one manifest below drives both directions. */
export type WireReserve = {
  readonly [K in keyof RawReserve]: RawReserve[K] extends bigint
    ? string
    : RawReserve[K] extends Address
      ? string
      : RawReserve[K];
};

export type WireEMode = {
  readonly [K in keyof RawEMode]: RawEMode[K] extends bigint ? string : RawEMode[K];
};

export interface WireEtherfi {
  readonly liquidityPool: string;
  readonly eETH: string;
  readonly weETH: string;
  readonly totalPooledEther: string;
  readonly totalShares: string;
  readonly rateWindow: {
    readonly rateNow: string;
    readonly rateBefore: string;
    readonly secondsElapsed: string;
  } | null;
}

export interface WireLiveCapture {
  readonly block: string;
  readonly blockHash: string;
  readonly blockTimestamp: string;
  /** The staking window's earlier endpoint identity; null when the capture had no window. */
  readonly window: { readonly block: string; readonly timestamp: string } | null;
  readonly pool: string;
  readonly weETH: WireReserve;
  readonly WETH: WireReserve;
  readonly USDC: WireReserve;
  readonly eModes: readonly WireEMode[];
  readonly etherfi: WireEtherfi;
  readonly user: {
    readonly address: string;
    readonly eModeCategoryId: number;
    readonly hasAaveFootprint: boolean;
  };
}

/** What the wallet router's readiness procedure returns on success. */
export interface WireLiveReadiness {
  readonly code:
    | { readonly status: "clear" }
    | { readonly status: "code-bearing"; readonly code: string };
  readonly capture: WireLiveCapture;
}

// ————————————————————————— field manifests —————————————————————————

const RESERVE_BIGINT_FIELDS = [
  "supplyCap",
  "borrowCap",
  "aTokenScaledTotalSupply",
  "variableDebtScaledTotalSupply",
  "accruedToTreasury",
  "liquidityRateRay",
  "variableBorrowRateRay",
  "liquidityIndexRay",
  "variableBorrowIndexRay",
  "lastUpdateTimestamp",
  "virtualUnderlyingBalance",
  "priceBase",
  "deficit",
] as const;

const RESERVE_NUMBER_FIELDS = [
  "reserveIndex",
  "decimals",
  "reserveLtvBps",
  "reserveLiquidationThresholdBps",
  "reserveFactorBps",
] as const;

const RESERVE_BOOLEAN_FIELDS = [
  "active",
  "frozen",
  "paused",
  "borrowingEnabled",
  "usageAsCollateralAllowed",
] as const;

const RESERVE_ADDRESS_FIELDS = ["underlying", "aToken", "variableDebtToken"] as const;

const STRATEGY_FIELDS = [
  "optimalUsageRatio",
  "baseVariableBorrowRate",
  "variableRateSlope1",
  "variableRateSlope2",
] as const;

// ————————————————————————— serialize (server side) —————————————————————————

const wei = (value: bigint): string => value.toString();

/** Unwrap one minted reserve back to the raw read values the wire carries. */
function rawReserveOf(reserve: ReserveSnapshot): RawReserve {
  return {
    underlying: reserve.underlying,
    aToken: reserve.aToken,
    variableDebtToken: reserve.variableDebtToken,
    reserveIndex: reserve.reserveIndex.value,
    decimals: reserve.decimals.value,
    active: reserve.active.value,
    frozen: reserve.frozen.value,
    paused: reserve.paused.value,
    borrowingEnabled: reserve.borrowingEnabled.value,
    usageAsCollateralAllowed: reserve.usageAsCollateralAllowed.value,
    reserveLtvBps: reserve.ltvBps.value,
    reserveLiquidationThresholdBps: reserve.liquidationThresholdBps.value,
    supplyCap: reserve.supplyCap.value,
    borrowCap: reserve.borrowCap.value,
    aTokenScaledTotalSupply: reserve.aTokenScaledTotalSupply.value,
    variableDebtScaledTotalSupply: reserve.variableDebtScaledTotalSupply.value,
    accruedToTreasury: reserve.accruedToTreasury.value,
    liquidityRateRay: reserve.liquidityRateRay.value,
    variableBorrowRateRay: reserve.variableBorrowRateRay.value,
    liquidityIndexRay: reserve.liquidityIndexRay.value,
    variableBorrowIndexRay: reserve.variableBorrowIndexRay.value,
    lastUpdateTimestamp: reserve.lastUpdateTimestamp.value,
    virtualUnderlyingBalance: reserve.virtualUnderlyingBalance.value,
    priceBase: reserve.priceBase.value,
    rateStrategy: reserve.rateStrategy.value,
    reserveFactorBps: reserve.reserveFactorBps.value,
    deficit: reserve.deficit.value,
  };
}

function wireReserveOf(raw: RawReserve): WireReserve {
  const out: Record<string, unknown> = { rateStrategy: { ...raw.rateStrategy } };
  for (const field of RESERVE_ADDRESS_FIELDS) out[field] = raw[field];
  for (const field of RESERVE_NUMBER_FIELDS) out[field] = raw[field];
  for (const field of RESERVE_BOOLEAN_FIELDS) out[field] = raw[field];
  for (const field of RESERVE_BIGINT_FIELDS) out[field] = wei(raw[field]);
  return out as WireReserve;
}

/**
 * The server-side half: the minted capture, unwrapped for the wire. `blockHash` arrives
 * from the capture call site, which pinned the capture to it via `expectBlockHash` — the
 * identity `LiveSimulationStanding` binds to (F3).
 */
export function wireLiveCaptureOf(snapshot: ChainSnapshot, blockHash: Hex): WireLiveCapture {
  const window = snapshot.etherfi.rateWindow;
  return {
    block: wei(snapshot.block),
    blockHash,
    blockTimestamp: wei(snapshot.blockTimestamp),
    window:
      window === null
        ? null
        : {
            block: wei(window.rateBefore.block),
            timestamp: String(window.rateBefore.fetchedAt),
          },
    pool: snapshot.pool,
    weETH: wireReserveOf(rawReserveOf(snapshot.reserves.weETH)),
    WETH: wireReserveOf(rawReserveOf(snapshot.reserves.WETH)),
    USDC: wireReserveOf(rawReserveOf(snapshot.reserves.USDC)),
    eModes: snapshot.eModeCategories.map((category) => ({
      id: category.id,
      label: category.label.value,
      ltvBps: category.ltvBps.value,
      liquidationThresholdBps: category.liquidationThresholdBps.value,
      collateralBitmap: wei(category.collateralBitmap.value),
      borrowableBitmap: wei(category.borrowableBitmap.value),
      isIsolated: category.isIsolated.value,
      ltvZeroBitmap: wei(category.ltvZeroBitmap.value),
    })),
    etherfi: {
      liquidityPool: snapshot.etherfi.liquidityPool,
      eETH: snapshot.etherfi.eETH,
      weETH: snapshot.etherfi.weETH,
      totalPooledEther: wei(snapshot.etherfi.totalPooledEther.value),
      totalShares: wei(snapshot.etherfi.totalShares.value),
      rateWindow:
        window === null
          ? null
          : {
              rateNow: wei(window.rateNow.value),
              rateBefore: wei(window.rateBefore.value),
              secondsElapsed: wei(window.secondsElapsed.value),
            },
    },
    user: {
      address: snapshot.user.address,
      eModeCategoryId: snapshot.user.eModeCategoryId.value,
      hasAaveFootprint: snapshot.user.hasAaveFootprint.value,
    },
  };
}

// ————————————————————————— parse (client side) —————————————————————————

/** A refusal names the path that failed — the debugging surface IS the refusal. */
class WireRefusalError extends Error {}

function fail(path: string, expected: string): never {
  throw new WireRefusalError(`live capture wire field ${path} is not ${expected}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "an object");
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "a string");
  return value;
}

function big(value: unknown, path: string): bigint {
  const raw = str(value, path);
  if (!/^-?\d+$/.test(raw)) fail(path, "a decimal integer string");
  return BigInt(raw);
}

function int(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) fail(path, "an integer");
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "a boolean");
  return value;
}

function addr(value: unknown, path: string): Address {
  const raw = str(value, path);
  try {
    return getAddress(raw);
  } catch {
    fail(path, "an address");
  }
}

function hex32(value: unknown, path: string): Hex {
  const raw = str(value, path);
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) fail(path, "a 32-byte hex hash");
  return raw as Hex;
}

function parseReserve(value: unknown, path: string): RawReserve {
  const rec = record(value, path);
  const strategyRec = record(rec["rateStrategy"], `${path}.rateStrategy`);
  const out: Record<string, unknown> = {
    rateStrategy: Object.fromEntries(
      STRATEGY_FIELDS.map((field) => [
        field,
        int(strategyRec[field], `${path}.rateStrategy.${field}`),
      ]),
    ),
  };
  for (const field of RESERVE_ADDRESS_FIELDS) out[field] = addr(rec[field], `${path}.${field}`);
  for (const field of RESERVE_NUMBER_FIELDS) out[field] = int(rec[field], `${path}.${field}`);
  for (const field of RESERVE_BOOLEAN_FIELDS) out[field] = bool(rec[field], `${path}.${field}`);
  for (const field of RESERVE_BIGINT_FIELDS) out[field] = big(rec[field], `${path}.${field}`);
  return out as unknown as RawReserve;
}

function parseEMode(value: unknown, path: string): RawEMode {
  const rec = record(value, path);
  return {
    id: int(rec["id"], `${path}.id`),
    label: str(rec["label"], `${path}.label`),
    ltvBps: int(rec["ltvBps"], `${path}.ltvBps`),
    liquidationThresholdBps: int(rec["liquidationThresholdBps"], `${path}.liquidationThresholdBps`),
    collateralBitmap: big(rec["collateralBitmap"], `${path}.collateralBitmap`),
    borrowableBitmap: big(rec["borrowableBitmap"], `${path}.borrowableBitmap`),
    isIsolated: bool(rec["isIsolated"], `${path}.isIsolated`),
    ltvZeroBitmap: big(rec["ltvZeroBitmap"], `${path}.ltvZeroBitmap`),
  };
}

/** Everything the client needs from one readiness call, rebuilt and re-minted. */
export interface LiveCapture {
  readonly snapshot: ChainSnapshot;
  readonly identity: LiveSnapshotIdentity;
  readonly code: WalletCodeReading;
  readonly footprint: WalletFootprintReading;
}

/**
 * WHY a readiness call produced no reading — typed, so a refusal is a designed state rather
 * than a string that happened to arrive (the wallet router's own doctrine, applied to the
 * client half). Every arm renders its `reason` and the gate refuses; the kind exists so a
 * test can assert WHICH absence it is proving.
 */
export type LiveReadinessRefusalKind =
  /** The wire did not parse — a field is missing or mis-shaped (this module's refusals). */
  | "malformed-wire"
  /** The transport itself failed: no response, or one that is not an object. */
  | "call-failed"
  /** The router answered its own typed refusal (no live RPC configured, capture refused). */
  | "refused-upstream"
  /** The demo source has no scenario for this address, so it declines to invent one. */
  | "not-in-demo-scenario";

export type ParsedLiveReadiness =
  | { readonly ok: true; readonly capture: LiveCapture }
  | {
      readonly ok: false;
      readonly kind: LiveReadinessRefusalKind;
      readonly reason: string;
    };

/**
 * Strict-parse a readiness payload and rebuild the block-pinned `ChainSnapshot`.
 *
 * The user pair is minted `Observed` against the capture's own block — the live replacement
 * for the sandbox's `Configured` pair that `src/lib/wallet/types.ts` names as this
 * boundary's whole purpose — with the same source labels `server/chain/snapshot.ts` mints,
 * so a tooltip cites one vocabulary whichever side minted it. The footprint READING is
 * derived from the same captured fact (`hasAaveFootprint`), never a second predicate
 * (`docs/live-execution-checklist.md` §1: one definition, or the two will disagree).
 */
export function parseLiveReadiness(value: unknown): ParsedLiveReadiness {
  try {
    const rec = record(value, "readiness");
    const codeRec = record(rec["code"], "readiness.code");
    const codeStatus = str(codeRec["status"], "readiness.code.status");
    let code: WalletCodeReading;
    if (codeStatus === "clear") {
      code = { status: "clear" };
    } else if (codeStatus === "code-bearing") {
      const bytes = str(codeRec["code"], "readiness.code.code");
      if (!/^0x[0-9a-fA-F]*$/.test(bytes)) fail("readiness.code.code", "hex bytes");
      code = { status: "code-bearing", code: bytes as Hex };
    } else {
      fail("readiness.code.status", "'clear' or 'code-bearing'");
    }

    const captureRec = record(rec["capture"], "capture");
    const block = big(captureRec["block"], "capture.block");
    if (block <= 0n) fail("capture.block", "a positive block number");
    const blockHash = hex32(captureRec["blockHash"], "capture.blockHash");
    const blockTimestamp = big(captureRec["blockTimestamp"], "capture.blockTimestamp");

    const windowValue = captureRec["window"];
    const window =
      windowValue === null
        ? null
        : (() => {
            const windowRec = record(windowValue, "capture.window");
            const windowBlock = big(windowRec["block"], "capture.window.block");
            if (windowBlock <= 0n) fail("capture.window.block", "a positive block number");
            return {
              block: windowBlock,
              timestamp: big(windowRec["timestamp"], "capture.window.timestamp"),
            };
          })();

    const etherfiRec = record(captureRec["etherfi"], "capture.etherfi");
    const rateWindowValue = etherfiRec["rateWindow"];
    if (rateWindowValue !== null && window === null) {
      fail("capture.window", "present whenever a rate window is");
    }
    const rateWindow =
      rateWindowValue === null
        ? null
        : (() => {
            const rw = record(rateWindowValue, "capture.etherfi.rateWindow");
            return {
              rateNow: big(rw["rateNow"], "capture.etherfi.rateWindow.rateNow"),
              rateBefore: big(rw["rateBefore"], "capture.etherfi.rateWindow.rateBefore"),
              secondsElapsed: big(
                rw["secondsElapsed"],
                "capture.etherfi.rateWindow.secondsElapsed",
              ),
            };
          })();

    const eModesValue = captureRec["eModes"];
    if (!Array.isArray(eModesValue)) fail("capture.eModes", "an array");
    const raw: RecordedProtocol = {
      pool: addr(captureRec["pool"], "capture.pool"),
      weETH: parseReserve(captureRec["weETH"], "capture.weETH"),
      WETH: parseReserve(captureRec["WETH"], "capture.WETH"),
      USDC: parseReserve(captureRec["USDC"], "capture.USDC"),
      eModes: eModesValue.map((entry, index) => parseEMode(entry, `capture.eModes[${index}]`)),
      etherfi: {
        liquidityPool: addr(etherfiRec["liquidityPool"], "capture.etherfi.liquidityPool"),
        eETH: addr(etherfiRec["eETH"], "capture.etherfi.eETH"),
        weETH: addr(etherfiRec["weETH"], "capture.etherfi.weETH"),
        totalPooledEther: big(etherfiRec["totalPooledEther"], "capture.etherfi.totalPooledEther"),
        totalShares: big(etherfiRec["totalShares"], "capture.etherfi.totalShares"),
        rateWindow,
      },
    };

    const userRec = record(captureRec["user"], "capture.user");
    const hasAaveFootprint = bool(userRec["hasAaveFootprint"], "capture.user.hasAaveFootprint");
    const mint = observationMinter(block, Number(blockTimestamp));
    const user: UserSnapshot = {
      address: addr(userRec["address"], "capture.user.address"),
      eModeCategoryId: mint.observe(
        int(userRec["eModeCategoryId"], "capture.user.eModeCategoryId"),
        "Pool.getUserEMode(user)",
      ),
      hasAaveFootprint: mint.observe(
        hasAaveFootprint,
        "aToken/variableDebt balanceOf sweep over getReservesList",
      ),
    };

    const snapshot = snapshotFrom(raw, user, {
      block,
      timestamp: blockTimestamp,
      // A windowless capture never reaches the window minter (recorded-snapshot.ts builds
      // it only when a rate window exists), so the log-shaped placeholder is inert.
      windowBlock: window === null ? block : window.block,
      windowTimestamp: window === null ? blockTimestamp : window.timestamp,
    });

    return {
      ok: true,
      capture: {
        snapshot,
        identity: { block, blockHash },
        code,
        footprint: { status: hasAaveFootprint ? "occupied" : "clear" },
      },
    };
  } catch (error) {
    if (error instanceof WireRefusalError) {
      return { ok: false, kind: "malformed-wire", reason: error.message };
    }
    throw error;
  }
}
