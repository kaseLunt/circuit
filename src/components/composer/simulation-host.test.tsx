/** @vitest-environment jsdom */
// No jest-dom matchers — the suite asserts on the DOM directly, as the rest of the
// component suites do.

import { afterEach, describe, expect, it } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { formatHealthFactor } from "../../core/format";
import { hfWadValue, riskState } from "../../core/health-factor";
import { valueOf } from "../../core/provenance";
import { simulate } from "../../core/risk";
import type { SimulationResult } from "../../lib/strategy/types";
import { FLAGSHIP_TEMPLATE_ID, leveragedRestakeLoop } from "../../lib/strategy/templates";
import { sandboxSnapshot } from "../../lib/recorded-reads/sandbox-snapshot";
import {
  createComposerStore,
  type ComposerStoreApi,
} from "../../app/store/composer-store";
import { ComposerStoreProvider, useComposerStore } from "../../app/store/composer-provider";
import { FORK_PROVEN_BORROW_BPS, flagshipGraph } from "../../../tests/helpers/graphs";
import { resolveSimulationView, useSimulation, type SnapshotState } from "./simulation-host";
import { loadSandboxSnapshot } from "./sandbox-composer";

afterEach(cleanup);

const READY: SnapshotState = { status: "ready", snapshot: sandboxSnapshot() };
const LOADING: SnapshotState = { status: "loading" };
const UNAVAILABLE: SnapshotState = { status: "unavailable", reason: "the reads log is missing" };

/** A result identity that is not any real one — the "already shown" value in hold tests. */
const HELD = simulate(flagshipGraph("10", 5000), sandboxSnapshot());
const FRESH = simulate(flagshipGraph("10", 7000), sandboxSnapshot());

describe("resolveSimulationView — the stale-while-revalidate rule", () => {
  it("shows a fresh result and settles pending", () => {
    expect(resolveSimulationView(FRESH, HELD, false)).toEqual({
      simulation: FRESH,
      simulationPending: false,
    });
  });

  it("holds the last shown result while a refresh is in flight", () => {
    expect(resolveSimulationView(null, HELD, true)).toEqual({
      simulation: HELD,
      simulationPending: true,
    });
  });

  it("never round-trips a shown value through null", () => {
    // The defect this rule exists to prevent: a null on every poll re-skeletons and
    // re-fades every slot on the canvas at once, which reads as a data loss that did not
    // happen. There is no input combination that produces it over a held value.
    for (const held of [HELD, FRESH]) {
      const view = resolveSimulationView(null, held, true);
      expect(view.simulation).not.toBeNull();
      expect(view.simulation).toBe(held);
    }
  });

  it("clears to a settled null when there is nothing in flight and nothing to show", () => {
    expect(resolveSimulationView(null, HELD, false)).toEqual({
      simulation: null,
      simulationPending: false,
    });
    expect(resolveSimulationView(null, null, false)).toEqual({
      simulation: null,
      simulationPending: false,
    });
  });
});

interface ProbeState {
  /** Every distinct result object the hook has handed out. A Set, so a repeated render
   *  that recomputes nothing cannot inflate the count. */
  readonly results: Set<SimulationResult>;
  /** Commits of the probe itself, so a test can prove a re-render DID reach the screen and
   *  the simulation still did not change — otherwise "no re-derivation" would pass for the
   *  uninteresting reason that nothing re-rendered at all. */
  commits: number;
  pending: boolean;
  simulation: SimulationResult | null;
}

function freshRecorder(): ProbeState {
  return { results: new Set(), commits: 0, pending: false, simulation: null };
}

/**
 * Module-scoped rather than a prop: the React compiler's immutability rule forbids writing
 * through props during render, and it is right to — the recorder is test scaffolding, not
 * component state.
 */
let recorder: ProbeState = freshRecorder();

function Probe({ snapshot }: { snapshot: SnapshotState }) {
  // Subscribing to the view map is what makes a block MOVE re-render this component:
  // `moveBlock` writes `view` and never `doc`.
  useComposerStore((s) => s.view);
  const view = useSimulation(snapshot);
  // Recorded in an effect, not during render: render must stay pure (the compiler enforces
  // it), and an effect with no dep array fires once per COMMIT — which is the honest thing
  // to count anyway, since a render React discards never reached the screen.
  useEffect(() => {
    recorder.commits += 1;
    if (view.simulation !== null) recorder.results.add(view.simulation);
    recorder.pending = view.simulationPending;
    recorder.simulation = view.simulation;
  });
  return (
    <span data-testid="hf">
      {view.simulation === null
        ? "no simulation"
        : formatHealthFactor(hfWadValue(valueOf(view.simulation.minHealthFactor)))}
    </span>
  );
}

function mount(store: ComposerStoreApi, snapshot: SnapshotState = READY) {
  recorder = freshRecorder();
  const state = recorder;
  const view = render(
    <ComposerStoreProvider store={store}>
      <Probe snapshot={snapshot} />
    </ComposerStoreProvider>,
  );
  const rerenderWith = (next: SnapshotState) =>
    view.rerender(
      <ComposerStoreProvider store={store}>
        <Probe snapshot={next} />
      </ComposerStoreProvider>,
    );
  return { ...view, state, rerenderWith };
}

function flagshipStore(): ComposerStoreApi {
  const store = createComposerStore();
  expect(store.getState().loadTemplate(FLAGSHIP_TEMPLATE_ID)).toBe(true);
  return store;
}

describe("useSimulation — one derivation per document revision", () => {
  it("derives the panel's health factor from the recorded read set, not from a fixture", () => {
    const { getByTestId, state } = mount(flagshipStore());
    // Expected from the TEMPLATE, not a restated allocation: this asserts the host simulates
    // the document the composer actually opens with, whatever the shipped default is.
    const expected = simulate(leveragedRestakeLoop(), sandboxSnapshot());
    expect(getByTestId("hf").textContent).toBe(
      formatHealthFactor(hfWadValue(valueOf(expected.minHealthFactor))),
    );
    expect(state.results.size).toBe(1);
    expect(state.pending).toBe(false);
  });

  it("opens SAFE, so the §3 step-3 crossing has somewhere to arrive from", () => {
    // The reason the shipped default is 5000. If the composer ever opens inside the warning
    // band again, step 3 has nothing left to demonstrate and this fails.
    const { state } = mount(flagshipStore());
    const hf = valueOf(state.simulation!.minHealthFactor);
    expect(hf.status).toBe("healthy");
    expect(riskState(hf)).toBe("ok");
  });

  it("re-derives when the document revision changes — the §3 step-3 drag", () => {
    const store = flagshipStore();
    const { getByTestId, state } = mount(store);
    const before = getByTestId("hf").textContent;

    act(() => {
      // 50% → 70%, exactly the drag SPEC §3 step 3 scripts — and the fork-proven point.
      store.getState().setBorrowAllocationBps("borrow", FORK_PROVEN_BORROW_BPS);
    });

    expect(getByTestId("hf").textContent).not.toBe(before);
    expect(state.results.size).toBe(2);
    // Borrowing more against the same collateral lowers the health factor, and it lands
    // inside the warning band: the drag crosses the threshold, live.
    expect(Number(getByTestId("hf").textContent)).toBeLessThan(Number(before));
    expect(riskState(valueOf(state.simulation!.minHealthFactor))).toBe("warning");
  });

  it("does NOT re-derive when a block only moves", () => {
    // `moveBlock` writes `view` and leaves `doc` alone precisely so a layout drag cannot
    // invalidate the risk projection. If this ever regresses, every block and the whole
    // panel re-render on every mouse-move of a drag.
    const store = flagshipStore();
    const { getByTestId, state } = mount(store);
    const before = getByTestId("hf").textContent;
    const commitsBefore = state.commits;

    act(() => {
      store.getState().moveBlock("borrow", { x: 999, y: 42 });
    });
    act(() => {
      store.getState().moveBlock("borrow", { x: 111, y: 7 });
    });

    // The moves really did re-render and re-commit this component — so holding at one
    // derivation is the memo doing its job, not the absence of a render.
    expect(state.commits).toBeGreaterThan(commitsBefore);
    expect(state.results.size).toBe(1);
    expect(getByTestId("hf").textContent).toBe(before);
  });
});

describe("useSimulation — what null means", () => {
  it("holds the shown result while the snapshot refreshes, and raises pending", () => {
    const store = flagshipStore();
    const { state, rerenderWith } = mount(store);
    const shown = state.simulation;
    expect(shown).not.toBeNull();

    rerenderWith(LOADING);

    expect(state.simulation).toBe(shown);
    expect(state.pending).toBe(true);
  });

  it("settles to null — not to a stale value — when the snapshot is unavailable", () => {
    const store = flagshipStore();
    const { state, rerenderWith } = mount(store);
    expect(state.simulation).not.toBeNull();

    rerenderWith(UNAVAILABLE);

    // A settled failure is a different fact from a refresh in flight: the consumers render
    // their designed unavailable states rather than skeletons that never resolve.
    expect(state.simulation).toBeNull();
    expect(state.pending).toBe(false);
  });

  it("reports no simulation for an empty canvas rather than simulating nothing", () => {
    const { getByTestId, state } = mount(createComposerStore());
    expect(getByTestId("hf").textContent).toBe("no simulation");
    expect(state.pending).toBe(false);
  });

  it("passes an invalid graph's refusal through instead of collapsing it to null", () => {
    const store = flagshipStore();
    // A second, unconnected input makes the graph structurally invalid.
    act(() => {
      store.getState().addBlock("input", { x: 10, y: 10 });
    });
    const { state } = mount(store);

    expect(state.simulation).not.toBeNull();
    expect(state.simulation?.isValid).toBe(false);
    expect(state.simulation?.errorMessage).toBeTruthy();
  });
});

describe("loadSandboxSnapshot", () => {
  it("resolves the committed read set into a ready state", () => {
    const loaded = loadSandboxSnapshot();
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") throw new Error("expected ready");
    expect(loaded.snapshot.block).toBe(sandboxSnapshot().block);
  });
});
