"use client";

/**
 * Composer layout shell.
 *
 * Structural only: three columns and the three sidebar actions forwarded to store
 * actions. It renders no quantity and imports no React Flow — the canvas arrives as a
 * node, so this file stays testable in jsdom and the canvas keeps ownership of its own
 * viewport.
 *
 * The store's React binding is `app/store/composer-provider.tsx` and nothing else. Two
 * bindings over one store would each carry their own subscription bookkeeping and drift
 * apart under maintenance; the canvas family already consumes that one, so this shell
 * takes the api from it rather than minting a second context.
 */
import type { ReactNode } from "react";
import type { BlockType } from "../../core/graph";
import { useComposerStoreApi } from "../../app/store/composer-provider";
import type { BlockPosition } from "../../app/store/composer-store";
import type { SimulationResult } from "../../lib/strategy/types";
import { Sidebar } from "./sidebar";
import { SimulationPanel } from "./simulation-panel";

export interface ComposerShellProps {
  /** The canvas surface. A node, so this shell never imports React Flow. */
  canvas: ReactNode;
  /** The panel's input. The shell computes nothing and never defaults it. */
  simulation: SimulationResult | null;
  simulationPending: boolean;
  /**
   * Replaces the right column wholesale when provided (the W07 execution host, which
   * owns the simulation-panel/execution-flow swap). Omitted, the shell renders the
   * simulation panel exactly as before — the shell stays structural either way.
   */
  panel?: ReactNode;
  /**
   * Canvas-space coordinate for a keyboard-placed block, resolved at the moment of the
   * keystroke because only the canvas knows the live viewport. The shell never invents
   * a position.
   */
  resolveDropPosition: () => BlockPosition;
  /** T26 write-lockdown reason while a run holds the document; null outside a run. */
  lockReason?: string | null;
}

export function ComposerShell({
  canvas,
  simulation,
  simulationPending,
  panel,
  resolveDropPosition,
  lockReason = null,
}: ComposerShellProps) {
  const api = useComposerStoreApi();

  /** Null is the store's refusal (T26), never a fabricated id — so the sidebar can say so. */
  function handleAddBlock(type: BlockType): boolean {
    return api.getState().addBlock(type, resolveDropPosition()) !== null;
  }

  function handleLoadTemplate(templateId: string): boolean {
    return api.getState().loadTemplate(templateId);
  }

  /**
   * `clear` returns void and no-ops on an already-empty document rather than pushing an
   * undo entry for nothing. The sidebar announces what happened, not what was asked for,
   * so the verdict is read from the document here — the store keeps its landed shape.
   *
   * The AFTER document is compared, not the before one: while a run holds the document the
   * store refuses the clear (T26), and reporting a clear that did not happen would be the same
   * dishonesty as announcing a template load that never landed.
   */
  function handleClear(): boolean {
    const before = api.getState().doc;
    if (before.blocks.length === 0 && before.edges.length === 0) return false;
    api.getState().clear();
    return api.getState().doc !== before;
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <Sidebar
        onAddBlock={handleAddBlock}
        onLoadTemplate={handleLoadTemplate}
        onClear={handleClear}
        lockReason={lockReason}
      />
      {/* Unlabelled on purpose: the canvas wrapper carries role=application and the
          "Strategy canvas" label, and a second landmark with the same name would be
          announced twice. */}
      <div className="relative min-w-0 flex-1">{canvas}</div>
      {panel === undefined ? (
        <SimulationPanel result={simulation} pending={simulationPending} />
      ) : (
        panel
      )}
    </div>
  );
}
