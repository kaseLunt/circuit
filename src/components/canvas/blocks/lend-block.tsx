"use client";

import { PiggyBank } from "lucide-react";
import { formatWadAsPercent } from "../../../core/format";
import type { LendBlockData, LendProtocol } from "../../../lib/strategy/types";
import { AssetChip } from "../../shared/asset-chip";
import { SourcedValue, slotClassName, type SlotRamp } from "../../shared/sourced-value";
import { BaseBlock, RATE_SLOT_CHARS, useBlockRuntime, type BlockState } from "./base-block";
import { BlockValueZone } from "./block-value-badge";
import type { NodePropsFor } from "./node-props";

const TITLE = "Supply";

/** Handed over only where a figure renders — a rate's absence must not wear its weight. */
const RATE_RAMP: SlotRamp = {
  resolved: "nodrag text-sm text-foreground",
  size: "nodrag text-sm",
};

/**
 * Exhaustive over core's LendProtocol union, so a new market is a compile error here.
 * Exported because the canvas narrows a document's `protocol` param against exactly this
 * table — one vocabulary, stated once.
 */
export const PROTOCOL_LABEL: Readonly<Record<LendProtocol, string>> = { "aave-v3": "Aave v3" };

/**
 * Supply collateral to a lending market.
 *
 * No LTV and no liquidation threshold appear on this block. The predecessor printed
 * 80 / 82.5 from a table in the component and reached for `?? 80` when the table missed —
 * numbers that are Observed reserve parameters on a block-pinned snapshot, subject to
 * e-mode, and wrong the moment the market is reconfigured. A risk parameter this block
 * cannot read is a risk parameter this block does not claim.
 *
 * The collateral asset is whatever the incoming edge produces; the store writes it on
 * connect. Unconnected is its own state, not a silent "ETH".
 */
export function LendBlock({ id, data, selected }: NodePropsFor<LendBlockData>) {
  const runtime = useBlockRuntime();
  const blockValue = runtime.blockValues[id] ?? null;
  const apyWad = blockValue === null ? null : blockValue.apyWad;

  const unconnected = data.asset === null;
  const state: BlockState = !data.isValid ? "error" : unconnected ? "warning" : "valid";
  const message = !data.isValid
    ? data.errorMessage
    : unconnected
      ? "Connect a producer — the collateral asset comes from the incoming edge."
      : undefined;

  return (
    <BaseBlock
      id={id}
      kind="lend"
      title={TITLE}
      icon={<PiggyBank />}
      state={state}
      selected={selected}
      message={message}
      headerRight={data.asset === null ? null : <AssetChip symbol={data.asset} />}
      valueSlot={
        <BlockValueZone subject={TITLE} value={blockValue} pending={runtime.pending} />
      }
    >
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-muted-foreground">Market</span>
        <span className="ml-auto text-sm text-foreground">{PROTOCOL_LABEL[data.protocol]}</span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="flex flex-col">
          <span className="text-xs text-muted-foreground">Supply APY</span>
          <span className="text-micro uppercase tracking-wider text-muted-foreground">
            current-rate run-rate
          </span>
        </span>
        <span className="ml-auto">
          <SourcedValue
            value={apyWad}
            pending={runtime.pending}
            label="Supply APY, current-rate run-rate"
            chars={RATE_SLOT_CHARS}
            format={formatWadAsPercent}
            unavailableReason="rate unavailable"
            className={slotClassName(apyWad !== null, runtime.pending, RATE_RAMP)}
          />
        </span>
      </div>
    </BaseBlock>
  );
}
