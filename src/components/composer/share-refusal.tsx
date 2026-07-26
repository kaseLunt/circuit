"use client";

/**
 * The one band both share refusals speak through — a link that would not open (SPEC §3
 * step 8's failing case) and a document that would not encode.
 *
 * The band exists because the alternative is a lie of omission. `loadFromShare` leaves the
 * document untouched when it refuses, so an arrival that quietly fell back to the flagship
 * would show a stranger a strategy they never sent, with nothing on screen to say the link
 * was refused at all. The composer therefore arrives on an EMPTY document with this band
 * above it, and the canvas's own empty state supplies the recovery path.
 *
 * It takes a `ShareRefusal` rather than a failure code because the two directions have
 * different owners and different lifetimes — arrival is decided once at mount by
 * `resolveArrival`, compose by a click. What they share is the GRAMMAR: headline, reason, the
 * validator's own bounded words, dismiss. The author must never learn LESS about a refusal
 * than the recipient does, which is exactly what happened while the compose path was routing
 * its reason through a four-second transient and dropping the details on the floor.
 *
 * Neutral, not `--destructive` and not `--warning`: a refused payload is the system WORKING.
 * The reader is safe *because* the validator refused, and dressing a successful defence as an
 * emergency both performs alarm over a non-event and spends chroma budgeted for money risk —
 * the step-3 crossing, partial allocation, over-allocation (treatment §2, §5 trap 1).
 *
 * NO auto-timeout, either direction. On arrival this is the only explanation the recipient
 * will ever get for why the canvas is empty; on compose it carries the zod paths and
 * validator errors that name the block to fix. A notice that expires while it is being read
 * is a notice that was not given. Retirement is the owner's call, never the clock's.
 */

import { Info, X } from "lucide-react";
import type { ShareRefusal } from "../../lib/share/share-url";

interface ShareRefusalBandProps {
  readonly refusal: ShareRefusal;
  readonly onDismiss: () => void;
}

export function ShareRefusalBand({ refusal, onDismiss }: ShareRefusalBandProps) {
  return (
    // Polite, never `alert`: the band arrives as a post-hydration DOM change or as the
    // response to a click, and nothing about it is urgent. The canvas's always-mounted
    // region carries the short form of the arrival event; this one carries the detail.
    <div
      role="status"
      className="flex shrink-0 items-start gap-2 border-b border-border bg-card px-4 py-3"
    >
      <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{refusal.headline}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{refusal.reason}</p>
        {refusal.details.length === 0 ? null : (
          // The validator's own words, capped and counted by the describers. Monospace
          // because these are identifiers and paths: read as prose, a payload's text is
          // easily mistaken for the app's own.
          <ul className="mt-1.5 space-y-0.5">
            {refusal.details.map((detail, index) => (
              <li
                key={`${index}-${detail}`}
                className="break-all font-mono text-xs text-muted-foreground"
              >
                {detail}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="focus-ring transition-fast -mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-card-hover"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
