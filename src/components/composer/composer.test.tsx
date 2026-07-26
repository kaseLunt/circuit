/** @vitest-environment jsdom */
// No jest-dom matchers: the suite asserts on the DOM directly, as the primitives suite
// does. Every fixture below mints its provenance through `observationMinter` — a
// hand-written `{ kind: "observed" }` literal is banned by lint precisely so a test
// cannot forge the thing it is asserting about.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Sidebar } from "./sidebar";
import { SimulationPanel } from "./simulation-panel";
import { ComposerShell } from "./composer-shell";
import {
  ComposerStoreProvider,
  useComposerStore,
  useComposerStoreApi,
} from "../../app/store/composer-provider";
import { createComposerStore } from "../../app/store/composer-store";
import { WAD } from "../../core/format";
import { derived, entered, observationMinter } from "../../core/provenance";
import { FLAGSHIP_TEMPLATE_ID } from "../../lib/strategy/templates";
import type { SimulationResult } from "../../lib/strategy/types";

afterEach(cleanup);

const minter = observationMinter(25_592_678n, 1_753_240_451);
const supplyRate = minter.observe(
  (WAD * 342n) / 10_000n,
  "AavePool.getReserveData(weETH).liquidityRate",
);

/** bps → WAD fraction: 485 bps == 4.85% == 0.0485e18. */
const wadPct = (bps: number): bigint => (WAD * BigInt(bps)) / 10_000n;

function simulation(overrides: Partial<SimulationResult> = {}): SimulationResult {
  return {
    isValid: true,
    grossApyWad: derived(wadPct(390), "r_coll", [supplyRate]),
    netApyWad: derived(wadPct(485), "(1+b)(1+r_coll) - b(1+r_debt) - 1", [supplyRate]),
    initialAmountWei: entered(10n * WAD),
    gasCostBase: derived(1_234_500_000n, "gasUnits * gasPrice * ethPrice", [supplyRate]),
    // Above HF_WARN_WAD (1.50) on purpose: the no-override fixture is the nominal safe
    // case, and every warning assertion below states its own health factor. A default
    // sitting inside the warning band would let a colour test pass for the wrong reason.
    minHealthFactor: { status: "healthy", hfWad: (WAD * 185n) / 100n },
    finalHealthFactor: { status: "healthy", hfWad: (WAD * 192n) / 100n },
    liquidationRatioWad: derived(
      (WAD * 8_235n) / 10_000n,
      "debtWei * 1e4 * WAD / (collWei * ltBps)",
      [supplyRate],
    ),
    leverageWad: derived((WAD * 333n) / 100n, "exposure / equity", [supplyRate]),
    yieldSources: [
      {
        protocol: "etherfi",
        type: "stake",
        apyWad: derived(wadPct(310), "rayAprToApyWad(stakeApr)", [supplyRate]),
        weightBps: 17_000,
      },
      {
        protocol: "aave-v3",
        type: "borrow",
        apyWad: derived(wadPct(265), "rayAprToApyWad(borrowApr)", [supplyRate]),
        weightBps: -7_000,
      },
    ],
    blockValues: {},
    ...overrides,
  };
}

describe("SimulationPanel — designed states", () => {
  it("renders no digit at all while its sources are in flight", () => {
    const { container } = render(<SimulationPanel result={null} pending />);
    expect(container.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/\d/);
  });

  it("a settled absence is an explicit no-simulation state, not an empty panel", () => {
    const { container } = render(<SimulationPanel result={null} pending={false} />);
    expect(screen.getByText("No simulation yet")).not.toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.textContent).not.toMatch(/\d/);
  });

  it("carries the run-rate qualifier inline with the Net APY label", () => {
    render(<SimulationPanel result={simulation()} pending={false} />);
    expect(screen.getByText("Net APY · current-rate run-rate, one iteration")).not.toBeNull();
    expect(screen.getByText("Incentives and rewards excluded.")).not.toBeNull();
  });

  it("ranks the health factor at the same type ramp as the yield headline", () => {
    render(<SimulationPanel result={simulation()} pending={false} />);
    const netApy = screen.getByRole("button", { name: "4.85%" });
    const healthFactor = screen.getByText("1.85");
    for (const node of [netApy, healthFactor]) {
      expect(node.className).toContain("text-2xl");
      expect(node.className).toContain("font-semibold");
      expect(node.className).toContain("tabular-nums");
    }
  });

  it("renders a safe health factor in the foreground colour — safe is not green", () => {
    const { container } = render(<SimulationPanel result={simulation()} pending={false} />);
    const healthFactor = screen.getByText("1.85");
    expect(healthFactor.className).toContain("text-foreground");
    expect(healthFactor.className).not.toContain("text-success");
    expect(healthFactor.className).not.toContain("text-warning");
    expect(container.querySelector(".status-dot-warning")).toBeNull();
  });

  it("flips to the warning colour and announces the crossing exactly once", () => {
    const { container } = render(
      <SimulationPanel
        result={simulation({ minHealthFactor: { status: "healthy", hfWad: (WAD * 120n) / 100n } })}
        pending={false}
      />,
    );
    const healthFactor = screen.getByText("1.20");
    expect(healthFactor.className).toContain("text-warning");
    expect(healthFactor.className).toContain("transition-fast");
    expect(container.querySelector(".status-dot-warning")).not.toBeNull();

    const regions = container.querySelectorAll('[role="status"]');
    expect(regions.length).toBe(1);
    expect(regions[0]?.textContent).toContain("1.20");
    expect(regions[0]?.textContent).toContain("1.50");
  });

  it("empties the live region when the panel empties, rather than holding stale prose", () => {
    const { container, rerender } = render(
      <SimulationPanel result={simulation()} pending={false} />,
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain("1.85");

    rerender(<SimulationPanel result={null} pending={false} />);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("says an unknown health factor is unknown and never implies safety", () => {
    const { container } = render(
      <SimulationPanel
        result={simulation({
          minHealthFactor: { status: "unknown", reason: "missing collateral or debt snapshot" },
          liquidationRatioWad: null,
        })}
        pending={false}
      />,
    );
    // The hero slot keeps the hero ramp in every state: "we cannot tell you your health
    // factor" is the most important thing this panel can say, and it must not rank below
    // the Net APY directly above it.
    const hero = screen.getByText("Unavailable");
    expect(hero.className).toContain("text-2xl");
    expect(hero.className).toContain("font-semibold");
    expect(
      screen.getByText("Data source failed — missing collateral or debt snapshot."),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("∞");
    expect(container.textContent).not.toContain("safe");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Health factor unavailable",
    );
  });

  it("says a debt-free position has no liquidation risk instead of printing ∞", () => {
    const { container } = render(
      <SimulationPanel
        result={simulation({
          minHealthFactor: { status: "no-debt" },
          finalHealthFactor: { status: "no-debt" },
          liquidationRatioWad: null,
        })}
        pending={false}
      />,
    );
    const hero = screen.getByText("No borrow");
    expect(hero.className).toContain("text-2xl");
    expect(hero.className).toContain("font-semibold");
    expect(screen.getByText("No liquidation risk.")).not.toBeNull();
    expect(container.textContent).not.toContain("∞");
  });

  it("renders the yield breakdown complete, with the debt leg's negative weight", () => {
    render(<SimulationPanel result={simulation()} pending={false} />);
    expect(screen.getByRole("button", { name: "3.10%" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "2.65%" })).not.toBeNull();
    expect(screen.getByText("170.00%")).not.toBeNull();
    expect(screen.getByText("-70.00%")).not.toBeNull();
  });

  it("refuses a partial breakdown — an empty list says so in prose", () => {
    render(
      <SimulationPanel
        result={simulation({ netApyWad: null, yieldSources: [] })}
        pending={false}
      />,
    );
    expect(screen.getByText(/Breakdown unavailable/)).not.toBeNull();
    expect(screen.getByText("net APY unavailable — a rate did not resolve")).not.toBeNull();
  });

  it("keeps the unavailable state off the hero ramp — prose must not look like a figure", () => {
    render(
      <SimulationPanel
        result={simulation({ netApyWad: null, yieldSources: [] })}
        pending={false}
      />,
    );
    const prose = screen.getByText("net APY unavailable — a rate did not resolve");
    expect(prose.className).toContain("text-xs");
    expect(prose.className).toContain("text-muted-foreground");
    expect(prose.className).not.toContain("text-2xl");
    expect(prose.className).not.toContain("font-semibold");
  });

  it("holds the hero's box while the figure is in flight", () => {
    const { container } = render(<SimulationPanel result={null} pending />);
    const skeleton = container.querySelector('[aria-label="Net APY: loading"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.className).toContain("text-2xl");
  });

  it("surfaces an invalid simulation verbatim rather than rendering it as a result", () => {
    render(
      <SimulationPanel
        result={simulation({ isValid: false, errorMessage: "block borrow: exceeds LTV ceiling" })}
        pending={false}
      />,
    );
    expect(screen.getByText("block borrow: exceeds LTV ceiling")).not.toBeNull();
  });

  it("raises an invalid simulation as an alert, not as silent decoration", () => {
    const { container } = render(
      <SimulationPanel
        result={simulation({ isValid: false, errorMessage: "block borrow: exceeds LTV ceiling" })}
        pending={false}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("block borrow: exceeds LTV ceiling");
    expect(container.querySelectorAll('[role="status"]').length).toBe(1);
  });

  it("is one w-80 complementary landmark", () => {
    render(<SimulationPanel result={simulation()} pending={false} />);
    const panel = screen.getByRole("complementary", { name: "Simulation" });
    expect(panel.className).toContain("w-80");
    expect(panel.className).toContain("border-l");
  });
});

describe("Sidebar — palette", () => {
  function renderSidebar() {
    const onAddBlock = vi.fn();
    const onLoadTemplate = vi.fn(() => true);
    const onClear = vi.fn(() => true);
    const view = render(
      <Sidebar onAddBlock={onAddBlock} onLoadTemplate={onLoadTemplate} onClear={onClear} />,
    );
    return { ...view, onAddBlock, onLoadTemplate, onClear };
  }

  it("is built from the core block vocabulary — every type, and nothing core lacks", () => {
    renderSidebar();
    for (const name of ["Input", "Stake", "Supply", "Borrow", "Wrap", "Unwrap"]) {
      expect(screen.getByRole("button", { name })).not.toBeNull();
    }
    expect(screen.queryByRole("button", { name: "Swap" })).toBeNull();
  });

  it("adds at the canvas centre on Enter — the palette is not drag-only", () => {
    const { onAddBlock } = renderSidebar();
    fireEvent.keyDown(screen.getByRole("button", { name: "Stake" }), { key: "Enter" });
    expect(onAddBlock).toHaveBeenCalledTimes(1);
    expect(onAddBlock).toHaveBeenCalledWith("stake");
  });

  it("adds on Space as well, and announces the add in one polite region", () => {
    const { container, onAddBlock } = renderSidebar();
    fireEvent.keyDown(screen.getByRole("button", { name: "Borrow" }), { key: " " });
    expect(onAddBlock).toHaveBeenCalledWith("borrow");
    const regions = container.querySelectorAll('[role="status"]');
    expect(regions.length).toBe(1);
    expect(regions[0]?.textContent).toBe("Borrow block added to the canvas.");
  });

  it("announces a repeated add — an identical sentence is still a second event", () => {
    const { container, onAddBlock } = renderSidebar();
    const stake = screen.getByRole("button", { name: "Stake" });
    const region = container.querySelector('[role="status"]');
    if (region === null) throw new Error("the sidebar has no live region");

    fireEvent.keyDown(stake, { key: "Enter" });
    const first = region.firstElementChild;
    expect(first?.textContent).toBe("Stake block added to the canvas.");

    fireEvent.keyDown(stake, { key: "Enter" });
    const second = region.firstElementChild;
    expect(second?.textContent).toBe("Stake block added to the canvas.");
    // A screen reader reads an insertion, not a string: the same sentence has to arrive
    // in a NEW text node or the second add is silent.
    expect(second).not.toBe(first);
    expect(onAddBlock).toHaveBeenCalledTimes(2);
  });

  it("ignores keys that are not activation keys", () => {
    const { onAddBlock } = renderSidebar();
    fireEvent.keyDown(screen.getByRole("button", { name: "Stake" }), { key: "a" });
    expect(onAddBlock).not.toHaveBeenCalled();
  });

  it("carries the application/reactflow drop contract the canvas reads", () => {
    renderSidebar();
    const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
    fireEvent.dragStart(screen.getByRole("button", { name: "Supply" }), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("application/reactflow", "lend");
    expect(dataTransfer.effectAllowed).toBe("move");
  });

  it("keeps every block reachable in the collapsed icon strip", () => {
    const { onAddBlock } = renderSidebar();
    const toggle = screen.getByRole("button", { name: "Collapse block palette" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);

    const expand = screen.getByRole("button", { name: "Expand block palette" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("complementary", { name: "Blocks, templates and canvas actions" }).className).toContain("w-12");

    const strip: ReadonlyArray<readonly [string, string]> = [
      ["Input block", "input"],
      ["Stake block", "stake"],
      ["Supply block", "lend"],
      ["Borrow block", "borrow"],
      ["Wrap block", "wrap"],
      ["Unwrap block", "unwrap"],
    ];
    for (const [name, type] of strip) {
      fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
      expect(onAddBlock).toHaveBeenLastCalledWith(type);
    }
    expect(onAddBlock).toHaveBeenCalledTimes(strip.length);
  });

  it("announces the clear, and says so when there was nothing to clear", () => {
    const cleared = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Clear canvas" }));
    expect(cleared.onClear).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("Canvas cleared.");
    cleanup();

    const onClear = vi.fn(() => false);
    render(<Sidebar onAddBlock={vi.fn()} onLoadTemplate={() => true} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear canvas" }));
    expect(screen.getByRole("status").textContent).toBe(
      "Canvas is already empty — nothing to clear.",
    );
  });

  it("is a w-64 complementary landmark with h-9 rows", () => {
    renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "Blocks, templates and canvas actions" });
    expect(sidebar.className).toContain("w-64");
    expect(screen.getByRole("button", { name: "Input" }).className).toContain("h-9");
  });

  it("keeps every control in the button radius zone", () => {
    renderSidebar();
    for (const name of ["Input", "Collapse block palette", "Clear canvas"]) {
      const control = screen.getByRole("button", { name });
      expect(control.className).toContain("rounded-sm");
      expect(control.className).not.toContain("rounded-md");
    }
  });
});

describe("Sidebar — templates", () => {
  it("shows name and prose only: no APY, no risk badge, no digit at all", () => {
    const onLoadTemplate = vi.fn(() => true);
    render(
      <Sidebar onAddBlock={vi.fn()} onLoadTemplate={onLoadTemplate} onClear={() => true} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));

    const panel = screen.getByRole("tabpanel", { name: "Templates" });
    expect(within(panel).getByText("Leveraged Restake Loop")).not.toBeNull();
    expect(panel.textContent).not.toMatch(/\d/);
    expect(panel.textContent).not.toContain("%");
    expect(within(panel).getByRole("button", { name: /Leveraged Restake Loop/ }).className)
      .toContain("rounded-sm");
  });

  it("reports the store's verdict rather than assuming a load happened", () => {
    render(
      <Sidebar onAddBlock={vi.fn()} onLoadTemplate={() => false} onClear={() => true} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    fireEvent.click(screen.getByRole("button", { name: /Leveraged Restake Loop/ }));
    expect(screen.getByRole("status").textContent).toBe(
      "Leveraged Restake Loop could not be loaded.",
    );
  });

  it("moves selection with the arrow keys", () => {
    render(<Sidebar onAddBlock={vi.fn()} onLoadTemplate={() => true} onClear={() => true} />);
    const blocks = screen.getByRole("tab", { name: "Blocks" });
    expect(blocks.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(blocks, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Templates" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("wraps on ArrowLeft and jumps to the ends with Home and End", () => {
    render(<Sidebar onAddBlock={vi.fn()} onLoadTemplate={() => true} onClear={() => true} />);

    fireEvent.keyDown(screen.getByRole("tab", { name: "Blocks" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Templates" }).getAttribute("aria-selected")).toBe(
      "true",
    );

    fireEvent.keyDown(screen.getByRole("tab", { name: "Templates" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Blocks" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Blocks" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Templates" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});

/** A subscriber, so the provider's own store can be observed without a test handle. */
function BlockCount() {
  const count = useComposerStore((state) => state.doc.blocks.length);
  return <span data-testid="block-count">{count}</span>;
}

/** Deliberately outside any provider. */
function Orphan() {
  useComposerStoreApi();
  return null;
}

describe("ComposerShell — store wiring", () => {
  function renderShell() {
    const store = createComposerStore();
    const view = render(
      <ComposerStoreProvider store={store}>
        <ComposerShell
          canvas={<div data-testid="canvas-slot" />}
          simulation={null}
          simulationPending={false}
          resolveDropPosition={() => ({ x: 320, y: 180 })}
        />
      </ComposerStoreProvider>,
    );
    return { ...view, store };
  }

  it("composes the three columns", () => {
    renderShell();
    expect(screen.getByRole("complementary", { name: "Blocks, templates and canvas actions" })).not.toBeNull();
    expect(screen.getByTestId("canvas-slot")).not.toBeNull();
    expect(screen.getByRole("complementary", { name: "Simulation" })).not.toBeNull();
  });

  it("places a keyboard-added block at the position the canvas host resolves", () => {
    const { store } = renderShell();
    fireEvent.keyDown(screen.getByRole("button", { name: "Stake" }), { key: "Enter" });

    const block = store.getState().doc.blocks[0];
    if (block === undefined) throw new Error("no block was added");
    expect(block.type).toBe("stake");
    expect(store.getState().view[block.id]).toEqual({ x: 320, y: 180, isAutoInserted: false });
  });

  it("loads a template through the store's own validation gate", () => {
    const { store } = renderShell();
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    fireEvent.click(screen.getByRole("button", { name: /Leveraged Restake Loop/ }));

    const state = store.getState();
    expect(state.loadedFrom).toEqual({ kind: "template", templateId: FLAGSHIP_TEMPLATE_ID });
    expect(state.doc.blocks.length).toBeGreaterThan(0);
    expect(state.lastLoadProblem).toBeNull();
  });

  it("clears through the store, keeping the action undoable", () => {
    const { store } = renderShell();
    fireEvent.keyDown(screen.getByRole("button", { name: "Input" }), { key: "Enter" });
    expect(store.getState().doc.blocks.length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Clear canvas" }));
    expect(store.getState().doc.blocks.length).toBe(0);
    store.getState().undo();
    expect(store.getState().doc.blocks.length).toBe(1);
  });

  it("reports the store's refusal to clear an already-empty document", () => {
    const { store } = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Clear canvas" }));

    const sidebar = screen.getByRole("complementary", { name: "Blocks, templates and canvas actions" });
    expect(within(sidebar).getByRole("status").textContent).toBe(
      "Canvas is already empty — nothing to clear.",
    );
    // The refusal is the store's, and it left no undo entry to trip over.
    expect(store.getState().past.length).toBe(0);
  });

  it("mints its own store when the provider is handed none", () => {
    render(
      <ComposerStoreProvider>
        <BlockCount />
        <ComposerShell
          canvas={<div data-testid="canvas-slot" />}
          simulation={null}
          simulationPending={false}
          resolveDropPosition={() => ({ x: 0, y: 0 })}
        />
      </ComposerStoreProvider>,
    );
    expect(screen.getByTestId("block-count").textContent).toBe("0");

    fireEvent.keyDown(screen.getByRole("button", { name: "Stake" }), { key: "Enter" });
    expect(screen.getByTestId("block-count").textContent).toBe("1");
  });

  it("refuses to run outside the provider instead of inventing a store", () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => render(<Orphan />)).toThrow(/ComposerStoreProvider/);
    } finally {
      reported.mockRestore();
    }
  });
});
