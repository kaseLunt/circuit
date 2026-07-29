"use client";

import { useId, type ChangeEvent } from "react";
import { HandCoins } from "lucide-react";
import { formatBpsAsPercent, formatHealthFactor, formatWadAsPercent, formatWadRatio } from "../../../core/format";
import { HF_WARN_WAD, hfWadValue, riskState, type HealthFactor } from "../../../core/health-factor";
import { valueOf } from "../../../core/provenance";
import { rateKindLabel } from "../../../core/risk";
import { FULL_ALLOCATION_BPS, type BorrowBlockData } from "../../../lib/strategy/types";
import { AssetChip } from "../../shared/asset-chip";
import { SourcedValue, slotClassName, type SlotRamp } from "../../shared/sourced-value";
import {
  BaseBlock,
  RATE_SLOT_CHARS,
  useBlockRuntime,
  useWriteRejection,
  type BlockState,
} from "./base-block";
import { BlockValueZone } from "./block-value-badge";
import type { NodePropsFor } from "./node-props";

const TITLE = "Borrow";

/**
 * One percentage point: the slider's granularity, in the integer bps core validates.
 * Exported because it is also the slider's minimum, which is where the control rests
 * while the document holds no allocation at all — the canvas reads it from here rather
 * than restating the number.
 */
export const BORROW_STEP_BPS = 100;

/** "0.9123" — six characters, the form `formatWadRatio` produces for a correlated pair. */
const RATIO_SLOT_CHARS = 6;
/** "12.34" — five characters, the widest `formatHealthFactor` produces for a live HF. */
const HF_SLOT_CHARS = 5;
/** "100%". */
const ALLOCATION_SLOT_CHARS = 4;

/**
 * The health factor is the loudest figure on this block, which is exactly why its ramp is
 * conditional: handed over unconditionally it would print "health factor unavailable" at
 * that weight and colour, and a refusal wearing the emphasis of a reading is the falsest
 * thing this canvas can render. Safe is not green — baseline safety reads as foreground so
 * warning chroma keeps its full contrast for the moment it actually arrives.
 */
const HF_RAMP: SlotRamp = {
  resolved: "nodrag transition-fast text-sm font-semibold text-foreground",
  size: "nodrag text-sm",
};
const HF_WARNING_RAMP: SlotRamp = {
  resolved: "nodrag transition-fast text-sm font-semibold text-warning",
  size: "nodrag text-sm",
};
const ALLOCATION_RAMP: SlotRamp = {
  resolved: "nodrag text-sm tabular-nums text-foreground",
  size: "nodrag text-sm",
};
const RATE_RAMP: SlotRamp = {
  resolved: "nodrag text-sm text-foreground",
  size: "nodrag text-sm",
};
const RATIO_RAMP: SlotRamp = {
  resolved: "nodrag text-xs text-foreground",
  size: "nodrag text-xs",
};

/**
 * A composition, not a formatter: `formatHealthFactor` owns every digit, the sentinel and
 * the rounding, and `hfWadValue` owns the unwrapping. This decides no scale, no suffix and
 * no rounding — it exists because core/format.ts cannot import core/health-factor.ts
 * (health-factor imports format, so the dependency runs one way).
 */
function formatMinHealthFactor(hf: HealthFactor): string {
  return formatHealthFactor(hfWadValue(hf));
}

/**
 * Which LTV/LT regime the refusal is quoting. SPEC §3 step 4 names getting this wrong as a
 * correctness bug, so the sentence states it rather than leaving the reader to assume the
 * reserve-level numbers when an e-mode category is active (they differ, often by a lot).
 */
function regimeLabel(categoryId: number | null): string {
  return categoryId === null
    ? "This reserve's own configuration"
    : `E-mode category ${categoryId}`;
}

/** The prose a settled-but-empty risk read gets. Never a dash, never a zero. */
const LIQUIDATION_UNAVAILABLE = "Liquidation level unavailable. The risk read did not resolve.";

/**
 * The ONE authored liquidation sentence, in the two forms it has to take: the words the
 * visible row wraps around the `SourcedValue` that renders the ratio, and the whole string
 * the slider announces. Both come from here, so the pointer path and the keyboard path
 * cannot say different things — the defect two independent authorings guarantee.
 */
function liquidationPrefix(pair: string): string {
  return `Liquidates if ${pair} falls to `;
}

function liquidationSentence(pair: string, ratio: string | null, pending: boolean): string {
  if (ratio !== null) return `${liquidationPrefix(pair)}${ratio}.`;
  return pending ? `Liquidation level for ${pair} loading.` : LIQUIDATION_UNAVAILABLE;
}

/**
 * Open debt against the supplied collateral.
 *
 * REBUILT, not ported. The predecessor carried a hardcoded ETH_PRICE = 3300 with a second
 * `|| ETH_PRICE` behind a store default of 2700, a recursive value trace duplicating the
 * simulation, three copies of the literal 82.5, an inline health factor that assumed
 * stablecoins are worth a dollar, and a "2% buffer" LTV cap that fell back to 70. Every
 * one of those numbers is now a read: the health factor comes from
 * `core/health-factor.ts`'s Aave-v3.7-exact sequence and the liquidation level is a
 * correlated-pair RATIO, because weETH/WETH has no honest USD liquidation price.
 *
 * The primary readout is a SENTENCE. Mid-drag, at canvas zoom, four digits of a ratio are
 * unreadable while "liquidates if the ratio falls to …" still parses — and the sentence is
 * what the slider announces, so the keyboard path and the pointer path say the same thing.
 *
 * The borrowed fraction is SPEC §5.2's `b`: an entered quantity, so it reaches the screen
 * through the store's provenanced reader and the one money renderer, never as a bare
 * number off the node's data.
 */
export function BorrowBlock({ id, data, selected }: NodePropsFor<BorrowBlockData>) {
  const runtime = useBlockRuntime();
  const sliderId = useId();
  const rejection = useWriteRejection();
  const blockValue = runtime.blockValues[id] ?? null;

  const rate = blockValue === null ? null : blockValue.rate;
  const kindLabel = rateKindLabel(rate === null ? "apy" : rate.kind);
  const collateralAsset = blockValue === null ? null : blockValue.inputAsset;
  const pair = collateralAsset === null ? "collateral/debt" : `${collateralAsset}/${data.asset}`;

  const allocation = runtime.borrowAllocations[id] ?? null;
  const allocationText =
    allocation === null ? "Not set" : formatBpsAsPercent(valueOf(allocation));

  const healthFactor = runtime.minHealthFactor;
  const hf = healthFactor === null ? null : valueOf(healthFactor);
  const risk = hf === null ? null : riskState(hf);

  // The threshold is core's named constant, rendered through core's formatter. No literal
  // "1.5" is authored here, so moving HF_WARN_WAD moves this copy with it.
  const warnThreshold = formatHealthFactor(HF_WARN_WAD);

  // SPEC §3 step 4. The verdict is `core/borrow-limit.ts`'s, over the same block-pinned read
  // set every other figure on this block comes from; this component chooses no numbers and
  // authors no thresholds — it renders the ceiling's own fields.
  const limit = runtime.borrowLimit;
  const overLimit =
    limit !== null && limit.status === "over-limit" && limit.ceiling.blockId === id
      ? limit.ceiling
      : null;

  const state: BlockState =
    rejection.reason !== null || !data.isValid || overLimit !== null
      ? "error"
      : risk === "warning" || !data.isConfigured
        ? "warning"
        : "valid";
  const message =
    rejection.reason !== null
      ? rejection.reason
      : !data.isValid
        ? data.errorMessage
        : overLimit !== null
          ? // Not scripted copy: every figure is read off the ceiling, which read them off
            // the ACTIVE configuration. The in-eMode and outside-eMode regimes differ, so the
            // sentence says which one it is quoting.
            `Past the borrow limit. ${regimeLabel(overLimit.categoryId)} allows ${formatBpsAsPercent(
              overLimit.ltvBps,
            )} of collateral value as debt (liquidation threshold ${formatBpsAsPercent(
              overLimit.ltBps,
            )}); this asks for ${formatBpsAsPercent(overLimit.requestedAllocationBps)}. The most it admits is ${formatBpsAsPercent(
              overLimit.maxAllocationBps,
            )}.`
          : risk === "warning"
            ? `Health factor is below the ${warnThreshold} warning threshold.`
            : !data.isConfigured
              ? "Choose how much of the collateral value to borrow."
              : undefined;

  const ratio = runtime.liquidationRatioWad;
  const sentence = liquidationSentence(
    pair,
    ratio === null ? null : formatWadRatio(valueOf(ratio)),
    runtime.pending,
  );

  function handleAllocationChange(event: ChangeEvent<HTMLInputElement>): void {
    // No pre-filtering: the store owns the bps domain, and a value it refuses is reported
    // in its own words rather than dropped on the floor by a guard clause here.
    rejection.record(runtime.setBorrowAllocationBps(id, event.target.valueAsNumber));
  }

  function handleGestureStart(): void {
    runtime.beginEdit("set borrow allocation");
  }

  return (
    <BaseBlock
      id={id}
      kind="borrow"
      title={TITLE}
      icon={<HandCoins />}
      state={state}
      selected={selected}
      message={message}
      headerRight={<AssetChip symbol={data.asset} />}
      valueSlot={
        <BlockValueZone
          subject={TITLE}
          value={blockValue}
          pending={runtime.pending}
          // A borrow opens debt against collateral it does not consume; there is no input
          // flow to report. `core/plan.ts` says so already — a borrow flow carries
          // `inputWei: null` by construction — and rendering the row anyway turned that
          // structural absence into "amount unavailable", which is a claim that a source
          // failed. Core stays untouched: `inputAsset` is load-bearing for the liquidation
          // pair and is not a promise that an input amount exists.
          showInput={false}
        />
      }
    >
      <div className="space-y-1">
        <div className="flex items-baseline gap-2">
          <label htmlFor={sliderId} className="text-xs text-muted-foreground">
            Borrowed against collateral
          </label>
          <span className="ml-auto">
            <SourcedValue
              value={allocation}
              pending={false}
              label="Borrowed against collateral value"
              chars={ALLOCATION_SLOT_CHARS}
              format={formatBpsAsPercent}
              unavailableReason="not set"
              className={slotClassName(allocation !== null, false, ALLOCATION_RAMP)}
            />
          </span>
        </div>
        <input
          id={sliderId}
          type="range"
          min={BORROW_STEP_BPS}
          max={FULL_ALLOCATION_BPS}
          step={BORROW_STEP_BPS}
          value={data.allocationBps}
          onChange={handleAllocationChange}
          onPointerDown={handleGestureStart}
          onKeyDown={handleGestureStart}
          onPointerUp={runtime.endEdit}
          onKeyUp={runtime.endEdit}
          onBlur={runtime.endEdit}
          aria-valuetext={`${allocationText} of collateral value borrowed. ${sentence}`}
          className="focus-ring nodrag h-1.5 w-full cursor-pointer appearance-none rounded-sm bg-muted accent-foreground"
        />
      </div>

      {ratio === null && !runtime.pending ? (
        <p className="text-xs text-muted-foreground">{sentence}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {liquidationPrefix(pair)}
          <SourcedValue
            value={ratio}
            pending={runtime.pending}
            label={`Liquidation ratio, ${pair}`}
            chars={RATIO_SLOT_CHARS}
            format={formatWadRatio}
            unavailableReason="unavailable"
            inline
            className={slotClassName(ratio !== null, runtime.pending, RATIO_RAMP)}
          />
          .
        </p>
      )}

      <div className="flex items-baseline gap-2">
        <span className="text-xs text-muted-foreground">Min health factor</span>
        <span className="ml-auto">
          {hf !== null && hf.status === "no-debt" ? (
            <span className="text-xs text-muted-foreground">No borrow, so no liquidation risk</span>
          ) : hf !== null && hf.status === "unknown" ? (
            <span className="text-xs text-muted-foreground">
              {`Health factor unavailable: ${hf.reason}`}
            </span>
          ) : (
            <SourcedValue
              value={healthFactor}
              pending={runtime.pending}
              label="Minimum health factor during execution"
              chars={HF_SLOT_CHARS}
              format={formatMinHealthFactor}
              unavailableReason="health factor unavailable"
              className={slotClassName(
                healthFactor !== null,
                runtime.pending,
                risk === "warning" ? HF_WARNING_RAMP : HF_RAMP,
              )}
            />
          )}
        </span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="flex flex-col">
          <span className="text-xs text-muted-foreground">{`Borrow ${kindLabel}`}</span>
          <span className="text-micro uppercase tracking-wider text-muted-foreground">
            current-rate run-rate
          </span>
        </span>
        <span className="ml-auto">
          <SourcedValue
            value={rate === null ? null : rate.wad}
            pending={runtime.pending}
            label={`Borrow ${kindLabel}, current-rate run-rate`}
            chars={RATE_SLOT_CHARS}
            format={formatWadAsPercent}
            unavailableReason="rate unavailable"
            className={slotClassName(rate !== null, runtime.pending, RATE_RAMP)}
          />
        </span>
      </div>
    </BaseBlock>
  );
}
