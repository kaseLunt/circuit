"use client";

/**
 * The allocation edge.
 *
 * What it says is deliberately small: direction (particles), activity (particle rate) and
 * one semantic state (partial allocation). It says nothing about amounts — an amount is a
 * money quantity, it needs a block-pinned snapshot, and the predecessor's inline traversal
 * multiplied hand-written LTVs by a fabricated ETH price to produce one.
 *
 * Over-allocation (>100% out of one source) is NOT rendered here. It is a property of the
 * source block and is surfaced there, so a document with a bad split has one locus of
 * blame instead of three amber edges pointing at each other.
 *
 * Colour lives in canvas.css; this file assigns classes. The only inline geometry is the
 * bezier path and the particle timing.
 */

import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import { Unlink } from "lucide-react";
import { formatBpsAsPercent } from "../../core/format";
import { useComposerStoreApi } from "../../app/store/composer-provider";
import { FULL_ALLOCATION_BPS } from "../../lib/strategy/types";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

export interface AllocationEdgeData {
  /** This edge's share of its source's output, in the integer bps core validates. */
  readonly allocationBps: number;
  /** Everything the source sends out, so the popover can state the remainder honestly. */
  readonly sourceOutgoingBps: number;
  /**
   * What the canvas CALLS the two blocks — "Supply", "Borrow" — not what the store keys
   * them on. A money control names what the user can see; `source`/`target` are document
   * ids, and "Out of supply1" beside a block labelled Supply is the store leaking through
   * the one surface where a share is edited.
   */
  readonly sourceLabel: string;
  readonly targetLabel: string;
  [key: string]: unknown;
}

export type AllocationEdge = Edge<AllocationEdgeData, "allocation">;

/** Slower flow at the low end, faster at full allocation. Motion, not money. */
const PARTICLE_SLOW_MS = 4_000;
const PARTICLE_FAST_MS = 2_000;
const PARTICLE_RADIUS = 2;

const BPS_PER_PERCENT = 100;

/**
 * Percent from basis points, through core/format.ts and nothing else. Whole percentages
 * print without a decimal tail; anything finer keeps two digits rather than rounding a
 * shared link's 33.33% into a lie. The precision decision is the only thing decided here.
 */
function formatAllocation(bps: number): string {
  return formatBpsAsPercent(bps, bps % BPS_PER_PERCENT === 0 ? 0 : 2);
}

function particleCountFor(bps: number): number {
  if (bps >= FULL_ALLOCATION_BPS) return 5;
  if (bps >= FULL_ALLOCATION_BPS / 2) return 4;
  return 3;
}

function particleDurationMs(bps: number): number {
  const span = PARTICLE_SLOW_MS - PARTICLE_FAST_MS;
  return PARTICLE_SLOW_MS - Math.round((bps / FULL_ALLOCATION_BPS) * span);
}

function FlowEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<AllocationEdge>) {
  const api = useComposerStoreApi();
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  /**
   * The edit gesture is bound to the POPOVER, not to the slider's focus.
   *
   * Focus/blur looked equivalent and was not: every close path that does not synchronously
   * move focus unmounts the focused slider without firing `focusout`, so `endEdit` never
   * ran — and a `pendingEdit` left open stops the store pushing to `past` entirely, which
   * silently ends undo recording for the rest of the session. A cleanup closes on every
   * path there is, including unmount.
   */
  useEffect(() => {
    if (!open) return;
    api.getState().beginEdit("set edge allocation");
    return () => api.getState().endEdit();
  }, [open, api]);

  useEffect(() => {
    if (!open) return;
    sliderRef.current?.focus();
    function onPointerDown(event: PointerEvent): void {
      const node = event.target;
      if (!(node instanceof globalThis.Node)) return;
      if (popoverRef.current?.contains(node) === true) return;
      if (triggerRef.current?.contains(node) === true) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // A missing `data` is a missing allocation, and an allocation is not something to guess:
  // the path still draws (the connection is real) and the label does not.
  if (data === undefined) {
    return <BaseEdge id={id} path={edgePath} className="flow-edge__path" interactionWidth={24} />;
  }

  const { allocationBps, sourceOutgoingBps, sourceLabel, targetLabel } = data;
  const isPartial = allocationBps < FULL_ALLOCATION_BPS;
  const isOverAllocated = sourceOutgoingBps > FULL_ALLOCATION_BPS;
  const allocationText = formatAllocation(allocationBps);
  const count = particleCountFor(allocationBps);
  const durationMs = particleDurationMs(allocationBps);

  function handleAllocation(next: number): void {
    api.getState().setEdgeAllocationBps(id, next);
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        className={cn("flow-edge__path", isPartial && "flow-edge__path--partial")}
        interactionWidth={24}
      />

      {/* Flat dots: direction and rate, no glow filter, no pulse, no opacity animation.
          Reduced motion hides the whole group and canvas.css dashes the stroke instead. */}
      <g className="flow-edge__particles" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <circle key={i} r={PARTICLE_RADIUS} className="flow-edge__particle">
            <animateMotion
              dur={`${durationMs}ms`}
              begin={`${Math.round((i / count) * durationMs)}ms`}
              repeatCount="indefinite"
              path={edgePath}
            />
          </circle>
        ))}
      </g>

      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
        >
          <button
            ref={triggerRef}
            // The accessible name carries the SAME string the pill prints. Rounding it to
            // a whole percent for assistive technology told two different stories about
            // one number — and the rounded one was the false one.
            aria-label={`Allocation, ${sourceLabel} to ${targetLabel}, ${allocationText}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? popoverId : undefined}
            className={cn(
              "focus-ring transition-fast rounded-sm border border-border bg-card px-1.5 py-0.5 text-xs tabular-nums",
              isPartial ? "text-warning" : "text-muted-foreground",
            )}
            onClick={() => setOpen((previous) => !previous)}
          >
            {allocationText}
          </button>
        </div>

        {open ? (
          <div
            ref={popoverRef}
            id={popoverId}
            role="dialog"
            aria-label={`Allocation from ${sourceLabel} to ${targetLabel}`}
            className="nodrag nopan absolute z-50 w-60 rounded-md border border-border bg-popover p-3 shadow-overlay"
            style={{
              transform: `translate(-50%, -100%) translate(${labelX}px, ${labelY - 12}px)`,
              pointerEvents: "all",
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                close();
              }
            }}
          >
            <p className="text-label uppercase tracking-wide text-muted-foreground">Allocation</p>

            {/* The control is denominated in the units the store stores: a percent slider
                had to multiply on the way out, which quietly rounded a 33.33% edge to 33%
                the first time anyone opened it. */}
            <input
              ref={sliderRef}
              type="range"
              min={BPS_PER_PERCENT}
              max={FULL_ALLOCATION_BPS}
              step={BPS_PER_PERCENT}
              value={allocationBps}
              aria-label="Share of this block's output"
              aria-valuetext={allocationText}
              // Neutral, matching the borrow block's slider: two accent colours for one
              // control type carry no semantic content, and --primary has exactly five
              // sanctioned sites in this family. A slider is not one of them.
              className="focus-ring mt-3 w-full accent-foreground"
              onChange={(event) => handleAllocation(Number(event.target.value))}
            />

            <dl className="mt-3 space-y-1 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">This edge</dt>
                <dd className="tabular-nums text-foreground">{allocationText}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Out of {sourceLabel}</dt>
                <dd
                  className={cn(
                    "tabular-nums",
                    isOverAllocated ? "text-warning" : "text-foreground",
                  )}
                >
                  {formatAllocation(sourceOutgoingBps)}
                </dd>
              </div>
            </dl>

            <Button
              variant="ghost"
              size="sm"
              // Neutral on hover, not destructive: disconnecting is UNDOABLE, and the
              // button API reserves destructive chroma for irreversible commits — and
              // 12px text-destructive over the hover surface fails the 4.5:1 AA floor
              // (Codex phase finding 2). The Unlink glyph carries the semantics.
              className="mt-3 w-full justify-start text-muted-foreground hover:text-foreground"
              onClick={() => {
                api.getState().disconnect(id);
                setOpen(false);
              }}
            >
              <Unlink aria-hidden="true" />
              Disconnect
            </Button>
          </div>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}

export const FlowEdge = memo(FlowEdgeComponent);
