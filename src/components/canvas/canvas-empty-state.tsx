"use client";

/**
 * The empty canvas.
 *
 * Three template cards and one sentence of instruction. No APY, no risk badge, no
 * estimated return: a template is prose plus a graph (lib/strategy/templates.ts), every
 * number on screen is a live read, and a card that quoted a yield would be quoting a
 * number no one measured.
 *
 * The overlay is `pointer-events-none` so a block dragged from the sidebar lands on the
 * canvas underneath; only the card row takes pointer events.
 */

import { useMemo, useState } from "react";
import { Info, MousePointerClick } from "lucide-react";
import { useComposerStoreApi } from "../../app/store/composer-provider";
import { STRATEGY_TEMPLATES } from "../../lib/strategy/templates";

export function CanvasEmptyState() {
  const api = useComposerStoreApi();
  const [failedId, setFailedId] = useState<string | null>(null);

  // graph() builds a fresh graph per call; counting blocks once keeps that off the
  // render path.
  const cards = useMemo(
    () =>
      STRATEGY_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        summary: template.summary,
        blockCount: template.graph().blocks.length,
      })),
    [],
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="w-full max-w-3xl px-8">
        <div className="text-center">
          <h2 className="text-base font-medium text-foreground">Start a strategy</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Open a template below, or drag a block in from the sidebar.
          </p>
        </div>

        {/* The summary sits OUTSIDE the button. A described element that is also a
            descendant is concatenated into the accessible name and then served again as
            the description, so every card was read twice. */}
        <div className="pointer-events-auto mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {cards.map((card) => (
            // The ring goes on the WRAPPER, because the wrapper is the card: it carries
            // the border, the surface and the hover, and the button covers only the top
            // of it. A ring around 60% of the thing that looks like the control does not
            // meet the visible-focus floor.
            <div
              key={card.id}
              className="focus-ring-within transition-fast rounded-lg border border-border bg-card hover:bg-card-hover"
            >
              <button
                type="button"
                aria-describedby={`template-summary-${card.id}`}
                className="w-full rounded-lg px-4 pb-2 pt-4 text-left outline-none"
                onClick={() => {
                  setFailedId(api.getState().loadTemplate(card.id) ? null : card.id);
                }}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{card.name}</span>
                  <span className="shrink-0 rounded-sm border border-border px-1 text-xs tabular-nums text-muted-foreground">
                    {card.blockCount} blocks
                  </span>
                </span>
              </button>
              <p
                id={`template-summary-${card.id}`}
                className="px-4 pb-4 text-xs text-muted-foreground"
              >
                {card.summary}
              </p>
            </div>
          ))}
        </div>

        {failedId === null ? null : (
          // Not a live region: the canvas owns the one polite region and announces load
          // failures from the store's `lastLoadProblem`. This is the visible half.
          //
          // Neutral, in the refusal strip's grammar: --destructive is reserved for money
          // risk, and a template that did not load is a mechanical failure, not one.
          <p className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Info aria-hidden="true" className="h-4 w-4 shrink-0" />
            That template could not be loaded.
          </p>
        )}

        <p className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <MousePointerClick aria-hidden="true" className="h-4 w-4" />
          Blocks connect left to right — one producer feeds one consumer.
        </p>
      </div>
    </div>
  );
}
