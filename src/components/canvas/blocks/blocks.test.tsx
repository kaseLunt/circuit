/** @vitest-environment jsdom */
// Renders inside <ReactFlowProvider> because <Handle> subscribes to React Flow's store
// and its handle-config context; the provider supplies both. No node-id context is
// available outside a real flow, which React Flow reports through `onError` — a no-op
// outside a development build, so nothing is written to the console here.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ReactNode } from "react";
import { WAD, formatBpsAsPercent, formatHealthFactor } from "../../../core/format";
import {
  HF_WARN_WAD,
  assetUnitOf,
  collateralBaseValue,
  computeHealthFactor,
  debtBaseValue,
  hfWadValue,
  type HealthFactor,
} from "../../../core/health-factor";
import { buildPlan, effectiveLiquidationThresholdBps } from "../../../core/plan";
import { borrowLimitVerdict } from "../../../core/borrow-limit";
import { simulate } from "../../../core/risk";
import {
  derived,
  entered,
  observationMinter,
  valueOf,
  type Derived,
  type Provenanced,
} from "../../../core/provenance";
import { PINNED_BLOCK } from "../../../../tests/helpers/protocol-reads";
import { carryGraph, flagshipGraph } from "../../../../tests/helpers/graphs";
import { fixtureSnapshot } from "../../../../tests/helpers/chain-snapshot";
import type {
  AutoWrapBlockData,
  BlockData,
  BorrowBlockData,
  ComputedBlockValue,
  InputBlockData,
  LendBlockData,
  StakeBlockData,
} from "../../../lib/strategy/types";
import { AutoWrapBlock } from "./auto-wrap-block";
import { BlockRuntimeProvider, type BlockRuntime, type RenderableBlockType } from "./base-block";
import { BorrowBlock } from "./borrow-block";
import { InputBlock } from "./input-block";
import { LendBlock } from "./lend-block";
import { BLOCK_COMPONENTS } from "./index";
import type { NodePropsFor } from "./node-props";
import { StakeBlock } from "./stake-block";

afterEach(cleanup);

const minter = observationMinter(25_592_678n, 1_753_240_451);
const collateralBase = minter.observe(3_500_00000000n, "AaveOracle.getAssetPrice(weETH)");
const debtBase = minter.observe(1_200_00000000n, "AavePool.getUserAccountData().totalDebtBase");

function healthFactor(hfWad: bigint): Provenanced<HealthFactor> {
  return derived<HealthFactor>({ status: "healthy", hfWad }, "wadDiv(Σ base·lt, debt) / 1e4", [
    collateralBase,
    debtBase,
  ]);
}

function wrapped(hf: HealthFactor): Provenanced<HealthFactor> {
  return derived(hf, "wadDiv(Σ base·lt, debt) / 1e4", [collateralBase, debtBase]);
}

const RESOLVED_VALUE: ComputedBlockValue = {
  inputAsset: "ETH",
  inputAmountWei: entered(10n * WAD),
  inputValueBase: minter.observe(35_000_00000000n, "derived from AaveOracle.getAssetPrice(WETH)"),
  outputAsset: "eETH",
  outputAmountWei: minter.observe((9_997n * WAD) / 1000n, "LiquidityPool.deposit share delta"),
  outputValueBase: minter.observe(34_990_00000000n, "derived from AaveOracle.getAssetPrice(weETH)"),
  gasCostBase: minter.observe(3_45000000n, "derived from eth_feeHistory"),
  // 3.42% expressed as a WAD.
  rate: {
    kind: "apy",
    wad: minter.observe((WAD * 342n) / 10_000n, "AavePool.getReserveData(WETH).liquidityRate"),
  },
};

function runtime(overrides: Partial<BlockRuntime> = {}): BlockRuntime {
  return {
    autoInsertedIds: new Set<string>(),
    overAllocatedIds: new Set<string>(),
    outgoingAllocationBps: {},
    inputAmounts: {},
    borrowAllocations: {},
    executingBlockId: null,
    blockValues: {},
    minHealthFactor: null,
    liquidationRatioWad: null,
    liquidationPair: null,
    borrowLimit: null,
    writeLockReason: null,
    pending: false,
    pendingEdit: null,
    docRev: 1,
    setBlockParam: () => ({ ok: true }),
    setBorrowAllocationBps: () => ({ ok: true }),
    beginEdit: () => undefined,
    endEdit: () => undefined,
    ...overrides,
  };
}

/** The sum a source routes out, wrapped exactly as the store's reader wraps it. */
function outgoing(bps: number): Derived<number> {
  return derived(bps, "sum of outgoing edge allocationBps out of stake1", [entered(bps)]);
}

function nodeProps<T extends BlockData>(
  id: string,
  type: RenderableBlockType,
  data: T,
  selected = false,
): NodePropsFor<T> {
  return {
    id,
    type,
    data,
    selected,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
    zIndex: 0,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
}

function tree(ui: ReactNode, rt: BlockRuntime) {
  return (
    <ReactFlowProvider>
      <BlockRuntimeProvider value={rt}>{ui}</BlockRuntimeProvider>
    </ReactFlowProvider>
  );
}

function mount(ui: ReactNode, rt: BlockRuntime = runtime()) {
  return render(tree(ui, rt));
}

const inputData: InputBlockData = {
  type: "input",
  label: "Input Capital",
  isConfigured: true,
  isValid: true,
  asset: "ETH",
  amount: "10",
};

const stakeData: StakeBlockData = {
  type: "stake",
  label: "Stake",
  isConfigured: true,
  isValid: true,
  protocol: "etherfi",
  inputAsset: "ETH",
  outputAsset: "eETH",
};

const lendData: LendBlockData = {
  type: "lend",
  label: "Supply",
  isConfigured: true,
  isValid: true,
  protocol: "aave-v3",
  asset: "weETH",
};

const borrowData: BorrowBlockData = {
  type: "borrow",
  label: "Borrow",
  isConfigured: true,
  isValid: true,
  protocol: "aave-v3",
  asset: "WETH",
  allocationBps: 5_000,
};

const wrapData: AutoWrapBlockData = {
  type: "auto-wrap",
  label: "Wrap",
  isConfigured: true,
  isValid: true,
  fromAsset: "eETH",
  toAsset: "weETH",
  isWrap: true,
};

function frameOf(container: HTMLElement): HTMLElement {
  const frame = container.querySelector<HTMLElement>("[data-block-type]");
  if (frame === null) throw new Error("no block frame rendered");
  return frame;
}

/** The value zones only — the rows SourcedValue owns. The designed-state rules about
 *  dashes and zeros are rules about VALUES, not about the prose around them. */
function valueZoneTextOf(container: HTMLElement): string {
  return [...container.querySelectorAll<HTMLElement>(".space-y-1.border-t")]
    .map((zone) => zone.textContent ?? "")
    .join(" ");
}

/**
 * A rendered zero standing in for a missing value: a bare "0", "0.0000" or "$0.00". The
 * digit must not be part of a longer number, so "10" and "1.05" are not matches.
 */
const COERCED_ZERO = /(^|\s)\$?0(\.0+)?(\s|$)/;

/** A dash used AS a value, which is what "never a dash" forbids. */
const DASH_AS_VALUE = /(^|\s)[—–-](\s|$)/;

describe("BaseBlock — frame anatomy", () => {
  it("gives every block one width, one surface and one radius", () => {
    const { container } = everyBlock(runtime());
    const frames = container.querySelectorAll<HTMLElement>("[data-block-type]");
    expect(frames.length).toBe(5);
    for (const frame of frames) {
      expect(frame.className).toContain("w-60");
      expect(frame.className).toContain("bg-card");
      expect(frame.className).toContain("rounded-lg");
      expect(frame.className).toContain("border");
    }
  });

  it("carries a 36px header band on the secondary surface", () => {
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />);
    const header = frameOf(container).querySelector<HTMLElement>(".bg-secondary");
    expect(header).not.toBeNull();
    expect(header?.className).toContain("h-9");
    expect(header?.className).toContain("border-b");
  });

  it("names the block by kind and title, and exposes kind as data only", () => {
    const { container } = mount(<LendBlock {...nodeProps("supply1", "lend", lendData)} />);
    const frame = frameOf(container);
    expect(frame.getAttribute("data-block-type")).toBe("lend");
    expect(frame.getAttribute("aria-label")).toBe("lend block, Supply");
  });

  it("holds exactly one live region per block — never one per pending slot", () => {
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, {
      ...runtime({ pending: true }),
    });
    expect(container.querySelectorAll("[aria-live]").length).toBe(1);
    expect(container.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(1);
  });

  it("says nothing about loading — pending is a slot fact, not a block-identity fact", () => {
    // Taste finding S-2a. `runtime.pending` is ONE flag shared by the whole canvas, so
    // announcing it per block turned a single simulation cycle into six simultaneous
    // announcements. The unresolved slots already carry aria-busy, which is where a
    // screen reader should learn this and the only place that names the actual slot.
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, {
      ...runtime({ pending: true }),
    });
    const region = container.querySelector("[aria-live]");
    expect(region?.textContent).toBe("");
    expect(container.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
  });

  it("still announces this block's own facts while its values are pending", () => {
    // Dropping the loading line must not silence the region: over-allocation and warnings
    // are per-block facts that need block identity and change rarely.
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, {
      ...runtime({
        pending: true,
        overAllocatedIds: new Set(["stake1"]),
        outgoingAllocationBps: { stake1: outgoing(11_500) },
      }),
    });
    const region = container.querySelector("[aria-live]");
    expect(region?.textContent).toContain("115%");
    expect(region?.textContent).not.toContain("loading");
  });
});

describe("BaseBlock — states are token assignments", () => {
  it("valid is zero chroma", () => {
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />);
    const frame = frameOf(container);
    expect(frame.getAttribute("data-block-state")).toBe("valid");
    expect(frame.className).toContain("border-border");
  });

  it("warning takes the warning border and a warning status dot", () => {
    const { container } = mount(
      <LendBlock {...nodeProps("supply1", "lend", { ...lendData, asset: null })} />,
    );
    const frame = frameOf(container);
    expect(frame.getAttribute("data-block-state")).toBe("warning");
    expect(frame.className).toContain("border-warning");
    expect(frame.querySelector(".status-dot-warning")).not.toBeNull();
  });

  it("error beats warning, takes the destructive border, and is described, not just coloured", () => {
    const { container } = mount(
      <InputBlock
        {...nodeProps("in1", "input", {
          ...inputData,
          amount: "",
          isValid: false,
          errorMessage: "input needs a positive amount",
        })}
      />,
    );
    const frame = frameOf(container);
    expect(frame.getAttribute("data-block-state")).toBe("error");
    expect(frame.className).toContain("border-destructive");
    expect(frame.className).not.toContain("border-warning");

    const describedBy = frame.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    // Attribute selector, not `#${CSS.escape(id)}`: jsdom installs no `CSS` global, so the
    // escape call throws a ReferenceError that lib.dom.d.ts happily typechecks.
    const described =
      describedBy === null ? null : container.querySelector(`[id="${describedBy}"]`);
    expect(described?.textContent).toContain("input needs a positive amount");
    // A lucide glyph, never the ⚠ emoji the prototype shipped.
    expect(described?.querySelector("svg")).not.toBeNull();
    expect(container.textContent).not.toContain("⚠");
  });

  it("never renders an error as colour alone, even with no reason to give", () => {
    const { container } = mount(
      <StakeBlock {...nodeProps("stake1", "stake", { ...stakeData, isValid: false })} />,
    );
    const frame = frameOf(container);
    expect(frame.getAttribute("data-block-state")).toBe("error");
    const describedBy = frame.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    const described =
      describedBy === null ? null : container.querySelector(`[id="${describedBy}"]`);
    expect(described?.textContent).toContain("can't run as configured");
    expect(described?.querySelector("svg")).not.toBeNull();
  });

  it("executing is the only state that spends --primary, and only on the border", () => {
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, {
      ...runtime({ executingBlockId: "stake1" }),
    });
    const frame = frameOf(container);
    expect(frame.getAttribute("data-block-state")).toBe("executing");
    expect(frame.className).toContain("border-primary");
    expect(container.innerHTML).not.toMatch(/(bg|text)-primary/);
  });

  it("does not let execution demote a live warning", () => {
    const { container } = mount(
      <LendBlock {...nodeProps("supply1", "lend", { ...lendData, asset: null })} />,
      { ...runtime({ executingBlockId: "supply1" }) },
    );
    const frame = frameOf(container);
    expect(frame.getAttribute("data-block-state")).toBe("warning");
    expect(frame.className).toContain("border-warning");
    expect(frame.className).not.toContain("border-primary");
  });

  it("selection is one ring for every type, in the landed focus-ring grammar", () => {
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData, true)} />,
    );
    const frame = frameOf(container);
    // One mechanism: the two-layer box-shadow declared in canvas.css. A second outline
    // utility on the same element would be a second authority for the same 2px.
    expect(frame.className).toContain("block-selected");
    expect(frame.className).not.toMatch(/ring-2|ring-offset|outline-2/);
  });
});

describe("BaseBlock — auto-insertion is view state, not document state", () => {
  it("badges and dashes a block the optimizer inserted", () => {
    const { container } = mount(<AutoWrapBlock {...nodeProps("wrap1", "auto-wrap", wrapData)} />, {
      ...runtime({ autoInsertedIds: new Set(["wrap1"]) }),
    });
    expect(screen.getByText("AUTO")).not.toBeNull();
    expect(frameOf(container).className).toContain("border-dashed");
    expect(container.textContent).toContain("Inserted for protocol compatibility.");
  });

  it("leaves a share-arrived wrap unbadged even when its data claims otherwise", () => {
    const { container } = mount(
      <AutoWrapBlock {...nodeProps("wrap1", "auto-wrap", { ...wrapData, isAutoInserted: true })} />,
    );
    expect(screen.queryByText("AUTO")).toBeNull();
    expect(frameOf(container).className).not.toContain("border-dashed");
  });

  it("draws no pair for a wrap the document has not configured", () => {
    const { container } = mount(
      <AutoWrapBlock {...nodeProps("wrap1", "auto-wrap", { ...wrapData, isConfigured: false })} />,
    );
    expect(frameOf(container).getAttribute("data-block-state")).toBe("warning");
    expect(container.textContent).toContain("Connect a producer");
    expect(container.textContent).not.toContain("weETH");
  });
});

describe("BaseBlock — over-allocation is blamed on the source", () => {
  it("escalates a valid source to warning and prints the total it routes, provenanced", () => {
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, {
      ...runtime({
        overAllocatedIds: new Set(["stake1"]),
        outgoingAllocationBps: { stake1: outgoing(11_500) },
      }),
    });
    const frame = frameOf(container);
    expect(frame.getAttribute("data-block-state")).toBe("warning");
    expect(frame.className).toContain("border-warning");
    expect(container.textContent).toContain("115% allocated");
  });

  it("renders the total through the one money renderer, never below text-xs", () => {
    mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, {
      ...runtime({
        overAllocatedIds: new Set(["stake1"]),
        outgoingAllocationBps: { stake1: outgoing(11_500) },
      }),
    });
    const badge = screen.getByText("115%");
    // SourcedValue's trigger: a real button carrying the provenance tooltip.
    expect(badge.tagName).toBe("BUTTON");
    expect(badge.className).toContain("text-xs");
    expect(badge.className).not.toContain("text-micro");
  });

  it("says nothing about allocation on a source the store did not call over-allocated", () => {
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, {
      ...runtime({ outgoingAllocationBps: { stake1: outgoing(9_000) } }),
    });
    expect(frameOf(container).getAttribute("data-block-state")).toBe("valid");
    expect(container.textContent).not.toContain("allocated");
  });
});

describe("BlockValueBadge — direction is a glyph, never a colour pair", () => {
  it("marks both directions with an arrow and a text label", () => {
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, {
      ...runtime({ blockValues: { stake1: RESOLVED_VALUE } }),
    });
    const zone = frameOf(container).querySelector<HTMLElement>(".border-t.px-3");
    expect(zone).not.toBeNull();
    expect(zone?.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("In")).not.toBeNull();
    expect(screen.getByText("Out")).not.toBeNull();
  });

  it("gives every quantity a row of its own inside the 240px frame", () => {
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, {
      ...runtime({ blockValues: { stake1: RESOLVED_VALUE } }),
    });
    const zone = frameOf(container).querySelector<HTMLElement>(".space-y-1.border-t");
    expect(zone).not.toBeNull();

    // In amount · in value · out amount · out value · gas. The base-currency figure is a
    // restatement of the token amount and does not hold equal width beside it: two 11ch
    // reservations plus an arrow and an asset chip over-ran the frame's 216px of content,
    // and nothing in a flex row shrinks once SourcedValue pins its width.
    const rows = [...(zone?.children ?? [])];
    expect(rows.length).toBe(5);
    for (const row of rows) {
      expect(row.querySelectorAll('[style*="min-width"]').length).toBe(1);
    }
  });

  it("spends no chroma on direction — success is reserved for confirmed execution", () => {
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, {
      ...runtime({ blockValues: { stake1: RESOLVED_VALUE } }),
    });
    expect(container.innerHTML).not.toMatch(
      /text-success|text-destructive|text-(blue|green|amber)-/,
    );
  });

  it("renders every digit through core/format.ts", () => {
    mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, {
      ...runtime({ blockValues: { stake1: RESOLVED_VALUE } }),
    });
    expect(screen.getByText("10.0000")).not.toBeNull();
    expect(screen.getByText("$35,000.00")).not.toBeNull();
    expect(screen.getByText("3.42%")).not.toBeNull();
  });
});

describe("BlockValueBadge — the value flash is a claim about the value", () => {
  function withOutput(amountWei: bigint): ComputedBlockValue {
    return {
      ...RESOLVED_VALUE,
      outputAmountWei: minter.observe(amountWei, "LiquidityPool.deposit share delta"),
    };
  }

  it("never fires on a first arrival", () => {
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, {
      ...runtime({ blockValues: { stake1: withOutput(10n * WAD) } }),
    });
    expect(container.innerHTML).not.toContain("value-up");
    expect(container.innerHTML).not.toContain("value-down");
  });

  it("fires on a discrete external change of a value already on screen", () => {
    const node = <StakeBlock {...nodeProps("stake1", "stake", stakeData)} />;
    const view = mount(node, runtime({ blockValues: { stake1: withOutput(10n * WAD) } }));
    expect(view.container.innerHTML).not.toContain("value-up");

    view.rerender(tree(node, runtime({ blockValues: { stake1: withOutput(11n * WAD) } })));
    expect(view.container.innerHTML).toContain("value-up");

    view.rerender(tree(node, runtime({ blockValues: { stake1: withOutput(9n * WAD) } })));
    expect(view.container.innerHTML).toContain("value-down");
  });

  it("stays silent while an edit gesture is open — a dragged number did not move itself", () => {
    const node = <StakeBlock {...nodeProps("stake1", "stake", stakeData)} />;
    const view = mount(node, runtime({ blockValues: { stake1: withOutput(10n * WAD) } }));

    view.rerender(
      tree(
        node,
        runtime({ blockValues: { stake1: withOutput(11n * WAD) }, pendingEdit: "move block" }),
      ),
    );
    expect(view.container.innerHTML).not.toContain("value-up");
    expect(view.container.innerHTML).not.toContain("value-down");
  });
});

describe("InputBlock — the raw string, never a coerced zero", () => {
  it("keeps what the user typed and reports the store's refusal", () => {
    const rt = runtime({
      setBlockParam: () => ({
        ok: false,
        reason: "value for 'amount' is not an accepted input parameter value",
      }),
    });
    const { container } = mount(<InputBlock {...nodeProps("in1", "input", inputData)} />, rt);
    const field = screen.getByLabelText("Amount");
    fireEvent.change(field, { target: { value: "10e" } });

    expect((field as HTMLInputElement).value).toBe("10e");
    expect(container.textContent ?? "").not.toMatch(COERCED_ZERO);
    expect(frameOf(container).getAttribute("data-block-state")).toBe("error");
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });

  it("says what the document still holds whenever the field disagrees with it", () => {
    const rt = runtime({
      inputAmounts: { in1: entered("10") },
      setBlockParam: () => ({ ok: false, reason: "refused" }),
    });
    const { container } = mount(<InputBlock {...nodeProps("in1", "input", inputData)} />, rt);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10e" } });
    expect(container.textContent).toContain("The strategy still starts with");
    expect(screen.getByText("10")).not.toBeNull();
  });

  it("treats an empty field as unconfigured, not as zero", () => {
    const { container } = mount(
      <InputBlock {...nodeProps("in1", "input", { ...inputData, amount: "" })} />,
    );
    expect(frameOf(container).getAttribute("data-block-state")).toBe("warning");
    expect(container.textContent).toContain("Enter the amount of ETH");
  });

  it("returns a CLEARED field to unconfigured rather than reporting a parser error", () => {
    // The store refuses "" — DECIMAL_AMOUNT admits no empty string — and it is right to.
    // An emptied field is still not an error: it is the unconfigured state, arrived at.
    const rt = runtime({
      setBlockParam: () => ({
        ok: false,
        reason: "value for 'amount' is not an accepted input parameter value",
      }),
    });
    const { container } = mount(<InputBlock {...nodeProps("in1", "input", inputData)} />, rt);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "" } });

    expect(frameOf(container).getAttribute("data-block-state")).toBe("warning");
    expect(container.textContent).toContain("Enter the amount of ETH");
    expect(container.textContent).not.toContain("not an accepted");
  });

  it("does not flash the error frame at an unfinished decimal", () => {
    const rt = runtime({
      setBlockParam: (_id, _key, value) =>
        typeof value === "string" && /^\d+(\.\d+)?$/.test(value)
          ? { ok: true }
          : { ok: false, reason: "value for 'amount' is not an accepted input parameter value" },
    });
    const { container } = mount(<InputBlock {...nodeProps("in1", "input", inputData)} />, rt);
    const field = screen.getByLabelText("Amount");

    fireEvent.change(field, { target: { value: "1." } });
    expect(frameOf(container).getAttribute("data-block-state")).not.toBe("error");
    expect(container.textContent).not.toContain("not an accepted");

    fireEvent.change(field, { target: { value: "1.5" } });
    expect(frameOf(container).getAttribute("data-block-state")).toBe("valid");
  });

  it("retires a refusal when the document moves underneath it", () => {
    const node = <InputBlock {...nodeProps("in1", "input", inputData)} />;
    const refusing = runtime({
      docRev: 4,
      setBlockParam: () => ({ ok: false, reason: "refused by the store" }),
    });
    const view = mount(node, refusing);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10e" } });
    expect(view.container.textContent).toContain("refused by the store");

    // An undo restores the SAME amount: the value did not change, but the document did,
    // and a refusal about a superseded edit must not outlive it.
    view.rerender(tree(node, runtime({ docRev: 5 })));
    expect(view.container.textContent).not.toContain("refused by the store");
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("10");
  });

  it("offers no asset selector — core admits exactly one input asset", () => {
    const { container } = mount(<InputBlock {...nodeProps("in1", "input", inputData)} />);
    expect(container.querySelector("select")).toBeNull();
  });
});

describe("StakeBlock — a refused write is reported, never swallowed", () => {
  it("surfaces the store's reason when the protocol write is refused", () => {
    const rt = runtime({
      setBlockParam: () => ({ ok: false, reason: "'protocol' is not a parameter of a stake block" }),
    });
    const { container } = mount(<StakeBlock {...nodeProps("stake1", "stake", stakeData)} />, rt);
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "lido" } });

    expect(frameOf(container).getAttribute("data-block-state")).toBe("error");
    expect(container.textContent).toContain("is not a parameter of a stake block");
  });

  it("opens on an explicit unset option when the document holds no protocol", () => {
    const { container } = mount(
      <StakeBlock {...nodeProps("stake1", "stake", { ...stakeData, isConfigured: false })} />,
    );
    const select = screen.getByLabelText("Protocol") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(container.textContent).toContain("Choose a protocol");
    expect(frameOf(container).getAttribute("data-block-state")).toBe("warning");
  });
});

describe("LendBlock — reserve risk parameters are reads, not constants", () => {
  it("prints no LTV and no liquidation threshold", () => {
    const { container } = mount(<LendBlock {...nodeProps("supply1", "lend", lendData)} />, {
      ...runtime({ blockValues: { supply1: RESOLVED_VALUE } }),
    });
    expect(container.textContent).not.toContain("LTV");
    expect(container.textContent).not.toContain("82.5");
    expect(container.textContent).not.toContain("Liq. Threshold");
  });

  it("labels the Aave rate current-rate run-rate, verbatim", () => {
    const { container } = mount(<LendBlock {...nodeProps("supply1", "lend", lendData)} />, {
      ...runtime({ blockValues: { supply1: RESOLVED_VALUE } }),
    });
    expect(container.textContent).toContain("current-rate run-rate");
  });

  it("says unconnected rather than assuming ETH", () => {
    const { container } = mount(
      <LendBlock {...nodeProps("supply1", "lend", { ...lendData, asset: null })} />,
    );
    expect(container.textContent).toContain("Connect a producer");
    expect(container.textContent).not.toContain("ETH");
  });
});

describe("BorrowBlock — risk thresholds come from core/health-factor.ts", () => {
  const liquidationRatio = minter.observe(
    (WAD * 9123n) / 10_000n,
    "derived from AaveOracle.getAssetPrice(weETH)/getAssetPrice(WETH)",
  );

  function borrowRuntime(overrides: Partial<BlockRuntime> = {}): BlockRuntime {
    return runtime({
      borrowAllocations: { borrow1: entered(5_000) },
      // The pair the sentence names now comes from the SIMULATION, beside the ratio it
      // describes — not from the borrow block's own (structurally absent) input asset. The
      // fixture supplies the flagship's pair because that is what its ratio is a ratio of.
      liquidationPair: { collateral: "weETH", debt: "WETH" },
      ...overrides,
    });
  }

  it("leads with the liquidation sentence, not with digits", () => {
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({
        blockValues: { borrow1: { ...RESOLVED_VALUE, inputAsset: "weETH" } },
        liquidationRatioWad: liquidationRatio,
        minHealthFactor: healthFactor(2n * WAD),
      }),
    );
    expect(container.textContent).toContain("Liquidates if weETH/WETH falls to");
    expect(screen.getByText("0.9123")).not.toBeNull();
  });

  it("carries the sentence into the slider's announced value, word for word", () => {
    mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({
        blockValues: { borrow1: { ...RESOLVED_VALUE, inputAsset: "weETH" } },
        liquidationRatioWad: liquidationRatio,
        minHealthFactor: healthFactor(2n * WAD),
      }),
    );
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("aria-valuetext")).toBe(
      "50% of collateral value borrowed. Liquidates if weETH/WETH falls to 0.9123.",
    );
    expect(slider.getAttribute("max")).toBe("10000");
  });

  it("renders the borrowed fraction through the store's provenanced reader", () => {
    mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({ minHealthFactor: healthFactor(2n * WAD) }),
    );
    const readout = screen.getByText("50%");
    expect(readout.tagName).toBe("BUTTON");
  });

  it("says the fraction is unset rather than printing a zero for it", () => {
    const { container } = mount(
      <BorrowBlock
        {...nodeProps("borrow1", "borrow", { ...borrowData, isConfigured: false })}
      />,
      runtime(),
    );
    expect(container.textContent).toContain("not set");
    expect(container.textContent ?? "").not.toMatch(COERCED_ZERO);
    expect(frameOf(container).getAttribute("data-block-state")).toBe("warning");
  });

  it("reports a refused allocation instead of snapping the slider back in silence", () => {
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({
        setBorrowAllocationBps: () => ({
          ok: false,
          reason: "allocation must be a whole basis-point value in [1, 10000]",
        }),
      }),
    );
    fireEvent.change(screen.getByRole("slider"), { target: { value: "6000" } });
    expect(frameOf(container).getAttribute("data-block-state")).toBe("error");
    expect(container.textContent).toContain("whole basis-point value");
  });

  it("warns exactly where riskState does — below HF_WARN_WAD, not at it", () => {
    const atThreshold = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({ minHealthFactor: healthFactor(HF_WARN_WAD) }),
    );
    expect(frameOf(atThreshold.container).getAttribute("data-block-state")).toBe("valid");
    cleanup();

    const belowThreshold = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({ minHealthFactor: healthFactor(HF_WARN_WAD - 1n) }),
    );
    const frame = frameOf(belowThreshold.container);
    expect(frame.getAttribute("data-block-state")).toBe("warning");
    // The copy quotes core's constant through core's formatter — no literal is authored.
    expect(belowThreshold.container.textContent).toContain(
      `below the ${formatHealthFactor(HF_WARN_WAD)} warning threshold`,
    );
  });

  it("is not green when it is safe — baseline safety reads as foreground", () => {
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({ minHealthFactor: healthFactor(2n * WAD) }),
    );
    const hf = screen.getByText("2.00");
    expect(hf.className).toContain("text-foreground");
    expect(container.innerHTML).not.toContain("text-success");
  });

  it("says a missing health factor is missing, never safe and never a dash", () => {
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({
        minHealthFactor: wrapped({
          status: "unknown",
          reason: "missing collateral or debt snapshot",
        }),
      }),
    );
    expect(container.textContent).toContain(
      "Health factor unavailable: missing collateral or debt snapshot",
    );
    expect(container.textContent ?? "").not.toMatch(DASH_AS_VALUE);
    expect(container.textContent).not.toContain("Safe");
  });

  it("refuses to print 'unavailable' at the weight of a health factor", () => {
    // The loudest slot on the block, so the falsest place to promote a refusal: the ramp
    // is handed to SourcedValue only where a figure renders, because the unavailable
    // branch merges the caller's className over its own and wins.
    mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({ minHealthFactor: null, pending: false }),
    );
    const prose = screen.getByText("health factor unavailable");
    expect(prose.className).toContain("text-xs");
    expect(prose.className).toContain("text-muted-foreground");
    expect(prose.className).not.toContain("font-semibold");
    expect(prose.className).not.toContain("text-sm");
  });

  it("holds the health factor's box while it is in flight, at its own size", () => {
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({ minHealthFactor: null, pending: true }),
    );
    const slot = container.querySelector<HTMLElement>(
      '[aria-label="Minimum health factor during execution: loading"]',
    );
    expect(slot).not.toBeNull();
    expect(slot?.className).toContain("text-sm");
    expect(slot?.className).not.toContain("font-semibold");
  });

  it("says a debt-free position has no liquidation risk, never ∞", () => {
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({ minHealthFactor: wrapped({ status: "no-debt" }) }),
    );
    expect(container.textContent).toContain("no liquidation risk");
    expect(container.textContent).not.toContain("∞");
  });

  it("renders no input row — a borrow does not consume what it borrows against", () => {
    // `core/plan.ts` gives a borrow flow `inputWei: null` by construction. Rendering the row
    // anyway turned that structural absence into "amount unavailable" — a claim that a data
    // source failed, about a quantity no read, wallet or provider could ever fill.
    //
    // Asserted with a FULLY RESOLVED value, so this cannot pass merely because the fixture
    // had nothing to show: even when core hands over an input amount, the borrow block
    // refuses the row.
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({ blockValues: { borrow1: { ...RESOLVED_VALUE, inputAsset: "weETH" } } }),
    );
    const directions = [...container.querySelectorAll("span.sr-only")].map((s) => s.textContent);
    expect(directions).not.toContain("In");
    expect(directions).toContain("Out");
    expect(container.textContent).not.toContain("In value");

    // The rows for quantities that DO exist are untouched: an out flow, and a gas cost that
    // exists but is unquoted in sandbox.
    expect(container.textContent).toContain("Out value");
    expect(container.textContent).toContain("Gas");
  });

  it("carries none of the prototype's hardcoded prices or thresholds", () => {
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({
        minHealthFactor: healthFactor(2n * WAD),
        liquidationRatioWad: liquidationRatio,
      }),
    );
    expect(container.textContent).not.toContain("3300");
    expect(container.textContent).not.toContain("2700");
    expect(container.textContent).not.toContain("82.5");
  });

  it("authors the unavailable liquidation copy exactly once", () => {
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime(),
    );
    const text = container.textContent ?? "";
    const sentence = "Liquidation level unavailable.";
    expect(text.split(sentence).length - 1).toBe(1);
  });

  /**
   * Displayed parity (SPEC §3 step 3): the block renders the health factor `core/risk.ts`
   * computed over the pinned reads log, and the expectation is computed from core too —
   * `computeHealthFactor` over legs this test assembles itself. No digit is typed on either
   * side, so the assertion is that the canvas shows core's number rather than that two
   * literals agree.
   */
  it("renders the block-pinned minimum health factor core derived, digit for digit", () => {
    const snapshot = fixtureSnapshot();
    const result = simulate(flagshipGraph("10", 7000), snapshot);
    const plan = buildPlan(flagshipGraph("10", 7000), snapshot);
    if (!plan.ok) throw new Error("fixture plan failed");
    const category =
      snapshot.eModeCategories.find((c) => c.id === plan.targetEModeCategoryId) ?? null;
    const weETH = snapshot.reserves.weETH;
    const firstSupplyWei = plan.flows.find((f) => f.type === "lend")!.inputWei!.value;
    const borrowWei = plan.flows.find((f) => f.type === "borrow")!.outputWei!.value;
    const expected = formatHealthFactor(
      hfWadValue(
        computeHealthFactor(
          [
            {
              base: collateralBaseValue(
                firstSupplyWei,
                weETH.priceBase.value,
                assetUnitOf(weETH.decimals.value),
              ),
              ltBps: effectiveLiquidationThresholdBps(weETH, category),
            },
          ],
          // Debt ceils, collateral floors — GenericLogic's own directions.
          debtBaseValue(
            borrowWei,
            snapshot.reserves.WETH.priceBase.value,
            assetUnitOf(snapshot.reserves.WETH.decimals.value),
          ),
        ),
      ),
    );

    mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({
        blockValues: { borrow1: { ...RESOLVED_VALUE, inputAsset: "weETH" } },
        minHealthFactor: result.minHealthFactor,
        liquidationRatioWad: result.liquidationRatioWad,
      }),
    );

    const slot = screen.getByRole("button", { name: expected });
    expect(slot).not.toBeNull();
    // Below the 1.50 threshold, so the block escalates to its warning state and the figure
    // takes the warning ramp — the §3 step-3 beat, asserted end to end.
    expect(slot.className).toContain("text-warning");
    expect(screen.getByRole("group").getAttribute("data-block-state")).toBe("warning");
  });

  it("cites the oracle read behind that health factor when the slot is opened (S-1)", () => {
    const result = simulate(flagshipGraph("10", 7000), fixtureSnapshot());
    mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      borrowRuntime({ minHealthFactor: result.minHealthFactor }),
    );
    const slot = screen.getByRole("button", {
      name: formatHealthFactor(hfWadValue(valueOf(result.minHealthFactor))),
    });
    fireEvent.focus(slot);
    const trail = screen.getByRole("tooltip").textContent ?? "";
    expect(trail).toContain("Oracle.getAssetPrice(weETH)");
    expect(trail).toContain(`@ block ${PINNED_BLOCK}`);
    // The regime is inspectable, not scripted copy: the trail says WHY 9500 applied.
    expect(trail).toContain("eMode1.collateralConfig.liquidationThreshold");
  });
});

/** Every block, mounted once, so a contract can be asserted family-wide. */
function everyBlock(rt: BlockRuntime) {
  return mount(
    <>
      <InputBlock {...nodeProps("in1", "input", inputData)} />
      <StakeBlock {...nodeProps("stake1", "stake", stakeData)} />
      <LendBlock {...nodeProps("supply1", "lend", lendData)} />
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />
      <AutoWrapBlock {...nodeProps("wrap1", "auto-wrap", wrapData)} />
    </>,
    rt,
  );
}

describe("the network-dead probe — every value slot lands in a designed state", () => {
  it("settles into explicit unavailable prose, with no zero, dash or ellipsis anywhere", () => {
    const { container } = everyBlock(runtime({ pending: false }));

    expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(0);
    expect(container.querySelectorAll(".skeleton-value").length).toBe(0);

    const text = container.textContent ?? "";
    expect(text).toContain("amount unavailable");
    expect(text).toContain("value unavailable");
    expect(text).toContain("not quoted");
    expect(text).toContain("rate unavailable");
    expect(text).toContain("health factor unavailable");
    expect(text).toContain("Liquidation level unavailable");

    // The dash and zero rules are rules about VALUES. Scoping them to the value zones is
    // what lets the family write prose — an unavailable sentence that has to avoid a
    // punctuation mark is a test dictating copy rather than checking a contract.
    const values = valueZoneTextOf(container);
    expect(values).not.toMatch(DASH_AS_VALUE);
    expect(values).not.toMatch(COERCED_ZERO);
    expect(values).not.toContain("NaN");

    expect(text).not.toContain("...");
    expect(text).not.toContain("…");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("∞");
    expect(text).not.toContain("$0");
  });

  it("shows a sized busy slot while in flight, and no placeholder digit", () => {
    const { container } = everyBlock(runtime({ pending: true }));

    const slots = container.querySelectorAll<HTMLElement>('[aria-busy="true"]');
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.textContent).toBe("");
      expect(slot.getAttribute("style")).toContain("ch");
      expect(slot.getAttribute("role")).toBeNull();
    }
    expect(container.textContent).not.toContain("unavailable");
  });
});

describe("the family's token contract", () => {
  it("uses no shadow, no ring utility, no bg-accent, no brand token and no raw hex", () => {
    const { container } = everyBlock(runtime({ blockValues: { stake1: RESOLVED_VALUE } }));
    const markup = container.innerHTML;
    expect(markup).not.toMatch(/shadow-(sm|md|lg|xl|2xl|none)\b/);
    expect(markup).not.toMatch(/\bring-2\b|ring-offset/);
    expect(markup).not.toContain("bg-accent");
    expect(markup).not.toContain("--brand-");
    expect(markup).not.toMatch(/class="[^"]*#[0-9a-fA-F]{3,8}/);
  });

  it("animates nothing but colour and opacity — no entrance, no pulse, no scale", () => {
    const { container } = everyBlock(runtime({ blockValues: { stake1: RESOLVED_VALUE } }));
    const markup = container.innerHTML;
    // A first resolution is not an event: the flash class is absent until a value that was
    // already on screen moves on its own.
    expect(markup).not.toContain("value-up");
    expect(markup).not.toContain("value-down");
    expect(markup).not.toMatch(/animate-(pulse|bounce|ping|spin)/);
    expect(markup).not.toMatch(/\bscale-\d/);
    expect(markup).toContain("transition-fast");
  });

  it("keeps every in-block control out of the drag path and on the one focus ring", () => {
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow1", "borrow", borrowData)} />,
      runtime({ minHealthFactor: healthFactor(2n * WAD) }),
    );
    const slider = screen.getByRole("slider");
    expect(slider.className).toContain("nodrag");
    expect(slider.className).toContain("focus-ring");
    expect(container.querySelector('[class*="user-select"]')).toBeNull();
  });
});

describe("BLOCK_COMPONENTS", () => {
  it("registers exactly the block types a valid graph can contain", () => {
    expect(Object.keys(BLOCK_COMPONENTS).sort()).toEqual(
      ["auto-wrap", "borrow", "input", "lend", "stake"].sort(),
    );
    expect(Object.keys(BLOCK_COMPONENTS)).not.toContain("swap");
  });
});

// ————————————————————————— W09: the regime is a rendered fact —————————————————————————

/**
 * SPEC §3.4's named correctness bug is quoting the WRONG regime. Its quieter sibling is
 * quoting NO regime: a user who adds an uncorrelated borrow to the loop moves the whole
 * position from the e-mode category's thresholds to the reserve's, every number moves
 * honestly, and nothing says why. These pin the sentence that says why — in both regimes,
 * from the ceiling's own fields, with no authored threshold anywhere in the component.
 */
describe("BorrowBlock — the governing regime is stated, not implied", () => {
  const ceilingOf = (graph: ReturnType<typeof flagshipGraph>) => {
    const verdict = borrowLimitVerdict(graph, fixtureSnapshot());
    if (verdict.status !== "within") throw new Error(`expected a within verdict, got ${verdict.status}`);
    return verdict;
  };

  function runtimeFor(verdict: ReturnType<typeof ceilingOf>): Partial<BlockRuntime> {
    // The component keys the ceiling to its own block id, so the fixture's borrow block id
    // has to be the one the plan produced.
    return {
      borrowAllocations: { borrow: entered(verdict.ceiling.requestedAllocationBps) },
      borrowLimit: verdict,
      minHealthFactor: healthFactor(2n * WAD),
    };
  }

  it("names the e-mode category, and its thresholds, for the correlated loop", () => {
    const verdict = ceilingOf(flagshipGraph());
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow", "borrow", borrowData)} />,
      runtime(runtimeFor(verdict)),
    );
    expect(container.textContent).toContain(`E-mode category ${verdict.ceiling.categoryId}`);
    expect(container.textContent).toContain("governs this position");
    expect(container.textContent).toContain(formatBpsAsPercent(verdict.ceiling.ltvBps));
    expect(container.textContent).toContain(formatBpsAsPercent(verdict.ceiling.ltBps));
  });

  it("says out loud that NO category governs the carry, and quotes the reserve pair instead", () => {
    const verdict = ceilingOf(carryGraph());
    expect(verdict.ceiling.categoryId).toBeNull();
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow", "borrow", { ...borrowData, asset: "USDC" })} />,
      runtime(runtimeFor(verdict)),
    );
    expect(container.textContent).toContain("No e-mode category governs this position");
    expect(container.textContent).toContain(formatBpsAsPercent(verdict.ceiling.ltvBps));
    expect(container.textContent).toContain(formatBpsAsPercent(verdict.ceiling.ltBps));
    // The regime the position is NOT in must not appear anywhere on the block.
    const categoryLtv = formatBpsAsPercent(fixtureSnapshot().eModeCategories[0]!.ltvBps.value);
    expect(container.textContent).not.toContain(categoryLtv);
  });

  it("frames the carry's liquidation level as an oracle-price ratio between its own two assets", () => {
    const result = simulate(carryGraph(), fixtureSnapshot());
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow", "borrow", { ...borrowData, asset: "USDC" })} />,
      runtime({
        borrowAllocations: { borrow: entered(6_000) },
        blockValues: { borrow: { ...RESOLVED_VALUE, inputAsset: null } },
        liquidationRatioWad: result.liquidationRatioWad,
        // Straight from the simulation — the pair is not something this test authors.
        liquidationPair: result.liquidationPair,
        minHealthFactor: result.minHealthFactor,
      }),
    );
    // A RATIO claim naming both assets — never a bare dollar level, and never the correlated
    // pair's depeg wording, which was written for weETH/WETH specifically.
    expect(container.textContent).toContain("Liquidates if weETH/USDC falls to");
    expect(container.textContent ?? "").not.toMatch(/depeg|slash/i);
    // Scoped to the SENTENCE, not the whole block: the value zone legitimately renders
    // oracle-base-currency figures, and what must never carry a dollar is the liquidation
    // CLAIM — "liquidates at $X" for a pair whose oracle is a ratio would be the §2.5 lie.
    const sentenceNode = [...container.querySelectorAll("p")].find((p) =>
      (p.textContent ?? "").startsWith("Liquidates if"),
    );
    if (sentenceNode === undefined) throw new Error("no liquidation sentence rendered");
    expect(sentenceNode.textContent).not.toContain("$");
  });

  /**
   * Codex W09 round-2 finding 3 / treatment §2.5, W09 objective 3: "the risk labels state
   * which way a depeg cuts (USDC downside RAISES carry HF)".
   *
   * The direction is counterintuitive and no production text stated it — a user had to work
   * out for themselves that the stablecoin is the DEBT, so its downside helps them. Asserted
   * from `simulate` and `borrowLimitVerdict` output: the asset names are the pair core minted
   * and the gate is the ceiling's own `categoryId`, so nothing here is authored copy the
   * component could have disagreed with.
   */
  it("states which way the carry's debt asset cuts — USDC downside RAISES the health factor", () => {
    const verdict = ceilingOf(carryGraph());
    expect(verdict.ceiling.categoryId).toBeNull();
    const result = simulate(carryGraph(), fixtureSnapshot());
    if (result.liquidationPair === null) throw new Error("the carry must mint a pair");
    const { debt, collateral } = result.liquidationPair;
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow", "borrow", { ...borrowData, asset: "USDC" })} />,
      runtime({
        ...runtimeFor(verdict),
        liquidationRatioWad: result.liquidationRatioWad,
        liquidationPair: result.liquidationPair,
        minHealthFactor: result.minHealthFactor,
      }),
    );
    const text = container.textContent ?? "";
    // HF-POSITIVE, in the block's own words: the debt shrinks, so the health factor rises.
    expect(text).toContain(`${debt} is this position's debt`);
    expect(text).toContain("shrinks the debt and raises the health factor");
    // …and the liquidation vector is named the other way round, so "downside is good" cannot
    // be read as "nothing liquidates this".
    expect(text).toContain(`What liquidates this position is ${collateral} falling against ${debt}`);
    // Still no depeg/slashing wording — §2.5 bans that framing for this pair.
    expect(text).not.toMatch(/depeg|slash/i);
  });

  it("says nothing of the sort for the correlated loop, whose debt does not move alone", () => {
    const verdict = ceilingOf(flagshipGraph());
    expect(verdict.ceiling.categoryId).not.toBeNull();
    const result = simulate(flagshipGraph(), fixtureSnapshot());
    const { container } = mount(
      <BorrowBlock {...nodeProps("borrow", "borrow", borrowData)} />,
      runtime({
        ...runtimeFor(verdict),
        liquidationRatioWad: result.liquidationRatioWad,
        liquidationPair: result.liquidationPair,
        minHealthFactor: result.minHealthFactor,
      }),
    );
    const text = container.textContent ?? "";
    // weETH is priced through eETH/ETH, so "a fall in WETH raises the health factor" is not
    // true here — and an uncorrelated note on a correlated pair is exactly the framing §2.5
    // bans. The block still names the pair and the regime; it just makes no direction claim.
    expect(text).not.toContain("is this position's debt");
    expect(text).not.toContain("shrinks the debt");
    expect(text).not.toContain("What liquidates this position is");
    expect(text).toContain("Liquidates if weETH/WETH falls to");
    expect(text).toContain(`E-mode category ${verdict.ceiling.categoryId}`);
  });
});
