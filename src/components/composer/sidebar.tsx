"use client";

/**
 * Composer sidebar — block palette, templates, collapse strip (treatment §4).
 *
 * Presentational on purpose: it takes three callbacks and holds no store subscription.
 * The keyboard add path needs a canvas-space coordinate and only the canvas host knows
 * the viewport, so the sidebar asks for a placement rather than inventing one — the same
 * reason `onLoadTemplate` returns the store's verdict instead of assuming a load
 * happened.
 *
 * The palette is keyed by `core/graph.ts`'s `BlockType`, so the vocabulary cannot drift
 * from the validator: adding a block type to core is a type error here until it is given
 * a row. The predecessor's `swap` entry does not survive that check — core has no swap
 * block — and neither do its per-type hue/glow, its estimated-APY strings nor its
 * RiskBadge (which rendered an unknown risk as green).
 */
import { useId, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  ChevronLeft,
  ChevronRight,
  HandCoins,
  Layers,
  Package,
  PackageOpen,
  PiggyBank,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { BlockType } from "../../core/graph";
import { STRATEGY_TEMPLATES } from "../../lib/strategy/templates";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

/**
 * The drop contract the canvas reads in `onDrop`. Exported so the two sides of the
 * gesture cite one constant instead of two string literals that can drift apart.
 */
export const BLOCK_DRAG_MIME = "application/reactflow";

interface PaletteEntry {
  readonly label: string;
  readonly icon: LucideIcon;
}

/** Record, not an array: the compiler refuses this table if core gains a block type. */
const PALETTE: Readonly<Record<BlockType, PaletteEntry>> = {
  input: { label: "Input", icon: Wallet },
  stake: { label: "Stake", icon: Layers },
  lend: { label: "Supply", icon: PiggyBank },
  borrow: { label: "Borrow", icon: HandCoins },
  wrap: { label: "Wrap", icon: Package },
  unwrap: { label: "Unwrap", icon: PackageOpen },
};

interface PaletteSection {
  readonly label: string;
  readonly types: readonly BlockType[];
}

const SECTIONS: readonly PaletteSection[] = [
  { label: "Source", types: ["input"] },
  { label: "Positions", types: ["stake", "lend", "borrow"] },
  { label: "Conversions", types: ["wrap", "unwrap"] },
];

/** Flat order for the collapsed icon strip — sections are a spacing rhythm, not data. */
const COLLAPSED_ORDER: readonly BlockType[] = SECTIONS.flatMap((s) => s.types);

type TabId = "blocks" | "templates";

interface TabDefinition {
  readonly id: TabId;
  readonly label: string;
}

const TABS: readonly TabDefinition[] = [
  { id: "blocks", label: "Blocks" },
  { id: "templates", label: "Templates" },
];

export interface SidebarProps {
  /**
   * Adds a block. The host places it at the canvas centre: drag is the pointer
   * affordance, and a palette reachable only by drag is an accessibility failure, so
   * every row is a real button whose activation adds.
   */
  onAddBlock: (type: BlockType) => void;
  /** The store's verdict. `false` means nothing was loaded, and the sidebar says so. */
  onLoadTemplate: (templateId: string) => boolean;
  /**
   * The store's verdict again. Clearing an already-empty canvas is a no-op there, and
   * announcing "canvas cleared" over a no-op is the same dishonesty as reporting a
   * template load that never happened.
   */
  onClear: () => boolean;
}

interface PaletteRowProps {
  readonly type: BlockType;
  readonly collapsed: boolean;
  readonly onAdd: (type: BlockType) => void;
}

function PaletteRow({ type, collapsed, onAdd }: PaletteRowProps) {
  const entry = PALETTE[type];
  const Icon = entry.icon;

  function handleDragStart(event: DragEvent<HTMLButtonElement>): void {
    event.dataTransfer.setData(BLOCK_DRAG_MIME, type);
    event.dataTransfer.effectAllowed = "move";
  }

  // Guard before preventDefault, and preventDefault before adding: suppressing the
  // native activation is what stops Enter from adding twice (once here, once via the
  // click the browser would synthesise afterwards).
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onAdd(type);
  }

  return (
    <button
      type="button"
      draggable
      data-block-type={type}
      onDragStart={handleDragStart}
      onClick={() => onAdd(type)}
      onKeyDown={handleKeyDown}
      {...(collapsed ? { "aria-label": `${entry.label} block`, title: entry.label } : {})}
      className={cn(
        "focus-ring transition-fast flex h-9 shrink-0 cursor-grab items-center gap-2 rounded-sm",
        "text-sm text-foreground hover:bg-card-hover active:cursor-grabbing",
        collapsed ? "w-9 justify-center" : "w-full px-3",
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {collapsed ? null : <span className="truncate">{entry.label}</span>}
    </button>
  );
}

/**
 * A message and the count of messages before it. The count is what makes a REPEAT
 * audible: two Stake adds in a row produce an identical string, React bails out on
 * `Object.is`, the text node never changes and no screen reader says the second one.
 * Keying the text node by the nonce remounts it, so every event announces.
 */
interface Announcement {
  readonly text: string;
  readonly nonce: number;
}

export function Sidebar({ onAddBlock, onLoadTemplate, onClear }: SidebarProps) {
  const baseId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<TabId>("blocks");
  // ONE polite region for the whole sidebar (taste gate: one live region per container),
  // mounted with the aside and never conditionally rendered — a region created in the
  // same commit as its first message is a region no assistive tech reads.
  const [announcement, setAnnouncement] = useState<Announcement>({ text: "", nonce: 0 });
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function announce(text: string): void {
    setAnnouncement((previous) => ({ text, nonce: previous.nonce + 1 }));
  }

  function handleAdd(type: BlockType): void {
    onAddBlock(type);
    announce(`${PALETTE[type].label} block added to the canvas.`);
  }

  function handleTemplate(templateId: string, name: string): void {
    const loaded = onLoadTemplate(templateId);
    announce(loaded ? `${name} loaded.` : `${name} could not be loaded.`);
  }

  function handleClear(): void {
    const cleared = onClear();
    announce(cleared ? "Canvas cleared." : "Canvas is already empty — nothing to clear.");
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = TABS.length - 1;
    let next: number;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    const target = TABS[next];
    if (target === undefined) return;
    setTab(target.id);
    tabRefs.current[next]?.focus();
  }

  const contentId = `${baseId}-content`;

  return (
    <aside
      // Names what the aside actually holds. "Block palette" described one of its three
      // tenants, so a screen-reader user landing here had no way to know the templates and
      // the canvas actions were in the same region.
      aria-label="Blocks, templates and canvas actions"
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-card",
        collapsed ? "w-12" : "w-64",
      )}
    >
      <p role="status" className="sr-only">
        <span key={announcement.nonce}>{announcement.text}</span>
      </p>

      <div className={cn("flex h-9 shrink-0 items-center", collapsed ? "justify-center" : "px-2")}>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={contentId}
          aria-label={collapsed ? "Expand block palette" : "Collapse block palette"}
          onClick={() => setCollapsed((previous) => !previous)}
          className="focus-ring transition-fast flex h-9 w-9 items-center justify-center rounded-sm text-muted-foreground hover:bg-card-hover"
        >
          {collapsed ? (
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {collapsed ? (
        <div id={contentId} className="flex flex-col items-center gap-1 overflow-y-auto pt-4">
          {COLLAPSED_ORDER.map((type) => (
            <PaletteRow key={type} type={type} collapsed onAdd={handleAdd} />
          ))}
        </div>
      ) : (
        <div id={contentId} className="flex min-h-0 flex-1 flex-col">
          <div role="tablist" aria-label="Palette sections" className="flex border-b border-border">
            {TABS.map((definition, index) => (
              <button
                key={definition.id}
                type="button"
                role="tab"
                id={`${baseId}-tab-${definition.id}`}
                aria-selected={tab === definition.id}
                aria-controls={`${baseId}-panel-${definition.id}`}
                tabIndex={tab === definition.id ? 0 : -1}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                onClick={() => setTab(definition.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                className={cn(
                  "focus-ring transition-fast h-9 flex-1 text-sm",
                  tab === definition.id
                    ? "border-b border-foreground text-foreground"
                    : "text-muted-foreground hover:bg-card-hover",
                )}
              >
                {definition.label}
              </button>
            ))}
          </div>

          <div
            id={`${baseId}-panel-blocks`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-blocks`}
            hidden={tab !== "blocks"}
            className="min-h-0 flex-1 overflow-y-auto pb-4"
          >
            {SECTIONS.map((section) => (
              <div key={section.label} className="px-2 pt-4">
                <p className="px-3 pb-1 text-label uppercase tracking-wider text-muted-foreground">
                  {section.label}
                </p>
                {section.types.map((type) => (
                  <PaletteRow key={type} type={type} collapsed={false} onAdd={handleAdd} />
                ))}
              </div>
            ))}
          </div>

          <div
            id={`${baseId}-panel-templates`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-templates`}
            hidden={tab !== "templates"}
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
          >
            <p className="px-3 pb-1 pt-4 text-label uppercase tracking-wider text-muted-foreground">
              Templates
            </p>
            {/* Name and prose only. No estimated APY and no risk badge: both were
                claims the template could not source, and the badge read an unknown
                risk as green. */}
            {STRATEGY_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => handleTemplate(template.id, template.name)}
                className="focus-ring transition-fast w-full rounded-sm px-3 py-2 text-left hover:bg-card-hover"
              >
                <span className="block text-sm font-medium text-foreground">{template.name}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {template.summary}
                </span>
              </button>
            ))}
          </div>

          <div className="shrink-0 border-t border-border p-2">
            <Button variant="outline" className="w-full" onClick={handleClear}>
              Clear canvas
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
}
