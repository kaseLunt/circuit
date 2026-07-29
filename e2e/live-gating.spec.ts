/**
 * SPEC §3 steps 4 and 7, executed.
 *
 * Sibling of `demo-script.spec.ts` and bound by the same rule: THE EXPECTED NUMBERS ARE
 * COMPUTED, NEVER TYPED. The over-limit allocation, the LTV and the liquidation threshold all
 * come from `core/borrow-limit.ts` over the same `sandboxSnapshot()` the browser is running
 * on, shaped by the same `core/format.ts` the block uses. A hardcoded "93%" would pass while
 * the app and the core disagreed — which is exactly the class of defect step 4 exists to
 * catch ("quoting the wrong regime is a correctness bug").
 *
 * The wallet is the wagmi MOCK connector (SPEC §3: "wallet interactions driven by a wagmi
 * mock connector"), configured by `playwright.config.ts` through
 * `NEXT_PUBLIC_WALLET_MOCK_ACCOUNTS`. Two accounts, and the scenario each one stands for is
 * named in the same place: one with no Aave footprint, one already holding a position.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { borrowLimitVerdict, type BorrowCeiling } from "../src/core/borrow-limit";
import { formatBpsAsPercent } from "../src/core/format";
import { sandboxSnapshot } from "../src/lib/recorded-reads/sandbox-snapshot";
import { leveragedRestakeLoop } from "../src/lib/strategy/templates";

const SNAPSHOT = sandboxSnapshot();
const TEMPLATE_BORROW_BPS = 5_000;
const TARGET_BORROW_BPS = 7_000;
const STEP_BPS = 100;

/**
 * The two mock accounts, and what each one IS. Kept in one place with
 * `playwright.config.ts`'s env block, which is the definition site — these constants
 * restate it so a drift between the two fails a test rather than a demo.
 */
const CLEAN_WALLET = "0x1111111111111111111111111111111111111111";
const OCCUPIED_WALLET = "0x2222222222222222222222222222222222222222";

/** What `core/` says the borrow ceiling IS at a given allocation. The whole oracle. */
function ceilingAt(borrowBps: number): BorrowCeiling {
  const verdict = borrowLimitVerdict(leveragedRestakeLoop(undefined, borrowBps), SNAPSHOT);
  if (verdict.status !== "within" && verdict.status !== "over-limit") {
    throw new Error(`the flagship at ${borrowBps} bps produced no ceiling: ${verdict.status}`);
  }
  return verdict.ceiling;
}

const CEILING = ceilingAt(TARGET_BORROW_BPS);
/** One slider step past the largest allocation the active configuration admits. */
const OVER_LIMIT_BPS = CEILING.maxAllocationBps + STEP_BPS - (CEILING.maxAllocationBps % STEP_BPS);

function node(page: Page, id: string): Locator {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

function borrowSlider(page: Page): Locator {
  return node(page, "borrow").getByRole("slider");
}

async function openComposer(page: Page): Promise<void> {
  await page.goto("/composer");
  await expect(node(page, "borrow")).toBeVisible();
}

/** The real gesture: focus the slider and walk it, one step per press, as a keyboard user does. */
async function walkSliderTo(page: Page, target: number): Promise<void> {
  const slider = borrowSlider(page);
  await slider.focus();
  const from = Number(await slider.inputValue());
  const presses = Math.abs(target - from) / STEP_BPS;
  const key = target > from ? "ArrowRight" : "ArrowLeft";
  for (let i = 0; i < presses; i += 1) await slider.press(key);
  await expect(slider).toHaveValue(String(target));
}

const armButton = (page: Page): Locator =>
  page.getByRole("button", { name: "Review & execute in sandbox" });

test.describe("SPEC §3 step 4 — the prevention-and-override beat", () => {
  test("refuses the over-limit borrow client-side with LTV/LT from the active eMode configuration", async ({
    page,
  }) => {
    // Preconditions, stated rather than assumed: the demo's opening position is admissible
    // and the point this test drags to is not, or the test would pass by asserting nothing.
    expect(borrowLimitVerdict(leveragedRestakeLoop(undefined, TEMPLATE_BORROW_BPS), SNAPSHOT).status).toBe(
      "within",
    );
    expect(borrowLimitVerdict(leveragedRestakeLoop(undefined, OVER_LIMIT_BPS), SNAPSHOT).status).toBe(
      "over-limit",
    );
    // The regime being quoted is an e-mode category, not the reserve's own numbers.
    expect(CEILING.categoryId).not.toBeNull();

    await openComposer(page);
    const borrow = node(page, "borrow");
    const frame = borrow.locator("[data-block-state]");
    await expect(frame).toHaveAttribute("data-block-state", "valid");
    await expect(armButton(page)).not.toHaveAttribute("aria-disabled", "true");

    await walkSliderTo(page, OVER_LIMIT_BPS);

    // The block rejects it INLINE, and the math it shows is core's, through core's formatter.
    await expect(frame).toHaveAttribute("data-block-state", "error");
    await expect(borrow).toContainText("Past the borrow limit");
    await expect(borrow).toContainText(`E-mode category ${CEILING.categoryId}`);
    await expect(borrow).toContainText(formatBpsAsPercent(CEILING.ltvBps));
    await expect(borrow).toContainText(formatBpsAsPercent(CEILING.ltBps));
    await expect(borrow).toContainText(formatBpsAsPercent(OVER_LIMIT_BPS));

    // Simulate is gated — `aria-disabled` with a stated reason, never `disabled`.
    const arm = armButton(page);
    await expect(arm).toHaveAttribute("aria-disabled", "true");
    await expect(arm).not.toHaveAttribute("disabled", "");
    const reasonId = await arm.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    await expect(page.locator(`#${reasonId}`)).toContainText("past the limit");
  });

  test('offers "Simulate anyway" as an explicit override, and any edit disarms it', async ({
    page,
  }) => {
    await openComposer(page);
    await walkSliderTo(page, OVER_LIMIT_BPS);

    const override = page.getByRole("button", { name: "Simulate anyway" });
    await expect(override).toBeVisible();
    await override.click();

    // The override is what lifts the gate — and nothing else changed about the document.
    await expect(armButton(page)).not.toHaveAttribute("aria-disabled", "true");
    await expect(override).toHaveCount(0);
    await expect(borrowSlider(page)).toHaveValue(String(OVER_LIMIT_BPS));

    // One-shot: SPEC §3.4's override is disarmed by ANY graph mutation. Stepping FURTHER
    // past the limit — still refused on the merits — re-gates, which is the property that
    // matters: the override applied to the document the user overrode, not to the session.
    await walkSliderTo(page, OVER_LIMIT_BPS + STEP_BPS);
    await expect(armButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: "Simulate anyway" })).toBeVisible();
  });

  test('drags back to 70% and the run control never says "Resume" (SPEC §6)', async ({ page }) => {
    await openComposer(page);
    await walkSliderTo(page, OVER_LIMIT_BPS);
    await expect(armButton(page)).toHaveAttribute("aria-disabled", "true");

    await walkSliderTo(page, TARGET_BORROW_BPS);

    // Back inside the limit: the gate lifts and the block leaves its error state.
    await expect(node(page, "borrow").locator("[data-block-state]")).toHaveAttribute(
      "data-block-state",
      "warning",
    );
    await expect(armButton(page)).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: "Simulate anyway" })).toHaveCount(0);
    // A failed or over-limit simulation has NO resumable prefix. The word never appears.
    await expect(page.getByRole("button", { name: /resume/i })).toHaveCount(0);
  });
});

test.describe("SPEC §3 step 7 — connect a wallet, live gating", () => {
  test("switches the session to Live and keeps Execute gated on a fresh simulation", async ({
    page,
  }) => {
    await openComposer(page);
    const badge = page.locator("header [data-mode]");
    await expect(badge).toHaveAttribute("data-mode", "sandbox");
    await expect(badge).toHaveText("Sandbox");

    await page.getByRole("button", { name: "Connect Mock Connector" }).click();

    await expect(badge).toHaveAttribute("data-mode", "live");
    await expect(badge).toHaveText("Live");
    await expect(page.getByTestId("wallet-address")).toHaveAttribute("title", CLEAN_WALLET);

    // Execute stays gated until a fresh simulation against the real balance passes — the
    // refusal is a designed STATE, with the mechanism stated, not a toast.
    await expect(
      page.getByText("No simulation against this wallet's balances yet").first(),
    ).toBeVisible();
    await expect(armButton(page)).toHaveAttribute("aria-disabled", "true");
  });

  test("refuses a wallet already holding an Aave position (the SPEC §2 footprint predicate)", async ({
    page,
  }) => {
    await openComposer(page);
    await page.getByRole("button", { name: "Connect Mock Wallet 2" }).click();

    await expect(page.getByTestId("wallet-address")).toHaveAttribute("title", OCCUPIED_WALLET);
    await expect(page.getByText("This wallet already has an Aave position").first()).toBeVisible();
    // The mechanism, stated honestly — never a safety verdict and never a scolding.
    await expect(
      page.getByText("Live mode opens a new position and does not merge into an existing one", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(armButton(page)).toHaveAttribute("aria-disabled", "true");

    // Disconnecting returns the session to Sandbox — the default no-wallet experience.
    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.locator("header [data-mode]")).toHaveAttribute("data-mode", "sandbox");
  });
});
