/** @vitest-environment jsdom */
// No jest-dom matchers: the suite asserts on the DOM directly, as the primitives suite
// does. Every fixture below mints its provenance through `observationMinter` — a
// hand-written `{ kind: "observed" }` literal is banned by lint precisely so a test
// cannot forge the thing it is asserting about.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Sidebar } from "./sidebar";
import { RUN_LOCK_REASON } from "../tx/step-status";
import { SimulationPanel } from "./simulation-panel";
import { ComposerShell } from "./composer-shell";
import {
  ComposerStoreProvider,
  useComposerStore,
  useComposerStoreApi,
} from "../../app/store/composer-provider";
import { createComposerStore } from "../../app/store/composer-store";
import {
  WAD,
  formatBpsAsPercent,
  formatHealthFactor,
  formatWadAsPercent,
  formatWadRatio,
} from "../../core/format";
import { HF_WARN_WAD, hfWadValue, type HealthFactor } from "../../core/health-factor";
import { derived, entered, observationMinter, valueOf } from "../../core/provenance";
import { simulate } from "../../core/risk";
import { FLAGSHIP_TEMPLATE_ID } from "../../lib/strategy/templates";
import type { SimulationResult } from "../../lib/strategy/types";
import { PINNED_BLOCK } from "../../../tests/helpers/protocol-reads";
import { flagshipGraph } from "../../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../../tests/helpers/chain-snapshot";

afterEach(cleanup);

const minter = observationMinter(25_592_678n, 1_753_240_451);
const supplyRate = minter.observe(
  (WAD * 342n) / 10_000n,
  "AavePool.getReserveData(weETH).liquidityRate",
);

/** bps → WAD fraction: 485 bps == 4.85% == 0.0485e18. */
const wadPct = (bps: number): bigint => (WAD * BigInt(bps)) / 10_000n;

/** The health factor arrives wrapped, exactly as core/risk.ts mints it. */
const hf = (value: HealthFactor) =>
  derived(value, "wadDiv(Σ base·lt, totalDebtBase) / 1e4", [supplyRate]);

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
    minHealthFactor: hf({ status: "healthy", hfWad: (WAD * 185n) / 100n }),
    finalHealthFactor: hf({ status: "healthy", hfWad: (WAD * 192n) / 100n }),
    liquidationRatioWad: derived(
      (WAD * 8_235n) / 10_000n,
      "debtWei * 1e4 * WAD / (collWei * ltBps)",
      [supplyRate],
    ),
    liquidationPair: { collateral: "weETH", debt: "WETH" },
    leverageWad: derived((WAD * 333n) / 100n, "exposure / equity", [supplyRate]),
    yieldSources: [
      {
        protocol: "etherfi",
        type: "stake",
        rate: { kind: "apr" as const, wad: derived(wadPct(310), "trailing staking APR", [supplyRate]) },
        weightBps: 17_000,
      },
      {
        protocol: "aave-v3",
        type: "borrow",
        rate: { kind: "apy" as const, wad: derived(wadPct(265), "rayAprToApyWad(borrowApr)", [supplyRate]) },
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
        result={simulation({ minHealthFactor: hf({ status: "healthy", hfWad: (WAD * 120n) / 100n }) })}
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

  it("announces the risk transition, not every recomputed frame of the drag", () => {
    // Taste finding S-2b. The §3 step-3 drag recomputes the health factor per frame; keying
    // the region on the SENTENCE made each frame a new announcement. The keyed span is the
    // instrument: an unchanged key means React kept the same DOM node, which is exactly
    // "assistive technology was not interrupted".
    const atHf = (hundredths: bigint) =>
      simulation({ minHealthFactor: hf({ status: "healthy", hfWad: (WAD * hundredths) / 100n }) });
    const spanOf = (container: HTMLElement) =>
      container.querySelector('[role="status"]')?.firstElementChild ?? null;

    const { container, rerender } = render(<SimulationPanel result={atHf(185n)} pending={false} />);
    const first = spanOf(container);
    expect(first?.textContent).toContain("1.85");

    // Six recomputes, all safely above the 1.50 threshold — the drag before the crossing.
    for (const hundredths of [180n, 175n, 170n, 165n, 160n, 155n]) {
      rerender(<SimulationPanel result={atHf(hundredths)} pending={false} />);
    }
    expect(spanOf(container)).toBe(first);
    // The hero moved every frame even though the region did not — the number IS the drama.
    expect(screen.getByText("1.55")).not.toBeNull();

    // The crossing: exactly one new announcement, carrying the value at the moment it crossed.
    rerender(<SimulationPanel result={atHf(140n)} pending={false} />);
    const crossed = spanOf(container);
    expect(crossed).not.toBe(first);
    expect(crossed?.textContent).toContain("1.40");
    expect(crossed?.textContent).toContain("1.50");

    // And deeper into the warning band is not a new event.
    rerender(<SimulationPanel result={atHf(120n)} pending={false} />);
    expect(spanOf(container)).toBe(crossed);
  });

  it("re-announces when the health factor's status changes, not merely its value", () => {
    const spanOf = (container: HTMLElement) =>
      container.querySelector('[role="status"]')?.firstElementChild ?? null;
    const { container, rerender } = render(
      <SimulationPanel
        result={simulation({ minHealthFactor: hf({ status: "healthy", hfWad: (WAD * 185n) / 100n }) })}
        pending={false}
      />,
    );
    const healthy = spanOf(container);

    rerender(
      <SimulationPanel
        result={simulation({ minHealthFactor: hf({ status: "unknown", reason: "no price" }) })}
        pending={false}
      />,
    );
    const unknown = spanOf(container);
    expect(unknown).not.toBe(healthy);
    expect(unknown?.textContent).toContain("unavailable");
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
          minHealthFactor: hf({ status: "unknown", reason: "missing collateral or debt snapshot" }),
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
          minHealthFactor: hf({ status: "no-debt" }),
          finalHealthFactor: hf({ status: "no-debt" }),
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

  /**
   * Panel parity (SPEC §3 step 3), and the closure of taste finding S-1: the hero renders
   * the health factor `core/risk.ts` derived over the pinned reads log, and it renders it
   * through `SourcedValue`, so the number can be interrogated back to the oracle read that
   * produced it. Nothing here is a typed digit.
   */
  it("renders the block-pinned health factor core derived, and cites its source", () => {
    const result = simulate(flagshipGraph("10", 7000), fixtureSnapshot());
    const expected = formatHealthFactor(hfWadValue(valueOf(result.minHealthFactor)));
    const { container } = render(<SimulationPanel result={result} pending={false} />);

    const hero = screen.getByRole("button", { name: expected });
    expect(hero.className).toContain("text-2xl");
    expect(hero.className).toContain("font-semibold");
    expect(hero.className).toContain("text-warning");
    expect(container.querySelector(".status-dot-warning")).not.toBeNull();

    const announcement = container.querySelector('[role="status"]')?.textContent ?? "";
    expect(announcement).toBe(
      `Minimum health factor ${expected} — below the ${formatHealthFactor(HF_WARN_WAD)} warning threshold.`,
    );

    // The panel discloses in-flow rather than floating: click the figure, the evidence
    // expands underneath it inside the panel that scrolls.
    fireEvent.click(hero);
    const disclosure = screen.getByRole("group", { name: /Minimum health factor.*provenance/ });
    const trail = disclosure.textContent ?? "";
    expect(trail).toContain("Oracle.getAssetPrice(weETH)");
    expect(trail).toContain(`@ block ${PINNED_BLOCK}`);
  });

  it("renders the final health factor with its provenance too, not as stripped text", () => {
    const result = simulate(flagshipGraph("10", 7000), fixtureSnapshot());
    const finalText = formatHealthFactor(hfWadValue(valueOf(result.finalHealthFactor)));
    render(<SimulationPanel result={result} pending={false} />);

    const row = screen.getByRole("button", { name: finalText });
    expect(row.className).toContain("text-sm");
    expect(row.className).toContain("tabular-nums");
    // It is the row ramp, not the hero's — the final HF is context beside the gating figure.
    expect(row.className).not.toContain("text-2xl");

    fireEvent.click(row);
    const disclosure = screen.getByRole("group", { name: /Health factor after execution provenance/ });
    // The label is the section's ACCESSIBLE NAME (the query above proves it); the visible
    // header says "Provenance", so the row's own label is not repeated on screen.
    const trail = disclosure.textContent ?? "";
    expect(trail).toContain("Provenance");
    expect(trail).toContain("Oracle.getAssetPrice(weETH)");
    expect(trail).toContain(`@ block ${PINNED_BLOCK}`);
  });

  it("keeps the final health factor's non-numeric states as authored prose", () => {
    render(
      <SimulationPanel
        result={simulation({
          finalHealthFactor: hf({ status: "unknown", reason: "no snapshot" }),
        })}
        pending={false}
      />,
    );
    const prose = screen.getByText("unavailable");
    expect(prose.tagName).toBe("SPAN");
    expect(prose.className).toContain("text-muted-foreground");
    expect(screen.queryByRole("button", { name: "unavailable" })).toBeNull();
  });

  it("renders the complete §5.2 breakdown core composed, weights and all", () => {
    const result = simulate(flagshipGraph("10", 7000), fixtureSnapshot());
    const { container } = render(<SimulationPanel result={result} pending={false} />);

    // Complete or empty, never partial — so the prose branch must be gone.
    expect(screen.queryByText(/Breakdown unavailable/)).toBeNull();
    expect(result.yieldSources).toHaveLength(3);
    for (const source of result.yieldSources) {
      expect(
        screen.getAllByRole("button", { name: formatWadAsPercent(valueOf(source.rate.wad)) }).length,
      ).toBeGreaterThan(0);
      expect(screen.getAllByText(formatBpsAsPercent(source.weightBps, 2)).length).toBeGreaterThan(0);
    }
    // The hero and the position row carry the composed figures.
    expect(
      screen.getAllByRole("button", { name: formatWadAsPercent(valueOf(result.netApyWad!)) }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: formatWadAsPercent(valueOf(result.grossApyWad!)) }).length,
    ).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("NaN");
    expect(container.textContent).not.toContain("∞");
  });

  it("still refuses the whole breakdown when the trailing window is missing", () => {
    const noWindow = fixtureSnapshot((raw) => {
      raw.etherfi.rateWindow = null;
    });
    const result = simulate(flagshipGraph("10", 7000), noWindow);
    render(<SimulationPanel result={result} pending={false} />);
    expect(screen.getByText(/Breakdown unavailable/)).not.toBeNull();
    expect(screen.getByText("net APY unavailable — a rate did not resolve")).not.toBeNull();
    // Risk is unaffected: the health factor still renders from its own reads.
    expect(
      screen.getByRole("button", {
        name: formatHealthFactor(hfWadValue(valueOf(result.minHealthFactor))),
      }),
    ).not.toBeNull();
  });

  it("discloses the liquidation ratio in the panel flow, not in a capped tooltip", () => {
    // The last panel slot on the floating surface. Under the canvas depth-1 cap its supply
    // and debt derivations were unreachable — which is the whole reason the panel discloses.
    const result = simulate(flagshipGraph("10", 7000), fixtureSnapshot());
    render(<SimulationPanel result={result} pending={false} />);

    const ratio = screen.getByRole("button", {
      name: formatWadRatio(valueOf(result.liquidationRatioWad!)),
    });
    expect(ratio.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(ratio);

    const section = screen.getByRole("group", { name: "Liquidation ratio provenance" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    const trail = section.textContent ?? "";
    // The full depth is present: the ratio's own formula AND the amounts underneath it.
    expect(trail).toContain("debtWei × unitColl × 1e4 × WAD / (collateralWei × unitDebt × ltBps)");
    expect(trail).toContain("Oracle.getAssetPrice(weETH)");
    expect(trail).not.toContain("more derivation");
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
    // Every host in this file lands the add; the refusal arm is the run-lock beat below.
    const onAddBlock = vi.fn(() => true);
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
    render(<Sidebar onAddBlock={() => true} onLoadTemplate={() => true} onClear={onClear} />);
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
      <Sidebar onAddBlock={() => true} onLoadTemplate={onLoadTemplate} onClear={() => true} />,
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
      <Sidebar onAddBlock={() => true} onLoadTemplate={() => false} onClear={() => true} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    fireEvent.click(screen.getByRole("button", { name: /Leveraged Restake Loop/ }));
    expect(screen.getByRole("status").textContent).toBe(
      "Leveraged Restake Loop could not be loaded.",
    );
  });

  it("moves selection with the arrow keys", () => {
    render(<Sidebar onAddBlock={() => true} onLoadTemplate={() => true} onClear={() => true} />);
    const blocks = screen.getByRole("tab", { name: "Blocks" });
    expect(blocks.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(blocks, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Templates" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("wraps on ArrowLeft and jumps to the ends with Home and End", () => {
    render(<Sidebar onAddBlock={() => true} onLoadTemplate={() => true} onClear={() => true} />);

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

/**
 * T26's write lockdown at the SIDEBAR and the shell (Codex round-3 finding 2).
 *
 * The round-2 shape passed `lockReason` to the sidebar and only the palette rows honoured it:
 * the template rows and Clear canvas still dispatched. Two claims are asserted here, and they
 * are deliberately separate:
 *
 *  1. THE AFFORDANCE — every write control states the refusal (`aria-disabled` plus the
 *     sentence, never `disabled`, no veil and no dimming) and dispatches nothing.
 *  2. THE BACKSTOP — with the STORE locked and the sidebar told nothing at all, every one of
 *     those controls leaves the document exactly as it was. That is the finding's own test:
 *     a control that forgets the lock must be harmless, not merely rare.
 */
describe("T26 — the sidebar and shell under the run lock", () => {
  const TEMPLATE = /Leveraged Restake Loop/;

  function renderLockedSidebar() {
    // Every host in this file lands the add; the refusal arm is the run-lock beat below.
    const onAddBlock = vi.fn(() => true);
    const onLoadTemplate = vi.fn(() => true);
    const onClear = vi.fn(() => true);
    const view = render(
      <Sidebar
        onAddBlock={onAddBlock}
        onLoadTemplate={onLoadTemplate}
        onClear={onClear}
        lockReason={RUN_LOCK_REASON}
      />,
    );
    return { ...view, onAddBlock, onLoadTemplate, onClear };
  }

  /** The shell over a real store, with the lock held by the store and/or stated to the UI. */
  function renderLockedShell(options: { readonly tellTheUi: boolean }) {
    const store = createComposerStore();
    expect(store.getState().loadTemplate(FLAGSHIP_TEMPLATE_ID)).toBe(true);
    store.getState().setWriteLock(RUN_LOCK_REASON);
    const view = render(
      <ComposerStoreProvider store={store}>
        <ComposerShell
          canvas={<div data-testid="canvas-slot" />}
          simulation={null}
          simulationPending={false}
          resolveDropPosition={() => ({ x: 320, y: 180 })}
          {...(options.tellTheUi ? { lockReason: RUN_LOCK_REASON } : {})}
        />
      </ComposerStoreProvider>,
    );
    return { ...view, store };
  }

  it("states the refusal on every write control — palette, templates and Clear canvas", () => {
    renderLockedSidebar();
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    const controls = [
      screen.getByRole("button", { name: "Clear canvas" }),
      screen.getByRole("button", { name: TEMPLATE }),
    ];
    fireEvent.click(screen.getByRole("tab", { name: "Blocks" }));
    controls.push(screen.getByRole("button", { name: "Stake" }));

    for (const control of controls) {
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(control.getAttribute("title")).toBe(RUN_LOCK_REASON);
      // Never `disabled`: a disabled control cannot be focused, so it cannot say why (T25/T33).
      expect(control.hasAttribute("disabled")).toBe(false);
      // No veil, no dimming, no blur — a frozen document is not a hidden one (T26). (The
      // button base's `[&_svg]:pointer-events-none` is the icon rule, not a veil.)
      expect(control.className).not.toMatch(/opacity-\d|\bblur\b|grayscale/);
    }
  });

  it("dispatches nothing, and says the sentence out loud instead", () => {
    const { onAddBlock, onLoadTemplate, onClear } = renderLockedSidebar();
    const region = screen.getByRole("status");

    fireEvent.click(screen.getByRole("button", { name: "Clear canvas" }));
    expect(onClear).not.toHaveBeenCalled();
    expect(region.textContent).toBe(RUN_LOCK_REASON);

    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    fireEvent.click(screen.getByRole("button", { name: TEMPLATE }));
    expect(onLoadTemplate).not.toHaveBeenCalled();
    expect(region.textContent).toBe(RUN_LOCK_REASON);

    fireEvent.click(screen.getByRole("tab", { name: "Blocks" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Stake" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Borrow" }));
    expect(onAddBlock).not.toHaveBeenCalled();
    expect(region.textContent).toBe(RUN_LOCK_REASON);
  });

  it("deactivates the palette drag at the source rather than refusing the drop", () => {
    renderLockedSidebar();
    const row = screen.getByRole("button", { name: "Stake" });
    expect(row.getAttribute("draggable")).toBe("false");
    const transferred: string[] = [];
    fireEvent.dragStart(row, {
      dataTransfer: { setData: (_k: string, v: string) => transferred.push(v) },
    });
    expect(transferred).toEqual([]);
  });

  it("keeps every read live: tabs, collapse and the template prose still work", () => {
    renderLockedSidebar();
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    expect(screen.getByRole("tab", { name: "Templates" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: TEMPLATE }).textContent).not.toBe("");
    const collapse = screen.getByRole("button", { name: "Collapse block palette" });
    expect(collapse.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(collapse);
    expect(screen.getByRole("button", { name: "Expand block palette" })).not.toBeNull();
  });

  it("leaves the document untouched through the shell's own write routes", () => {
    const { store } = renderLockedShell({ tellTheUi: true });
    const before = store.getState();

    fireEvent.keyDown(screen.getByRole("button", { name: "Stake" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Clear canvas" }));
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    fireEvent.click(screen.getByRole("button", { name: /Restake and supply/ }));

    const after = store.getState();
    expect(after.doc).toBe(before.doc);
    expect(after.rev).toBe(before.rev);
    expect(after.view).toBe(before.view);
    expect(after.loadedFrom).toBe(before.loadedFrom);
  });

  it("survives a control that forgets the lock — the store is the backstop", () => {
    // The sidebar is told NOTHING: `lockReason` is absent, so every control dispatches, which
    // is exactly the round-2 failure mode. The document must still be untouched.
    const { store } = renderLockedShell({ tellTheUi: false });
    const before = store.getState();
    const sidebar = screen.getByRole("complementary", {
      name: "Blocks, templates and canvas actions",
    });
    expect(screen.getByRole("button", { name: "Stake" }).getAttribute("aria-disabled")).toBeNull();

    // Every announcement is honest about what HAPPENED, because each verdict is read off the
    // document rather than off the request — an add that was refused is not reported as an add.
    fireEvent.keyDown(screen.getByRole("button", { name: "Stake" }), { key: "Enter" });
    expect(within(sidebar).getByRole("status").textContent).toBe(
      "Stake block could not be added.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear canvas" }));
    expect(within(sidebar).getByRole("status").textContent).toBe(
      "Canvas is already empty — nothing to clear.",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    fireEvent.click(screen.getByRole("button", { name: /Restake and supply/ }));
    expect(within(sidebar).getByRole("status").textContent).toBe(
      "Restake and supply could not be loaded.",
    );

    const after = store.getState();
    expect(after.doc).toBe(before.doc);
    expect(after.rev).toBe(before.rev);
    expect(after.loadedFrom).toBe(before.loadedFrom);
  });

  it("lifts on release: the same controls land writes once the run settles", () => {
    const { store } = renderLockedShell({ tellTheUi: true });
    store.getState().setWriteLock(null);
    cleanup();

    const view = render(
      <ComposerStoreProvider store={store}>
        <ComposerShell
          canvas={<div data-testid="canvas-slot" />}
          simulation={null}
          simulationPending={false}
          resolveDropPosition={() => ({ x: 8, y: 9 })}
        />
      </ComposerStoreProvider>,
    );
    const blocks = store.getState().doc.blocks.length;
    fireEvent.keyDown(within(view.container).getByRole("button", { name: "Stake" }), {
      key: "Enter",
    });
    expect(store.getState().doc.blocks.length).toBe(blocks + 1);
    fireEvent.click(within(view.container).getByRole("button", { name: "Clear canvas" }));
    expect(store.getState().doc.blocks.length).toBe(0);
  });
});
