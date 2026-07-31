/**
 * The sandbox execution arc — arm, review, execute, attribute, receipt — against a real
 * session fork.
 *
 * A SIBLING of demo-script.spec.ts rather than an extension of it, because the two suites
 * have different environmental truths: steps 1–3 and 8 run on the recorded read set alone
 * (no chain, no secrets — they gate every external PR), while these beats REQUIRE a live
 * pristine upstream at the pinned block (`SANDBOX_FORK_URL`) for the session service to
 * fork from. The split keeps `npm run test:e2e` byte-identical in behaviour; this file
 * runs under playwright.fork.config.ts (`npm run test:e2e:fork`).
 *
 * THE EXPECTED NUMBERS ARE COMPUTED, NEVER TYPED — the sibling suite's law, kept. The
 * review's calls, amounts, tolerance bounds, checkpoints, and the receipt's figures all
 * come from `buildPlan`/`simulate`/`riskLedger` over the same `sandboxSnapshot()` the app
 * plans from, shaped by the same `core/format.ts` formatters the components use. What the
 * plan CANNOT predict — attributed outputs, chain health factors, gas — is asserted
 * structurally (mechanism + tx + block citations, receipt-bearing details), and asserted
 * NUMERICALLY exactly where the machine's own tolerance contract makes the rendered digits
 * deterministic: a completed run guarantees |attributed − predicted| ≤ toleranceWei, so
 * wherever a prediction sits further than that bound from a display-truncation boundary,
 * the attributed string MUST equal the predicted one. `truncationStable` states that
 * precondition; nothing is asserted on hope.
 *
 * The sandbox happy path never paints an `attributing` frame: the wire result lands as ONE
 * machine event (`applyStepResult`), so a row goes pending → settled in a single commit
 * and the treatment's attributing arm is exercised by the unit family instead
 * (tx-family.test.tsx). The progression asserted here is the one the machine actually
 * produces: queued (Circle) → pending (the one `.step-spinner`) → settled (the one
 * `text-success` Check per row), observed by a MutationObserver rather than by polling, so
 * every committed frame is evidence and none is a race.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { getAddress, toFunctionSelector } from "viem";
import { borrowLimitVerdict } from "../src/core/borrow-limit";
import { decodeRevert } from "../src/core/errors";
import {
  WAD,
  formatAddress,
  formatHealthFactor,
  formatToken,
  formatUnits,
  formatWadAsPercent,
  formatWadRatio,
} from "../src/core/format";
import { hfWadValue, riskState } from "../src/core/health-factor";
import { buildPlan, type PlanSuccess, type TransactionStep } from "../src/core/plan";
import { valueOf } from "../src/core/provenance";
import { riskLedger, simulate } from "../src/core/risk";
import {
  SANDBOX_HF_REL_POW,
  SANDBOX_OUTPUT_TOLERANCE,
  toleranceWeiFor,
} from "../src/lib/execution/tolerance";
import { PINNED_BLOCK, readsMeta } from "../src/lib/recorded-reads/reads-log";
import { sandboxSnapshot } from "../src/lib/recorded-reads/sandbox-snapshot";
import { leveragedRestakeLoop } from "../src/lib/strategy/templates";
import { mechanismLabel } from "../src/lib/tx/provenance";
import { producerMechanismOf } from "../src/server/sandbox/execute-step";
import {
  approveConsumerOf,
  approveSpenderAddressOf,
  plannedAmountOf,
} from "../src/components/tx/step-status";

const TEMPLATE_BORROW_BPS = 5_000;
/** The demo executes the position §3 step 3 dragged to — the fork-proven 70%. */
const TARGET_BORROW_BPS = 7_000;
const STEP_BPS = 100;

const SNAPSHOT = sandboxSnapshot();
const DOC = leveragedRestakeLoop(undefined, TARGET_BORROW_BPS);

/** The frozen plan — the same buildPlan over the same snapshot the host arms with. */
const PLAN: PlanSuccess = (() => {
  const built = buildPlan(DOC, SNAPSHOT);
  if (!built.ok) {
    throw new Error(`the flagship at ${TARGET_BORROW_BPS}bps must plan: ${JSON.stringify(built.errors)}`);
  }
  return built;
})();
const N = PLAN.steps.length;

const SIM = simulate(DOC, SNAPSHOT);
const LEDGER = riskLedger(DOC, SNAPSHOT);

const PRODUCER_STEPS = PLAN.steps.filter((step) => producerMechanismOf(step) !== null);
const APPROVE_STEPS = PLAN.steps.filter((step) => step.functionName === "approve");

/** A producer step's predicted output — the plan's own flows wrapper, the §6.2 one source. */
function predictedOutputWeiOf(step: TransactionStep): bigint {
  const flow = PLAN.flows.find((candidate) => candidate.blockId === step.blockId);
  if (flow === undefined || flow.outputWei === null) {
    throw new Error(`producer step ${step.id} has no predicted flow output`);
  }
  return valueOf(flow.outputWei);
}

/**
 * Whether truncating `wei` to `displayDecimals` is immune to a perturbation of up to
 * `toleranceWei`: the value sits strictly further than the tolerance from both edges of
 * its truncation bucket. Where this holds for a prediction, the attributed figure of a
 * COMPLETED run must render the identical string — the machine's tolerance gate is what
 * turns "approximately equal wei" into "equal digits", so the equality is asserted only
 * under this measured precondition, never on hope. (stake/borrow/withdraw predictions at
 * this pin sit 1 wei under a round 4dp edge, so they are asserted structurally instead.)
 */
function truncationStable(wei: bigint, displayDecimals: number, toleranceWei: bigint): boolean {
  const bucket = 10n ** BigInt(18 - displayDecimals);
  const down = wei % bucket;
  return down > toleranceWei && bucket - down > toleranceWei;
}

function node(page: Page, id: string): Locator {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

function borrowSlider(page: Page): Locator {
  return node(page, "borrow").getByRole("slider");
}

/** Land → composer → drag 50% → 70%, the §3 step-3 gesture this run executes from. */
async function openComposerAtTarget(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: "Try sandbox" }).click();
  await page.waitForURL("**/composer");
  await expect(node(page, "borrow")).toBeVisible({ timeout: 30_000 });
  const slider = borrowSlider(page);
  await slider.focus();
  for (let bps = TEMPLATE_BORROW_BPS; bps < TARGET_BORROW_BPS; bps += STEP_BPS) {
    await slider.press("ArrowRight");
  }
  await expect(slider).toHaveValue(String(TARGET_BORROW_BPS));
}

/**
 * Arm the run: the session fork spawns and both sides plan before the review renders, so
 * the Execute button is the "armed" signal. The generous timeout is the cold path — a
 * fresh anvil forking from the upstream plus a full snapshot capture against its cache.
 */
async function armSandboxRun(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Review & execute in sandbox" }).click();
  const column = page.getByRole("complementary", { name: "Execution" });
  await expect(column).toBeVisible({ timeout: 30_000 });
  await expect(column.getByRole("button", { name: "Execute", exact: true })).toBeVisible({
    timeout: 180_000,
  });
  return column;
}

/**
 * The provenance reader for the execution column's DISCLOSURE surface (the column moved
 * off floating tooltips when they clipped against the aside — the panel slots open an
 * inline `role="group"` evidence panel on click, per the W05 panel contract). Scoped to
 * the slot's own wrapper for the same reason the old reader was: page-level lookups can
 * read a neighbouring slot's evidence. Escape closes and returns focus to the trigger,
 * so successive reads never stack panels.
 */
async function citationOf(slot: Locator): Promise<{ label: string; lines: string[] }> {
  // Once open, the wrapper also contains the panel's Close button — the bare slot
  // locator goes strict-mode ambiguous, so the trigger is pinned before the click.
  const trigger = slot.first();
  await trigger.click();
  const panel = trigger.locator("xpath=ancestor::span[1]").getByRole("group");
  await expect(panel).toBeVisible();
  const label = (await panel.getAttribute("aria-label")) ?? "";
  const lines = (await panel.locator("span").allTextContents()).filter((t) => t.trim().length > 0);
  await panel.press("Escape");
  await expect(panel).toBeHidden();
  return { label, lines };
}

/**
 * Durable evidence in the run log of every PASS (the sibling suite's pattern): the
 * configured reporters drop in-memory annotations on green runs, so measured values are
 * emitted as GitHub Actions notices. GH workflow-command escaping: % CR LF %-encoded.
 */
function emitNotice(title: string, payload: unknown): void {
  const escaped = JSON.stringify(payload)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  console.log(`::notice title=${title}::${escaped}`);
}

test.describe("Sandbox execution — the pre-execute review on the session fork", () => {
  test("reviews every planned call, the tolerance contract, the block pin and the session facts", async ({
    page,
  }) => {
    await openComposerAtTarget(page);
    const column = await armSandboxRun(page);

    // The commit sentence names the count from the frozen plan, not a typed 13.
    await expect(column.getByText(`Execute ${N} steps on the session fork`)).toBeVisible();

    // The resolved input — the literal the plan's first step carries, through core/format.
    const inputStep = PLAN.steps[0];
    if (inputStep === undefined || inputStep.amount.kind !== "literal") {
      throw new Error("the flagship's first step must carry the literal input amount");
    }
    await expect(
      column.getByRole("button", {
        name: `${formatToken(valueOf(inputStep.amount.amount), 4)} ETH`,
      }),
    ).toBeVisible();

    // T29: the block pin and the recomposed (never ticking) age.
    await expect(
      column.getByText(new RegExp(`Simulated at block ${PINNED_BLOCK} · \\d`)),
    ).toBeVisible();

    // The §5.5 tolerance contract, verbatim from the named constants' own module.
    const absText = `${formatUnits(SANDBOX_OUTPUT_TOLERANCE.absWei, 0, 0)} wei`;
    const relText = formatUnits(SANDBOX_OUTPUT_TOLERANCE.relPow, 0, 0);
    await expect(column.getByText(/Each measured output must land within/)).toContainText(
      `± max(${absText}, predicted ÷ ${relText}) of its prediction, or execution halts.`,
    );

    // TTL as prose (T29: no countdown anywhere), and the session's identity facts: the
    // actor and the fork base pinned to the SAME block and hash every tooltip cites.
    await expect(column.getByText(/This session expires .+ after creation\./)).toBeVisible();
    await expect(column.getByText(/^actor 0x[0-9a-fA-F]{40}$/)).toBeVisible();
    await expect(
      column.getByText(`fork base block ${PINNED_BLOCK} · ${readsMeta.pinned_block.hash}`),
    ).toBeVisible();

    // T13's call zone, one entry per step: sentence, FULL target address, signature, and
    // the amount stated spec-or-resolved honestly — asserted for ALL steps, not a sample.
    const calls = column.getByRole("list", { name: "Planned calls" });
    await expect(calls.getByRole("listitem")).toHaveCount(N);
    for (const [position, step] of PLAN.steps.entries()) {
      const item = calls.getByRole("listitem").nth(position);
      await expect(item).toContainText(`${step.index}. ${step.description}`);
      await expect(item).toContainText(step.to);
      await expect(item).toContainText(`${step.functionName}(`);
      const planned = plannedAmountOf(PLAN, step);
      if (planned.kind === "bound") {
        await expect(item).toContainText(
          `amount: bound to the attributed output of step ${planned.producerStepNumber}`,
        );
      } else if (planned.kind === "figure") {
        await expect(item).toContainText(`amount: ${formatToken(valueOf(planned.amount), 4)}`);
      }
    }

    // The per-step risk lines are the frozen plan's own risk walk (T13), and the drag to
    // 70% makes the mid-execution checkpoint the card's ONE permitted chroma.
    if (!LEDGER.ok) throw new Error("the flagship risk walk must produce checkpoints");
    expect(LEDGER.checkpoints.length).toBeGreaterThan(0);
    let warningsSeen = 0;
    for (const checkpoint of LEDGER.checkpoints) {
      const step = PLAN.steps.find(
        (candidate) =>
          candidate.blockId === checkpoint.blockId && candidate.functionName === checkpoint.cause,
      );
      if (step === undefined) {
        throw new Error(`no plan step for checkpoint ${checkpoint.blockId}:${checkpoint.cause}`);
      }
      const item = calls.getByRole("listitem").nth(step.index - 1);
      const hf = checkpoint.healthFactor;
      if (hf.status === "no-debt") {
        await expect(item).toContainText("After this step: no debt — no liquidation risk.");
        continue;
      }
      const wad = hfWadValue(hf);
      if (wad === null) throw new Error(`checkpoint ${checkpoint.blockId} has no computable HF`);
      await expect(item).toContainText(`After this step: HF ${formatHealthFactor(wad)}`);
      if (riskState(hf) === "warning") {
        warningsSeen += 1;
        await expect(
          item.getByRole("button", { name: formatHealthFactor(wad) }),
        ).toHaveClass(/text-warning/);
      }
    }
    // Stated as a precondition (the sibling suite's rule): at 70% the minimum-HF
    // checkpoint IS in the warning band, or the chroma assertion above asserted nothing.
    expect(warningsSeen).toBeGreaterThan(0);

    // T3a: Execute is the screen's one terminal commit — primary, ungated, and alone.
    const execute = column.getByRole("button", { name: "Execute", exact: true });
    await expect(execute).toHaveClass(/bg-primary/);
    await expect(execute).not.toHaveAttribute("aria-disabled", "true");
    await expect(column.locator(".bg-primary")).toHaveCount(1);
    // T28's badge line belongs to the RUN (past ready), not to the review.
    await expect(column.getByText("No signatures in sandbox")).toHaveCount(0);

    emitNotice("presign-review-surface", {
      plannedCalls: N,
      producerSteps: PRODUCER_STEPS.length,
      approveSteps: APPROVE_STEPS.length,
      riskCheckpoints: LEDGER.checkpoints.length,
      warningCheckpoints: warningsSeen,
    });
  });
});

declare global {
  interface Window {
    __execProbe?: {
      announcements: string[];
      ladder: { s: number; r: number | null; spinners: number; t: number }[];
    };
  }
}

test.describe("Sandbox execution — run all steps, watch attribution, read the receipt", () => {
  /**
   * One continuous test for the three beats, deliberately: they are claims about ONE run
   * (§6 — a failed or re-armed run has no resumable prefix, so re-executing per beat
   * would assert three different runs), and a 13-step fork execution is minutes, not
   * milliseconds. `test.step` keeps the beats named in the report.
   */
  test("runs all 13 steps, attributes every output, and closes on the still receipt", async ({
    page,
  }) => {
    await openComposerAtTarget(page);
    const column = await armSandboxRun(page);
    const execute = column.getByRole("button", { name: "Execute", exact: true });

    // The observers are installed at `ready`, BEFORE the commit: every announcement and
    // every committed glyph frame from here on is recorded, none is polled for.
    await page.evaluate(() => {
      const columnEl = document.querySelector('aside[aria-label="Execution"]');
      const narrator = columnEl?.querySelector('p[role="status"]');
      const list = columnEl?.querySelector('ol[aria-label="Execution steps"]');
      if (!columnEl || !narrator || !list) {
        throw new Error("probe: the execution column's surfaces are missing");
      }
      const probe: NonNullable<Window["__execProbe"]> = {
        announcements: [narrator.textContent ?? ""],
        ladder: [],
      };
      window.__execProbe = probe;
      const record = (): void => {
        const settled = list.querySelectorAll("svg.text-success").length;
        const spinners = list.querySelectorAll(".step-spinner");
        let row: number | null = null;
        const spinner = spinners.item(0);
        if (spinner !== null) {
          const item = spinner.closest("li");
          const index = item === null ? -1 : Array.prototype.indexOf.call(list.children, item);
          row = index >= 0 ? index : null;
        }
        const last = probe.ladder[probe.ladder.length - 1];
        if (
          last === undefined ||
          last.s !== settled ||
          last.r !== row ||
          last.spinners !== spinners.length
        ) {
          probe.ladder.push({
            s: settled,
            r: row,
            spinners: spinners.length,
            t: Math.round(performance.now()),
          });
        }
      };
      record();
      new MutationObserver(record).observe(list, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      new MutationObserver(() => {
        const text = narrator.textContent ?? "";
        if (probe.announcements[probe.announcements.length - 1] !== text) {
          probe.announcements.push(text);
        }
      }).observe(narrator, { subtree: true, childList: true, characterData: true });
    });

    const runStartedAt = Date.now();
    await execute.click();
    await expect(column.getByText("Execution complete", { exact: true })).toBeVisible({
      timeout: 240_000,
    });
    const runMs = Date.now() - runStartedAt;
    // Park the pointer: it is still at the Execute button's former coordinates, and the
    // receipt that replaced the card puts a provenance slot under it — a hover-opened
    // tooltip must not shadow the evidence the assertions below open deliberately.
    await page.mouse.move(0, 0);

    const probe = await page.evaluate(() => window.__execProbe);
    if (probe === undefined) throw new Error("the execution probe did not survive the run");

    await test.step("execute — per-step progression and the single narrator", async () => {
      // The region the run was narrated into held the ready sentence when the probe
      // attached — T31's one voice, already speaking before the commit.
      expect(probe.announcements[0]).toBe(`Simulation complete: ${N} steps.`);

      const ladder = probe.ladder;
      const first = ladder[0];
      const last = ladder[ladder.length - 1];
      if (first === undefined || last === undefined) throw new Error("the ladder recorded nothing");
      // At ready: no glyph is green and nothing spins; at the end: N checks, stillness.
      expect(first.s).toBe(0);
      expect(first.r).toBeNull();
      expect(last.s).toBe(N);
      expect(last.r).toBeNull();

      let previousSettled = 0;
      for (const frame of ladder) {
        // The record only grows: a check that appeared never disappears (T8 — the
        // executed prefix IS the record).
        expect(frame.s).toBeGreaterThanOrEqual(previousSettled);
        previousSettled = frame.s;
        // T3's chroma budget as a committed-frame fact: never more than ONE spinner.
        expect(frame.spinners).toBeLessThanOrEqual(1);
        // The spinner only ever sits on the first unsettled row — the machine's active
        // step, not a decorative one.
        if (frame.r !== null) expect(frame.r).toBe(frame.s);
      }
      // Every step was OBSERVED executing: for each k a committed frame held k settled
      // checks with the spinner on row k. Thirteen steps, thirteen observed lifecycles.
      for (let k = 0; k < N; k += 1) {
        expect(
          ladder.some((frame) => frame.s === k && frame.r === k),
          `no committed frame observed step ${k + 1} executing`,
        ).toBe(true);
      }

      // T32's grammar, one sentence per step: the dispatch sentence or the coalesced
      // step-advance sentence — both carry the step number, the count and the plan's own
      // title. Which of the two speaks depends on whether React commits the attributed
      // frame separately, and both are ruled sentences, so both are accepted.
      for (const [position, step] of PLAN.steps.entries()) {
        const k = position + 1;
        const dispatch = `Executing — step ${k} of ${N}: ${step.description}.`;
        const advance = `Step ${k - 1} confirmed. Step ${k} of ${N}: ${step.description}.`;
        expect(
          probe.announcements.some((text) => text === dispatch || text === advance),
          `no announcement narrated step ${k}`,
        ).toBe(true);
      }
      expect(probe.announcements[probe.announcements.length - 1]).toBe(
        `Execution complete: ${N} steps confirmed.`,
      );

      const stepStarts = PLAN.steps.map(
        (_, position) => ladder.find((frame) => frame.s === position && frame.r === position)?.t,
      );
      emitNotice("sandbox-execution-progression", {
        totalMs: runMs,
        committedFrames: ladder.length,
        announcements: probe.announcements.length,
        stepStartOffsetsMs: stepStarts.map((t) =>
          t === undefined || stepStarts[0] === undefined ? null : t - stepStarts[0],
        ),
      });
    });

    const rows = column.getByRole("list", { name: "Execution steps" }).getByRole("listitem");

    await test.step("attribute — mechanisms, receipts, gas, consumed approvals", async () => {
      await expect(rows).toHaveCount(N);

      // Every settled row carries its receipt evidence: the hash with its copy
      // affordance, and gas FROM the receipt ("used", never an estimate) — T9.
      for (let position = 0; position < N; position += 1) {
        const row = rows.nth(position);
        await expect(row.getByRole("button", { name: "Copy transaction hash" })).toBeVisible();
        await expect(row).toContainText(/gas used \d/);
      }

      // The clean run's negative space: no halt, no divergence, no destructive chroma —
      // the T17/T22 identities exist and are NOT on this screen.
      await expect(column.getByText(/HALTED/)).toHaveCount(0);
      await expect(column.locator(".text-destructive")).toHaveCount(0);
      await expect(column.locator(".border-foreground")).toHaveCount(0);

      // Producer steps: the labelled PREDICTED / ATTRIBUTED pair (T10), the predicted
      // figure being the plan's own flow wrapper — exact by construction — and the
      // attributed figure citing its mechanism + tx + block in its provenance surface.
      for (const step of PRODUCER_STEPS) {
        const row = rows.nth(step.index - 1);
        const predictedWei = predictedOutputWeiOf(step);
        const toleranceWei = toleranceWeiFor(predictedWei, SANDBOX_OUTPUT_TOLERANCE);

        await expect(row).toContainText("Predicted");
        await expect(row).toContainText("Attributed");
        const predictedSlot = row
          .getByText("Predicted", { exact: true })
          .locator("xpath=following-sibling::*[1]")
          .getByRole("button");
        await expect(predictedSlot).toHaveText(formatToken(predictedWei, 6));

        const attributedSlot = row
          .getByText("Attributed", { exact: true })
          .locator("xpath=following-sibling::*[1]")
          .getByRole("button");
        await expect(attributedSlot).toHaveText(/^\d+\.\d{6}$/);
        // Where the prediction sits clear of its truncation boundary by more than the
        // tolerance, completion makes the attributed DIGITS deterministic — assert them.
        if (truncationStable(predictedWei, 6, toleranceWei)) {
          await expect(attributedSlot).toHaveText(formatToken(predictedWei, 6));
        }
        const rowSlot = row.locator("div.h-9").getByRole("button");
        await expect(rowSlot).toHaveText(/^\d+\.\d{4}$/);
        if (truncationStable(predictedWei, 4, toleranceWei)) {
          await expect(rowSlot).toHaveText(formatToken(predictedWei, 4));
        }

        const mechanism = producerMechanismOf(step);
        if (mechanism === null) throw new Error(`producer step ${step.id} lost its mechanism`);
        const citation = await citationOf(attributedSlot);
        expect(citation.label).toContain(`Step ${step.index} attributed output`);
        const joined = citation.lines.join(" ");
        // T10: the mechanism is the evidence surface's FIRST line, then where it was
        // measured — transaction and block, the receipt the figure rode in on.
        expect(joined).toContain(`derived: ${mechanismLabel(mechanism)}`);
        expect(joined).toMatch(/measured at execution: tx 0x[0-9a-fA-F]{64} @ block \d+/);
      }

      // The §3.3 zero-after-consume fact, where the treatment puts it (T15): each approve
      // row's settled detail states the exact scope and that nothing remains — a sentence
      // that is only legal because the engine verified the residual, and a run that
      // completed IS that verification (a non-zero residual halts before this screen).
      for (const approve of APPROVE_STEPS) {
        const spender = approveSpenderAddressOf(approve);
        const consumer = approveConsumerOf(PLAN, approve);
        if (spender === null || consumer === null) {
          throw new Error(`approve ${approve.id} lacks its spender or consumer`);
        }
        const spec = approve.amount;
        if (spec.kind !== "step-output") {
          throw new Error(`approve ${approve.id} must bind to a step output`);
        }
        const producer = PLAN.steps.find((candidate) => candidate.id === spec.producerStepId);
        if (producer === undefined) throw new Error(`approve ${approve.id} has no producer`);
        await expect(rows.nth(approve.index - 1)).toContainText(
          `Allows ${formatAddress(spender, 4)} — the target of step ${consumer.index} — ` +
            `to move exactly the attributed output of step ${producer.index}. ` +
            `Step ${consumer.index} spends it in full; nothing remains.`,
        );
      }

      // The §5.4 per-step cross-check made visible: each risk-changing row shows the HF
      // the CHAIN reported after it. Digits asserted under the same stability rule, with
      // the machine's own HF tolerance; the no-debt checkpoint renders the sentinel.
      if (!LEDGER.ok) throw new Error("the flagship risk walk must produce checkpoints");
      for (const checkpoint of LEDGER.checkpoints) {
        const step = PLAN.steps.find(
          (candidate) =>
            candidate.blockId === checkpoint.blockId &&
            candidate.functionName === checkpoint.cause,
        );
        if (step === undefined) throw new Error(`no step for ${checkpoint.blockId}`);
        const row = rows.nth(step.index - 1);
        await expect(row).toContainText("HF after this step:");
        const hf = checkpoint.healthFactor;
        if (hf.status === "no-debt") {
          await expect(row).toContainText("HF after this step: ∞");
          continue;
        }
        const wad = hfWadValue(hf);
        if (wad === null) throw new Error(`checkpoint ${checkpoint.blockId} HF not computable`);
        if (truncationStable(wad, 2, wad / SANDBOX_HF_REL_POW)) {
          await expect(row).toContainText(`HF after this step: ${formatHealthFactor(wad)}`);
        }
      }

      const gasLines = await column
        .getByRole("list", { name: "Execution steps" })
        .getByText(/^gas used \d/)
        .allTextContents();
      emitNotice("sandbox-attribution-facts", {
        settledRows: N,
        producerPairs: PRODUCER_STEPS.length,
        approveExplainers: APPROVE_STEPS.length,
        chainRiskReadings: LEDGER.checkpoints.length,
        gasUsed: gasLines,
      });
    });

    await test.step("receipt — the completion receipt, still", async () => {
      const receipt = column.locator('section[aria-labelledby="execution-complete-heading"]');
      await expect(receipt).toBeVisible();

      // T4, page-wide and exact: N row checks plus the receipt's one — and NOT ONE MORE
      // green element anywhere in the product at this moment.
      await expect(page.locator(".text-success")).toHaveCount(N + 1);
      await expect(receipt.locator(".text-success")).toHaveCount(1);

      // The §3.5 summary through the pinned simulation — the run's own predictions.
      const netApyWad = SIM.netApyWad;
      const ratioWad = SIM.liquidationRatioWad;
      if (netApyWad === null || ratioWad === null) {
        throw new Error("the fixture must produce a net APY and a liquidation ratio");
      }
      await expect(receipt).toContainText("Net APY · current-rate run-rate, one iteration");
      await expect(
        receipt.getByRole("button", { name: formatWadAsPercent(valueOf(netApyWad)) }),
      ).toBeVisible();
      // The pair the level is a level OF, read off the simulation that minted the ratio
      // (Codex W09 finding 2). The receipt used to print one generic sentence, which a carry
      // would have printed identically — on the one surface a user reads after committing.
      const pair = SIM.liquidationPair;
      if (pair === null) throw new Error("the fixture must produce a liquidation pair");
      await expect(receipt).toContainText(
        `Liquidates if ${pair.collateral}/${pair.debt} falls to`,
      );
      await expect(receipt).not.toContainText("collateral/debt");
      await expect(
        receipt.getByRole("button", { name: formatWadRatio(valueOf(ratioWad)) }),
      ).toBeVisible();

      // The CHAIN / PREDICTED pair (T23): the chain's reading in the hero position,
      // labelled, with the §5.4 read cited to the receipt it followed. Completion bounds
      // the two within the machine's HF tolerance, and the fixture's final HF sits clear
      // of its truncation boundary — stated as a precondition — so the two labelled
      // figures must carry identical digits.
      await expect(receipt).toContainText("Final health factor");
      const finalWad = hfWadValue(valueOf(SIM.finalHealthFactor));
      if (finalWad === null) throw new Error("the fixture must produce a final health factor");
      const finalText = formatHealthFactor(finalWad);
      expect(truncationStable(finalWad, 2, finalWad / SANDBOX_HF_REL_POW)).toBe(true);
      const predictedSlot = receipt
        .getByText("Predicted", { exact: true })
        .locator("xpath=following-sibling::*[1]")
        .getByRole("button");
      await expect(predictedSlot).toHaveText(finalText);
      const chainSlot = receipt
        .getByText("Chain", { exact: true })
        .locator("xpath=following-sibling::*[1]")
        .getByRole("button");
      await expect(chainSlot).toHaveText(finalText);
      const chainCitation = await citationOf(chainSlot);
      expect(chainCitation.label).toContain("Final health factor, chain reading");
      const chainJoined = chainCitation.lines.join(" ");
      expect(chainJoined).toContain("Pool.getUserAccountData(actor).healthFactor");
      expect(chainJoined).toMatch(/read after execution: tx 0x[0-9a-fA-F]{64} @ block \d+/);

      // T28: the honest framing, verbatim and computed — never "proof of live behavior".
      await expect(
        receipt.getByText(
          `${N} steps confirmed on the session fork — a forked-mainnet demo, not proof of live behavior.`,
        ),
      ).toBeVisible();

      // The session chrome holds through the terminal state: the badge line, the full
      // counter, and the block pin with its recomposed age (T28/T29).
      await expect(column.getByText("No signatures in sandbox")).toBeVisible();
      await expect(column.getByText(`${N} of ${N}`, { exact: true })).toBeVisible();
      await expect(
        column.getByText(new RegExp(`Simulated at block ${PINNED_BLOCK} · \\d`)),
      ).toBeVisible();

      // Stillness (T23/T3a): the terminal commit is gone and nothing on the column is
      // primary, spinning, or destructive. The receipt is complete, and it is quiet.
      await expect(column.getByRole("button", { name: "Execute", exact: true })).toHaveCount(0);
      await expect(column.locator(".bg-primary")).toHaveCount(0);
      await expect(column.locator(".step-spinner")).toHaveCount(0);

      emitNotice("sandbox-completion-receipt", {
        successGlyphs: N + 1,
        chainPredictedAgree: finalText,
        netApy: formatWadAsPercent(valueOf(netApyWad)),
        liquidationRatio: formatWadRatio(valueOf(ratioWad)),
        runMs,
      });
    });
  });
});

// ————— SPEC §3 step 4 on the fork: the decoded revert, and the full re-simulation —————

/** The ceiling the pinned snapshot admits — the source of the LT figure below. */
const TARGET_CEILING = (() => {
  const verdict = borrowLimitVerdict(DOC, SNAPSHOT);
  if (verdict.status !== "within") throw new Error("the flagship at 70% must be within the limit");
  return verdict.ceiling;
})();

/**
 * The first slider step whose modeled post-borrow HF sits STRICTLY below 1 with rounding
 * headroom (SPEC §3 step 4: "strictly above the block-pinned liquidation threshold with
 * rounding headroom") — computed from the same risk walk the app runs, never typed. The
 * 0.1% margin is the headroom: at exactly LT, HF = 1 PASSES Aave's check and the LTV error
 * would fire instead of the HF error this beat asserts.
 */
const OVER_LT_BPS = (() => {
  const margin = WAD / 1_000n;
  const first = (Math.floor(TARGET_CEILING.ltBps / STEP_BPS) + 1) * STEP_BPS;
  for (let bps = first; bps <= 10_000; bps += STEP_BPS) {
    const ledger = riskLedger(leveragedRestakeLoop(undefined, bps), SNAPSHOT);
    if (!ledger.ok || ledger.min === null) continue;
    const wad = hfWadValue(ledger.min.healthFactor);
    if (wad !== null && wad <= WAD - margin) return bps;
  }
  throw new Error("no slider allocation drives the flagship strictly past LT with headroom");
})();

const OVER_PLAN: PlanSuccess = (() => {
  const built = buildPlan(leveragedRestakeLoop(undefined, OVER_LT_BPS), SNAPSHOT);
  if (!built.ok) {
    // buildPlan deliberately does NOT refuse on LTV — the over-limit document must stay
    // plannable so the override can run it and the chain can answer (SPEC §5.7).
    throw new Error(`the flagship at ${OVER_LT_BPS}bps must still plan`);
  }
  return built;
})();

const BORROW_STEP = (() => {
  const step = OVER_PLAN.steps.find((candidate) => candidate.functionName === "borrow");
  if (step === undefined) throw new Error("the over-LT plan lost its borrow step");
  return step;
})();

/**
 * Codex's D-011 ruling, verified against the deployed revision's sources rather than taken
 * on faith: v3.7 `BorrowLogic.executeBorrow` MINTS the debt (BorrowLogic.sol:69-76) before
 * `validateHFAndLtv` (BorrowLogic.sol:95-103), and that validation checks
 * `healthFactor >= 1e18` (HealthFactorLowerThanLiquidationThreshold,
 * ValidationLogic.sol:376-379) BEFORE collateral coverage
 * (CollateralCannotCoverNewBorrow, ValidationLogic.sol:381-384). A position strictly above
 * LT fails the HF line first, so the fork's revert is deterministically this selector —
 * and the assertions below read what the fork ACTUALLY returned, so a deployed revision
 * that disagreed with upstream main would fail here, not pass politely.
 */
const HF_ERROR_SELECTOR = toFunctionSelector("HealthFactorLowerThanLiquidationThreshold()");
const HF_ERROR = decodeRevert(HF_ERROR_SELECTOR);
if (HF_ERROR.source !== "custom-error") {
  throw new Error("core/errors.ts no longer decodes the deployed revision's HF error");
}

/** Walk the borrow slider to any step-aligned target, in either direction. */
async function walkBorrowSliderTo(page: Page, target: number): Promise<void> {
  const slider = borrowSlider(page);
  await slider.focus();
  const from = Number(await slider.inputValue());
  const presses = Math.abs(target - from) / STEP_BPS;
  const key = target > from ? "ArrowRight" : "ArrowLeft";
  for (let i = 0; i < presses; i += 1) await slider.press(key);
  await expect(slider).toHaveValue(String(target));
}

test.describe("SPEC §3 step 4 on the fork — override, decoded revert, full re-simulation", () => {
  test("refuses inline, overrides to the fork's own HF revert, and re-simulates the whole bundle", async ({
    page,
  }) => {
    await page.goto("/composer");
    await expect(node(page, "borrow")).toBeVisible({ timeout: 30_000 });
    await walkBorrowSliderTo(page, OVER_LT_BPS);

    await test.step("the inline step-4 refusal, before any chain is asked", async () => {
      await expect(node(page, "borrow").locator("[data-block-state]")).toHaveAttribute(
        "data-block-state",
        "error",
      );
      await expect(node(page, "borrow")).toContainText("Past the borrow limit");
      const arm = page.getByRole("button", { name: "Review & execute in sandbox" });
      await expect(arm).toHaveAttribute("aria-disabled", "true");
    });

    await test.step("Simulate anyway → the borrow step fails with the DECODED revert", async () => {
      await page.getByRole("button", { name: "Simulate anyway" }).click();
      const column = await armSandboxRun(page);
      await column.getByRole("button", { name: "Execute", exact: true }).click();

      // The failure card's fact line IS the decoded message (T21) — core/errors' copy for
      // the fork's own revert data, not scripted text. `.first()` because the narrator's
      // polite region may speak the same sentence — one voice, same words.
      await expect(column.getByText(HF_ERROR.message).first()).toBeVisible({ timeout: 240_000 });
      // The raw revert data renders in full beside it; for this no-argument custom error
      // that is exactly the 4-byte selector the decoder matched.
      await expect(column.getByText(new RegExp(HF_ERROR_SELECTOR)).first()).toBeVisible();

      // The executed prefix stands: every step before the borrow settled and stays green.
      await expect(column.locator(".text-success")).toHaveCount(BORROW_STEP.index - 1);
      // A revert is a FAILED state, not a halt: the halted identity does not render.
      await expect(column.getByText(/HALTED/)).toHaveCount(0);

      emitNotice("fork-decoded-revert", {
        allocationBps: OVER_LT_BPS,
        borrowStepIndex: BORROW_STEP.index,
        selector: HF_ERROR_SELECTOR,
        decoded: HF_ERROR.message,
      });
    });

    await test.step("drag back → Re-simulate reruns the ENTIRE bundle from the base snapshot", async () => {
      await walkBorrowSliderTo(page, TARGET_BORROW_BPS);
      await expect(node(page, "borrow").locator("[data-block-state]")).toHaveAttribute(
        "data-block-state",
        "warning",
      );
      const column = page.getByRole("complementary", { name: "Execution" });
      await column.getByRole("button", { name: "Re-simulate" }).click();

      // The whole bundle re-plans: a fresh review with the full step list and NO retained
      // prefix — a failed simulation has no resumable prefix (SPEC §6).
      await expect(column.getByRole("button", { name: "Execute", exact: true })).toBeVisible({
        timeout: 180_000,
      });
      await expect(
        column.getByRole("list", { name: "Planned calls" }).getByRole("listitem"),
      ).toHaveCount(N);
      await expect(column.locator(".text-success")).toHaveCount(0);
      // SPEC §6, verbatim: the control is "Re-simulate", never "Resume".
      await expect(page.getByRole("button", { name: /resume/i })).toHaveCount(0);
    });
  });
});

// ————— SPEC §3 step 7 on the fork: the REAL readiness capture clears the gate —————

/** Must match playwright.fork.config.ts's NEXT_PUBLIC_WALLET_MOCK_ACCOUNTS. */
const FORK_WALLET = getAddress("0x7f3a921c5be694fa8f3ba14e58cd06897e9dd47e");

test.describe("SPEC §3 step 7 on the fork — live gate cleared by the wallet router's capture", () => {
  test("captures readiness through our RPC, clears the gate, and regates on plan drift", async ({
    page,
  }) => {
    await page.goto("/composer");
    await expect(node(page, "borrow")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Connect Mock Connector" }).click();
    await expect(page.locator("header [data-mode]")).toHaveAttribute("data-mode", "live");
    await expect(page.getByTestId("wallet-address")).toHaveAttribute("title", FORK_WALLET);

    // The connect seam is the SAME wallet-router capture (NEXT_PUBLIC_WALLET_LIVE_SOURCE=rpc):
    // eth_getCode + the §2 footprint sweep against the pinned upstream. Until it resolves the
    // gate refuses on the unread seam; once clear, the freshness gate is what remains.
    await expect(
      page.getByText("No simulation against this wallet's balances yet").first(),
    ).toBeVisible({ timeout: 120_000 });
    const arm = page.getByRole("button", { name: "Review & execute in sandbox" });
    await expect(arm).toHaveAttribute("aria-disabled", "true");

    // The F2 clearing path, against the REAL procedure: capture, simulate, standing.
    await page.getByRole("button", { name: "Simulate against this wallet" }).click();
    await expect(arm).not.toHaveAttribute("aria-disabled", "true", { timeout: 180_000 });
    await expect(page.getByText("No simulation against this wallet's balances yet")).toHaveCount(0);

    // The F3 beat on the same standing: one slider step is a different plan, and the gate
    // says THAT — drift, not staleness — before any clock is consulted.
    await walkBorrowSliderTo(page, TEMPLATE_BORROW_BPS + STEP_BPS);
    await expect(
      page.getByText("The strategy changed after it was simulated").first(),
    ).toBeVisible();
    await expect(arm).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: "Simulate against this wallet" })).toBeVisible();

    emitNotice("fork-live-gate-cleared", {
      wallet: FORK_WALLET,
      clearedThen: "plan-drift on one slider step",
    });
  });
});
