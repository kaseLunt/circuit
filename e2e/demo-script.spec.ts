/**
 * SPEC §3, the demo script, executed. W05's evidence target is steps 1–3 and 8 on the
 * recorded read set; the sandbox execution arc runs under e2e/playwright.fork.config.ts,
 * and the remaining §3 beats (prevention/override, live gating) are W08/P3b scope.
 *
 * THE EXPECTED NUMBERS ARE COMPUTED, NEVER TYPED. Every figure asserted below comes from
 * `core/risk.ts` over the same `sandboxSnapshot()` the browser is running on, shaped by the
 * same `core/format.ts` formatter the component uses. A hardcoded "1.42" would pass while the
 * app and the core disagreed — which is precisely the defect SPEC §3 step 3 exists to catch
 * ("the displayed HF must equal core/health-factor.ts for the same inputs"). The literals
 * that DO appear are structural: block ids (a documented contract in templates.ts), the
 * template's borrow default, and the 70% the script drags to.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  formatBlockTime,
  formatBpsAsPercent,
  formatHealthFactor,
  formatWadAsMultiple,
  formatWadAsPercent,
  formatWadRatio,
} from "../src/core/format";
import { hfWadValue, riskState } from "../src/core/health-factor";
import { valueOf } from "../src/core/provenance";
import { rateKindLabel, simulate } from "../src/core/risk";
import { PINNED_BLOCK, PINNED_TS, WINDOW_BLOCK, WINDOW_TS } from "../src/lib/recorded-reads/reads-log";
import { sandboxSnapshot } from "../src/lib/recorded-reads/sandbox-snapshot";
import { SHARE_PARAM, decodeShareGraph } from "../src/lib/share/encode";
import { leveragedRestakeLoop, weethUsdcCarry } from "../src/lib/strategy/templates";
import { borrowLimitVerdict } from "../src/core/borrow-limit";
import { NOTICE_DURATION_MS } from "../src/components/shared/notice";

/** The flagship's shipped opening position (templates.ts DEFAULT_BORROW_ALLOCATION_BPS). */
const TEMPLATE_BORROW_BPS = 5_000;
/** Where §3 step 3 drags to — the fork-proven point, one slider away from the default. */
const TARGET_BORROW_BPS = 7_000;
const STEP_BPS = 100;

const SNAPSHOT = sandboxSnapshot();

interface Expected {
  readonly healthFactor: string;
  readonly liquidationRatio: string;
  readonly supplyApy: string;
  readonly borrowApy: string;
  readonly stakingApy: string;
  readonly leverage: string;
  readonly stakingKind: string;
  readonly supplyKind: string;
  readonly borrowKind: string;
  readonly netApy: string;
  readonly isWarning: boolean;
}

/** What `core/` says the screen must show for a given borrow size. The whole oracle. */
function expectedAt(borrowBps: number): Expected {
  const result = simulate(leveragedRestakeLoop(undefined, borrowBps), SNAPSHOT);
  const hf = valueOf(result.minHealthFactor);
  if (hf.status !== "healthy") throw new Error(`fixture has no healthy HF at ${borrowBps}bps`);
  const ratio = result.liquidationRatioWad;
  const supply = result.blockValues["supply1"]?.rate;
  const borrow = result.blockValues["borrow"]?.rate;
  const staking = result.blockValues["stake1"]?.rate;
  const leverage = result.leverageWad;
  const net = result.netApyWad;
  if (
    ratio == null ||
    supply == null ||
    borrow == null ||
    staking == null ||
    net == null ||
    leverage == null
  ) {
    throw new Error(`fixture is missing a quantity the demo script asserts at ${borrowBps}bps`);
  }
  return {
    healthFactor: formatHealthFactor(hfWadValue(hf)),
    liquidationRatio: formatWadRatio(valueOf(ratio)),
    supplyApy: formatWadAsPercent(valueOf(supply.wad)),
    supplyKind: rateKindLabel(supply.kind),
    borrowApy: formatWadAsPercent(valueOf(borrow.wad)),
    borrowKind: rateKindLabel(borrow.kind),
    stakingApy: formatWadAsPercent(valueOf(staking.wad)),
    leverage: formatWadAsMultiple(valueOf(leverage)),
    stakingKind: rateKindLabel(staking.kind),
    netApy: formatWadAsPercent(valueOf(net)),
    isWarning: riskState(hf) === "warning",
  };
}

/**
 * SPEC §5.1's staking APR is a trailing seven-day exchange-rate delta, so it is two archive
 * reads at TWO blocks — the one quantity in v1 that legitimately crosses. The snapshot now
 * carries that window, so the slot resolves, and its citation must show BOTH read points
 * plus the reason the crossing is correct.
 */
const WINDOW_CITATION = "cross-block window:";

function node(page: Page, id: string): Locator {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

function borrowSlider(page: Page): Locator {
  return node(page, "borrow").getByRole("slider");
}

/**
 * Opens a provenance tooltip the way a keyboard user does, and returns it line by line.
 *
 * Line by line rather than as one blob: SPEC §3 step 2's claim is that EVERY chain read
 * behind a figure cites its method, its block and its block time. Asserted over the joined
 * text, one correctly-cited read would cover for a dozen uncited ones.
 */
async function citationOf(slot: Locator): Promise<{ label: string; lines: string[] }> {
  await slot.focus();
  const tooltip = slot.page().getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  const [label = "", ...lines] = await tooltip.locator("> span").allTextContents();
  return { label, lines };
}

/**
 * The panel's surface: click the figure and the evidence expands INSIDE the panel, in its
 * flow. A sixty-line derivation tree in a floating box is unusable at any width — it cannot
 * scroll with its container and it covers what it explains — so the panel discloses instead.
 */
async function disclosureOf(slot: Locator, name: string): Promise<string[]> {
  await slot.click();
  const section = slot.page().getByRole("group", { name: `${name} provenance` });
  await expect(section).toBeVisible();
  return section.locator("span[style]").allTextContents();
}

/**
 * Asserts the §3 step-2 contract over a whole derivation tree, not a sample of it.
 *
 * `allowWindow` is the ONE sanctioned exception: a trailing rate has two endpoints, so the
 * staking APR and the compositions containing it cite the window's start block as well as the
 * pin. Every such line still carries a method, a block and a block time — the exception is
 * about WHICH block a read may name, never about whether it must name one.
 */
function expectEveryReadCited(lines: readonly string[], allowWindow = false): void {
  const observed = lines.map((line) => line.trim()).filter((line) => line.startsWith("observed"));
  // A derived figure with no chain read underneath it would be a number with no source.
  expect(observed.length).toBeGreaterThan(0);
  const pinned = `@ block ${PINNED_BLOCK} · ${formatBlockTime(Number(PINNED_TS))}`;
  const windowCitation = `@ block ${WINDOW_BLOCK} · ${formatBlockTime(Number(WINDOW_TS))}`;
  const permitted = allowWindow ? [pinned, windowCitation] : [pinned];
  for (const line of observed) {
    // observed <method> @ block <n> · <block time>
    expect(line).toMatch(/^observed \S+ @ block \d+ · /);
    expect(permitted.some((citation) => line.includes(citation)), line).toBe(true);
  }
  if (allowWindow) {
    // The exception has to be USED, or this would silently degrade to the ordinary rule.
    expect(observed.some((line) => line.includes(windowCitation)), "no window read cited").toBe(true);
    expect(observed.some((line) => line.includes(pinned)), "no pinned read cited").toBe(true);
  }
}

/**
 * Everything about the document that a share link is supposed to carry: which blocks, which
 * edges, how the flow is allocated, and how much is borrowed. Deliberately read from the
 * SCREEN rather than from the store — the §3 step-8 claim is about what a second reader sees.
 */
async function documentSignature(page: Page) {
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  return {
    blocks: await page.locator(".react-flow__node").evaluateAll((els) =>
      els
        .map((el) => {
          const frame = el.querySelector("[data-block-type]");
          return `${el.getAttribute("data-id") ?? "?"}:${frame?.getAttribute("data-block-type") ?? "?"}`;
        })
        .sort(),
    ),
    edges: await page
      .locator(".react-flow__edge")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-id") ?? "?").sort()),
    allocations: await page
      .getByRole("button", { name: /^Allocation, / })
      .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? "?").sort()),
    borrowBps: await borrowSlider(page).inputValue(),
  };
}

async function openComposerFromLanding(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: "Try sandbox" }).click();
  await page.waitForURL("**/composer");
  await expect(node(page, "borrow")).toBeVisible();
}

test.describe("SPEC §3 step 1 — land, try sandbox, flagship loaded", () => {
  test("opens the composer on the Leveraged Restake Loop with the Sandbox badge visible", async ({
    page,
  }) => {
    await openComposerFromLanding(page);

    // The SPEC §2 expanded DAG: nine blocks, one closed iteration, laid out.
    const expectedBlocks = leveragedRestakeLoop().blocks;
    await expect(page.locator(".react-flow__node")).toHaveCount(expectedBlocks.length);
    for (const block of expectedBlocks) {
      await expect(node(page, block.id)).toBeVisible();
    }
    await expect(page.locator(".react-flow__edge")).toHaveCount(
      leveragedRestakeLoop().edges.length,
    );

    // Achromatic and in the chrome band, where the session states what it IS.
    await expect(page.locator("header").getByText("Sandbox", { exact: true })).toBeVisible();
    // The badge is not decoration: the chrome cites the block every tooltip on screen cites.
    await expect(page.locator("header")).toContainText(`block ${PINNED_BLOCK}`);

    await expect(borrowSlider(page)).toHaveValue(String(TEMPLATE_BORROW_BPS));
  });
});

test.describe("SPEC §3 step 2 — every number is sourced, or says it is not", () => {
  test("supply APY and borrow APR render from provenance and cite method, block and block time", async ({
    page,
  }) => {
    await openComposerFromLanding(page);
    const expected = expectedAt(TEMPLATE_BORROW_BPS);

    const supplySlot = node(page, "supply1").getByRole("button", { name: expected.supplyApy });
    await expect(supplySlot).toBeVisible();
    const supply = await citationOf(supplySlot);
    expect(expected.supplyKind).toBe("APY");
    expect(supply.label).toContain("Supply APY");
    expectEveryReadCited(supply.lines);
    // The APY is DERIVED, and the tooltip opens into the equation rather than asserting a
    // number: the reserve read it compounds is named on the face of it.
    expect(supply.lines.join(" ")).toContain("liquidityRate");
    expect(supply.lines.some((line) => line.includes("getReserveData"))).toBe(true);

    const borrowSlot = node(page, "borrow").getByRole("button", { name: expected.borrowApy });
    await expect(borrowSlot).toBeVisible();
    const borrow = await citationOf(borrowSlot);
    expect(expected.borrowKind).toBe("APY");
    expect(borrow.label).toContain("Borrow APY");
    expectEveryReadCited(borrow.lines);
    expect(borrow.lines.join(" ")).toContain("BorrowRate");
    expect(borrow.lines.some((line) => line.includes("getReserveData"))).toBe(true);

    // Both rate rows carry the honest framing verbatim (SPEC §5.1), not a bare percentage.
    await expect(node(page, "supply1")).toContainText("current-rate run-rate");
    await expect(node(page, "borrow")).toContainText("current-rate run-rate");
  });

  test("the staking APR resolves and cites BOTH ends of its trailing window", async ({
    page,
  }) => {
    await openComposerFromLanding(page);
    const expected = expectedAt(TEMPLATE_BORROW_BPS);
    const stake = node(page, "stake1");

    // APR, not APY: the trailing window annualizes linearly and compounds nothing, so the
    // label must not claim otherwise. The kind travels with the figure from core/risk.ts.
    expect(expected.stakingKind).toBe("APR");
    await expect(stake).toContainText("Staking APR");
    await expect(stake).not.toContainText("Staking APY");
    // The framing rides with the figure, in the same micro tier the Aave legs use.
    await expect(stake).toContainText("trailing 7-day window");
    const slot = stake.getByRole("button", { name: expected.stakingApy });
    await expect(slot).toBeVisible();

    // Read the SETTLED block before opening anything: the assertions below are about what the
    // slot renders, and an open tooltip would fold its explanatory prose into the same text.
    const text = (await stake.textContent()) ?? "";

    const citation = await citationOf(slot);
    expect(citation.label).toContain("Staking APR");
    // Two blocks, both fully cited — the sanctioned exception to the single-block rule.
    expectEveryReadCited(citation.lines, true);
    // …and the tooltip SAYS why the crossing is correct rather than leaving a reader to
    // wonder why two block numbers appear under one figure.
    expect(citation.lines.join(" ")).toContain(WINDOW_CITATION);
    expect(citation.lines.join(" ")).toContain("getRate");
    // SPEC §3 step 2 stays fully proven under the canvas tooltip's depth-1 cap: the trailing
    // APR's three reads ARE its immediate inputs, so nothing about it is deferred.
    expect(citation.lines.join(" ")).not.toContain("more derivation");

    // The rate is real, so none of the ways a missing rate is faked may appear.
    expect(text).not.toContain("rate unavailable");
    expect(text).not.toContain("0.00%");
    expect(text).not.toContain("—");
    expect(text).not.toContain("…");
  });

  test("the yield breakdown is complete, and the net APY is composed from all three legs", async ({
    page,
  }) => {
    await openComposerFromLanding(page);
    const expected = expectedAt(TEMPLATE_BORROW_BPS);
    const panel = page.getByRole("complementary", { name: "Simulation" });

    // Complete or empty, never partial: the refusal prose must be gone.
    await expect(panel.getByText(/Breakdown unavailable/)).toHaveCount(0);
    await expect(panel.getByRole("button", { name: expected.netApy })).toBeVisible();

    // All three legs on screen, each showing the rate its own block shows.
    for (const rate of [expected.stakingApy, expected.supplyApy, expected.borrowApy]) {
      await expect(panel.getByRole("button", { name: rate }).first()).toBeVisible();
    }

    // The net APY inherits the window, so its citation crosses too — and says so. It is read
    // from the PANEL's disclosure, which carries the whole tree rather than a capped view.
    const net = await disclosureOf(panel.getByRole("button", { name: expected.netApy }), "Net APY");
    expectEveryReadCited(net, true);
    expect(net.join(" ")).toContain(WINDOW_CITATION);
    // The breakdown row's suffix is READ from the leg's kind: the staking row discloses as
    // an APR, which is the defect this round closed at the panel as well as on the block.
    // Scoped to the breakdown: the gross APY happens to render the same 2.36%, because the
    // supply leg contributes almost nothing to the collateral rate at this block.
    const sources = page.getByLabel("Yield sources");
    await sources.getByRole("button", { name: expected.stakingApy }).click();
    await expect(page.getByRole("group", { name: "etherfi stake APR provenance" })).toBeVisible();
    await expect(page.getByRole("group", { name: /etherfi stake APY/ })).toHaveCount(0);
  });

  /**
   * GEOMETRY, not DOM presence. `Row` used to be a fixed 36px box, so a disclosure opening
   * inside one overlapped the rows beneath at their closed positions — the tree was in the
   * document and on top of the next row. Only a box comparison catches that.
   */
  test("an open row disclosure pushes the following row down instead of covering it", async ({
    page,
  }) => {
    await openComposerFromLanding(page);
    const expected = expectedAt(TEMPLATE_BORROW_BPS);
    const panel = page.getByRole("complementary", { name: "Simulation" });

    // Leverage and the row directly beneath it in the Position section.
    const leverage = panel.getByRole("button", { name: expected.leverage });
    const nextRowLabel = panel.getByText("Equity in", { exact: true });

    // A CLOSED row is still exactly the 36px box it always was.
    const closedRow = await leverage.locator("xpath=ancestor::div[1]").boundingBox();
    expect(closedRow?.height).toBe(36);
    const before = await nextRowLabel.boundingBox();

    await leverage.click();
    const section = page.getByRole("group", { name: "Leverage provenance" });
    await expect(section).toBeVisible();

    const sectionBox = await section.boundingBox();
    const after = await nextRowLabel.boundingBox();
    if (sectionBox === null || after === null || before === null) {
      throw new Error("expected measurable geometry for the row, the section and its neighbour");
    }

    const geometry = JSON.stringify({
      closedRowHeight: closedRow?.height,
      neighbourTopBefore: Math.round(before.y),
      disclosureTop: Math.round(sectionBox.y),
      disclosureBottom: Math.round(sectionBox.y + sectionBox.height),
      neighbourTopAfter: Math.round(after.y),
    });
    test.info().annotations.push({ type: "row-disclosure-geometry", description: geometry });
    // Playwright's in-memory annotations never reach a green CI run (the configured
    // reporters drop them and artifacts upload only on failure), so the evidence is
    // also emitted as a GitHub Actions notice: the runner parses `::notice` from any
    // stdout line, making the measured numbers durable in the run log of every pass.
    // GH workflow-command escaping: % CR LF must be %-encoded in the message.
    const escaped = geometry.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::notice title=row-disclosure-geometry::${escaped}`);

    // The neighbour moved DOWN, and its top clears the disclosure's bottom edge: the row grew
    // rather than the tree spilling over what follows it.
    expect(after.y).toBeGreaterThan(before.y);
    expect(after.y).toBeGreaterThanOrEqual(sectionBox.y + sectionBox.height);
  });

  test("the sticky header keeps the FIGURE when the subject is too long for the panel", async ({
    page,
  }) => {
    await openComposerFromLanding(page);
    const expected = expectedAt(TEMPLATE_BORROW_BPS);
    const panel = page.getByRole("complementary", { name: "Simulation" });

    // The longest label on the w-80 panel — the one that used to clip the number.
    await panel.getByRole("button", { name: expected.healthFactor }).click();
    const section = page.getByRole("group", { name: /Minimum health factor.*provenance/ });
    const header = section.locator("> span").first();

    // The subject may truncate; the figure is a sibling that never shrinks, so it is whole.
    const figure = header.locator("span").nth(1);
    await expect(figure).toHaveText(expected.healthFactor);
    const figureBox = await figure.boundingBox();
    const headerBox = await header.boundingBox();
    if (figureBox === null || headerBox === null) throw new Error("header is not measurable");
    // Fully inside the header's box — not clipped off its right edge.
    expect(figureBox.x + figureBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1);
    expect(figureBox.width).toBeGreaterThan(0);
  });

  test("the panel discloses provenance in its own flow, and the keyboard can leave again", async ({
    page,
  }) => {
    await openComposerFromLanding(page);
    const expected = expectedAt(TEMPLATE_BORROW_BPS);
    const panel = page.getByRole("complementary", { name: "Simulation" });
    const hero = panel.getByRole("button", { name: expected.healthFactor });

    await expect(hero).toHaveAttribute("aria-expanded", "false");
    await hero.click();
    const section = page.getByRole("group", { name: /Minimum health factor.*provenance/ });
    await expect(section).toBeVisible();
    await expect(hero).toHaveAttribute("aria-expanded", "true");

    // In the panel's FLOW, not floating over it: no tooltip is involved at all.
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    // Focus moved in, so a screen reader lands on the evidence rather than being told it
    // exists; Escape returns to the trigger.
    await expect(section).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(section).toHaveCount(0);
    await expect(hero).toBeFocused();
    await expect(hero).toHaveAttribute("aria-expanded", "false");
  });

  test("a rate too small to render at 2dp states its bound instead of claiming zero", async ({
    page,
  }) => {
    await openComposerFromLanding(page);
    const expected = expectedAt(TEMPLATE_BORROW_BPS);

    // The recorded weETH supply APY really is ~2.6e-7. "0.00%" would assert it is ZERO;
    // the bound form is the honest rendering, and `core/format.ts` owns the decision.
    expect(expected.supplyApy).toBe("<0.01%");
    await expect(
      node(page, "supply1").getByRole("button", { name: expected.supplyApy }),
    ).toBeVisible();
    expect((await node(page, "supply1").textContent()) ?? "").not.toContain("0.00%");
  });

  test("no number renders before its source resolves — nothing is left busy or blank", async ({
    page,
  }) => {
    await openComposerFromLanding(page);
    const canvas = page.locator(".react-flow__nodes");

    // Every slot has SETTLED: none is still shimmering, and none settled into a placeholder.
    await expect(canvas.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(canvas.locator(".skeleton-value")).toHaveCount(0);

    // A settled failure states itself in prose. A settled success shows a figure. There is
    // no third rendering, so a stray sentinel anywhere on the canvas is a regression.
    const text = (await canvas.textContent()) ?? "";
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("∞");
  });
});

test.describe("SPEC §3 step 3 — drag the borrow allocation 50% → 70%", () => {
  test("min-HF and the liquidation ratio track core, and the block enters its warning state", async ({
    page,
  }) => {
    await openComposerFromLanding(page);
    const before = expectedAt(TEMPLATE_BORROW_BPS);
    const after = expectedAt(TARGET_BORROW_BPS);

    // The fixture has to actually cross the threshold, or this test would pass by asserting
    // nothing. Stated as a precondition rather than assumed.
    expect(before.isWarning).toBe(false);
    expect(after.isWarning).toBe(true);
    expect(after.healthFactor).not.toBe(before.healthFactor);
    expect(after.liquidationRatio).not.toBe(before.liquidationRatio);

    const borrow = node(page, "borrow");
    const frame = borrow.locator("[data-block-state]");
    await expect(borrow.getByRole("button", { name: before.healthFactor })).toBeVisible();
    await expect(borrow).toContainText(before.liquidationRatio);
    await expect(frame).toHaveAttribute("data-block-state", "valid");

    // The real gesture: the slider takes focus and the keyboard walks it, one step per
    // press, exactly as a keyboard user would. The canvas's own key handler bails on an
    // input target, so nothing else consumes these.
    const slider = borrowSlider(page);
    await slider.focus();
    for (let bps = TEMPLATE_BORROW_BPS; bps < TARGET_BORROW_BPS; bps += STEP_BPS) {
      await slider.press("ArrowRight");
    }
    await expect(slider).toHaveValue(String(TARGET_BORROW_BPS));

    // The displayed health factor IS the core value for the same inputs, through the same
    // formatter — not a string this test decided.
    await expect(borrow.getByRole("button", { name: after.healthFactor })).toBeVisible();
    await expect(borrow).toContainText(after.liquidationRatio);
    await expect(frame).toHaveAttribute("data-block-state", "warning");
    await expect(borrow).toContainText("warning threshold");

    // The panel's hero moves with the block — one health factor, one number, two places.
    const panel = page.getByRole("complementary", { name: "Simulation" });
    await expect(panel.getByRole("button", { name: after.healthFactor })).toBeVisible();

    // The slider announces the liquidation SENTENCE, so the keyboard path and the pointer
    // path cannot say different things (treatment §1).
    const valueText = await slider.getAttribute("aria-valuetext");
    expect(valueText).toContain("70%");
    expect(valueText).toContain(after.liquidationRatio);
  });
});

test.describe("SPEC §3 step 8 — copy the share URL, open it clean", () => {
  test("rehydrates the identical graph in a fresh browser context", async ({ page, browser }) => {
    await openComposerFromLanding(page);

    // Move off the template default first, so a rehydrated flagship could not pass this test
    // by accident: the link has to carry the 70% the user chose.
    const slider = borrowSlider(page);
    await slider.focus();
    for (let bps = TEMPLATE_BORROW_BPS; bps < TARGET_BORROW_BPS; bps += STEP_BPS) {
      await slider.press("ArrowRight");
    }
    await expect(slider).toHaveValue(String(TARGET_BORROW_BPS));

    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.locator("header")).toContainText("Link copied.");

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`#${SHARE_PARAM}=`);
    // The payload rides the FRAGMENT (encode.ts): a shared graph must not reach the server.
    expect(new URL(copied).search).toBe("");

    // The token carries the document the user is looking at — proved against the one decode
    // pipeline, not against a re-implementation.
    const token = new URL(copied).hash.slice(`#${SHARE_PARAM}=`.length);
    const decoded = decodeShareGraph(token);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.graph).toEqual(leveragedRestakeLoop(undefined, TARGET_BORROW_BPS));

    const sent = await documentSignature(page);

    // A CLEAN context: no storage, no session, nothing but the link. This is the "private
    // window" of SPEC §3 step 8.
    const fresh = await browser.newContext({ permissions: [] });
    const reader = await fresh.newPage();
    await reader.goto(copied);
    await expect(node(reader, "borrow")).toBeVisible();
    await expect(borrowSlider(reader)).toHaveValue(String(TARGET_BORROW_BPS));

    const received = await documentSignature(reader);
    expect(received).toEqual(sent);

    // And the numbers derived from it agree, because the read set is block-pinned: the same
    // graph over the same snapshot is the same risk.
    const after = expectedAt(TARGET_BORROW_BPS);
    await expect(node(reader, "borrow").getByRole("button", { name: after.healthFactor })).toBeVisible();
    await expect(reader.locator('[data-block-state="warning"]').first()).toBeVisible();

    await fresh.close();
  });

  test("refuses a tampered payload arriving by URL, and substitutes nothing", async ({ page }) => {
    // The W03 malicious corpus's headline member, minted the way an attacker mints it —
    // by hand, never through `encodeShareGraph`, which refuses the same documents the
    // decoder does. A whitelisted KEY carrying an attacker-chosen ADDRESS is the exact hole
    // a key-only whitelist left open (src/lib/share/encode.test.ts, W05 R7).
    const hostile = {
      v: 1,
      b: [
        { i: "in", t: "input", p: { asset: "ETH", amount: "10" } },
        { i: "stake1", t: "stake", p: { protocol: "etherfi" } },
        { i: "wrap1", t: "wrap", p: { from: "eETH", to: "weETH" } },
        {
          i: "supply1",
          t: "lend",
          p: { protocol: "aave-v3", asset: "0x000000000000000000000000000000000000dEaD" },
        },
      ],
      e: [
        { i: "e0", s: "in", t: "stake1", a: 10_000 },
        { i: "e1", s: "stake1", t: "wrap1", a: 10_000 },
        { i: "e2", s: "wrap1", t: "supply1", a: 10_000 },
      ],
    };
    const token = Buffer.from(JSON.stringify(hostile), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    // The browser assertion below is only meaningful if the validator really refuses this —
    // so the refusal is established against the one pipeline first.
    const verdict = decodeShareGraph(token);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failure.code).toBe("schema");

    await page.goto(`/composer#${SHARE_PARAM}=${token}`);

    // The refusal is SHOWN, in the app's own words.
    const band = page.getByText("This link could not be opened.");
    await expect(band).toBeVisible();
    await expect(page.getByText("The link doesn't describe a strategy this version can open.")).toBeVisible();

    // And nothing is silently substituted: no flagship, no partially applied graph.
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Start a strategy" })).toBeVisible();

    // The chrome still states what the session is — a refused link is not a broken app.
    await expect(page.locator("header").getByText("Sandbox", { exact: true })).toBeVisible();
  });

  test("refuses a damaged link the same way, without guessing at a repair", async ({ page }) => {
    await page.goto(`/composer#${SHARE_PARAM}=not-a-real-payload`);
    await expect(page.getByText("This link could not be opened.")).toBeVisible();
    await expect(page.getByText("The link is damaged or incomplete.")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
  });

  test("puts the link in the address bar BEFORE the clipboard, so the refusal sentence is true", async ({
    page,
  }) => {
    // The ordering claim in `share-link.tsx` is only observable when the clipboard REFUSES:
    // if `replaceState` ran first, the link is genuinely in the address bar and the sentence
    // the user reads is a fact. If the order were reversed, the copy would be a lie and this
    // assertion would catch it. Asserted through behaviour rather than by patching internals.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("clipboard blocked")) },
      });
    });
    await openComposerFromLanding(page);
    const before = page.url();
    expect(before).not.toContain(`#${SHARE_PARAM}=`);

    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.locator("header")).toContainText("Couldn't copy the link");

    // The sentence's promise, kept.
    const after = page.url();
    expect(after).toContain(`#${SHARE_PARAM}=`);
    const token = new URL(after).hash.slice(`#${SHARE_PARAM}=`.length);
    const decoded = decodeShareGraph(token);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.graph).toEqual(leveragedRestakeLoop());

    // A blocked clipboard is a transient, not a refusal: nothing escalates to the band.
    await expect(page.getByText("This strategy could not be shared.")).toHaveCount(0);
  });

  test("escalates a COMPOSE refusal into the band with the validator's own words", async ({
    page,
  }) => {
    // Arrive refused, which leaves an empty canvas — a document `encodeShareGraph` also
    // refuses. One click therefore exercises both halves of the band's contract: a compose
    // refusal carries DETAILS (the finding that sent the author less than the recipient got),
    // and it SUPERSEDES the arrival refusal, because it is about what the user just did.
    await page.goto(`/composer#${SHARE_PARAM}=not-a-real-payload`);
    await expect(page.getByText("This link could not be opened.")).toBeVisible();

    await page.getByRole("button", { name: "Copy link" }).click();

    await expect(page.getByText("This strategy could not be shared.")).toBeVisible();
    await expect(page.getByText("This link could not be opened.")).toHaveCount(0);
    // The validator's own error, on the author's screen, with no timeout to outrun.
    await expect(page.getByText("graph has no blocks")).toBeVisible();

    await page.waitForTimeout(NOTICE_DURATION_MS + 500);
    await expect(page.getByText("graph has no blocks")).toBeVisible();

    // Retired by an explicit act, never by the clock.
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText("This strategy could not be shared.")).toHaveCount(0);
  });
});

/**
 * Ratified deviation 2, MEASURED — and the measurement corrected the premise.
 *
 * The deviation was accepted on the understanding that `/composer` is prerendered with the
 * flagship, so a fragment-borne share arrival would paint the wrong document for one hydration
 * beat. Inspecting the build output shows otherwise: React Flow mounts NO nodes during SSR
 * (`.react-flow__nodes` is empty in `.next/server/app/composer.html`, and the shell carries the
 * canvas's empty state instead). The server renders no document at all, so the layout-effect
 * swap lands before React Flow has painted a single node.
 *
 * The wrong-document beat is therefore ZERO, and this test asserts that as a CORRECTNESS
 * property rather than a timing budget: a per-frame probe records every borrow allocation the
 * page ever renders, and the arriving graph's must be the only one. That is strictly stronger
 * than "under 200ms" and, unlike a wall-clock threshold in a `retries: 0` evidence suite, it
 * cannot flake on a slow runner.
 *
 * The time from first contentful paint to the document appearing is still reported, as an
 * annotation and not an assertion. It measures the shell-to-document gap that EVERY path pays
 * — step 1 included — which is a React Flow SSR property, not a cost the share transport added.
 */
declare global {
  interface Window {
    __arrivalProbe?: { seen: string[]; fcpToDocumentMs: number | null };
  }
}

test.describe("ratified deviation 2 — what a cold share arrival actually paints", () => {
  test("never paints a document the sender did not send, and logs no hydration error", async ({
    browser,
  }) => {
    const author = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const page = await author.newPage();
    await openComposerFromLanding(page);
    const slider = borrowSlider(page);
    await slider.focus();
    for (let bps = TEMPLATE_BORROW_BPS; bps < TARGET_BORROW_BPS; bps += STEP_BPS) {
      await slider.press("ArrowRight");
    }
    await page.getByRole("button", { name: "Copy link" }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    await author.close();

    // Cold: fresh cache, fresh storage, nothing but the link.
    const cold = await browser.newContext({ permissions: [] });
    const reader = await cold.newPage();

    // A hydration mismatch is reported as a console error, so collecting them is a direct
    // assertion that the swap does not fight the server's markup — better than reasoning
    // about it in a comment.
    const consoleErrors: string[] = [];
    reader.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    reader.on("pageerror", (error) => consoleErrors.push(error.message));

    await reader.addInitScript(() => {
      const probe: { seen: string[]; fcpToDocumentMs: number | null } = {
        seen: [],
        fcpToDocumentMs: null,
      };
      window.__arrivalProbe = probe;
      const tick = () => {
        // Every borrow allocation this page has ever had in the DOM, in order. If the
        // flagship were painted even once, its 5000 would be recorded here.
        const slot = document.querySelector<HTMLInputElement>('input[type="range"]');
        if (slot !== null && probe.seen[probe.seen.length - 1] !== slot.value) {
          probe.seen.push(slot.value);
          if (probe.fcpToDocumentMs === null) {
            const paint = performance
              .getEntriesByType("paint")
              .find((entry) => entry.name === "first-contentful-paint");
            probe.fcpToDocumentMs =
              paint === undefined ? null : Math.round(performance.now() - paint.startTime);
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await reader.goto(link);
    await expect(borrowSlider(reader)).toHaveValue(String(TARGET_BORROW_BPS));
    // Hold past the point where a late re-render could still swap something in.
    await reader.waitForTimeout(500);

    const probe = await reader.evaluate(() => window.__arrivalProbe);
    test.info().annotations.push(
      {
        type: "arrival-documents-painted",
        description: JSON.stringify(probe?.seen ?? []),
      },
      {
        type: "fcp-to-document-ms (shell → canvas, every path pays this)",
        description: String(probe?.fcpToDocumentMs ?? "unmeasured"),
      },
    );
    // Durable in CI like the geometry evidence: in-memory annotations vanish on a
    // green run, so the measured beat is also a workflow notice (Codex phase
    // finding 3 — an evidence value nobody can retrieve is not evidence).
    const fcpPayload = JSON.stringify({
      documentsPainted: probe?.seen ?? [],
      fcpToDocumentMs: probe?.fcpToDocumentMs ?? "unmeasured",
    })
      .replace(/%/g, "%25")
      .replace(/\r/g, "%0D")
      .replace(/\n/g, "%0A");
    console.log(`::notice title=arrival-fcp-to-document::${fcpPayload}`);

    // THE assertion: exactly one document was ever on screen, and it is the one that was sent.
    expect(probe?.seen).toEqual([String(TARGET_BORROW_BPS)]);
    expect(consoleErrors).toEqual([]);

    await cold.close();
  });
});

/**
 * W09 — the two-template contrast, in a real browser.
 *
 * Scope, judged rather than assumed: the charter's e2e obligation is the fork proof, and the
 * demo script is the FLAGSHIP's story — the carry has no beat in it. What earns a browser
 * test is the one claim only a browser can settle: that loading the carry from the shipped
 * roster drives the real store, the real snapshot and the real simulation to a screen whose
 * regime sentence and risk state are the ones `core/` computes. The jsdom suite proves the
 * component renders a ceiling it is handed; this proves the app hands it the right one.
 *
 * Every expected figure is computed here from the same `sandboxSnapshot()` the browser runs
 * on. Nothing below is typed.
 */
test.describe("W09 — the carry template renders its own regime, beside the loop's", () => {
  test("loads from the roster into the amber band, quoting the reserve regime out loud", async ({
    page,
  }) => {
    const carry = weethUsdcCarry();
    const result = simulate(carry, SNAPSHOT);
    const hf = valueOf(result.minHealthFactor);
    if (hf.status !== "healthy") throw new Error("the carry fixture has no healthy HF");
    const verdict = borrowLimitVerdict(carry, SNAPSHOT);
    if (verdict.status !== "within") throw new Error(`carry verdict is ${verdict.status}`);
    const ratio = result.liquidationRatioWad;
    if (ratio === null) throw new Error("the carry fixture has no liquidation ratio");

    // The carry's whole purpose: it arrives amber. If this ever goes green the default has
    // drifted out of the window its definition site argues for.
    expect(riskState(hf)).toBe("warning");

    await openComposerFromLanding(page);
    await page.getByRole("tab", { name: "Templates" }).click();
    await page.getByRole("button", { name: /weETH carry/ }).click();

    const borrow = node(page, "borrow");
    await expect(borrow).toBeVisible();
    // Five blocks, and no unwrap/restake tail — the carry stops at the borrow.
    await expect(page.locator(".react-flow__node")).toHaveCount(5);

    // THE REGIME, AS A STATED FACT. Not inferable from the numbers, and not deferred to the
    // moment the position is already over its limit.
    await expect(borrow).toContainText("No e-mode category governs this position");
    await expect(borrow).toContainText(formatBpsAsPercent(verdict.ceiling.ltvBps));
    await expect(borrow).toContainText(formatBpsAsPercent(verdict.ceiling.ltBps));
    // …and the category regime the flagship stands in must not be quoted here.
    await expect(borrow).not.toContainText(
      formatBpsAsPercent(SNAPSHOT.eModeCategories[0]!.ltvBps.value),
    );

    // The liquidation claim is a PRICE RATIO between the position's own two assets.
    await expect(borrow).toContainText("Liquidates if weETH/USDC falls to");
    await expect(borrow).toContainText(formatWadRatio(valueOf(ratio)));

    // The health factor on screen is core's, to the digit, and it is in its warning state.
    await expect(borrow).toContainText(formatHealthFactor(hfWadValue(hf)));
    await expect(borrow.locator("[data-block-state]")).toHaveAttribute(
      "data-block-state",
      "warning",
    );
  });

  test("the loop quotes the category regime for the same collateral", async ({ page }) => {
    const loop = leveragedRestakeLoop();
    const verdict = borrowLimitVerdict(loop, SNAPSHOT);
    if (verdict.status !== "within") throw new Error(`flagship verdict is ${verdict.status}`);
    expect(verdict.ceiling.categoryId).not.toBeNull();

    await openComposerFromLanding(page);
    const borrow = node(page, "borrow");
    // The SAME weETH collateral, a correlated borrow, and therefore a different regime —
    // which is the contrast the two templates exist to draw.
    await expect(borrow).toContainText(`E-mode category ${verdict.ceiling.categoryId}`);
    await expect(borrow).toContainText("governs this position");
    await expect(borrow).toContainText(formatBpsAsPercent(verdict.ceiling.ltvBps));
    await expect(borrow).not.toContainText("No e-mode category governs");
  });
});
