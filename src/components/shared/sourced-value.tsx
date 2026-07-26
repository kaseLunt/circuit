"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { provenanceTrail, valueOf, type Provenanced } from "../../core/provenance";
import { SkeletonValue } from "../ui/skeleton";
import { cn } from "../../lib/utils";

export interface SlotRamp {
  /** Typography for a slot that is actually showing a figure. */
  readonly resolved: string;
  /** Size alone — enough for the skeleton to hold the box the figure will occupy. */
  readonly size: string;
}

/**
 * The className a `SourcedValue` may safely be handed, given what it is about to render.
 *
 * `SourcedValue`'s unavailable branch merges the caller's className OVER its mandated
 * `text-xs text-muted-foreground`, and tailwind-merge resolves that collision in the
 * CALLER's favour. So a className passed unconditionally prints "health factor
 * unavailable" at the weight, size and colour of a live figure — the loudest element on
 * the block making the falsest claim on it, and the pending/unavailable/zero conflation
 * treatment §5 trap 3 exists to stop.
 *
 * The ramp is therefore handed over only where a figure renders; while pending the size
 * survives alone so nothing moves when the number lands; and a settled failure gets
 * nothing at all, which is what lets the component's own prose styling through.
 *
 * This lives beside `SourcedValue` rather than in any one consumer because every call
 * site in the app has the same trap under it.
 */
export function slotClassName(
  present: boolean,
  pending: boolean,
  ramp: SlotRamp,
): string | undefined {
  if (present) return ramp.resolved;
  return pending ? ramp.size : undefined;
}

interface SourcedValueProps<T> {
  /**
   * The quantity, wrapped. `T` is only inferable through `Provenanced<T>` and `format`,
   * so a bare number cannot be passed here — SPEC §5's "nothing launders a literal into a
   * rendered figure" expressed as a type rather than a review note.
   */
  value: Provenanced<T> | null;
  /**
   * True while the source is still in flight. `null` + pending renders the skeleton;
   * `null` + settled renders the unavailable prose. Those are different facts and this
   * component refuses to guess which one a bare null means.
   *
   * Consumer contract (stale-while-revalidate): hold the last Observed and pass `null`
   * only for a settled failure. A refresh over an already-shown value is
   * `pending={false}` with the previous value still in place — never a null round-trip,
   * which would re-skeleton and re-fade the slot on every block poll.
   */
  pending: boolean;
  /** What this slot holds, e.g. "Supply APY". Announced while pending; never a value. */
  label: string;
  /** Width of the pending slot in `ch`, from the widest form `format` can produce. */
  chars: number;
  /** This quantity's formatter from core/format.ts. Components never format inline. */
  format: (value: T) => string;
  /**
   * Prose for a source that settled without a value. Never a dash, never a zero.
   * When the gap is STRUCTURAL (nothing attempts the read yet, e.g. gas before a
   * provider exists) rather than a per-instance failure: keep this terse and name
   * WHAT is missing ("not quoted"); the owning container states WHY, once.
   */
  unavailableReason?: string;
  /**
   * The slot sits INSIDE a sentence rather than in a column. Drops the resolved value's
   * width reservation — a reservation protects the alignment of a column, and there is no
   * column inside prose, where it only opens a gap before the next word. The pending
   * skeleton keeps its `chars` width either way: a slot with no box would let the sentence
   * reflow when the number lands.
   */
  inline?: boolean;
  className?: string;
}

/**
 * SPEC §3 step 2: the sole renderer of a money/rate/risk quantity. Three visually
 * disjoint states — pending, resolved, unavailable — and no way to express a fourth.
 *
 * Resolution is opacity only. The skeleton already holds the line box, so the number
 * arrives without moving anything, and a value that is present on the first paint renders
 * solid rather than fading: a first resolution is not an event worth animating.
 */
export function SourcedValue<T>({
  value,
  pending,
  label,
  chars,
  format,
  unavailableReason = "unavailable",
  inline = false,
  className,
}: SourcedValueProps<T>) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState(value !== null);
  const [wasNull, setWasNull] = useState(value === null);

  // Reset the cross-fade when the value transitions back to null, using React's
  // render-time state-adjustment pattern — a synchronous setState inside the
  // effect body triggers the compiler's cascading-render lint, and deriving the
  // reset during render is the documented alternative.
  if ((value === null) !== wasNull) {
    setWasNull(value === null);
    if (value === null) setEntered(false);
  }

  useEffect(() => {
    if (value === null || entered) return;
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [value, entered]);

  if (value === null) {
    if (pending) return <SkeletonValue label={label} chars={chars} className={className} />;
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>{unavailableReason}</span>
    );
  }

  const trail = provenanceTrail(value);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "Escape") setOpen(false);
  }

  return (
    <span className="relative inline-block">
      <button
        type="button"
        aria-describedby={open ? tooltipId : undefined}
        // The resolved state holds the pending state's box: `ch` resolves at the
        // value's own type size because the width lives on the element carrying
        // the caller's className. In prose there is no box to hold, only a gap to
        // open before the next word.
        style={inline ? undefined : { minWidth: `${chars}ch` }}
        className={cn(
          "focus-ring transition-fast inline-block rounded-sm text-left tabular-nums",
          entered ? "opacity-100" : "opacity-0",
          className,
        )}
        // Open-only: role="tooltip" is a describe surface, not a popover — a click
        // that latched it shut would hide the evidence under the pointer.
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onKeyDown={handleKeyDown}
      >
        {format(valueOf(value))}
      </button>
      {open ? (
        <span
          id={tooltipId}
          role="tooltip"
          className={cn(
            "absolute left-0 top-full z-50 mt-1 w-max max-w-sm overflow-hidden",
            "rounded-md border border-border bg-popover p-2 shadow-overlay",
          )}
        >
          <span className="block text-label uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {trail.map((line, index) => (
            <span
              key={`${index}-${line}`}
              className="block whitespace-pre-wrap font-mono text-xs tabular-nums text-popover-foreground"
            >
              {line}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
