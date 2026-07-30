"use client";

/**
 * The simulation derivation — the seam between the composer document and `core/risk.ts`.
 *
 * Three rules, and each one is a defect this file exists to prevent:
 *
 * 1. ONE SIMULATION PER DOCUMENT REVISION. `simulate` is pure and fast, so the §3 step-3
 *    drag recomputes on every allocation change and the numbers move live — no debounce,
 *    no tween, no interpolated intermediate value. The memo is keyed on the DOCUMENT
 *    REFERENCE, which is the revision: every money-bearing action replaces `doc` and bumps
 *    `rev` in the same `set`, while `moveBlock` writes only `view` and leaves `doc`
 *    untouched precisely so "a drag must not invalidate the risk projection's memo". So a
 *    block dragged around the canvas re-renders nothing here, and no separate `rev`
 *    subscription with an untracked `getState()` read is needed to get that — the memo
 *    depends on exactly what it reads.
 *
 * 2. STALE-WHILE-REVALIDATE, the obligation both consumers document (`canvas.tsx`,
 *    `simulation-panel.tsx`). A shown value never round-trips through `null` on the way to
 *    its replacement: while a snapshot refresh is in flight, the last resolved result stays
 *    on screen with `pending` raised. A null round-trip re-skeletons and re-fades every
 *    slot on the canvas at once, which reads as a data loss that did not happen.
 *
 * 3. NULL MEANS "NO RESULT AT ALL", never "a result that failed". An invalid graph is a
 *    `SimulationResult` with `isValid: false` and an `errorMessage`, and it is passed
 *    through as-is: the panel renders the refusal, which is strictly more honest than the
 *    empty state a null would produce. `null` is reserved for the two facts that really
 *    are an absence — an empty canvas, and a snapshot that could not be built.
 */

import { useMemo, useState } from "react";
import { borrowLimitVerdict, type BorrowLimitVerdict } from "../../core/borrow-limit";
import type { ChainSnapshot } from "../../core/plan";
import { simulate } from "../../core/risk";
import type { SimulationResult } from "../../lib/strategy/types";
import { useComposerStore } from "../../app/store/composer-provider";

/**
 * Where the block-pinned read set stands. In P2 the sandbox snapshot is built synchronously
 * from the committed reads log, so `loading` does not occur in the running app — but it is
 * the state a live capture (P3) arrives through, and `unavailable` is reachable today the
 * moment the reads log is missing or mis-shaped.
 */
export type SnapshotState =
  | { readonly status: "ready"; readonly snapshot: ChainSnapshot }
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface SimulationView {
  readonly simulation: SimulationResult | null;
  readonly simulationPending: boolean;
}

/**
 * The stale-while-revalidate rule as a pure function, so it can be asserted without a DOM.
 *
 * `held` is the last result that was actually shown. A fresh result always wins; with no
 * fresh result, a refresh in flight keeps the held one visible and raises `pending`; and a
 * settled absence clears to null. There is no fourth case — in particular, nothing here can
 * emit `{ simulation: null, simulationPending: true }` over a value the user was reading.
 */
export function resolveSimulationView(
  next: SimulationResult | null,
  held: SimulationResult | null,
  snapshotPending: boolean,
): SimulationView {
  if (next !== null) return { simulation: next, simulationPending: false };
  if (snapshotPending) return { simulation: held, simulationPending: true };
  return { simulation: null, simulationPending: false };
}

export function useSimulation(snapshotState: SnapshotState): SimulationView {
  // `doc` IS a StrategyGraph — the store's money truth is core's own type, so nothing is
  // adapted, converted or re-validated on the way into `simulate`.
  const doc = useComposerStore((state) => state.doc);
  // Passed alongside so the derivation trees behind Net APY and the health factor cite the
  // SAME provenance the block's own tooltip does. Without it a template's untouched
  // allocation would read `Configured` on the borrow block and `entered by user` inside
  // every quantity derived from it — one number, two stories.
  const paramOrigins = useComposerStore((state) => state.paramOrigins);
  const snapshot = snapshotState.status === "ready" ? snapshotState.snapshot : null;

  const next = useMemo(() => {
    if (snapshot === null) return null;
    // An empty canvas is not a failed strategy. Simulating it would produce a refusal
    // ("no input block") and paint an error over a canvas the user has not built yet;
    // the panel's designed empty state is the honest answer.
    if (doc.blocks.length === 0) return null;
    return simulate(doc, snapshot, paramOrigins);
  }, [doc, paramOrigins, snapshot]);

  // Render-time state adjustment, the pattern SourcedValue and the panel both use: this
  // converges in one extra render and never mutates during a render that may be discarded.
  const [held, setHeld] = useState<SimulationResult | null>(null);
  const view = resolveSimulationView(next, held, snapshotState.status === "loading");
  if (view.simulation !== held) setHeld(view.simulation);
  return view;
}

/**
 * SPEC §3 step 4's client-side verdict, derived beside the simulation over the SAME document
 * revision and the SAME block-pinned snapshot.
 *
 * Kept out of `SimulationResult` on purpose. That type is the panel's answer to "what does
 * this strategy earn and risk"; this is the composer's answer to "will the protocol accept
 * it at all", and folding a gate into a projection is how a gate ends up being read as a
 * number. Both are pure, both are memoized on the document reference, and neither derives
 * anything the other derives — the LTV/LT pair here comes off `core/borrow-limit.ts`, which
 * reads the risk ledger's own legs.
 *
 * Null means "no snapshot, so nothing to say" — the same absence `useSimulation` uses.
 */
export function useBorrowLimit(snapshotState: SnapshotState): BorrowLimitVerdict | null {
  const doc = useComposerStore((state) => state.doc);
  const snapshot = snapshotState.status === "ready" ? snapshotState.snapshot : null;
  return useMemo(() => {
    if (snapshot === null) return null;
    if (doc.blocks.length === 0) return null;
    return borrowLimitVerdict(doc, snapshot);
  }, [doc, snapshot]);
}
