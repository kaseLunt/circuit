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
 * mount effect means the canvas's first paint is the finished picture: no empty-canvas frame
 * to flash past between mount and template, and no entrance animation to cover one —
 * treatment §3, composition does the work. If the template ever failed to load, `loadTemplate`
 * records the reason and the canvas renders its designed load-problem state; nothing throws
 * and nothing substitutes a different strategy.
 *
 * SPEC §3 step 8 arrives through `./arrival.ts`, which owns WHICH document a session starts
 * on; this file owns only WHEN that decision is made. Two properties force the shape below:
 *
 * 1. THE TOKEN IS READ ONCE, ON MOUNT, AND NEVER RE-READ. `readShareToken` is the same
 *    reader `encode.ts` publishes, so the fragment and the recorded `?g=` compatibility path
 *    behave identically. A later hash change is the user's own `Copy link` writing the
 *    address bar, and re-resolving on it would reload the document out from under them.
 * 2. THE ARRIVAL IS RESOLVED IN A LAYOUT EFFECT, AND NO DOCUMENT IS EVER PAINTED TWICE. The
 *    payload rides the URL FRAGMENT (encode.ts: a fragment never reaches the server, so a
 *    shared graph stays out of access logs, `Referer` headers and CDN cache keys), which is
 *    invisible to the prerender by construction — so the arrival can only be resolved on the
 *    client.
 *
 *    MEASURED, not assumed: React Flow mounts NO nodes during SSR (`.react-flow__nodes` is
 *    empty in the prerendered HTML, and the canvas's empty state is what the shell carries).
 *    The server therefore renders no document for the client to disagree with, and the store
 *    swap below lands in the hydration commit — before React Flow has painted a single node.
 *    A share arrival never shows the flagship, not for one frame: the e2e gate asserts that
 *    no frame ever observes a borrow allocation other than the arriving graph's, and that the
 *    arrival page logs no hydration error. What the shell does show pre-hydration is the empty
 *    canvas, on EVERY path including step 1 — a React Flow SSR property this file does not
 *    control and does not paper over.
 *
 * The snapshot is built once, inside a try: `lib/recorded-reads` throws on a missing or
 * mis-shaped read rather than defaulting, so the failure surfaces as a labelled
 * `unavailable` state in the chrome and a settled-null simulation in the panel. There is no
 * partial snapshot worth rendering.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CANVAS_ORIGIN, StrategyCanvas } from "../canvas/canvas";
import { ComposerStoreProvider, useComposerStore } from "../../app/store/composer-provider";
import type { BlockPosition } from "../../app/store/composer-store";
import { sandboxSnapshot } from "../../lib/recorded-reads/sandbox-snapshot";
import { readShareToken } from "../../lib/share/encode";
import { describeArrivalFailure, type ShareRefusal } from "../../lib/share/share-url";
import { logError } from "../../lib/log";
import { ExecutionHost, createDefaultSandboxDriver } from "../tx/execution-host";
import { executingBlockIdOf } from "../tx/step-status";
import { flagshipStore, resolveArrival, type Arrival } from "./arrival";
import { ComposerShell } from "./composer-shell";
import { SandboxChrome } from "./sandbox-chrome";
import { ShareLink } from "./share-link";
import { ShareRefusalBand } from "./share-refusal";
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

  // The driver lives HERE so both consumers of one machine state can read it: the host
  // (the execution column) and the canvas (the T26 executing frame — the active step's
  // block carries border-primary during executing(k), P2 site five).
  const [driver] = useState(createDefaultSandboxDriver);
  const driverSnap = useSyncExternalStore(driver.subscribe, driver.snapshot, driver.snapshot);
  const executingBlockId = executingBlockIdOf(driverSnap.machine);

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
          executingBlockId={executingBlockId}
        />
      }
      simulation={simulation}
      simulationPending={simulationPending}
      panel={
        <ExecutionHost
          snapshot={snapshot}
          simulation={simulation}
          simulationPending={simulationPending}
          driver={driver}
        />
      }
      resolveDropPosition={resolveDropPosition}
    />
  );
}

/**
 * Layout on the client, plain effect on the server — where effects never run at all, so the
 * substitution changes nothing except that React is not asked to schedule a layout effect
 * during a render that has no layout. Chosen at module scope, so the hook identity is fixed
 * for the lifetime of the bundle and hook order cannot vary between renders.
 */
const useArrivalEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The frame, and the ONE owner of the refusal band.
 *
 * It lives inside the provider because both retirement rules are facts about the DOCUMENT: an
 * arrival refusal is history the moment a strategy exists on the canvas, and a compose refusal
 * is history the moment the document it was about changes (the `docRev` rule the block family
 * already uses for write rejections). One owner, because the two can be live at once — the
 * canvas is empty after a refused link, and `Copy link` on an empty canvas refuses too — and
 * two independently-mounted bands would stack a stale explanation on top of a fresh one.
 *
 * A compose refusal WINS: it is about what the user just did, where the arrival refusal is
 * about how they got here.
 */
function ComposerFrame({
  snapshot,
  arrival,
}: {
  readonly snapshot: SnapshotState;
  readonly arrival: Arrival;
}) {
  const hasStrategy = useComposerStore((state) => state.doc.blocks.length > 0);
  const rev = useComposerStore((state) => state.rev);
  const [composeRefusal, setComposeRefusal] = useState<ShareRefusal | null>(null);
  const [arrivalDismissed, setArrivalDismissed] = useState(false);

  // Render-time state adjustment, the pattern this codebase uses instead of a setState in an
  // effect body: a refusal about a document that has since moved is a refusal about nothing.
  const [seenRev, setSeenRev] = useState(rev);
  if (seenRev !== rev) {
    setSeenRev(rev);
    if (composeRefusal !== null) setComposeRefusal(null);
  }

  const showArrival = arrival.kind === "share-refused" && !arrivalDismissed && !hasStrategy;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <SandboxChrome snapshot={snapshot} actions={<ShareLink onRefused={setComposeRefusal} />} />
      {composeRefusal !== null ? (
        <ShareRefusalBand refusal={composeRefusal} onDismiss={() => setComposeRefusal(null)} />
      ) : showArrival && arrival.kind === "share-refused" ? (
        <ShareRefusalBand
          refusal={describeArrivalFailure(arrival.failure)}
          onDismiss={() => setArrivalDismissed(true)}
        />
      ) : null}
      <div className="min-h-0 flex-1">
        <ComposerBody snapshot={snapshot} />
      </div>
    </div>
  );
}

export function SandboxComposer() {
  const [store, setStore] = useState(flagshipStore);
  const [arrival, setArrival] = useState<Arrival>({ kind: "template" });
  const snapshot = useMemo(() => loadSandboxSnapshot(), []);

  useArrivalEffect(() => {
    const token = readShareToken(window.location);
    // No token is the prerendered case, which is already on screen and correct. Returning
    // here is what keeps the common path free of a second store and a second render.
    if (token === null) return;
    const resolved = resolveArrival(token);
    setStore(resolved.store);
    setArrival(resolved.arrival);
  }, []);

  return (
    <ComposerStoreProvider store={store}>
      <ComposerFrame snapshot={snapshot} arrival={arrival} />
    </ComposerStoreProvider>
  );
}
