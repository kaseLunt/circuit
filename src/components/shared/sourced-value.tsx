"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { provenanceTrail, valueOf, type Provenanced } from "../../core/provenance";
import { SkeletonValue } from "../ui/skeleton";
import { cn } from "../../lib/utils";

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
   */
  pending: boolean;
  /** What this slot holds, e.g. "Supply APY". Announced while pending; never a value. */
  label: string;
  /** Width of the pending slot in `ch`, from the widest form `format` can produce. */
  chars: number;
  /** This quantity's formatter from core/format.ts. Components never format inline. */
  format: (value: T) => string;
  /** Prose for a source that settled without a value. Never a dash, never a zero. */
  unavailableReason?: string;
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
        className={cn(
          "focus-ring transition-fast rounded-sm tabular-nums",
          entered ? "opacity-100" : "opacity-0",
          className,
        )}
        onClick={() => setOpen((previous) => !previous)}
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
            "absolute left-0 top-full z-50 mt-1 w-max max-w-xs",
            "rounded-md border border-border bg-popover p-2 shadow-overlay",
          )}
        >
          <span className="block text-label uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {trail.map((line, index) => (
            <span
              key={`${index}-${line}`}
              className="block whitespace-pre font-mono text-xs tabular-nums text-popover-foreground"
            >
              {line}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
