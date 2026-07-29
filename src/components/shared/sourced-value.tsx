"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  provenanceTrail,
  valueOf,
  withoutInheritedNotes,
  type Provenanced,
  type TrailEntry,
} from "../../core/provenance";
import { SkeletonValue } from "../ui/skeleton";
import { cn } from "../../lib/utils";

/**
 * How a slot shows its evidence.
 *
 * `tooltip` is the canvas surface: it floats, so it is capped (below) and can never grow past
 * the block it belongs to. `disclosure` is the panel surface: the evidence expands INTO the
 * container's own flow, so it scrolls with the panel, its text is selectable, and there is no
 * height it can outgrow. A 2528px floating tooltip — which is what the uncapped trail produced
 * — is not a long tooltip, it is the wrong container.
 */
export type ProvenanceSurface = "tooltip" | "disclosure";

/**
 * How deep a floating tooltip may go: the value's own line plus its immediate inputs.
 *
 * Everything below that is reachable through the disclosure surface, and the tooltip SAYS how
 * much it is not showing rather than trailing off. A count is a fact; an ellipsis is a shrug.
 */
const TOOLTIP_MAX_DEPTH = 1;

function cappedTrail(entries: readonly TrailEntry[]): {
  readonly shown: readonly TrailEntry[];
  readonly hidden: number;
} {
  const shown = entries.filter((entry) => entry.depth <= TOOLTIP_MAX_DEPTH);
  return { shown, hidden: entries.length - shown.length };
}

/** Nesting rendered as PADDING, so a wrapped continuation stays under its own entry. */
const DEPTH_INDENT_REM = 0.75;

/**
 * Viewport collision gutter for the floating tooltip: one 0.5rem step from the spacing
 * scale (the `--space-2`-class step — no new token). Evidence flush against the bezel
 * reads as cropped; the box shifts left just enough to keep this gutter.
 */
const TOOLTIP_GUTTER_PX = 8;

function TrailLines({ entries }: { entries: readonly TrailEntry[] }) {
  // Inherited echoes are dropped at the RENDER; the data still carries them.
  const rendered = withoutInheritedNotes(entries);
  return (
    <>
      {rendered.map((entry, index) => (
        <span
          key={`${index}-${entry.text}`}
          className="block break-words font-mono text-xs tabular-nums text-foreground"
          style={{ paddingLeft: `${entry.depth * DEPTH_INDENT_REM}rem` }}
        >
          {entry.text}
          {(entry.notes ?? []).map((note) => (
            // The WHY, visibly not the formula: muted, on its own line, so it reads as
            // annotation rather than as more arithmetic. One line per qualification —
            // none of them stands in for another.
            <span key={note} className="block text-muted-foreground">
              {note}
            </span>
          ))}
        </span>
      ))}
    </>
  );
}

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
  /**
   * Where the evidence goes. Defaults to `tooltip` — the canvas surface, capped at one level
   * of inputs. Panel slots pass `disclosure`, which expands in the owning container's flow.
   */
  provenance?: ProvenanceSurface;
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
  provenance = "tooltip",
  className,
}: SourcedValueProps<T>) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const tooltipBoxRef = useRef<HTMLSpanElement>(null);
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

  // Measurement-driven positioning, written to the node directly: this is layout, not
  // state — a setState here would re-render for a value React never reads, and the
  // shift must land before paint. Extends the existing tooltip (T35: no second
  // evidence surface); the box keeps the gutter instead of kissing the bezel.
  useLayoutEffect(() => {
    if (!open) return;
    const node = tooltipBoxRef.current;
    if (node === null) return;
    node.style.left = "0px";
    const rect = node.getBoundingClientRect();
    const overflow = rect.right + TOOLTIP_GUTTER_PX - window.innerWidth;
    if (overflow > 0) node.style.left = `${-overflow}px`;
  }, [open]);

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

  if (provenance === "disclosure") {
    return (
      <DisclosureValue
        formatted={format(valueOf(value))}
        label={label}
        trail={trail}
        chars={chars}
        inline={inline}
        entered={entered}
        className={className}
        open={open}
        setOpen={setOpen}
        triggerRef={triggerRef}
        panelRef={panelRef}
        disclosureId={tooltipId}
      />
    );
  }

  const { shown, hidden } = cappedTrail(trail);

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
          ref={tooltipBoxRef}
          id={tooltipId}
          role="tooltip"
          className={cn(
            "absolute left-0 top-full z-50 mt-1 w-max max-w-md overflow-hidden",
            "rounded-md border border-border bg-popover p-2 shadow-overlay",
          )}
        >
          <span className="block text-label uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <TrailLines entries={shown} />
          {hidden === 0 ? null : (
            // States the remainder as a COUNT. The full tree is one click away on the panel's
            // disclosure surface; a floating box is the wrong place to put it.
            <span className="block pt-1 text-xs text-muted-foreground">
              {`${hidden} more derivation ${hidden === 1 ? "step" : "steps"}`}
            </span>
          )}
        </span>
      ) : null}
    </span>
  );
}

interface DisclosureValueProps {
  readonly formatted: string;
  readonly label: string;
  readonly trail: readonly TrailEntry[];
  readonly chars: number;
  readonly inline: boolean;
  readonly entered: boolean;
  readonly className?: string;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly panelRef: React.RefObject<HTMLSpanElement | null>;
  readonly disclosureId: string;
}

/**
 * The panel surface: evidence in the FLOW, not floating over it.
 *
 * A provenance tree is long by nature — the flagship's net APY is sixty lines — and a floating
 * box that tall is unusable at any width: it cannot scroll with its container, its text is
 * awkward to select, and it covers the thing it is explaining. Expanding inline solves all
 * three at once, and costs only that the section below it moves down, which is what a
 * disclosure is supposed to do.
 *
 * Keyboard contract: the trigger is a real `aria-expanded` button, focus MOVES INTO the opened
 * section (so a screen reader lands on the evidence rather than announcing it exists), Escape
 * returns focus to the trigger, and an explicit Close does the same for pointer users.
 */
function DisclosureValue({
  formatted,
  label,
  trail,
  chars,
  inline,
  entered,
  className,
  open,
  setOpen,
  triggerRef,
  panelRef,
  disclosureId,
}: DisclosureValueProps) {
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open, panelRef]);

  function close(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    // Block-level SPANS throughout: several panel slots sit inside prose or inline cells,
    // where a <div> is invalid HTML and a hydration mismatch. The WRAPPER follows the
    // caller's `inline` intent so a figure inside a sentence stays in the line; the panel
    // below it is block-level either way and lands beneath the sentence.
    <span className={inline ? "inline" : "block"}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? disclosureId : undefined}
        style={inline ? undefined : { minWidth: `${chars}ch` }}
        className={cn(
          "focus-ring transition-fast inline-block rounded-sm text-left tabular-nums",
          entered ? "opacity-100" : "opacity-0",
          className,
        )}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {formatted}
      </button>
      {open ? (
        <span
          ref={panelRef}
          id={disclosureId}
          tabIndex={-1}
          role="group"
          aria-label={`${label} provenance`}
          className="focus-ring mt-2 block max-h-96 overflow-y-auto rounded-md border border-border bg-card p-2 text-left"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          {/* Sticky, and it carries the SUBJECT: a long tree scrolled past its own opening
              line would otherwise leave the reader holding evidence for something they can
              no longer name — and with no way out but the keyboard. */}
          <span className="sticky top-0 z-10 -m-2 mb-0 flex items-baseline gap-2 border-b border-border bg-card p-2">
            {/* Three SIBLINGS, and the order of shrinkage is the point: the label absorbs the
                loss, the figure never does. Nested inside the truncating label, the longest
                panel subject clipped the one thing this header exists to keep on screen. */}
            <span className="min-w-0 flex-1 truncate text-label uppercase tracking-wide text-muted-foreground">
              {`Provenance · ${label}`}
            </span>
            <span className="shrink-0 text-label tabular-nums text-foreground">{formatted}</span>
            <button
              type="button"
              onClick={close}
              className="focus-ring shrink-0 rounded-sm text-xs text-muted-foreground"
            >
              Close
            </button>
          </span>
          {/* Selectable, wrapping, and scrolling with the panel: the whole point of being in
              the flow. Wide trees scroll horizontally in their own box rather than widening
              the panel. */}
          <span className="mt-1 block overflow-x-auto">
            <TrailLines entries={trail} />
          </span>
        </span>
      ) : null}
    </span>
  );
}
