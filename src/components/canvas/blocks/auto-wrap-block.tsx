"use client";

import { ArrowRight, Repeat } from "lucide-react";
import type { AutoWrapBlockData } from "../../../lib/strategy/types";
import { AssetChip } from "../../shared/asset-chip";
import { BaseBlock, useBlockRuntime, type BlockState } from "./base-block";
import { BlockValueZone } from "./block-value-badge";
import type { NodePropsFor } from "./node-props";

/**
 * A wrap or unwrap step between two protocols that disagree about a token's form.
 *
 * The dashed frame and the AUTO chip are the keepers from the prototype — they encode
 * real information: the user did not place this block, the route optimizer did. Both are
 * driven by `view[id].isAutoInserted`, so a wrap that arrived inside a share payload is
 * indistinguishable from a typed one and carries no badge, which is correct: the graph is
 * identical either way and the badge is a claim about authorship, not about the document.
 *
 * The block is system-managed and has no controls. The prototype's hover tooltip is gone
 * rather than fixed: it never rendered (no ancestor carried the `group` class) and its
 * comment claimed it showed a contract address while its body held a static sentence —
 * and addresses do not ride a shareable document in the first place.
 */
export function AutoWrapBlock({ id, data, selected }: NodePropsFor<AutoWrapBlockData>) {
  const runtime = useBlockRuntime();
  const title = data.isWrap ? "Wrap" : "Unwrap";
  const state: BlockState = !data.isValid ? "error" : data.isConfigured ? "valid" : "warning";

  return (
    <BaseBlock
      id={id}
      kind="auto-wrap"
      title={title}
      icon={<Repeat />}
      state={state}
      selected={selected}
      message={
        !data.isValid
          ? data.errorMessage
          : data.isConfigured
            ? undefined
            : "Connect a producer: the pair comes from the incoming edge."
      }
      valueSlot={
        <BlockValueZone
          subject={title}
          value={runtime.blockValues[id] ?? null}
          pending={runtime.pending}
        />
      }
    >
      {/* The pair is a read of the document, so an unconnected wrap draws no chips: a
          conversion nothing has chosen yet has no assets to name. */}
      {data.isConfigured ? (
        <div className="flex items-center justify-center gap-2">
          <AssetChip symbol={data.fromAsset} size="md" />
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <AssetChip symbol={data.toAsset} size="md" />
        </div>
      ) : null}
      {runtime.autoInsertedIds.has(id) ? (
        <p className="text-xs text-muted-foreground">Inserted for protocol compatibility.</p>
      ) : null}
    </BaseBlock>
  );
}
