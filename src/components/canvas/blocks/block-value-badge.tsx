"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { formatToken, formatUsdBase } from "../../../core/format";
import { valueOf, type Provenanced } from "../../../core/provenance";
import type { AssetType, ComputedBlockValue } from "../../../lib/strategy/types";
import { AssetChip } from "../../shared/asset-chip";
import { SourcedValue, slotClassName, type SlotRamp } from "../../shared/sourced-value";
import { useBlockRuntime } from "./base-block";
import { cn } from "../../../lib/utils";

/**
 * Widest form each formatter produces for a plausible position: "10,000.0000" and
 * "$100,000.00" — both eleven characters. The pending slot is sized to it so the number
 * arrives without moving anything on the canvas, and so a resolved value never overflows
 * the box its skeleton reserved.
 */
const AMOUNT_SLOT_CHARS = 11;
const BASE_SLOT_CHARS = 11;

/**
 * The token amount leads its row, so it is the one quantity here that reads at
 * `text-foreground`; the base-currency restatement and gas stay on the muted ramp. Each is
 * handed over only where a figure renders — `SourcedValue`'s unavailable prose must not
 * inherit a figure's colour, or "amount unavailable" reads as an amount.
 */
const AMOUNT_RAMP: SlotRamp = {
  resolved: "nodrag text-xs text-foreground",
  size: "nodrag text-xs",
};
const SECONDARY_RAMP: SlotRamp = {
  resolved: "nodrag text-xs text-muted-foreground",
  size: "nodrag text-xs",
};

/**
 * How long the flash class stays on. It only has to outlast the keyframes, which run at
 * --motion-slow; the animation itself is CSS, so this number never times anything the
 * user sees moving.
 */
const VALUE_FLASH_MS = 240;

/**
 * A value-change flash is a claim: "this number moved on its own, look". It is true only
 * for a DISCRETE EXTERNAL change of a value that was already on screen, so:
 *
 *   - a first resolution never flashes (an arrival is not a change), and
 *   - nothing flashes while `pendingEdit` is open, because during a drag the user IS the
 *     thing moving the number and the claim would be false sixty times a second.
 *
 * The comparison is a render-time state adjustment rather than an effect: the value this
 * component last PAINTED is the only honest baseline, and a ref written in an effect
 * lags it by a commit.
 */
function useValueFlash(value: Provenanced<bigint> | null): string | undefined {
  const runtime = useBlockRuntime();
  const next = value === null ? null : valueOf(value);
  const [shown, setShown] = useState<bigint | null>(next);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  if (next !== shown) {
    const external = shown !== null && next !== null && runtime.pendingEdit === null;
    setShown(next);
    setFlash(external ? (next > shown ? "up" : "down") : null);
  }

  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), VALUE_FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  if (flash === null) return undefined;
  return flash === "up" ? "value-up" : "value-down";
}

type Direction = "in" | "out";

const DIRECTION_ICON = { in: ArrowDown, out: ArrowRight } as const;
const DIRECTION_NOUN = { in: "input", out: "output" } as const;
const DIRECTION_LABEL = { in: "In", out: "Out" } as const;

interface BlockValueBadgeProps {
  direction: Direction;
  /** The owning block's title; the value labels are built from it. */
  subject: string;
  asset: AssetType | null;
  amountWei: Provenanced<bigint> | null;
  valueBase: Provenanced<bigint> | null;
  pending: boolean;
}

/**
 * One side of a block's value zone: TWO rows, one quantity each.
 *
 * The frame is 240px wide and its body is 216px inside the padding. A token amount and a
 * base-currency amount both reserve 11ch — `SourcedValue` pins that width so a number
 * never overflows the box its skeleton held — and on one line the pair over-ran the
 * border. They also carry different weight: the base-currency figure restates a movement
 * the token amount already stated, and a restatement should not hold equal width to the
 * primary. So the amount leads its row and the value gets a labelled row of its own,
 * exactly as gas already has.
 *
 * Direction is an ARROW, at muted-foreground. The predecessor encoded it as
 * blue-for-in / green-for-out, which spends two hues on a fact the glyph already states,
 * and green in particular is this product's confirmed-execution colour — it cannot also
 * mean "downstream". The screen-reader name carries the same fact as text, so the
 * distinction survives with colour switched off entirely.
 */
export function BlockValueBadge({
  direction,
  subject,
  asset,
  amountWei,
  valueBase,
  pending,
}: BlockValueBadgeProps) {
  const Icon = DIRECTION_ICON[direction];
  const noun = DIRECTION_NOUN[direction];
  // The token amount is the quantity this side is about; the base-currency row restates
  // the same movement, and flashing both would double the claim.
  const flash = useValueFlash(amountWei);

  return (
    <>
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="sr-only">{DIRECTION_LABEL[direction]}</span>
        {asset === null ? null : <AssetChip symbol={asset} />}
        <span className="ml-auto">
          <SourcedValue
            value={amountWei}
            pending={pending}
            label={`${subject} ${noun} amount`}
            chars={AMOUNT_SLOT_CHARS}
            format={formatToken}
            unavailableReason="amount unavailable"
            className={cn(slotClassName(amountWei !== null, pending, AMOUNT_RAMP), flash)}
          />
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-micro uppercase tracking-wider text-muted-foreground">
          {DIRECTION_LABEL[direction]} value
        </span>
        <span className="ml-auto">
          <SourcedValue
            value={valueBase}
            pending={pending}
            label={`${subject} ${noun} value`}
            chars={BASE_SLOT_CHARS}
            format={formatUsdBase}
            unavailableReason="value unavailable"
            className={slotClassName(valueBase !== null, pending, SECONDARY_RAMP)}
          />
        </span>
      </div>
    </>
  );
}

interface BlockValueZoneProps {
  subject: string;
  /** Absent until a simulation resolves for this block. Never substituted with zeros. */
  value: ComputedBlockValue | null;
  pending: boolean;
  showInput?: boolean;
  showOutput?: boolean;
  /** Blocks that emit a transaction show what it costs; the input block emits none. */
  showGas?: boolean;
}

/**
 * The whole value zone, so five block files do not each re-derive the same rows.
 * A missing `ComputedBlockValue` is passed straight through as nulls: the slots then
 * land in the pending or unavailable state on their own, which is precisely the
 * behaviour the network-dead probe checks.
 */
export function BlockValueZone({
  subject,
  value,
  pending,
  showInput = true,
  showOutput = true,
  showGas = true,
}: BlockValueZoneProps) {
  const gasCostBase = value === null ? null : value.gasCostBase;
  return (
    <>
      {showInput ? (
        <BlockValueBadge
          direction="in"
          subject={subject}
          asset={value === null ? null : value.inputAsset}
          amountWei={value === null ? null : value.inputAmountWei}
          valueBase={value === null ? null : value.inputValueBase}
          pending={pending}
        />
      ) : null}
      {showOutput ? (
        <BlockValueBadge
          direction="out"
          subject={subject}
          asset={value === null ? null : value.outputAsset}
          amountWei={value === null ? null : value.outputAmountWei}
          valueBase={value === null ? null : value.outputValueBase}
          pending={pending}
        />
      ) : null}
      {showGas ? (
        <div className="flex items-center gap-2">
          <span className="text-micro uppercase tracking-wider text-muted-foreground">Gas</span>
          <span className="ml-auto">
            <SourcedValue
              value={gasCostBase}
              pending={pending}
              label={`${subject} gas cost`}
              chars={BASE_SLOT_CHARS}
              format={formatUsdBase}
              unavailableReason="not quoted"
              className={slotClassName(gasCostBase !== null, pending, SECONDARY_RAMP)}
            />
          </span>
        </div>
      ) : null}
    </>
  );
}
