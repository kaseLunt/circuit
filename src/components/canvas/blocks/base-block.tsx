"use client";

import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";
import type { ActionResult } from "../../../app/store/composer-store";
import { formatBpsAsPercent } from "../../../core/format";
import type { HealthFactor } from "../../../core/health-factor";
import { valueOf, type Derived, type Provenanced } from "../../../core/provenance";
import type { BlockType, ComputedBlockValue } from "../../../lib/strategy/types";
import { SourcedValue } from "../../shared/sourced-value";
import { cn } from "../../../lib/utils";

/**
 * Every block type the composer can put on canvas. `swap` is excluded deliberately:
 * `core/graph.ts`'s BlockType has no swap member, so a swap block cannot survive
 * `validateGraph` and therefore cannot exist in a document — shipping a component for
 * it would advertise a capability the execution path refuses. `wrap` and `unwrap` are
 * one renderable family (`auto-wrap`); the direction rides `AutoWrapBlockData.isWrap`.
 */
export type RenderableBlockType = Exclude<BlockType, "swap">;

/**
 * Semantic block state. `valid` is the zero-chroma default — silence is what a working
 * block looks like. `executing` ships now and is consumed in P3; it is the only state
 * that spends --primary, and it spends it on a border and nothing else.
 */
export type BlockState = "valid" | "warning" | "error" | "executing";

/**
 * What the canvas hands the block family. It is a VIEW PROJECTION, not the store and
 * not the simulation: each field is the exact quantity a block renders, already
 * provenanced by whoever derived it, so no component can mint provenance and no block
 * can reach around the seam for a second opinion.
 *
 * The three provenanced maps are the money boundary. They are maps rather than
 * functions because `composer-store.ts`'s readers mint a fresh wrapper per call and
 * are documented to be called inside one memo keyed on `rev` — the canvas does that
 * once for the whole document instead of once per block per render.
 *
 * `minHealthFactor` is wrapped because SPEC §3 step 2 admits `Provenanced<T> | null`
 * and nothing else. The wrapper arrives already minted from `core/risk.ts`, the site that
 * derives the health factor — never from here and never from the canvas adapter, which
 * observes nothing. Here `null` means "no simulation at all", a different fact from
 * `{ status: "unknown" }`, which is why this field keeps its `| null` and
 * `SimulationResult.minHealthFactor` does not.
 */
export interface BlockRuntime {
  /**
   * Block ids the route optimizer inserted, in the store's CANONICAL ids — i.e.
   * `view[id].isAutoInserted` and nothing else. Deliberately not `BlockData.isAutoInserted`:
   * the graph must be byte-identical whether a wrap was typed or inserted, so the badge is
   * view state. A wrap that arrived in a share payload is indistinguishable from a
   * user-placed one and carries no badge by design.
   */
  readonly autoInsertedIds: ReadonlySet<string>;
  /**
   * The store selector's verdict on which sources route more than 100% of their output.
   * "Is it over" is answered here and nowhere else; "by how much" is
   * `outgoingAllocationBps`, so the two can never be derived twice and disagree.
   */
  readonly overAllocatedIds: ReadonlySet<string>;
  /** Total outgoing allocation per source, derived over the entered edge allocations. */
  readonly outgoingAllocationBps: Readonly<Record<string, Derived<number>>>;
  /**
   * The amount the DOCUMENT holds for an input block, wrapped in the provenance it actually
   * has: `Configured` while it is still the template's named default, `Entered` once the
   * user has typed one. The store decides which; nothing here may assume.
   */
  readonly inputAmounts: Readonly<Record<string, Provenanced<string>>>;
  /** Debt opened as a fraction of collateral (SPEC §5.2 `b`), with the same two origins. */
  readonly borrowAllocations: Readonly<Record<string, Provenanced<number>>>;
  /** The block currently executing (P3). Null outside an execution. */
  readonly executingBlockId: string | null;
  /** Per-block computed values from the block-pinned simulation. */
  readonly blockValues: Readonly<Record<string, ComputedBlockValue>>;
  /** Minimum health factor across the plan (SPEC §5.4), wrapped where it was derived. */
  readonly minHealthFactor: Provenanced<HealthFactor> | null;
  /** Collateral/debt oracle ratio at liquidation, WAD. A correlated pair has no USD price. */
  readonly liquidationRatioWad: Provenanced<bigint> | null;
  /**
   * True while the snapshot/simulation is in flight. `pending` + null renders a skeleton;
   * settled + null renders the unavailable prose. A block never guesses which a null means.
   */
  readonly pending: boolean;
  /**
   * The open edit gesture's label, or null. A value-change flash is a claim that the
   * number moved on its own; while the user is dragging the thing that moves it, the
   * claim is false, so the flash is suppressed for the duration.
   */
  readonly pendingEdit: string | null;
  /**
   * The document's monotonic revision. A change means the document moved underneath the
   * block — an undo, a share load, a template swap — which is what retires a refusal a
   * block is still showing about a value the document no longer holds.
   */
  readonly docRev: number;

  setBlockParam(id: string, key: string, value: string | number): ActionResult;
  setBorrowAllocationBps(id: string, bps: number): ActionResult;
  beginEdit(label: string): void;
  endEdit(): void;
}

const BlockRuntimeContext = createContext<BlockRuntime | null>(null);

export function BlockRuntimeProvider({
  value,
  children,
}: {
  value: BlockRuntime;
  children: ReactNode;
}) {
  return <BlockRuntimeContext.Provider value={value}>{children}</BlockRuntimeContext.Provider>;
}

/**
 * Throws rather than defaulting. A no-op runtime would swallow the user's edits in
 * silence and a zero-filled one would put fabricated numbers on the canvas; a missing
 * provider is a wiring bug and is worth failing loudly at first render.
 */
export function useBlockRuntime(): BlockRuntime {
  const runtime = useContext(BlockRuntimeContext);
  if (runtime === null) {
    throw new Error("Block components must render inside a <BlockRuntimeProvider>");
  }
  return runtime;
}

export interface WriteRejection {
  /** The store's own words for why it refused, or null while nothing is refused. */
  readonly reason: string | null;
  /** Records a write's outcome and answers whether it landed. */
  record(result: ActionResult): boolean;
  /** Drops a refusal the block has decided is no longer worth showing. */
  clear(): void;
}

/**
 * `ActionResult` exists to be read. A control bound to `data` snaps back on refusal, so
 * a swallowed result is a control that changes under the user with no explanation.
 *
 * The refusal is retired the moment the document moves: an undo or a share load makes a
 * refusal about the previous value, and a stale one would sit on a block whose contents
 * have already changed.
 */
export function useWriteRejection(): WriteRejection {
  const runtime = useBlockRuntime();
  const [reason, setReason] = useState<string | null>(null);
  const [seenRev, setSeenRev] = useState(runtime.docRev);

  if (seenRev !== runtime.docRev) {
    setSeenRev(runtime.docRev);
    if (reason !== null) setReason(null);
  }

  return {
    reason,
    record(result) {
      setReason(result.ok ? null : result.reason);
      return result.ok;
    },
    clear() {
      setReason(null);
    },
  };
}

/** Widest form `formatWadAsPercent` produces for a plausible rate: "12.34%". */
export const RATE_SLOT_CHARS = 7;

/** Widest plausible form of an over-allocation total: "1,150%". */
const ALLOCATION_SLOT_CHARS = 6;

/**
 * An error state with no copy is a colour and nothing else — unreachable for a screen
 * reader and unreadable for anyone who cannot separate red from amber. `errorMessage` is
 * optional on `BaseBlockData`, so the guarantee lives here rather than in five callers.
 */
const ERROR_WITHOUT_REASON = "This block can't run as configured.";

const STATE_BORDER: Readonly<Record<BlockState, string>> = {
  valid: "border-border",
  warning: "border-warning",
  error: "border-destructive",
  executing: "border-primary",
};

const STATE_DOT: Readonly<Record<BlockState, string | null>> = {
  valid: null,
  warning: "status-dot-warning",
  error: "status-dot-error",
  // No dot: the executing border is one of the five sanctioned --primary sites and a
  // second primary mark on the same block would make it six.
  executing: null,
};

export interface BaseBlockProps {
  /** The store id. Also the key every runtime lookup uses. */
  id: string;
  /** Feeds `data-block-type` and the accessible name. Never a style, never a hue. */
  kind: RenderableBlockType;
  title: string;
  /** A lucide glyph. Sized and coloured here so no block can spend chroma on identity. */
  icon: ReactNode;
  state: BlockState;
  selected: boolean;
  /** Warning/error copy. Reachable through `aria-describedby`, never through colour alone. */
  message?: string;
  hasInput?: boolean;
  hasOutput?: boolean;
  headerRight?: ReactNode;
  valueSlot?: ReactNode;
  children: ReactNode;
}

/**
 * The frame every block wears. One width, one header height, one selected ring, one set
 * of state colours — the block's TYPE is carried by its title, its icon and its content,
 * never by its palette, because a canvas whose blocks are five hues has spent its whole
 * colour budget before a single warning arrives.
 *
 * Skeletons are a value-slot state, not a block state: the frame renders immediately and
 * the slots inside it resolve, so nothing on the canvas ever pops into existence.
 */
export function BaseBlock({
  id,
  kind,
  title,
  icon,
  state,
  selected,
  message,
  hasInput = true,
  hasOutput = true,
  headerRight,
  valueSlot,
  children,
}: BaseBlockProps) {
  const runtime = useBlockRuntime();
  const messageId = useId();

  const isAutoInserted = runtime.autoInsertedIds.has(id);
  const isOverAllocated = runtime.overAllocatedIds.has(id);
  const outgoingBps = isOverAllocated ? (runtime.outgoingAllocationBps[id] ?? null) : null;

  // Over-allocation is surfaced on the SOURCE block (SPEC §2), so a valid-looking block
  // that routes 115% of its output is escalated here rather than by every caller.
  const escalated: BlockState = state === "valid" && isOverAllocated ? "warning" : state;
  // error > warning > executing > valid. Executing does NOT demote a live warning:
  // execution is the moment a warning matters most, and a frame that drops it there
  // hides the risk exactly when it becomes real.
  const effectiveState: BlockState =
    escalated === "error" || escalated === "warning"
      ? escalated
      : runtime.executingBlockId === id
        ? "executing"
        : escalated;

  const dotClass = STATE_DOT[effectiveState];
  const reason = effectiveState === "error" ? (message ?? ERROR_WITHOUT_REASON) : message;
  const showMessage =
    reason !== undefined && (effectiveState === "warning" || effectiveState === "error");

  // ONE polite live region per block, carrying only PER-BLOCK FACTS: this block's warning
  // or error, and this block's outgoing allocation. Both are about this block's identity
  // and both change rarely.
  //
  // Pending is deliberately NOT announced (taste finding S-2a). `runtime.pending` is one
  // shared flag across the whole canvas, so "values loading" was six simultaneous
  // announcements for one simulation cycle — and it dragged each block's warning back
  // through the region alongside it. Loading is already conveyed where it belongs: each
  // unresolved slot carries `aria-busy` on the element whose value is missing.
  const announcements: string[] = [];
  if (showMessage) announcements.push(`${title}: ${reason}`);
  if (outgoingBps !== null) {
    announcements.push(`${title} allocates ${formatBpsAsPercent(valueOf(outgoingBps))} of its output.`);
  }

  return (
    <div
      role="group"
      aria-label={`${kind} block, ${title}`}
      aria-describedby={showMessage ? messageId : undefined}
      data-block-type={kind}
      data-block-state={effectiveState}
      className={cn(
        "block-frame transition-fast relative w-60 rounded-lg border bg-card text-card-foreground",
        STATE_BORDER[effectiveState],
        // Provenance, not state: an inserted block is dashed and badged in neutral ink.
        isAutoInserted && "border-dashed",
        // One ring for every block type, in the two-layer .focus-ring grammar. The ring
        // is declared once in canvas.css; a second outline utility here would be a
        // second authority for the same 2px of chrome.
        selected && "block-selected",
      )}
    >
      {/* No className: handle geometry, paint and transition are declared once in
          canvas.css, which is imported after base.css and already wins on every property.
          A `!important` utility here would be a second authority for the same chrome —
          and the only thing that can defeat the stylesheet written to own it. */}
      {hasInput ? <Handle type="target" position={Position.Left} /> : null}

      <div className="flex h-9 items-center gap-2 rounded-t-lg border-b border-border bg-secondary px-3">
        <span
          aria-hidden="true"
          className="flex shrink-0 items-center text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5"
        >
          {icon}
        </span>
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {isAutoInserted ? (
            <span className="rounded-sm border border-border px-1 text-micro uppercase tracking-wider text-muted-foreground">
              AUTO
            </span>
          ) : null}
          {outgoingBps === null ? null : (
            // The digits are a DERIVED quantity — the sum of this source's entered edge
            // allocations — so they arrive wrapped and render through the one money
            // renderer, at text-xs. A number never goes below text-xs; the micro tier is
            // for uppercase label chrome only.
            <span className="flex items-center gap-1 rounded-sm border border-border px-1 text-xs tabular-nums text-warning">
              <SourcedValue
                value={outgoingBps}
                pending={false}
                label={`${title} outgoing allocation`}
                chars={ALLOCATION_SLOT_CHARS}
                format={formatBpsAsPercent}
                unavailableReason="allocation unavailable"
                // Exempt from `slotClassName`: the whole badge is mounted only when
                // `outgoingBps` is non-null and it is never pending, so this slot has no
                // unavailable branch to dress as a figure.
                className="nodrag text-xs tabular-nums text-warning"
              />
              {" allocated"}
            </span>
          )}
          {headerRight}
          {dotClass === null ? null : (
            <span aria-hidden="true" className={cn("status-dot transition-fast", dotClass)} />
          )}
        </span>
      </div>

      <div className="space-y-2 p-3">{children}</div>

      {showMessage ? (
        <div id={messageId} className="flex items-start gap-2 border-t border-border px-3 py-2">
          <AlertTriangle
            aria-hidden="true"
            className={cn(
              "transition-fast mt-0.5 h-3.5 w-3.5 shrink-0",
              effectiveState === "error" ? "text-destructive" : "text-warning",
            )}
          />
          <span className="text-xs text-foreground">{reason}</span>
        </div>
      ) : null}

      {valueSlot === undefined ? null : (
        <div className="space-y-1 border-t border-border px-3 py-2">{valueSlot}</div>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {announcements.join(" ")}
      </div>

      {hasOutput ? <Handle type="source" position={Position.Right} /> : null}
    </div>
  );
}
