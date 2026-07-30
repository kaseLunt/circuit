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
import {
  ComposerStoreProvider,
  useComposerStore,
  useComposerStoreApi,
} from "../../app/store/composer-provider";
import type { BlockPosition } from "../../app/store/composer-store";
import { sandboxSnapshot } from "../../lib/recorded-reads/sandbox-snapshot";
import { buildPlan } from "../../core/plan";
import { readShareToken } from "../../lib/share/encode";
import { describeArrivalFailure, type ShareRefusal } from "../../lib/share/share-url";
import { logError } from "../../lib/log";
import { ExecutionHost, createDefaultSandboxDriver } from "../tx/execution-host";
import {
  liveExecuteRefusalOf,
  msUntilStale,
  type LiveExecuteRefusal,
} from "../../lib/wallet/gate";
import { WalletProvider, useWalletBoundary } from "../../lib/wallet/wallet-provider";
import {
  MOCK_ACCOUNTS,
  MOCK_CODE_BEARING_ACCOUNTS,
  MOCK_OCCUPIED_ACCOUNTS,
} from "../../lib/wallet/config";
import { configuredDemoSeam } from "../../lib/wallet/seam";
import { demoLiveCaptureSource } from "../../lib/live/demo-capture";
import { liveSeam, trpcLiveCaptureSource } from "../../lib/live/live-transport";
import { routedCaptureSource, routedSeam } from "../../lib/live/readiness-source";
import { useLiveSimulation, type LiveSimulationView } from "./live-simulation";
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
 * What the composer's live gate publishes: the verdict the button is PAINTED with, and the
 * re-decision the moment of commitment requires.
 */
export interface LiveGate {
  readonly mode: ComposerMode;
  readonly refusal: LiveExecuteRefusal | null;
  /**
   * Re-decide the whole gate NOW, against a fresh monotonic reading, and return what it
   * refuses. Called immediately before a run is armed: a rendered verdict is a reading of a
   * clock that has since moved, and this is the reading that counts. A refusal is also
   * SURFACED by this call — it bumps the gate's own state, so the render it triggers states
   * the refusal through the same path every other refusal takes.
   */
  revalidate(): LiveExecuteRefusal | null;
}

/**
 * SPEC §3 step 7's gate, assembled where the wallet and the document meet.
 *
 * The plan is built over the SANDBOX read set — that is what the canvas is showing — and it
 * is handed to the gate only so `planRequiresCodeFreeActor` can answer whether this strategy
 * contains a WETH withdrawal. Nothing about the wallet's balances is read from it.
 *
 * The SIMULATION standing comes from the live-simulation path (Codex D-011 F2): a
 * block-pinned capture for the connected address through our configured RPC, the same pure
 * `buildPlan`/`riskLedger` run over it, and a standing that binds address + plan hash +
 * block identity + monotonic time + THE READINGS THE CAPTURE CARRIED (round-4 finding 2 —
 * `gate.ts` evaluates those over the connect-time pair whenever a standing exists). Until one
 * exists the gate refuses with `no-fresh-simulation` — SPEC §3 step 7 verbatim — and after any
 * drift (document edited, capture superseded) it refuses with the drift stated (F3).
 *
 * TWO TIMES THIS GATE IS EVALUATED, and neither is optional (round-4 finding 1). Every render
 * decides it, and a standing arms a timer so a render happens the instant its freshness bound
 * expires; and `revalidate` decides it again inside the commit handler, because between the
 * last paint and the press the only thing that can have changed — the clock — is the one input
 * a rendered verdict cannot have seen move.
 */
export function useLiveGate(snapshot: SnapshotState, liveSim: LiveSimulationView): LiveGate {
  const wallet = useWalletBoundary();
  const doc = useComposerStore((state) => state.doc);
  const mode: ComposerMode = wallet.session === null ? "sandbox" : "live";
  const plan = useMemo(
    () => (snapshot.status === "ready" ? buildPlan(doc, snapshot.snapshot) : null),
    [doc, snapshot],
  );
  const session = wallet.session;
  const readings = wallet.readings;
  const monotonicNow = wallet.monotonicNow;
  const standing = liveSim.standing;
  const currentPlanHash = liveSim.currentPlanHash;
  const currentSnapshot = liveSim.currentSnapshot;

  /**
   * The expiry alarm (Codex round-4 finding 1, layer a).
   *
   * The staleness bound is a CLOCK reading, and a clock advances with no render to observe it:
   * sampled only while rendering, the gate left an enabled Execute button sitting over a
   * simulation that had already expired. So a standing schedules its own re-evaluation at the
   * instant it goes stale — `msUntilStale` on the injected monotonic clock, never wall time —
   * and this state bump is what makes the render below re-decide with nothing to click.
   *
   * `tick` is in the dependency list on purpose: each firing re-runs this effect, so a timer
   * that lands EARLY (a throttled or coarse host timer against a monotonic reading that has
   * not yet crossed) schedules the remainder instead of leaving the hole open. The delay
   * strictly decreases, so the rescheduling terminates.
   */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (standing === null) return;
    const delay = msUntilStale(standing, monotonicNow());
    if (delay <= 0) return;
    const alarm = setTimeout(() => setTick((previous) => previous + 1), delay);
    return () => {
      clearTimeout(alarm);
    };
  }, [standing, monotonicNow, tick]);

  const gateInputs = useMemo(
    () =>
      plan === null || !plan.ok
        ? null
        : { session, readings, plan, simulation: standing, currentPlanHash, currentSnapshot },
    [plan, session, readings, standing, currentPlanHash, currentSnapshot],
  );

  /**
   * The gate at the INSTANT OF COMMITMENT (Codex round-4 finding 1, layer b).
   *
   * Everything a render closed over is still current — readings, standing and hashes only ever
   * change through a state update, which renders — except the clock, so this re-decides the
   * FULL gate against a fresh monotonic reading rather than trusting the verdict the button was
   * painted with. A refusal also bumps the tick, so the render that follows states it: the
   * refusal a caller is handed and the refusal a user reads are one evaluation, not two.
   */
  const revalidate = useCallback((): LiveExecuteRefusal | null => {
    if (session === null) return null;
    const refusal =
      gateInputs === null
        ? { kind: "no-fresh-simulation" as const }
        : liveExecuteRefusalOf({ ...gateInputs, nowMonotonicMs: monotonicNow() });
    if (refusal !== null) setTick((previous) => previous + 1);
    return refusal;
  }, [session, gateInputs, monotonicNow]);

  if (mode === "sandbox") return { mode, refusal: null, revalidate };
  if (gateInputs === null) {
    return { mode, refusal: { kind: "no-fresh-simulation" }, revalidate };
  }
  return {
    mode,
    refusal: liveExecuteRefusalOf({ ...gateInputs, nowMonotonicMs: monotonicNow() }),
    revalidate,
  };
}

function ComposerBody({ snapshot }: { readonly snapshot: SnapshotState }) {
  const { simulation, simulationPending } = useSimulation(snapshot);
  const wallet = useWalletBoundary();
  const session = wallet.session;
  // The whole session, not its address: the hook keys its held capture on the full reading
  // target, so a reconnect through another connector at the same address starts from nothing
  // (Codex round-3 finding 1).
  const liveSim = useLiveSimulation(liveCaptureSource, wallet.monotonicNow, session);
  const live = useLiveGate(snapshot, liveSim);
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

  /**
   * The ONE composition point where the store learns the lock (Codex round-3 finding 2).
   *
   * The store cannot see a run and must not hold an opinion about one, so the derivation above
   * is handed to it — and from there every document-mutating action refuses on its own
   * (`lockGuarded`), which is what makes a control that forgets the lock harmless rather than
   * destructive. The props below stay: they are the AFFORDANCE (a refusal stated where the user
   * pressed), and this is the enforcement.
   *
   * An effect, not a render-time write: a store write during render is a side effect in render.
   * Ordering is not a race — the lock's only source is this driver's machine, whose transitions
   * arrive in commits, and React flushes pending passive effects before it dispatches the next
   * discrete user event, so no press can land between the transition and this sync.
   */
  const storeApi = useComposerStoreApi();
  useEffect(() => {
    storeApi.getState().setWriteLock(writeLockReason);
  }, [storeApi, writeLockReason]);

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
          revalidateLive={live.revalidate}
          liveSimulationPhase={liveSim.phase}
          onLiveSimulate={session === null ? null : liveSim.simulate}
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
 * The live capture source and the connect seam this build uses — ONE composition rule for
 * both, so the readings and the snapshot can never come from different worlds:
 *
 *  - The RPC arm is the REAL wallet-router procedure (Codex D-011 F2): `eth_getCode` + the §2
 *    footprint + the block-pinned capture, all through our configured RPC. With no
 *    `LIVE_CHAIN_RPC_URL` in the deployment, the router answers its stated refusal, the seam
 *    reads as unavailable, and the gate REFUSES — SPEC §5's explicit absence, never a
 *    permissive default. It is always composed, because it is the DEFAULT arm.
 *  - The demo arm exists only in a build that configured mock accounts, and only when the
 *    build has not forced RPC: the scenario table plus the committed-reads-log capture —
 *    hermetic, no chain, no secrets.
 *  - `NEXT_PUBLIC_WALLET_LIVE_SOURCE=rpc` drops the demo arm entirely — the fork e2e rig's
 *    posture, where the mock connector supplies the SESSION and the wallet router performs
 *    the CAPTURE against the pinned fork upstream, which is what makes that suite the
 *    authoritative proof of this path.
 *
 * WHICH ARM ANSWERS IS PER SESSION, NOT PER BUILD (Codex round-2 finding 2). A mock-enabled
 * build still exposes the `injected` connector — deliberately: a developer running the demo
 * build must be able to connect a real wallet and see the honest refusal rather than have the
 * control hidden from them. So `routedCaptureSource`/`routedSeam` send every non-mock session
 * to the RPC arm regardless of any public flag, and the demo arm answers for mock-connector
 * sessions alone. See `src/lib/live/readiness-source.ts` for why that is not the connector
 * branch treatment §1.2 forbids: it selects the transport a reading arrives by, and the
 * invariant it protects is that fabricated readings may only ever attach to fabricated
 * wallets.
 */
const hasMockAccounts = MOCK_ACCOUNTS.length > 0;
const forceRpcCapture = process.env.NEXT_PUBLIC_WALLET_LIVE_SOURCE === "rpc";
const demoScenarios = {
  accounts: MOCK_ACCOUNTS,
  codeBearing: MOCK_CODE_BEARING_ACCOUNTS,
  occupied: MOCK_OCCUPIED_ACCOUNTS,
};
const rpcCaptureSource = trpcLiveCaptureSource();
// ONE condition for both demo arms, computed once: a capture arm and a readings arm that
// could disagree about whether the demo source exists would pair one world's footprint with
// another world's snapshot — the failure the "one composition rule" above exists to prevent.
const demoArmed = hasMockAccounts && !forceRpcCapture;
const liveCaptureSource = routedCaptureSource({
  demo: demoArmed ? demoLiveCaptureSource(demoScenarios) : null,
  rpc: rpcCaptureSource,
});
const walletSeam = routedSeam({
  demo: configuredDemoSeam(demoScenarios, demoArmed),
  rpc: liveSeam(rpcCaptureSource),
});

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
    <WalletProvider seam={walletSeam}>
      <ComposerStoreProvider store={store}>
        <ComposerFrame snapshot={snapshot} arrival={arrival} />
      </ComposerStoreProvider>
    </WalletProvider>
  );
}
