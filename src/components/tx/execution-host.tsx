"use client";

/**
 * The execution host — the one place the composer meets the tx family. It owns the
 * driver, derives the ARM input (frozen local plan + share-codec token) from the same
 * document and snapshot the simulation reads, and swaps the right column between the
 * simulation panel and the execution flow — the one panel-level transition, opacity
 * only, content never slides (T30).
 *
 * The local plan handed to the driver is built by the SAME `buildPlan` over the SAME
 * block-pinned snapshot the canvas simulates from; the server plans from its own capture
 * of the session fork, and the two reconcile by plan hash and step identity (§5.3 —
 * agreement is not identity, so it is CHECKED, driver `planAgreementFailure`).
 *
 * §2.4: a document mutation while the machine is `ready` disarms the run (the driver
 * relays `document-mutated`). Canvas write-lockdown during `executing` (T26) is NOT
 * implemented this round — the tx column renders exclusively from the machine's frozen
 * plan, so a mid-run edit changes only the canvas view, never what executes or what the
 * column claims; see the surface report.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { BorrowLimitVerdict } from "../../core/borrow-limit";
import { simulationCanClear, type LiveExecuteRefusal } from "../../lib/wallet/gate";
import type { LiveSimulationPhase } from "../composer/live-simulation";
import { LiveRefusalCard, liveRefusalCopy, type ComposerMode } from "../wallet/connect-surface";
import { formatBpsAsPercent } from "../../core/format";
import { buildPlan, type PlanSuccess } from "../../core/plan";
import { riskLedger, type RiskCheckpoint } from "../../core/risk";
import { encodeShareGraph } from "../../lib/share/encode";
import type { SimulationResult } from "../../lib/strategy/types";
import type { ExecutionPhase } from "../../lib/execution/types";
import {
  SandboxDriver,
  localPointerStorage,
  type DriverFault,
  type PointerStorage,
} from "../../lib/tx/driver";
import { trpcSandboxTransport, type SandboxTransport } from "../../lib/tx/transport";
import { useComposerStore } from "../../app/store/composer-provider";
import { cn } from "../../lib/utils";
import { SimulationPanel } from "../composer/simulation-panel";
import type { SnapshotState } from "../composer/simulation-host";
import { announcementKeyOf, announcementOf } from "./announcements";
import { ExecutionFlow, FaultCard, faultAnnouncementOf } from "./execution-flow";
import { TransactionButton } from "./transaction-button";

export interface ExecutionHostProps {
  readonly snapshot: SnapshotState;
  readonly simulation: SimulationResult | null;
  readonly simulationPending: boolean;
  /**
   * SPEC §3 step 4's client-side verdict (`useBorrowLimit`). An `over-limit` verdict GATES
   * Simulate; the gate is lifted only by the store's explicit one-shot override, which any
   * document mutation disarms.
   */
  readonly borrowLimit?: BorrowLimitVerdict | null;
  /**
   * SPEC §3 step 7. `sandbox` is the default no-wallet experience; connecting a wallet
   * switches the session to `live`, where the sandbox arm control is replaced by the live
   * gate. The refusal is computed by the pure gate and passed in — this component never
   * decides whether a wallet may execute.
   */
  readonly mode?: ComposerMode;
  readonly liveRefusal?: LiveExecuteRefusal | null;
  /**
   * The live gate, re-decided at the instant of commitment (Codex round-4 finding 1).
   *
   * `liveRefusal` above is what the button was PAINTED with, and a paint is a reading of a
   * clock: the freshness bound can expire with no render to notice, so the verdict on screen is
   * not the authority at the moment a run starts. This callback asks the gate again — the
   * composer owns the inputs and reads the monotonic clock fresh — and a non-null answer stops
   * the run before `driver.arm` opens a session. Surfacing is the gate's own (it re-renders
   * through `liveRefusal`), so this component decides nothing and states nothing new.
   */
  readonly revalidateLive?: (() => LiveExecuteRefusal | null) | null;
  /**
   * The live-simulation path's phase and trigger (Codex D-011 F2). The trigger is offered
   * only against refusals a fresh simulation can CLEAR (`simulationCanClear` — the pure
   * gate decides, this component renders); a null trigger means no wallet is connected.
   */
  readonly liveSimulationPhase?: LiveSimulationPhase;
  readonly onLiveSimulate?: (() => void) | null;
  /**
   * An externally owned driver (the composer body creates one so the canvas can read
   * the executing step for its T26 frame). Omitted, the host composes its own from the
   * seams below.
   */
  readonly driver?: SandboxDriver;
  /** Test seams; production uses the tRPC transport and localStorage. */
  readonly transport?: SandboxTransport;
  readonly storage?: PointerStorage;
  readonly now?: () => number;
}

/** No-op storage for environments without localStorage (SSR render pass). */
const NO_STORAGE: PointerStorage = {
  read: () => null,
  write: () => undefined,
  clear: () => undefined,
};

function defaultStorage(): PointerStorage {
  if (typeof window === "undefined") return NO_STORAGE;
  return localPointerStorage(window.localStorage);
}

/** The production driver composition, for callers that own the driver (composer body). */
export function createDefaultSandboxDriver(): SandboxDriver {
  return new SandboxDriver({ transport: trpcSandboxTransport(), storage: defaultStorage() });
}

/**
 * The predictions a run commits to, pinned at arm/restore (Codex fix 1): the frozen
 * plan REFERENCE plus the simulation and risk walk derived from the same document
 * instance. The pin attaches to the flow ONLY while the machine holds the same plan
 * object — identity, not shape — so a canvas edit during or after execution can never
 * pair plan A's receipt with plan B's predictions; a mismatch renders the predicted
 * columns as explicit unavailable states.
 */
interface PinnedRun {
  readonly plan: PlanSuccess;
  readonly simulation: SimulationResult | null;
  readonly checkpoints: readonly RiskCheckpoint[] | null;
}

interface Announcement {
  readonly key: string;
  readonly text: string;
  readonly nonce: number;
}

/**
 * T30's one panel-level transition: content swaps at full opacity on first paint and
 * fades only on an identity CHANGE — never an entrance animation on load.
 */
function PanelFade({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  const [entered, setEntered] = useState(true);
  const [seen, setSeen] = useState(id);
  if (seen !== id) {
    setSeen(id);
    setEntered(false);
  }
  useEffect(() => {
    if (entered) return;
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [entered, seen]);
  return (
    <div className={cn("transition-slow flex h-full min-h-0 flex-col", entered ? "opacity-100" : "opacity-0")}>
      {children}
    </div>
  );
}

export function ExecutionHost({
  snapshot,
  simulation,
  simulationPending,
  borrowLimit = null,
  mode = "sandbox",
  liveRefusal = null,
  revalidateLive = null,
  liveSimulationPhase = { kind: "idle" },
  onLiveSimulate = null,
  driver: externalDriver,
  transport,
  storage,
  now,
}: ExecutionHostProps) {
  const doc = useComposerStore((state) => state.doc);
  const rev = useComposerStore((state) => state.rev);
  const overrideArmed = useComposerStore((state) => state.overrideGateArmed);
  const armOverride = useComposerStore((state) => state.armOverride);

  const [driver] = useState(
    () =>
      externalDriver ??
      new SandboxDriver({
        transport: transport ?? trpcSandboxTransport(),
        storage: storage ?? defaultStorage(),
        ...(now === undefined ? {} : { now }),
      }),
  );
  const snap = useSyncExternalStore(driver.subscribe, driver.snapshot, driver.snapshot);

  const armable = useMemo(() => {
    if (snapshot.status !== "ready") {
      return { input: null, checkpoints: null, reason: "the block-pinned read set is unavailable" };
    }
    if (doc.blocks.length === 0) {
      return { input: null, checkpoints: null, reason: "the canvas is empty" };
    }
    const plan = buildPlan(doc, snapshot.snapshot);
    if (!plan.ok) {
      return {
        input: null,
        checkpoints: null,
        reason: "the strategy does not plan — see the simulation panel",
      };
    }
    const encoded = encodeShareGraph(doc);
    if (!encoded.ok) {
      return { input: null, checkpoints: null, reason: "the document cannot be encoded for transport" };
    }
    // SPEC §3 step 4: the client-side gate. `buildPlan` deliberately does NOT refuse on LTV
    // — the over-limit document has to stay representable so the block can show the math and
    // the override can run it — so the refusal lives here, and it is the store's one-shot
    // `overrideGateArmed` that lifts it. An UNAVAILABLE verdict gates too: a limit that could
    // not be evaluated is not a satisfied one (SPEC §5).
    if (borrowLimit !== null && !overrideArmed) {
      if (borrowLimit.status === "over-limit") {
        return {
          input: null,
          checkpoints: null,
          reason: `the borrow is past the limit the active configuration allows (${formatBpsAsPercent(
            borrowLimit.ceiling.maxAllocationBps,
          )} of collateral value) — edit it, or override with "Simulate anyway"`,
        };
      }
      if (borrowLimit.status === "unavailable") {
        return {
          input: null,
          checkpoints: null,
          reason: `the borrow limit could not be evaluated: ${borrowLimit.reason}`,
        };
      }
    }
    // The plan's own risk walk (§0: one prediction home) — pinned with the plan at arm.
    const ledger = riskLedger(doc, snapshot.snapshot);
    return {
      input: { plan, token: encoded.token },
      checkpoints: ledger.ok ? ledger.checkpoints : null,
      reason: null,
    };
  }, [doc, snapshot, borrowLimit, overrideArmed]);

  // Codex fix 1: the predictions a run renders are PINNED at the moment it is armed or
  // restored — the same document instance produced the plan reference, the simulation,
  // and the risk walk, so plan identity is the proof they belong together.
  const [pinned, setPinned] = useState<PinnedRun | null>(null);
  const pinRun = (): void => {
    if (armable.input !== null) {
      setPinned({ plan: armable.input.plan, simulation, checkpoints: armable.checkpoints });
    }
  };

  /**
   * The last thing asked before a run starts (Codex round-4 finding 1): does the live gate
   * STILL refuse nothing, decided now rather than at the last paint? Every route that ARMS asks
   * it — the two direct controls below and a fault's re-arm Retry — because each opens a session
   * and none of them may do so on an expired simulation.
   */
  const liveCommitRefused = (): boolean => revalidateLive !== null && revalidateLive() !== null;

  /**
   * The same question, asked for a FAULT's Retry (Codex round-5). `DriverFault.retry` names the
   * family the action belongs to, and one of the three IS an arm: `retry: "arm"` re-enters
   * create/reset/plan inside the driver, from the retained arm input, without passing either
   * button's guard. A fault card sits on screen for as long as the user leaves it there, so by
   * the time Retry is pressed the standing may have expired with no render to notice — the same
   * stale authority the two direct handlers already refuse, reaching the wire by another door.
   *
   * The other two families stay ungated on purpose, because they are the machine's rather than a
   * new commitment: `run` re-enters the step loop of a run the user already committed, and
   * `reload` rehydrates server truth about it (both idempotent replay and discovery, D6/D11).
   * Holding those hostage to simulation freshness would strand a committed mid-run session with
   * no way to learn what the server did — the opposite of the guard's purpose.
   */
  const retryFault = (): void => {
    if (snap.fault !== null && snap.fault.retry === "arm" && liveCommitRefused()) return;
    void driver.retry();
  };

  // §2.4: the driver no-ops unless the machine is `ready`, so every rev bump may relay.
  // `lastRev` doubles as the restore guard's live reading of the document generation.
  const lastRev = useRef(rev);
  useEffect(() => {
    if (lastRev.current === rev) return;
    lastRev.current = rev;
    driver.documentMutated();
  }, [rev, driver]);

  // Resume a persisted run once, as soon as a local plan exists to resume against
  // (D11). The attempt is BOUND to the document generation captured at launch (Codex
  // thread 019fa749 finding 2): an edit while the lookup is in flight invalidates the
  // attempt — the driver rechecks the guard before adoption and before continuation.
  // The pin captures the simulation derived from the same document as the plan being
  // restored against; `restored` guards re-runs, so the extra deps are inert.
  const restored = useRef(false);
  const restoreRev = useRef(rev);
  useEffect(() => {
    if (restored.current || armable.input === null) return;
    restored.current = true;
    restoreRev.current = rev;
    setPinned({
      plan: armable.input.plan,
      simulation,
      checkpoints: armable.checkpoints,
    });
    void driver.restore(armable.input, () => lastRev.current === restoreRev.current);
  }, [armable, driver, simulation, rev]);

  const machinePlan = snap.machine.plan ?? armable.input?.plan ?? null;
  const flowActive =
    snap.machine.phase.kind !== "idle" && machinePlan !== null && snapshot.status === "ready";
  // Identity, not shape (Codex fix 1): predictions attach only while the machine holds
  // the exact pinned plan object; otherwise the predicted columns state their absence.
  const runPinned = pinned !== null && pinned.plan === machinePlan ? pinned : null;

  // The single narrator (T31, moved here per Codex fix 6): one polite region that
  // survives the panel/idle swap, speaking machine transitions (T32 grammar) and
  // transport faults (T27 copy) with one voice.
  const [announced, setAnnounced] = useState<Announcement>({ key: "idle", text: "", nonce: 0 });
  const [prevPhase, setPrevPhase] = useState<ExecutionPhase | null>(null);
  const [seenFault, setSeenFault] = useState<DriverFault | null>(null);
  const phaseKey = announcementKeyOf(snap.machine.phase);
  if (phaseKey !== announced.key) {
    // Render-time state adjustment (the SimulationPanel pattern): the sentence is
    // composed once, at the transition, from what is known at that moment (T32a). A
    // SILENT transition moves the key without touching the spoken text — an arming
    // refusal lands back on idle, and idle's empty sentence must not wipe the fault
    // announcement that just fired.
    const text = announcementOf(snap.machine, prevPhase, machinePlan?.steps.length ?? null);
    setAnnounced((previous) =>
      text === ""
        ? { ...previous, key: phaseKey }
        : { key: phaseKey, text, nonce: previous.nonce + 1 },
    );
    setPrevPhase(snap.machine.phase);
  }
  const fault = snap.fault;
  if (fault !== seenFault) {
    setSeenFault(fault);
    if (fault !== null) {
      setAnnounced((previous) => ({
        key: previous.key,
        text: faultAnnouncementOf(fault),
        nonce: previous.nonce + 1,
      }));
    }
  }
  const narrator = (
    <p role="status" className="sr-only">
      <span key={announced.nonce}>{announced.text}</span>
    </p>
  );

  // SPEC §6, verbatim: "The UI labels it 'Re-simulate', never 'Resume'." A failed or
  // over-limit simulation has NO resumable prefix, so once this session has armed a run the
  // control that runs it again says so. `armed` is session state, not document state: it
  // survives the mutation that disarmed the override, which is exactly the §3.4 beat (drag
  // back to 70% → "Re-simulate" reruns the ENTIRE bundle from the base snapshot).
  const [hasArmed, setHasArmed] = useState(false);
  const armLabel = hasArmed ? "Re-simulate" : "Review & execute in sandbox";
  const overrideOffered =
    borrowLimit !== null && borrowLimit.status === "over-limit" && !overrideArmed;
  // In live mode the refusal's own title IS the gate reason — one sentence, one source.
  const liveGateReason =
    mode === "live" && liveRefusal !== null ? liveRefusalCopy(liveRefusal).title : null;

  if (!flowActive) {
    const busyReason =
      snap.busy === null ? null : "Preparing the session — a sandbox call is in flight.";
    return (
      <div className="flex h-full shrink-0 flex-col">
        {narrator}
        <PanelFade id="simulation">
          <div className="min-h-0 flex-1">
            <SimulationPanel result={simulation} pending={simulationPending} />
          </div>
          <div className="w-80 shrink-0 space-y-3 border-l border-t border-border bg-card p-4">
            {snap.fault === null ? null : (
              <FaultCard
                fault={snap.fault}
                onRetryFault={retryFault}
                busyReason={busyReason}
              />
            )}
            {mode === "live" ? (
              /*
               * SPEC §3 step 7: Execute STAYS GATED in live mode until a fresh simulation
               * against the connected wallet's real balances passes, and the §2 footprint
               * predicate refuses a wallet that already holds a position. Both arrive here
               * as one verdict from the pure gate, rendered in the T27 designed-stop
               * grammar — a state, never a toast.
               */
              <>
                {liveRefusal === null ? null : <LiveRefusalCard refusal={liveRefusal} />}
                {liveSimulationPhase.kind === "refused" ? (
                  /*
                   * A capture or simulation that refused is a designed state with its
                   * reason stated (SPEC §5) — never a silent return to the gated button.
                   */
                  <p
                    role="status"
                    data-testid="live-simulation-refusal"
                    className="text-xs text-muted-foreground"
                  >
                    {liveSimulationPhase.reason}
                  </p>
                ) : null}
                {onLiveSimulate !== null &&
                liveRefusal !== null &&
                simulationCanClear(liveRefusal) ? (
                  /*
                   * The F2 clearing path: capture the wallet's block-pinned chain state
                   * through our RPC, run the same pure simulation, and the standing it
                   * mints is what lifts the gate. Offered ONLY against refusals a fresh
                   * simulation can answer — the pure gate decides which those are.
                   */
                  <TransactionButton
                    variant="default"
                    onClick={onLiveSimulate}
                    gateReason={
                      liveSimulationPhase.kind === "capturing"
                        ? "Capturing this wallet's chain state…"
                        : null
                    }
                  >
                    Simulate against this wallet
                  </TransactionButton>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Live execution signs from the connected wallet against Ethereum mainnet.
                  Nothing is sent until a fresh simulation against its real balances passes.
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Run this strategy on a forked-mainnet sandbox session — no wallet, no
                signatures.
              </p>
            )}
            <TransactionButton
              onClick={() => {
                if (armable.input === null || liveCommitRefused()) return;
                setHasArmed(true);
                pinRun();
                void driver.arm(armable.input);
              }}
              gateReason={liveGateReason ?? armable.reason ?? busyReason}
            >
              {armLabel}
            </TransactionButton>
            {overrideOffered ? (
              /*
               * SPEC §3.4's explicit override, "kept for exactly this purpose". It does not
               * simulate anything itself and it promises nothing: it arms the store's
               * one-shot flag, which ANY document mutation disarms, so the next press of the
               * gated control runs the bundle the user insisted on and the chain answers.
               * Neutral variant — an override is not the screen's terminal commit (T3a).
               */
              <TransactionButton variant="default" onClick={armOverride} gateReason={busyReason}>
                Simulate anyway
              </TransactionButton>
            ) : null}
          </div>
        </PanelFade>
      </div>
    );
  }

  return (
    <aside
      aria-label="Execution"
      className="flex h-full w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-card p-4"
    >
      {narrator}
      <PanelFade id="execution">
        <ExecutionFlow
          plan={machinePlan}
          planActor={snapshot.snapshot.user.address}
          snapshot={snap}
          simulation={runPinned === null ? null : runPinned.simulation}
          checkpoints={runPinned === null ? null : runPinned.checkpoints}
          simulatedAtBlock={snapshot.snapshot.block}
          nowMs={snap.nowMs}
          onExecute={() => void driver.execute()}
          onRearm={() => {
            if (armable.input === null || liveCommitRefused()) return;
            pinRun();
            void driver.arm(armable.input);
          }}
          onRetryFault={retryFault}
        />
      </PanelFade>
    </aside>
  );
}
