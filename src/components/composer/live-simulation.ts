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
 * The decisions are pure exports (`liveStandingOf`, `currentPlanHashOf`, `captureIdentityOf`)
 * so every refusal is unit-provable without a DOM (doctrine D10); the hook is thread-through —
 * state keyed on the session it is about, a supersession guard for in-flight captures, and
 * nothing else.
 *
 * WHAT A STANDING IS ABOUT (Codex round-3 finding 1). Held state is keyed on the FULL
 * `ReadingTarget` — address AND connector — and the hook is HANDED that target rather than
 * taking one per press. Keyed on the address alone, a demo capture minted for a mock session
 * survived a disconnect and a reconnect through `injected` at the same address, and the gate
 * accepted it: it binds address + plan hash + block identity, all of which still matched. So
 * the identity is part of the key, a change of either half drops the capture, the standing and
 * the phase in the same render, and a capture pressed for the old identity cannot adopt state
 * when it settles.
 *
 * WHAT A STANDING STANDS ON (Codex round-4 finding 2). A capture is ONE atomic observation:
 * `eth_getCode`, the §2 footprint predicate and the balances all arrive in the same block-pinned
 * response. So the readings ride INTO the standing, and the Execute gate evaluates those rather
 * than the connect-time seam pair, which is older by construction — an EOA that gains an EIP-7702
 * delegation between connecting and simulating reads clear at connect and code-bearing in the
 * capture, and the plan's WETH withdrawal needs the newer answer. The same readings also refuse
 * the MINT: a capture that contradicts the plan it was taken for resolves into a stated refusal
 * rather than a standing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAddress, type Address, type Hex } from "viem";
import type { StrategyGraph } from "../../core/graph";
import { buildPlan } from "../../core/plan";
import { riskLedger } from "../../core/risk";
import { planHashOf } from "../../lib/execution/plan-hash";
import type { LiveCaptureSource } from "../../lib/live/live-transport";
import type { LiveCapture } from "../../lib/live/snapshot-wire";
import {
  readingsRefusalOf,
  type LiveSimulationStanding,
  type LiveSnapshotIdentity,
} from "../../lib/wallet/gate";
import type { ReadingTarget } from "../../lib/wallet/types";
import { liveRefusalCopy } from "../wallet/connect-surface";
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
  // The capture's OWN readings, against the plan they would stand behind (Codex round-4
  // finding 2). `eth_getCode` and the §2 footprint arrived in the same block-pinned response
  // as the balances, so a wallet that gained an EIP-7702 delegation since connect is caught
  // HERE rather than admitted on the older connect-time answer. The decision is the gate's —
  // one definition serves connect, this mint, and Execute — and the sentence is the T27 card's,
  // so the refusal a user reads is the same sentence whichever surface states it.
  const refused = readingsRefusalOf({ code: capture.code, footprint: capture.footprint }, plan);
  if (refused !== null) {
    const copy = liveRefusalCopy(refused);
    return {
      ok: false,
      reason: `${copy.title} — ${copy.explanation} That was read at the capture's pinned block ${capture.identity.block}, not at connect.`,
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
      // Bound to the standing, not read from the seam later: the gate must be able to ask
      // what THIS simulation stood on, and a pointer to whatever the connect seam holds at
      // Execute time is a different question with a different answer.
      readings: { code: capture.code, footprint: capture.footprint },
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

/**
 * WHO a capture belongs to, as one comparable value: the address AND the connector it arrived
 * by. Null means no session — itself an identity, and the one a disconnect moves to.
 *
 * The connector is in the key because it is the only thing that tells a fabricated wallet from
 * a real one (`lib/wallet/types.ts` on `ReadingTarget`: fabricated readings may only ever
 * attach to fabricated wallets). A capture routed to the demo source
 * (`lib/live/readiness-source.ts`) is evidence about a mock session and about nothing else, so
 * it may not outlive one.
 *
 * The same `address@connectorId` shape the wallet boundary resets its seam readings on
 * (`wallet-provider.tsx`), for the same reason and with the same consequence: a change of
 * either half is a different wallet, and nothing read for the old one carries over. Addresses
 * are checksum-normalized so one wallet cannot present as two.
 */
export function captureIdentityOf(target: ReadingTarget | null): string | null {
  return target === null ? null : `${getAddress(target.address)}@${target.connectorId}`;
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
  /**
   * Captures for the session the hook was HANDED, and takes no target of its own (round-3
   * finding 1): a caller that could name the target could name one the held state is not
   * keyed on, which is precisely the hole this signature closes. No session, no capture.
   */
  simulate(): void;
}

/**
 * Everything the hook holds, in one atom keyed by the identity it is ABOUT.
 *
 * One atom rather than three pieces of state because they must move together: what made the
 * round-3 finding possible was a held capture that outlived the session it was captured for,
 * beside a phase that only advanced when another press started.
 *
 * `ticket` is the supersession token, as object identity rather than a counter: a press mints
 * one, every reset drops it, and a resolution adopts state only while its own ticket is still
 * the held one. A counter would have to be bumped by hand at every reset site — the forgettable
 * shape this replaces.
 */
interface CaptureState {
  readonly identity: string | null;
  readonly ticket: symbol | null;
  readonly phase: LiveSimulationPhase;
  readonly held: {
    readonly capture: LiveCapture;
    readonly standing: LiveSimulationStanding;
  } | null;
}

/** Nothing captured and nothing in flight, for a stated identity. */
function idleFor(identity: string | null): CaptureState {
  return { identity, ticket: null, phase: { kind: "idle" }, held: null };
}

export function useLiveSimulation(
  source: LiveCaptureSource,
  monotonicNow: () => number,
  /**
   * The session this hook is FOR — the whole target, address and connector. Null when no
   * wallet is connected, which is an identity change like any other: a disconnect discards
   * the standing rather than parking it for whoever connects next.
   */
  target: ReadingTarget | null,
): LiveSimulationView {
  const doc = useComposerStore((state) => state.doc);
  const identity = captureIdentityOf(target);
  const [state, setState] = useState<CaptureState>(() => idleFor(identity));

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

  // Render-time state adjustment — the pattern this codebase uses instead of a setState in an
  // effect body, and the one `wallet-provider.tsx` resets its seam readings with. The moment
  // the identity moves (a new address, a new connector, or a disconnect) the capture, the
  // standing, the phase AND the outstanding ticket are dropped in the same render, so an
  // in-flight capture pressed for the previous identity cannot adopt state when it settles.
  if (state.identity !== identity) setState(idleFor(identity));
  // What the hook EXPOSES is always about the identity it was asked about, never about
  // whatever it still holds: the adjustment above re-renders, and this covers the render that
  // observed the change first. A standing is served to one identity only, by construction.
  const current = state.identity === identity ? state : idleFor(identity);
  const held = current.held;

  const simulate = useCallback(() => {
    if (target === null) return;
    const pressedFor = captureIdentityOf(target);
    const ticket = Symbol("live-capture");
    setState({
      identity: pressedFor,
      ticket,
      phase: { kind: "capturing" },
      // A standing for THIS identity stands until the new capture lands — a re-simulation
      // must not open a hole in the gate. `held` is identity-checked above, so there is
      // nothing here that could belong to another wallet.
      held,
    });
    /** Adopts a resolution only while this press is still the live one for its identity. */
    const settle = (resolve: (previous: CaptureState) => CaptureState): void => {
      setState((previous) => (previous.ticket === ticket ? resolve(previous) : previous));
    };
    const refuse = (reason: string) => (previous: CaptureState) => ({
      ...previous,
      ticket: null,
      phase: { kind: "refused" as const, reason },
    });
    void source
      .capture(target)
      .then((outcome) => {
        if (!outcome.ok) {
          settle(refuse(outcome.reason));
          return;
        }
        const minted = liveStandingOf(
          docRef.current,
          outcome.capture,
          target.address,
          monotonicNow(),
        );
        if (!minted.ok) {
          settle(refuse(minted.reason));
          return;
        }
        settle((previous) => ({
          ...previous,
          ticket: null,
          phase: { kind: "ready" },
          held: { capture: outcome.capture, standing: minted.standing },
        }));
      })
      .catch((cause: unknown) => {
        settle(
          refuse(
            `the live capture failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        );
      });
  }, [source, monotonicNow, target, held]);

  const currentPlanHash = useMemo(
    () => currentPlanHashOf(doc, held === null ? null : held.capture),
    [doc, held],
  );

  return {
    phase: current.phase,
    standing: held === null ? null : held.standing,
    currentPlanHash,
    currentSnapshot: held === null ? null : held.capture.identity,
    simulate,
  };
}
