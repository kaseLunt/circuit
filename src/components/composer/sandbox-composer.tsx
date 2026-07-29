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
import { buildPlan } from "../../core/plan";
import { readShareToken } from "../../lib/share/encode";
import { describeArrivalFailure, type ShareRefusal } from "../../lib/share/share-url";
import { logError } from "../../lib/log";
import { ExecutionHost, createDefaultSandboxDriver } from "../tx/execution-host";
import { liveExecuteRefusalOf, type LiveExecuteRefusal } from "../../lib/wallet/gate";
import { WalletProvider, useWalletBoundary } from "../../lib/wallet/wallet-provider";
import {
  MOCK_ACCOUNTS,
  MOCK_CODE_BEARING_ACCOUNTS,
  MOCK_OCCUPIED_ACCOUNTS,
} from "../../lib/wallet/config";
import { configuredDemoSeam } from "../../lib/wallet/seam";
import { ConnectSurface, type ComposerMode } from "../wallet/connect-surface";
import { executingBlockIdOf, runLocksDocument, RUN_LOCK_REASON } from "../tx/step-status";
import { flagshipStore, resolveArrival, type Arrival } from "./arrival";
import { ComposerShell } from "./composer-shell";
import { SandboxChrome } from "./sandbox-chrome";
import { ShareLink } from "./share-link";
import { ShareRefusalBand } from "./share-refusal";
import { useBorrowLimit, useSimulation, type SnapshotState } from "./simulation-host";

export function loadSandboxSnapshot(): SnapshotState {
  try {
    return { status: "ready", snapshot: sandboxSnapshot() };
  } catch (error) {
    logError("sandbox snapshot could not be built from the committed reads log", error);
    return { status: "unavailable", reason: "the committed reads log could not be read" };
  }
}

/**
 * SPEC §3 step 7's gate, assembled where the wallet and the document meet.
 *
 * The plan is built over the SANDBOX read set — that is what the canvas is showing — and it
 * is handed to the gate only so `planRequiresCodeFreeActor` can answer whether this strategy
 * contains a WETH withdrawal. Nothing about the wallet's balances is read from it.
 *
 * `simulation: null` is a STATEMENT, not a stub: no simulation has been run against the
 * connected wallet's real balances, so the gate refuses with `no-fresh-simulation` and
 * Execute stays gated — which is SPEC §3 step 7 verbatim. Wiring a live capture is the first
 * item on `docs/live-execution-checklist.md`.
 */
export function useLiveGate(snapshot: SnapshotState): {
  readonly mode: ComposerMode;
  readonly refusal: LiveExecuteRefusal | null;
} {
  const wallet = useWalletBoundary();
  const doc = useComposerStore((state) => state.doc);
  const mode: ComposerMode = wallet.session === null ? "sandbox" : "live";
  const plan = useMemo(
    () => (snapshot.status === "ready" ? buildPlan(doc, snapshot.snapshot) : null),
    [doc, snapshot],
  );
  if (mode === "sandbox") return { mode, refusal: null };
  if (plan === null || !plan.ok) {
    return { mode, refusal: { kind: "no-fresh-simulation" } };
  }
  return {
    mode,
    refusal: liveExecuteRefusalOf({
      session: wallet.session,
      readings: wallet.readings,
      plan,
      simulation: null,
      nowMonotonicMs: wallet.monotonicNow(),
    }),
  };
}

function ComposerBody({ snapshot }: { readonly snapshot: SnapshotState }) {
  const { simulation, simulationPending } = useSimulation(snapshot);
  const live = useLiveGate(snapshot);
  // SPEC §3 step 4's verdict, derived once beside the simulation and handed to BOTH the
  // canvas (the block's inline refusal) and the execution column (the Simulate gate). One
  // derivation, two consumers — the two can never disagree about whether the borrow is past
  // the limit, which is the whole point of deriving it here rather than in each of them.
  const borrowLimit = useBorrowLimit(snapshot);

  // The driver lives HERE so both consumers of one machine state can read it: the host
  // (the execution column) and the canvas (the T26 executing frame — the active step's
  // block carries border-primary during executing(k), P2 site five).
  const [driver] = useState(createDefaultSandboxDriver);
  const driverSnap = useSyncExternalStore(driver.subscribe, driver.snapshot, driver.snapshot);
  const executingBlockId = executingBlockIdOf(driverSnap.machine);
  // T26: one derivation of "the document is frozen", handed to the palette and to the
  // canvas. Reads stay live everywhere; only writes refuse, and they refuse in words.
  const writeLockReason = runLocksDocument(driverSnap.machine) ? RUN_LOCK_REASON : null;

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
          borrowLimit={borrowLimit}
          writeLockReason={writeLockReason}
        />
      }
      simulation={simulation}
      simulationPending={simulationPending}
      panel={
        <ExecutionHost
          snapshot={snapshot}
          simulation={simulation}
          simulationPending={simulationPending}
          borrowLimit={borrowLimit}
          mode={live.mode}
          liveRefusal={live.refusal}
          driver={driver}
        />
      }
      resolveDropPosition={resolveDropPosition}
      lockReason={writeLockReason}
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
  const wallet = useWalletBoundary();
  const mode: ComposerMode = wallet.session === null ? "sandbox" : "live";
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
      <SandboxChrome
        snapshot={snapshot}
        mode={mode}
        actions={
          <>
            <ConnectSurface />
            <ShareLink onRefused={setComposeRefusal} />
          </>
        }
      />
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

/**
 * The seam the running build uses. A demo/CI build (mock accounts configured) reads the
 * scenario table; a production build has none, so the provider's own stated-unavailable
 * default answers and the live gate REFUSES rather than admitting. Wiring the real
 * `eth_getCode` + footprint reads through `server/chain` is the first item on
 * `docs/live-execution-checklist.md`.
 */
const demoSeamOrDefault =
  configuredDemoSeam(
    { codeBearing: MOCK_CODE_BEARING_ACCOUNTS, occupied: MOCK_OCCUPIED_ACCOUNTS },
    MOCK_ACCOUNTS.length > 0,
  ) ?? undefined;

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
    <WalletProvider seam={demoSeamOrDefault}>
      <ComposerStoreProvider store={store}>
        <ComposerFrame snapshot={snapshot} arrival={arrival} />
      </ComposerStoreProvider>
    </WalletProvider>
  );
}
