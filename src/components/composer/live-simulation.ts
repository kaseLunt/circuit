"use client";

/**
 * The composer's live-simulation path (Codex D-011 F2): capture the connected wallet's
 * block-pinned chain state through OUR configured RPC, run the SAME pure simulation the
 * sandbox runs (`buildPlan`/`riskLedger` — no new math), and on success mint the
 * `LiveSimulationStanding` the Execute gate consumes.
 *
 * The COMPOSER computes the plan hash, not the wallet module (Codex D-011 F5 seam ruling):
 * `planHashOf` is a value import from `lib/execution`, and the wallet boundary's one value
 * route into that module stays the tolerance constant. The gate receives two opaque hashes
 * and compares them; this file is where they are minted.
 *
 * The decisions are pure exports (`liveStandingOf`, `currentPlanHashOf`) so every refusal
 * is unit-provable without a DOM (doctrine D10); the hook is thread-through — state, a
 * supersession guard for in-flight captures, and nothing else.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import type { StrategyGraph } from "../../core/graph";
import { buildPlan } from "../../core/plan";
import { riskLedger } from "../../core/risk";
import { planHashOf } from "../../lib/execution/plan-hash";
import type { LiveCaptureSource } from "../../lib/live/live-transport";
import type { LiveCapture } from "../../lib/live/snapshot-wire";
import type { LiveSimulationStanding, LiveSnapshotIdentity } from "../../lib/wallet/gate";
import { useComposerStore } from "../../app/store/composer-provider";

export type LiveStandingOutcome =
  | { readonly ok: true; readonly standing: LiveSimulationStanding }
  | { readonly ok: false; readonly reason: string };

/**
 * The standing a successful live simulation earns: the SAME `buildPlan` the sandbox path
 * runs, over the captured snapshot, fingerprinted with the SAME `planHashOf` the session
 * reconciliation uses (§10.10: one definition, or the two drift apart). A document that
 * does not plan against the wallet's real chain state earns nothing — a stated refusal,
 * never a permissive default.
 */
export function liveStandingOf(
  doc: StrategyGraph,
  capture: LiveCapture,
  simulatedFor: Address,
  nowMonotonicMs: number,
): LiveStandingOutcome {
  const plan = buildPlan(doc, capture.snapshot);
  if (!plan.ok) {
    return {
      ok: false,
      reason:
        "the strategy does not plan against this wallet's captured chain state, so there is no simulation to stand behind Execute",
    };
  }
  const ledger = riskLedger(doc, capture.snapshot);
  if (!ledger.ok) {
    return {
      ok: false,
      reason:
        "the strategy's risk walk does not resolve against this wallet's captured chain state, so there is no simulation to stand behind Execute",
    };
  }
  return {
    ok: true,
    standing: {
      simulatedFor,
      simulatedAtMonotonicMs: nowMonotonicMs,
      planHash: planHashOf(plan.steps),
      snapshot: capture.identity,
    },
  };
}

/**
 * The CURRENT document's fingerprint over the pinned capture — recomputed on every render
 * the document changes, so an edit after simulating flips the gate to `plan-drift` (F3).
 * Null when no capture is in hand, or when the document no longer plans over it: absence
 * stated, which the gate reads as drift, never as a pass.
 */
export function currentPlanHashOf(doc: StrategyGraph, capture: LiveCapture | null): Hex | null {
  if (capture === null) return null;
  const plan = buildPlan(doc, capture.snapshot);
  return plan.ok ? planHashOf(plan.steps) : null;
}

export type LiveSimulationPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "capturing" }
  | { readonly kind: "ready" }
  | { readonly kind: "refused"; readonly reason: string };

export interface LiveSimulationView {
  readonly phase: LiveSimulationPhase;
  readonly standing: LiveSimulationStanding | null;
  readonly currentPlanHash: Hex | null;
  readonly currentSnapshot: LiveSnapshotIdentity | null;
  simulate(address: Address): void;
}

export function useLiveSimulation(
  source: LiveCaptureSource,
  monotonicNow: () => number,
): LiveSimulationView {
  const doc = useComposerStore((state) => state.doc);
  const [phase, setPhase] = useState<LiveSimulationPhase>({ kind: "idle" });
  const [held, setHeld] = useState<{
    readonly capture: LiveCapture;
    readonly standing: LiveSimulationStanding;
  } | null>(null);

  // The document the standing is minted against is the one CURRENT when the capture
  // RESOLVES — the simulation genuinely ran over it — so the ref tracks the committed
  // document rather than freezing the one the button was pressed on. An edit after
  // resolution regates through `plan-drift`, which is the designed answer, not a race.
  // (Written in an effect, not during render: the resolution that reads it is always
  // after commit, and a discarded render must not leak its document into the ref.)
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  // Supersession: a stale capture resolving after a newer press (or a disconnect) must not
  // adopt state — the same discard rule the wallet provider's seam read applies.
  const flight = useRef(0);

  const simulate = useCallback(
    (address: Address) => {
      const ticket = flight.current + 1;
      flight.current = ticket;
      setPhase({ kind: "capturing" });
      void source
        .capture(address)
        .then((outcome) => {
          if (flight.current !== ticket) return;
          if (!outcome.ok) {
            setPhase({ kind: "refused", reason: outcome.reason });
            return;
          }
          const minted = liveStandingOf(docRef.current, outcome.capture, address, monotonicNow());
          if (!minted.ok) {
            setPhase({ kind: "refused", reason: minted.reason });
            return;
          }
          setHeld({ capture: outcome.capture, standing: minted.standing });
          setPhase({ kind: "ready" });
        })
        .catch((cause: unknown) => {
          if (flight.current !== ticket) return;
          setPhase({
            kind: "refused",
            reason: `the live capture failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
        });
    },
    [source, monotonicNow],
  );

  const currentPlanHash = useMemo(
    () => currentPlanHashOf(doc, held === null ? null : held.capture),
    [doc, held],
  );

  return {
    phase,
    standing: held === null ? null : held.standing,
    currentPlanHash,
    currentSnapshot: held === null ? null : held.capture.identity,
    simulate,
  };
}
