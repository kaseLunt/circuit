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
  transport,
  storage,
  now,
}: ExecutionHostProps) {
  const doc = useComposerStore((state) => state.doc);
  const rev = useComposerStore((state) => state.rev);

  const [driver] = useState(
    () =>
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
    // The plan's own risk walk (§0: one prediction home) — pinned with the plan at arm.
    const ledger = riskLedger(doc, snapshot.snapshot);
    return {
      input: { plan, token: encoded.token },
      checkpoints: ledger.ok ? ledger.checkpoints : null,
      reason: null,
    };
  }, [doc, snapshot]);

  // Codex fix 1: the predictions a run renders are PINNED at the moment it is armed or
  // restored — the same document instance produced the plan reference, the simulation,
  // and the risk walk, so plan identity is the proof they belong together.
  const [pinned, setPinned] = useState<PinnedRun | null>(null);
  const pinRun = (): void => {
    if (armable.input !== null) {
      setPinned({ plan: armable.input.plan, simulation, checkpoints: armable.checkpoints });
    }
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
                onRetryFault={() => void driver.retry()}
                busyReason={busyReason}
              />
            )}
            <p className="text-xs text-muted-foreground">
              Run this strategy on a forked-mainnet sandbox session — no wallet, no
              signatures.
            </p>
            <TransactionButton
              onClick={() => {
                if (armable.input !== null) {
                  pinRun();
                  void driver.arm(armable.input);
                }
              }}
              gateReason={armable.reason ?? busyReason}
            >
              Review &amp; execute in sandbox
            </TransactionButton>
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
          snapshot={snap}
          simulation={runPinned === null ? null : runPinned.simulation}
          checkpoints={runPinned === null ? null : runPinned.checkpoints}
          simulatedAtBlock={snapshot.snapshot.block}
          nowMs={snap.nowMs}
          onExecute={() => void driver.execute()}
          onRearm={() => {
            if (armable.input !== null) {
              pinRun();
              void driver.arm(armable.input);
            }
          }}
          onRetryFault={() => void driver.retry()}
        />
      </PanelFade>
    </aside>
  );
}
