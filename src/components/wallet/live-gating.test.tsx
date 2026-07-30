/** @vitest-environment jsdom */
/**
 * SPEC §3 steps 4 and 7, at the component seam.
 *
 * The DECISIONS are proven in `src/core/borrow-limit.test.ts` and `src/lib/wallet/gate.test.ts`;
 * what is proven here is that the components render those verdicts and refuse accordingly —
 * that the gate is wired, not merely written.
 *
 * Two reconciliations this file carries deliberately:
 *
 *  - No VALUE import of core money-math (Codex round-2 finding 3): `src/components/wallet/**`
 *    is lint-restricted to type-only, so the borrow verdict this suite gates against is built
 *    in `tests/helpers/plans.ts` and handed in. wagmi is legal here; money-math is not.
 *  - The readiness source is composed EXACTLY as the composer composes it (round-2 finding 2):
 *    a demo arm plus the chain arm, routed per session connector. Every live beat below
 *    therefore walks the router rather than a bare demo source, and the injected-connector
 *    beats prove a real wallet cannot be served fabricated readings.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createConfig } from "wagmi";
import { mainnet } from "wagmi/chains";
import { mock } from "wagmi/connectors";
import { custom, getAddress, type Address, type Transport } from "viem";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { flagshipBorrowVerdict, flagshipOverLimitBps } from "../../../tests/helpers/plans";
import { createComposerStore } from "../../app/store/composer-store";
import { ComposerStoreProvider } from "../../app/store/composer-provider";
import { createWalletConfig, type WalletConfig } from "../../lib/wallet/config";
import { INJECTED_CONNECTOR_ID } from "../../lib/wallet/connectors";
import { demoSeam, type WalletSeamSource } from "../../lib/wallet/seam";
import { WalletProvider, useWalletBoundary } from "../../lib/wallet/wallet-provider";
import { demoLiveCaptureSource } from "../../lib/live/demo-capture";
import { liveSeam, type LiveCaptureSource } from "../../lib/live/live-transport";
import { routedCaptureSource, routedSeam } from "../../lib/live/readiness-source";
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
const offlineTransport: Transport = custom({
  request: ({ method }: { method: string }) => {
    if (method === "eth_chainId") return Promise.resolve("0x1");
    return Promise.reject(new Error(`the offline test transport answers no ${method}`));
  },
});

const CLEAN: Address = getAddress("0x1111111111111111111111111111111111111111");
const OCCUPIED: Address = getAddress("0x2222222222222222222222222222222222222222");
/** A wallet the demo scenario table has never heard of — what a real extension supplies. */
const REAL_WALLET: Address = getAddress("0x9999999999999999999999999999999999999999");

/**
 * What the chain arm answers in a deployment with no `LIVE_CHAIN_RPC_URL` — the wallet
 * router's own `live-chain-unconfigured` reason, abbreviated. The demo/CI build IS such a
 * deployment, which is exactly why the routing matters: the honest answer for a real wallet
 * there is "nothing was read", and the gate must refuse on it.
 */
const NO_LIVE_RPC =
  "no live chain source is configured in this deployment (LIVE_CHAIN_RPC_URL), so the wallet's code, footprint and balances cannot be read";

const unconfiguredRpcCapture: LiveCaptureSource = {
  capture: () =>
    Promise.resolve({ ok: false as const, kind: "refused-upstream" as const, reason: NO_LIVE_RPC }),
};

afterEach(cleanup);

/** A store holding the flagship at a chosen borrow allocation. */
function storeAt(allocationBps: number) {
  const store = createComposerStore();
  const base = flagshipGraph(10, allocationBps);
  store.setState({ doc: base, rev: 1 });
  return store;
}

/** The over-limit point, computed from the ceiling `core/` reports rather than typed. */
const OVER_BPS = flagshipOverLimitBps();

/**
 * A session whose transport is a REAL wallet, for a component test with no extension in the
 * page: the mock connector, re-identified as `injected`. That re-identification is not a trick
 * invented here — `config.ts` performs the same one to tell `mock-2` from `mock` — and it is
 * the only way to drive the boundary's real code with a non-mock connector id.
 */
function injectedSessionConfig(account: Address): WalletConfig {
  return createConfig({
    chains: [mainnet],
    connectors: [
      (config) => ({
        ...mock({ accounts: [account], features: { defaultConnected: false } })(config),
        id: INJECTED_CONNECTOR_ID,
        name: "Injected Wallet",
      }),
    ],
    transports: { [mainnet.id]: offlineTransport },
    storage: null,
    ssr: false,
  });
}

interface LiveWiring {
  readonly source: LiveCaptureSource;
  readonly seam: WalletSeamSource;
}

/**
 * The composer's composition, verbatim: a demo arm over the scenario table plus the chain arm,
 * both routed by session connector. `accounts` is the scenario table's DOMAIN — the demo
 * build's own fabricated wallets — and nothing outside it can be answered by the demo arm.
 */
function composerWiring(options: {
  readonly accounts: readonly Address[];
  readonly occupied: readonly Address[];
  readonly captureOccupied: readonly Address[];
}): LiveWiring {
  const { accounts, occupied, captureOccupied } = options;
  return {
    source: routedCaptureSource({
      demo: demoLiveCaptureSource({ accounts, codeBearing: [], occupied: captureOccupied }),
      rpc: unconfiguredRpcCapture,
    }),
    seam: routedSeam({
      demo: demoSeam({ accounts, codeBearing: [], occupied }),
      rpc: liveSeam(unconfiguredRpcCapture),
    }),
  };
}

/**
 * The composer's own wiring, isolated: the live gate feeding the execution column, with the
 * F2 live-simulation path composed exactly as `ComposerBody` composes it — the routed capture
 * source and a fixed monotonic clock. The whole SESSION goes to `simulate`, because which
 * source may answer is a fact about its connector.
 */
function LiveHost({
  allocationBps,
  source,
}: {
  readonly allocationBps: number;
  readonly source: LiveCaptureSource;
}) {
  const state = { status: "ready", snapshot } as const;
  const wallet = useWalletBoundary();
  const session = wallet.session;
  const liveSim = useLiveSimulation(source, () => 1_000);
  const live = useLiveGate(state, liveSim);
  return (
    <ExecutionHost
      snapshot={state}
      simulation={null}
      simulationPending={false}
      borrowLimit={flagshipBorrowVerdict(allocationBps)}
      mode={live.mode}
      liveRefusal={live.refusal}
      liveSimulationPhase={liveSim.phase}
      onLiveSimulate={session === null ? null : () => liveSim.simulate(session)}
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
  /** A non-mock session, for the round-2 finding 2 beats. */
  readonly config?: WalletConfig;
  /** Override the connect seam alone, to isolate the capture half. */
  readonly seam?: WalletSeamSource;
}) {
  const store = storeAt(options.allocationBps);
  const wiring = composerWiring({
    accounts: options.accounts,
    occupied: options.occupied,
    captureOccupied: options.captureOccupied ?? options.occupied,
  });
  const view = render(
    <WalletProvider
      config={options.config ?? createWalletConfig(options.accounts, offlineTransport)}
      seam={options.seam ?? wiring.seam}
    >
      <ComposerStoreProvider store={store}>
        <ConnectSurface />
        <LiveHost allocationBps={options.allocationBps} source={wiring.source} />
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
  const verdict = flagshipBorrowVerdict(options.allocationBps);
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
      seam={demoSeam({ accounts: wallet.accounts, codeBearing: [], occupied: wallet.occupied })}
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
    // source here, reached through the router because the session IS a mock connector; the
    // wallet router in production), runs the same pure simulation, and the standing it mints
    // is what lifts the gate — nothing else changed.
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

/**
 * Codex round-2 finding 2, at the seam that shipped it: a mock-enabled build must not serve
 * demo readiness to a real wallet. Both mounts below are the DEMO/CI build — mock accounts
 * configured, no live RPC — with a session that arrived by the `injected` connector for an
 * address the scenario table never named.
 */
describe("SPEC §3 step 7 — fabricated readings attach only to fabricated wallets", () => {
  it("answers an injected-connector session from the chain arm, and refuses on what was not read", async () => {
    mountLive({
      accounts: [CLEAN],
      occupied: [],
      allocationBps: 7000,
      config: injectedSessionConfig(REAL_WALLET),
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect Injected Wallet" }));

    await waitFor(
      () => {
        expect(screen.getByTestId("wallet-address").getAttribute("title")).toBe(REAL_WALLET);
      },
      { timeout: 8_000 },
    );
    // The demo scenario would have read this wallet clear on BOTH facts. The router sent it to
    // the chain arm instead, which read nothing — so the gate refuses, and it says why. The
    // code reading is what refuses first because the flagship contains a WETH withdrawal and
    // the stipend gate is plan-conditional (gate.ts ordering); the unread footprint would
    // refuse identically for a plan without one.
    await waitFor(() => {
      expect(
        screen.getAllByText("The wallet's code could not be read").length,
      ).toBeGreaterThan(0);
    });
    // The stated reason reaches the screen verbatim — the refusal explains what was not read,
    // rather than reporting a generic failure.
    expect(document.body.textContent).toContain(NO_LIVE_RPC);
    expect(
      screen
        .getByRole("button", { name: "Review & execute in sandbox" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    // Not offered: no simulation can answer an unread seam (`simulationCanClear`), and the old
    // behaviour's failure mode was precisely that this control appeared and then CLEARED.
    expect(screen.queryByRole("button", { name: "Simulate against this wallet" })).toBeNull();
  });

  it("captures an injected-connector session through the chain arm even when the connect readings passed", async () => {
    // Defence in depth, isolated: the connect seam is handed the demo scenario DIRECTLY, as if
    // only the capture half had been fixed, so this beat is about the capture routing alone.
    // The gate reaches the freshness refusal, the control is offered — and the capture the
    // press performs comes from the chain arm, which refuses. The gate never clears.
    mountLive({
      accounts: [CLEAN],
      occupied: [],
      allocationBps: 7000,
      config: injectedSessionConfig(REAL_WALLET),
      seam: demoSeam({ accounts: [REAL_WALLET], codeBearing: [], occupied: [] }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect Injected Wallet" }));
    await waitFor(
      () => {
        expect(screen.queryByRole("button", { name: "Simulate against this wallet" })).not.toBeNull();
      },
      { timeout: 8_000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "Simulate against this wallet" }));
    await waitFor(() => {
      expect(screen.getByTestId("live-simulation-refusal").textContent).toContain(
        "no live chain source is configured",
      );
    });
    expect(
      screen
        .getByRole("button", { name: "Review & execute in sandbox" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("still walks the whole scenario for a mock-connector session in the same build", async () => {
    // The other side of the rule, in the same wiring: the demo arm is not disabled, it is
    // SCOPED. A mock session clears the gate exactly as it did before.
    mountLive({
      accounts: [CLEAN],
      occupied: [],
      allocationBps: 7000,
    });
    fireEvent.click(screen.getByRole("button", { name: /Connect Mock/i }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Simulate against this wallet" })).not.toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "Simulate against this wallet" }));
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "Review & execute in sandbox" })
          .getAttribute("aria-disabled"),
      ).toBeNull();
    });
  });
});
