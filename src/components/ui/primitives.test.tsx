/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Button, buttonVariants } from "./button";
import { SourcedValue } from "../shared/sourced-value";
import { derived, observationMinter, provenanceTrail } from "../../core/provenance";
import { SkeletonValue } from "./skeleton";
import { AssetChip } from "../shared/asset-chip";
import { ErrorBoundary } from "../shared/error-boundary";
import { setLogSink } from "../../lib/log";

afterEach(cleanup);

const VARIANTS = ["default", "outline", "ghost", "primary", "destructive"] as const;

describe("Button", () => {
  it("defaults to type=button so a consumer never submits an enclosing form by accident", () => {
    render(<Button>Save draft</Button>);
    expect(screen.getByRole("button", { name: "Save draft" }).getAttribute("type")).toBe("button");
  });

  it("respects an explicit type", () => {
    render(<Button type="submit">Send</Button>);
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("type")).toBe("submit");
  });

  it("forces no type onto an asChild element — the child owns its own semantics", () => {
    render(
      <Button asChild>
        <a href="#composer">Open composer</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Open composer" });
    expect(link.getAttribute("type")).toBeNull();
    expect(link.className).toContain("bg-secondary");
  });

  it("defaults to the neutral variant — chroma is spent only on a commit", () => {
    expect(buttonVariants({})).toContain("bg-secondary");
    expect(buttonVariants({})).not.toContain("bg-primary");
  });

  it("steps the surface on hover and press for every variant", () => {
    expect(buttonVariants({ variant: "default" })).toContain("active:bg-card-elevated");
    expect(buttonVariants({ variant: "outline" })).toContain("hover:bg-card-hover");
    expect(buttonVariants({ variant: "ghost" })).toContain("hover:bg-secondary");
    expect(buttonVariants({ variant: "primary" })).toContain("hover:bg-primary/90");
    expect(buttonVariants({ variant: "destructive" })).toContain("active:bg-destructive/80");
  });

  it("carries no press-scale, no shadow, no ring utilities and no bg-accent", () => {
    for (const variant of VARIANTS) {
      const classes = buttonVariants({ variant });
      expect(classes).not.toMatch(/scale/);
      expect(classes).not.toMatch(/shadow-/);
      expect(classes).not.toMatch(/ring-2|ring-offset/);
      expect(classes).not.toMatch(/bg-accent/);
    }
  });

  it("uses the single focus-ring and transition utilities", () => {
    expect(buttonVariants({})).toContain("focus-ring");
    expect(buttonVariants({})).toContain("transition-fast");
  });

  it("keeps a disabled control legible and pointer-reachable", () => {
    const classes = buttonVariants({});
    expect(classes).toContain("disabled:cursor-not-allowed");
    expect(classes).not.toContain("disabled:opacity-50");
    expect(classes).not.toContain("disabled:pointer-events-none");
  });
});

describe("SkeletonValue", () => {
  it("announces busy, names what is loading, and holds a caller-sized box", () => {
    const { container } = render(<SkeletonValue label="Supply APY" chars={7} />);
    const slot = container.querySelector("span");
    expect(slot).not.toBeNull();
    expect(slot?.getAttribute("aria-busy")).toBe("true");
    expect(slot?.getAttribute("aria-label")).toBe("Supply APY: loading");
    expect(slot?.className).toContain("skeleton-value");
    expect(slot?.getAttribute("style")).toContain("width: 7ch");
  });

  it("carries no role=status — the owning container holds the one live region", () => {
    const { container } = render(<SkeletonValue label="Min health factor" chars={4} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("renders no text, so no placeholder digit can reach the screen", () => {
    const { container } = render(<SkeletonValue label="Net APY" chars={7} />);
    expect(container.textContent).toBe("");
  });
});

describe("AssetChip", () => {
  it("renders the full symbol, case preserved", () => {
    const { container } = render(<AssetChip symbol="weETH" />);
    expect(container.textContent).toBe("weETH");
  });

  it("regression: WETH and weETH render distinctly — two glyphs collided on both", () => {
    const { container } = render(
      <>
        <AssetChip symbol="WETH" />
        <AssetChip symbol="weETH" />
      </>,
    );
    expect(container.textContent).toBe("WETHweETH");
    expect(screen.getByText("WETH")).not.toBe(screen.getByText("weETH"));
  });

  it("regression: USDC and USDT render distinctly", () => {
    const { container } = render(
      <>
        <AssetChip symbol="USDC" />
        <AssetChip symbol="USDT" />
      </>,
    );
    expect(container.textContent).toBe("USDCUSDT");
  });

  it("announces a full name instead of the symbol when the caller supplies one", () => {
    render(<AssetChip symbol="weETH" name="Wrapped eETH" />);
    expect(screen.getByText("Wrapped eETH").className).toContain("sr-only");
    expect(screen.getByText("weETH").getAttribute("aria-hidden")).toBe("true");
  });

  it("stays monochrome and untabulated — the slot holds letters, not digits", () => {
    const { container } = render(<AssetChip symbol="WETH" />);
    const chip = container.firstElementChild;
    expect(chip?.className).toContain("text-muted-foreground");
    expect(chip?.className).not.toContain("tabular-nums");
    expect(chip?.className).not.toContain("bg-secondary");
  });
});

let shouldThrow = true;

function Boom() {
  if (shouldThrow) throw new Error("weETH exchange rate read reverted");
  return <span>rate 1.0412</span>;
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    shouldThrow = true;
    setLogSink(() => undefined);
  });

  afterEach(() => {
    setLogSink(null);
  });

  it("catches a throwing child and reports it verbatim", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const report = screen.getByRole("alert");
    expect(report.textContent).toContain("This panel failed to render");
    expect(screen.getByText("weETH exchange rate read reverted")).not.toBeNull();
  });

  it("does not rewrite the cause into a guess", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const report = screen.getByRole("alert");
    expect(report.textContent).not.toContain("Network connection failed");
    expect(report.textContent).not.toContain("An unexpected error occurred");
  });

  it("offers a single action labelled Retry, which re-renders the subtree", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const retry = screen.getByRole("button", { name: "Retry" });
    shouldThrow = false;
    fireEvent.click(retry);
    expect(screen.getByText("rate 1.0412")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("routes the caught error through the log module, never the raw console", () => {
    const levels: string[] = [];
    setLogSink((level) => {
      levels.push(level);
    });
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(levels).toContain("error");
  });

  it("renders a caller's fallback instead of the default report", () => {
    render(
      <ErrorBoundary fallback={<p>panel unavailable</p>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("panel unavailable")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("SourcedValue — the two provenance surfaces", () => {
  const minter = observationMinter(25_592_678n, 1_784_776_451);
  const price = minter.observe(192_386_686_200n, "Oracle.getAssetPrice(WETH)");
  const inner = derived(2n, "inner formula", [price], "the inner WHY");
  const deep = derived(3n, "outer formula", [inner]);
  const shallow = derived(3n, "outer formula", [price]);
  const fmt = (v: bigint): string => String(v);

  it("caps the canvas tooltip at one level and STATES what it is not showing", () => {
    render(
      <SourcedValue value={deep} pending={false} label="Deep" chars={4} format={fmt} />,
    );
    fireEvent.focus(screen.getByRole("button", { name: "3" }));
    const tip = screen.getByRole("tooltip");
    const text = tip.textContent ?? "";
    // Depth 0 and 1 are shown…
    expect(text).toContain("outer formula");
    expect(text).toContain("inner formula");
    // …and the remainder is a COUNT, never an ellipsis.
    expect(text).toContain("1 more derivation step");
    expect(text).not.toContain("Oracle.getAssetPrice(WETH)");
    expect(text).not.toContain("…");
    expect(text).not.toContain("...");
  });

  it("says nothing about a remainder when there is none — a fully proven slot is silent", () => {
    render(
      <SourcedValue value={shallow} pending={false} label="Shallow" chars={4} format={fmt} />,
    );
    fireEvent.focus(screen.getByRole("button", { name: "3" }));
    const text = screen.getByRole("tooltip").textContent ?? "";
    expect(text).toContain("Oracle.getAssetPrice(WETH)");
    expect(text).not.toContain("more derivation");
  });

  it("renders nesting as padding, not as leading spaces in the text", () => {
    render(
      <SourcedValue value={deep} pending={false} label="Deep" chars={4} format={fmt} />,
    );
    fireEvent.focus(screen.getByRole("button", { name: "3" }));
    const lines = screen.getByRole("tooltip").querySelectorAll<HTMLElement>("span[style]");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.style.paddingLeft).toMatch(/rem$/);
      expect(line.textContent ?? "").toBe((line.textContent ?? "").trimStart());
    }
  });

  it("shows a derivation's note apart from its formula", () => {
    render(
      <SourcedValue value={inner} pending={false} label="Inner" chars={4} format={fmt} />,
    );
    fireEvent.focus(screen.getByRole("button", { name: "2" }));
    const text = screen.getByRole("tooltip").textContent ?? "";
    expect(text).toContain("inner formula");
    expect(text).toContain("the inner WHY");
    // Not concatenated into the formula — a renderer can tell them apart.
    expect(text).not.toContain("inner formula — the inner WHY");
  });

  describe("disclosure surface", () => {
    function open() {
      render(
        <SourcedValue
          value={deep}
          pending={false}
          label="Net APY"
          chars={4}
          format={fmt}
          provenance="disclosure"
        />,
      );
      const trigger = screen.getByRole("button", { name: "3" });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(trigger);
      return { trigger, section: screen.getByRole("group", { name: "Net APY provenance" }) };
    }

    it("expands in the flow with the WHOLE tree — no cap, because nothing floats", () => {
      const { section } = open();
      const text = section.textContent ?? "";
      expect(text).toContain("outer formula");
      expect(text).toContain("inner formula");
      // The depth the tooltip had to cap is fully present here.
      expect(text).toContain("Oracle.getAssetPrice(WETH)");
      expect(text).not.toContain("more derivation");
      // In-flow, not floating: no tooltip role, and nothing positioned absolutely.
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("moves focus into the section and returns it to the trigger on Escape", () => {
      const { trigger, section } = open();
      expect(document.activeElement).toBe(section);
      fireEvent.keyDown(section, { key: "Escape" });
      expect(screen.queryByRole("group", { name: "Net APY provenance" })).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });

    it("heads the section with the subject being proven, and keeps it in view", () => {
      const { section } = open();
      const header = section.firstElementChild as HTMLElement;
      // At any scroll depth the reader can still name what is being proven, and leave.
      expect(header.className).toContain("sticky");
      expect(header.className).toContain("top-0");
      expect(header.className).toContain("bg-card");
      expect(header.textContent).toContain("Provenance · Net APY");
      // The VALUE, so the header identifies the figure and not just the slot.
      expect(header.textContent).toContain("3");
      expect(within(header).getByRole("button", { name: "Close" })).not.toBeNull();
    });

    it("renders each qualification as its own line, and drops an inherited echo", () => {
      const shared = "the shared WHY";
      const child = derived(1n, "child formula", [price], shared);
      const parent = derived(2n, "parent formula", [child], shared);
      render(
        <SourcedValue
          value={parent}
          pending={false}
          label="Composed"
          chars={4}
          format={fmt}
          provenance="disclosure"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "2" }));
      const section = screen.getByRole("group", { name: "Composed provenance" });
      // The fact originates on the child; the parent's echo adds nothing on screen.
      expect(screen.getAllByText(shared)).toHaveLength(1);
      // …and the data still carries it on both, which is the propagation invariant.
      expect(provenanceTrail(parent)[0]?.notes).toEqual([shared]);
      expect(section.textContent).toContain("parent formula");
    });

    it("is dismissible by pointer, and the trigger reports its state", () => {
      const { trigger } = open();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("group", { name: "Net APY provenance" })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });
});
