"use client";

/**
 * The P2 host: the one component that owns a composer session.
 *
 * It assembles four things that each refuse to know about the others — the store, the
 * block-pinned read set, `core/risk.ts`, and the three-column shell — and it is the only
 * place they meet. Nothing below it fetches, and nothing below it derives a quantity.
 *
 * The store is created ALREADY CARRYING the flagship (SPEC §3 step 1: the composer opens
 * with the Leveraged Restake Loop laid out). Loading in the state initializer rather than a
 * mount effect means the first paint is the finished picture: there is no empty-canvas frame
 * to flash past, and no entrance animation to cover one — treatment §3, composition does the
 * work. If the template ever failed to load, `loadTemplate` records the reason and the
 * canvas renders its designed load-problem state; nothing throws and nothing substitutes a
 * different strategy.
 *
 * The snapshot is built once, inside a try: `lib/recorded-reads` throws on a missing or
 * mis-shaped read rather than defaulting, so the failure surfaces as a labelled
 * `unavailable` state in the chrome and a settled-null simulation in the panel. There is no
 * partial snapshot worth rendering.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { CANVAS_ORIGIN, StrategyCanvas } from "../canvas/canvas";
import { ComposerStoreProvider } from "../../app/store/composer-provider";
import { createComposerStore, type BlockPosition } from "../../app/store/composer-store";
import { sandboxSnapshot } from "../../lib/recorded-reads/sandbox-snapshot";
import { FLAGSHIP_TEMPLATE_ID } from "../../lib/strategy/templates";
import { logError } from "../../lib/log";
import { ComposerShell } from "./composer-shell";
import { SandboxChrome } from "./sandbox-chrome";
import { useSimulation, type SnapshotState } from "./simulation-host";

export function loadSandboxSnapshot(): SnapshotState {
  try {
    return { status: "ready", snapshot: sandboxSnapshot() };
  } catch (error) {
    logError("sandbox snapshot could not be built from the committed reads log", error);
    return { status: "unavailable", reason: "the committed reads log could not be read" };
  }
}

function ComposerBody({ snapshot }: { readonly snapshot: SnapshotState }) {
  const { simulation, simulationPending } = useSimulation(snapshot);

  // Filled by the canvas once it has a viewport (see StrategyCanvasProps.dropPositionRef).
  // Read only inside the shell's keyboard handler, so the composer does not re-render when
  // the user pans.
  const dropPosition = useRef<(() => BlockPosition) | null>(null);
  const resolveDropPosition = useCallback(
    () => dropPosition.current?.() ?? CANVAS_ORIGIN,
    [],
  );

  return (
    <ComposerShell
      canvas={
        <StrategyCanvas
          simulation={simulation}
          simulationPending={simulationPending}
          dropPositionRef={dropPosition}
        />
      }
      simulation={simulation}
      simulationPending={simulationPending}
      resolveDropPosition={resolveDropPosition}
    />
  );
}

export function SandboxComposer() {
  const [store] = useState(() => {
    const created = createComposerStore();
    created.getState().loadTemplate(FLAGSHIP_TEMPLATE_ID);
    return created;
  });
  const snapshot = useMemo(() => loadSandboxSnapshot(), []);

  return (
    <ComposerStoreProvider store={store}>
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        <SandboxChrome snapshot={snapshot} />
        <div className="min-h-0 flex-1">
          <ComposerBody snapshot={snapshot} />
        </div>
      </div>
    </ComposerStoreProvider>
  );
}
