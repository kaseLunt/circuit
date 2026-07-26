"use client";

/**
 * The multi-selection toolbar.
 *
 * The 150ms delay is the whole reason this component holds state: without it the bar
 * appears under the cursor mid-box-select and eats the drag. The delay is a named
 * constant rather than a magic number because it is an interaction decision.
 *
 * Centering is a static CSS transform. The predecessor set `translateX(-50%)` in `style`
 * and then let framer-motion animate `transform`, which overwrote it — the bar was never
 * actually centred. Nothing here animates but opacity.
 */

import { useEffect, useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

/** Long enough that a box-select gesture finishes before the bar can intercept it. */
export const SELECTION_BAR_REVEAL_MS = 150;

/** Gap between the selection's bottom edge and the bar. */
const BAR_OFFSET_PX = 20;

interface SelectionActionBarProps {
  count: number;
  /** Screen-space anchor, or null when the selection has no measured geometry. */
  position: { x: number; y: number } | null;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function SelectionActionBar({
  count,
  position,
  onDuplicate,
  onDelete,
}: SelectionActionBarProps) {
  const [revealed, setRevealed] = useState(false);
  const [wasActive, setWasActive] = useState(false);
  const active = count >= 2 && position !== null;

  // Render-time state adjustment rather than an effect body: a synchronous setState in an
  // effect is a cascading render, and the reveal has to reset in the same paint the
  // selection changes in — an effect would show the previous selection's bar for a frame.
  if (wasActive !== active) {
    setWasActive(active);
    setRevealed(false);
  }

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setRevealed(true), SELECTION_BAR_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [active]);

  if (!active || position === null) return null;

  return (
    <div
      // Hit-testing follows visibility. Delaying only the opacity left the bar mounted,
      // hit-testable and pointer-events-auto for the whole 150 ms — still eating the
      // box-select drag it exists to stay out of, just invisibly.
      className={cn(
        "absolute z-20 -translate-x-1/2",
        revealed ? "pointer-events-auto" : "pointer-events-none",
      )}
      style={{ left: position.x, top: position.y + BAR_OFFSET_PX }}
    >
      <div
        // A labelled group, not role="toolbar": the toolbar role obliges roving arrow-key
        // navigation, and building it for two controls trades working Tab for a widget
        // contract nothing here needs. The name is what a screen reader is owed.
        role="group"
        aria-label="Selection actions"
        className={cn(
          "transition-fast flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1.5 shadow-overlay",
          revealed ? "opacity-100" : "opacity-0",
        )}
      >
        <span className="rounded-sm border border-border px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
          {count} selected
        </span>
        <Button variant="ghost" size="sm" onClick={onDuplicate}>
          <Copy aria-hidden="true" />
          Duplicate
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Delete selection"
          // Neutral at rest, destructive on intent: the colour arrives with the cursor, so
          // a resting canvas keeps its achromatic budget.
          className="text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
