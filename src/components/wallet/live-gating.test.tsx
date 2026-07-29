/** @vitest-environment jsdom */
/**
 * SPEC §3 steps 4 and 7, at the component seam.
 *
 * The DECISIONS are proven in `src/core/borrow-limit.test.ts` and `src/lib/wallet/gate.test.ts`;
 * what is proven here is that the components render those verdicts and refuse accordingly —
 * that the gate is wired, not merely written.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { custom, getAddress, type Address } from "viem";
import { borrowLimitVerdict } from "../../core/borrow-limit";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { createComposerStore } from "../../app/store/composer-store";
import { ComposerStoreProvider } from "../../app/store/composer-provider";
import { createWalletConfig } from "../../lib/wallet/config";
import { demoSeam } from "../../lib/wallet/seam";
import { WalletProvider, useWalletBoundary } from "../../lib/wallet/wallet-provider";
import { demoLiveCaptureSource } from "../../lib/live/demo-capture";
import { ExecutionHost } from "../tx/execution-host";
import { useLiveGate } from "../composer/sandbox-composer";
import { useLiveSimulation } from "../composer/live-simulation";
import { ConnectSurface } from "./connect-surface";

const snapshot = fixtureSnapshot();

/**
 * A transport that opens no socket. The mock connector forwards `eth_chainId` to the config's
 * client during connect, and a suite that answered it over the public RPC would be asserting
 * the internet's uptime. Anything else THROWS rather than returning a plausible-looking
 * value — a test transport that invents chain data is exactly the defect this repo's
 * recorded-reads discipline exists to prevent.
 */
const offlineTransport = custom({
  request: ({ method }: { method: string }) => {
    if (method === "eth_chainId") return Promise.resolve("0x1");
    return Promise.reject(new Error(`the offline test transport answers no ${method}`));
  },
});

const CLEAN: Address = getAddress("0x1111111111111111111111111111111111111111");
const OCCUPIED: Address = getAddress("0x2222222222222222222222222222222222222222");

afterEach(cleanup);

/** A store holding the flagship at a chosen borrow allocation. */
function storeAt(allocationBps: number) {
  const store = createComposerStore();
  const base = flagshipGraph(10, allocationBps);
  store.setState({ doc: base, rev: 1 });
  return store;
}

function verdictAt(allocationBps: number) {
  return borrowLimitVerdict(flagshipGraph(10, allocationBps), snapshot);
}

/** The over-limit point, computed from the ceiling rather than typed. */
const CEILING = (() => {
  const within = verdictAt(7000);
  if (within.status !== "within") throw new Error("the flagship at 70% must be within the limit");
  return within.ceiling;
})();
const OVER_BPS = CEILING.maxAllocationBps + 100;

/**
 * The composer's own wiring, isolated: the live gate feeding the execution column, with the
 * F2 live-simulation path composed exactly as `ComposerBody` composes it — the demo capture
 * source (the committed reads log; hermetic) and a fixed monotonic clock.
 */
function LiveHost({
  allocationBps,
  captureOccupied,
}: {
  readonly allocationBps: number;
  readonly captureOccupied: readonly Address[];
}) {
  const state = { status: "ready", snapshot } as const;
  const wallet = useWalletBoundary();
  const sessionAddress = wallet.session === null ? null : wallet.session.address;
  const liveSim = useLiveSimulation(
    demoLiveCaptureSource({ codeBearing: [], occupied: captureOccupied }),
    () => 1_000,
  );
  const live = useLiveGate(state, liveSim);
  return (
    <ExecutionHost
      snapshot={state}
      simulation={null}
      simulationPending={false}
      borrowLimit={verdictAt(allocationBps)}
      mode={live.mode}
      liveRefusal={live.refusal}
      liveSimulationPhase={liveSim.phase}
      onLiveSimulate={sessionAddress === null ? null : () => liveSim.simulate(sessionAddress)}
      now={() => 1_000}
    />
  );
}

function mountLive(options: {
  readonly accounts: readonly Address[];
  readonly occupied: readonly Address[];
  readonly allocationBps: number;
  /** The CAPTURE's occupied set, when a test needs it to disagree with the connect seam's
   *  (the connect-clear-then-position-opened race); defaults to the seam's. */
  readonly captureOccupied?: readonly Address[];
}) {
  const store = storeAt(options.allocationBps);
  const view = render(
    <WalletProvider
      config={createWalletConfig(options.accounts, offlineTransport)}
      seam={demoSeam({ codeBearing: [], occupied: options.occupied })}
    >
      <ComposerStoreProvider store={store}>
        <ConnectSurface />
        <LiveHost
          allocationBps={options.allocationBps}
          captureOccupied={options.captureOccupied ?? options.occupied}
        />
      </ComposerStoreProvider>
    </WalletProvider>,
  );
  return { store, view };
}

function mountHost(options: {
  readonly allocationBps: number;
  readonly wallet?: { readonly accounts: readonly Address[]; readonly occupied: readonly Address[] };
}) {
  const store = storeAt(options.allocationBps);
  const verdict = verdictAt(options.allocationBps);
  const wallet = options.wallet;
  const body = (
    <ComposerStoreProvider store={store}>
      <ExecutionHost
        snapshot={{ status: "ready", snapshot }}
        simulation={null}
        simulationPending={false}
        borrowLimit={verdict}
        now={() => 1_000}
      />
    </ComposerStoreProvider>
  );
  if (wallet === undefined) return { store, view: render(body) };
  const view = render(
    <WalletProvider
      config={createWalletConfig(wallet.accounts, offlineTransport)}
      seam={demoSeam({ codeBearing: [], occupied: wallet.occupied })}
    >
      {body}
    </WalletProvider>,
  );
  return { store, view };
}

describe("SPEC §3 step 4 — prevention and override", () => {
  it("gates Simulate past the limit, and states the ceiling in the reason", () => {
    mountHost({ allocationBps: OVER_BPS });
    const button = screen.getByRole("button", { name: "Review & execute in sandbox" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // Never `disabled` — a disabled control cannot be focused, so it cannot say why.
    expect(button.hasAttribute("disabled")).toBe(false);
    const described = button.getAttribute("aria-describedby");
    expect(described).not.toBeNull();
    const reason = document.getElementById(described ?? "")?.textContent ?? "";
    expect(reason).toContain("past the limit");
    expect(reason).toContain("Simulate anyway");
  });

  it("offers the explicit override, and arming it lifts the gate", () => {
    const { store } = mountHost({ allocationBps: OVER_BPS });
    expect(store.getState().overrideGateArmed).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Simulate anyway" }));
    expect(store.getState().overrideGateArmed).toBe(true);
  });

  it("does not offer the override when the borrow is within the limit", () => {
    mountHost({ allocationBps: 7000 });
    expect(screen.queryByRole("button", { name: "Simulate anyway" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Review & execute in sandbox" }).getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it('labels the rerun "Re-simulate", never "Resume" (SPEC §6)', async () => {
    mountHost({ allocationBps: 7000 });
    fireEvent.click(screen.getByRole("button", { name: "Review & execute in sandbox" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Re-simulate" })).not.toBeNull();
    });
    expect(screen.queryByRole("button", { name: /Resume/i })).toBeNull();
  });
});

describe("SPEC §3 step 7 — live gating", () => {
  it("stays in sandbox with no wallet, and offers the sandbox entry affordance", () => {
    mountHost({ allocationBps: 7000, wallet: { accounts: [], occupied: [] } });
    expect(screen.queryByRole("button", { name: "Review & execute in sandbox" })).not.toBeNull();
  });

  it("connects the mock connector and reports the address it produced", async () => {
    mountLive({ accounts: [CLEAN], occupied: [], allocationBps: 7000 });
    fireEvent.click(screen.getByRole("button", { name: /Connect Mock/i }));
    await waitFor(
      () => {
        expect(screen.getByTestId("wallet-address").getAttribute("title")).toBe(CLEAN);
      },
      { timeout: 8_000 },
    );
  });

  it("switches the session to Live and gates Execute on a fresh simulation against real balances", async () => {
    mountLive({ accounts: [CLEAN], occupied: [], allocationBps: 7000 });
    fireEvent.click(screen.getByRole("button", { name: /Connect Mock/i }));
    await waitFor(() => {
      // Twice on purpose: once as the designed-stop card's title, once as the gated
      // button's stated reason. One sentence, one source (`liveRefusalCopy`).
      expect(
        screen.getAllByText("No simulation against this wallet's balances yet").length,
      ).toBeGreaterThan(0);
    });
    expect(
      screen
        .getByRole("button", { name: "Review & execute in sandbox" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("clears the gate with a live simulation against the wallet, then regates on plan drift (F2/F3)", async () => {
    const { store } = mountLive({ accounts: [CLEAN], occupied: [], allocationBps: 7000 });
    fireEvent.click(screen.getByRole("button", { name: /Connect Mock/i }));
    await waitFor(() => {
      expect(
        screen.getAllByText("No simulation against this wallet's balances yet").length,
      ).toBeGreaterThan(0);
    });

    // The F2 clearing path: one press captures the wallet's pinned chain state (the demo
    // source here; the wallet router in production), runs the same pure simulation, and
    // the standing it mints is what lifts the gate — nothing else changed.
    fireEvent.click(screen.getByRole("button", { name: "Simulate against this wallet" }));
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "Review & execute in sandbox" })
          .getAttribute("aria-disabled"),
      ).toBeNull();
    });
    expect(screen.queryAllByText("No simulation against this wallet's balances yet")).toHaveLength(0);

    // The F3 beat: edit the document — address unchanged, clock unchanged — and the gate
    // refuses on the DRIFT, not on staleness: the simulated plan is not the current plan.
    store.setState({ doc: flagshipGraph(10, 7100), rev: 2 });
    await waitFor(() => {
      expect(
        screen.getAllByText("The strategy changed after it was simulated").length,
      ).toBeGreaterThan(0);
    });
    expect(
      screen
        .getByRole("button", { name: "Review & execute in sandbox" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    // The clearing control is offered again — drift is exactly what a re-simulation answers.
    expect(screen.queryByRole("button", { name: "Simulate against this wallet" })).not.toBeNull();
  });

  it("states the refusal when the live simulation itself cannot stand behind Execute (F2)", async () => {
    // The connect seam read clear, but the CAPTURE sees an Aave footprint — the position
    // was opened between the two reads. The capture succeeds and the SIMULATION refuses
    // (existing-footprint is a plan constraint), so the stated-absence path renders its
    // reason rather than silently returning to the gated button.
    mountLive({ accounts: [CLEAN], occupied: [], allocationBps: 7000, captureOccupied: [CLEAN] });
    fireEvent.click(screen.getByRole("button", { name: /Connect Mock/i }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Simulate against this wallet" })).not.toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "Simulate against this wallet" }));
    await waitFor(() => {
      expect(screen.getByTestId("live-simulation-refusal").textContent).toContain(
        "does not plan against this wallet's captured chain state",
      );
    });
    expect(
      screen
        .getByRole("button", { name: "Review & execute in sandbox" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("refuses a wallet already holding an Aave position, in the designed-stop grammar", async () => {
    mountLive({ accounts: [OCCUPIED], occupied: [OCCUPIED], allocationBps: 7000 });
    fireEvent.click(screen.getByRole("button", { name: /Connect Mock/i }));
    await waitFor(() => {
      expect(screen.getAllByText("This wallet already has an Aave position").length).toBeGreaterThan(0);
    });
    // A STATE, not a toast — and it gates the commit rather than decorating it.
    expect(
      screen
        .getByRole("button", { name: "Review & execute in sandbox" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    // The footprint refusal wins over the freshness gate: the wallet is out of scope for
    // live v1 whatever the simulation says.
    expect(screen.queryAllByText("No simulation against this wallet's balances yet")).toHaveLength(0);
  });
});
