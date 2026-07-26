"use client";

import { useId, type ChangeEvent } from "react";
import { Layers } from "lucide-react";
import { formatWadAsPercent } from "../../../core/format";
import type { StakeBlockData, StakeProtocol } from "../../../lib/strategy/types";
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

const TITLE = "Stake";

/** Handed over only where a figure renders — a rate's absence must not wear its weight. */
const RATE_RAMP: SlotRamp = {
  resolved: "nodrag text-sm text-foreground",
  size: "nodrag text-sm",
};

/**
 * The two liquid-staking protocols `core/graph.ts` admits in v1. LABELS ONLY: the output
 * asset is not restated here. The predecessor kept a protocol→asset table in the
 * component and reached for `?? "eETH"` when it missed; core/route-optimizer.ts owns that
 * mapping (`outputAssetOf`), so this list carries display names and nothing else and
 * there is no second table to drift.
 *
 * Exported because the canvas narrows a document's `protocol` param against exactly this
 * list — one vocabulary, stated once.
 */
export const STAKE_PROTOCOLS: readonly { readonly value: StakeProtocol; readonly label: string }[] =
  [
    { value: "etherfi", label: "ether.fi" },
    { value: "lido", label: "Lido" },
  ];

/**
 * Stake ETH into a liquid-staking token.
 *
 * The rate is read, never remembered: `apy` was a field on the old block data, written on
 * every protocol change from a getter that bottomed out in a hardcoded default table, and
 * then ignored by the component that wrote it. Nothing is written here but the protocol —
 * the rate arrives through the simulation, provenanced, or the slot says it did not.
 *
 * A freshly dropped stake block holds no protocol at all (the store writes only
 * structural params), so the select opens on an explicit unset option rather than
 * claiming a choice the document does not hold.
 */
export function StakeBlock({ id, data, selected }: NodePropsFor<StakeBlockData>) {
  const runtime = useBlockRuntime();
  const fieldId = useId();
  const rejection = useWriteRejection();
  const blockValue = runtime.blockValues[id] ?? null;
  const apyWad = blockValue === null ? null : blockValue.apyWad;

  function handleProtocolChange(event: ChangeEvent<HTMLSelectElement>): void {
    // The select is bound to the document, so a refused write snaps the control back.
    // Reporting the store's reason is what keeps that from looking like a dead control.
    rejection.record(runtime.setBlockParam(id, "protocol", event.target.value));
  }

  const state: BlockState =
    rejection.reason !== null || !data.isValid
      ? "error"
      : !data.isConfigured
        ? "warning"
        : "valid";
  const message =
    rejection.reason !== null
      ? rejection.reason
      : !data.isValid
        ? data.errorMessage
        : !data.isConfigured
          ? "Choose the staking protocol this block routes through."
          : undefined;

  return (
    <BaseBlock
      id={id}
      kind="stake"
      title={TITLE}
      icon={<Layers />}
      state={state}
      selected={selected}
      message={message}
      valueSlot={
        <BlockValueZone subject={TITLE} value={blockValue} pending={runtime.pending} />
      }
    >
      <div className="space-y-1">
        <label htmlFor={fieldId} className="block text-xs text-muted-foreground">
          Protocol
        </label>
        <select
          id={fieldId}
          value={data.isConfigured ? data.protocol : ""}
          onChange={handleProtocolChange}
          className="focus-ring transition-fast nodrag h-8 w-full rounded-sm border border-border bg-input px-2 text-sm text-foreground"
        >
          {data.isConfigured ? null : (
            <option value="" disabled>
              Choose a protocol
            </option>
          )}
          {STAKE_PROTOCOLS.map((protocol) => (
            <option key={protocol.value} value={protocol.value}>
              {protocol.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-xs text-muted-foreground">Staking APY</span>
        <span className="ml-auto">
          <SourcedValue
            value={apyWad}
            pending={runtime.pending}
            label="Staking APY"
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
