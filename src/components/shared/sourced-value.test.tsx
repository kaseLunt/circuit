/** @vitest-environment jsdom */
// The type-level half of this contract is checked by `npm run typecheck`, not here:
// `value` admits `Provenanced<T> | null` and nothing else, so `value={3.42}` does not
// compile. Asserting that at runtime would need a suppression comment, which is banned.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SourcedValue, slotClassName } from "./sourced-value";
import { derived, entered, observationMinter } from "../../core/provenance";
import { RAY, formatRayRateAsPct } from "../../core/format";

afterEach(cleanup);

const minter = observationMinter(25_592_678n, 1_753_240_451);
const liquidityRate = minter.observe(
  (RAY * 342n) / 10_000n,
  "AavePool.getReserveData(WETH).liquidityRate",
);
const formatRate = (value: bigint): string => formatRayRateAsPct(value);

describe("SourcedValue — three disjoint states", () => {
  it("pending renders a busy slot and no digits at all", () => {
    const { container } = render(
      <SourcedValue
        value={null}
        pending
        label="Supply APY"
        chars={7}
        format={formatRate}
      />,
    );
    const slot = container.querySelector('[aria-busy="true"]');
    expect(slot).not.toBeNull();
    expect(slot?.getAttribute("aria-label")).toBe("Supply APY: loading");
    expect(container.textContent).toBe("");
  });

  it("a settled null renders explicit prose, never a zero or a dash", () => {
    const { container } = render(
      <SourcedValue
        value={null}
        pending={false}
        label="Supply APY"
        chars={7}
        format={formatRate}
        unavailableReason="rate unavailable — Aave read failed"
      />,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByText("rate unavailable — Aave read failed")).not.toBeNull();
    expect(container.textContent).not.toContain("0.00");
    expect(container.textContent).not.toContain("—0");
  });

  it("defaults the unavailable prose rather than inventing a value", () => {
    render(
      <SourcedValue value={null} pending={false} label="Supply APY" chars={7} format={formatRate} />,
    );
    expect(screen.getByText("unavailable")).not.toBeNull();
  });

  it("resolved renders the formatted value with tabular figures", () => {
    render(
      <SourcedValue
        value={liquidityRate}
        pending={false}
        label="Supply APY"
        chars={7}
        format={formatRate}
      />,
    );
    const trigger = screen.getByRole("button", { name: "3.42%" });
    expect(trigger.className).toContain("tabular-nums");
    expect(trigger.className).toContain("transition-fast");
  });

  it("a value present on the first paint renders solid — first resolution never fades", () => {
    render(
      <SourcedValue
        value={liquidityRate}
        pending={false}
        label="Supply APY"
        chars={7}
        format={formatRate}
      />,
    );
    const trigger = screen.getByRole("button", { name: "3.42%" });
    expect(trigger.className).toContain("opacity-100");
    expect(trigger.className).not.toContain("opacity-0");
  });
});

describe("slotClassName — a refusal never wears a figure's weight", () => {
  const ramp = { resolved: "text-sm font-semibold text-foreground", size: "text-sm" };

  it("hands the ramp over where a figure renders, the size alone while pending, and nothing when settled empty", () => {
    expect(slotClassName(true, false, ramp)).toBe(ramp.resolved);
    expect(slotClassName(false, true, ramp)).toBe(ramp.size);
    expect(slotClassName(false, false, ramp)).toBeUndefined();
  });

  it("leaves the unavailable prose on the component's own ramp, not the caller's", () => {
    // The trap this guard exists for: the unavailable branch merges the caller's className
    // OVER `text-xs text-muted-foreground`, and tailwind-merge resolves it in the caller's
    // favour — so an unconditional ramp prints a refusal at the weight of a reading.
    render(
      <SourcedValue
        value={null}
        pending={false}
        label="Minimum health factor"
        chars={5}
        format={formatRate}
        unavailableReason="health factor unavailable"
        className={slotClassName(false, false, ramp)}
      />,
    );
    const prose = screen.getByText("health factor unavailable");
    expect(prose.className).toContain("text-xs");
    expect(prose.className).toContain("text-muted-foreground");
    expect(prose.className).not.toContain("font-semibold");
    expect(prose.className).not.toContain("text-sm");
  });
});

describe("SourcedValue — provenance tooltip", () => {
  it("exposes the observed trail on activation and wires aria-describedby", () => {
    render(
      <SourcedValue
        value={liquidityRate}
        pending={false}
        label="Supply APY"
        chars={7}
        format={formatRate}
      />,
    );
    const trigger = screen.getByRole("button", { name: "3.42%" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(trigger);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("AavePool.getReserveData(WETH).liquidityRate");
    expect(tooltip.textContent).toContain("@ block 25592678");
    expect(tooltip.textContent).toContain("2025-07-23 03:14:11 UTC");
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.getAttribute("id"));

    // Open-only: a second click must not latch the evidence shut under the pointer.
    fireEvent.click(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeNull();
  });

  it("reserves the pending slot's width so resolution does not move the layout", () => {
    render(
      <SourcedValue
        value={liquidityRate}
        pending={false}
        label="Supply APY"
        chars={7}
        format={formatRate}
      />,
    );
    const trigger = screen.getByRole("button", { name: "3.42%" });
    expect(trigger.style.minWidth).toBe("7ch");
  });

  it("drops the reservation inside prose, where there is no column to protect", () => {
    const { container, rerender } = render(
      <SourcedValue
        value={liquidityRate}
        pending={false}
        label="Supply APY"
        chars={7}
        format={formatRate}
        inline
      />,
    );
    // A reservation inside a sentence is a gap before the next word, not an alignment.
    expect(screen.getByRole("button", { name: "3.42%" }).style.minWidth).toBe("");

    // The skeleton still holds its box either way: a pending slot with no width would let
    // the sentence reflow at the moment the number lands.
    rerender(
      <SourcedValue
        value={null}
        pending
        label="Supply APY"
        chars={7}
        format={formatRate}
        inline
      />,
    );
    const slot = container.querySelector<HTMLElement>('[aria-busy="true"]');
    expect(slot?.style.width).toBe("7ch");
  });

  it("shows a derivation's formula and each of its inputs", () => {
    const netRate = derived(
      (RAY * 128n) / 10_000n,
      "supplyRate * leverage - borrowRate * debtShare",
      [liquidityRate, entered(2n)],
    );
    render(
      <SourcedValue
        value={netRate}
        pending={false}
        label="Net APY"
        chars={7}
        format={formatRate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "1.28%" }));
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("derived: supplyRate * leverage - borrowRate * debtShare");
    expect(tooltip.textContent).toContain("entered by user");
  });

  it("opens on keyboard focus and closes on Escape and on blur", () => {
    render(
      <SourcedValue
        value={liquidityRate}
        pending={false}
        label="Supply APY"
        chars={7}
        format={formatRate}
      />,
    );
    const trigger = screen.getByRole("button", { name: "3.42%" });

    // React maps onFocus/onBlur to the bubbling focusin/focusout events.
    fireEvent.focusIn(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeNull();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focusIn(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeNull();

    fireEvent.focusOut(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
