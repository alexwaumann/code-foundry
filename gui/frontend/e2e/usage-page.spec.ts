import { expect, test, type Page } from "@playwright/test";
import { emit, openApp, resetMock } from "./fixtures";

/**
 * The Usage page (view.usage), in its sheet, over the mock's usage buckets
 * (mock/usage.ts): two weeks of four models on s-1..s-4, an unpriced claude-opus-5 on
 * s-3, and a retired ledger
 * with claude-opus-4-8 ("Other") 12 days ago and opus 20, 33 and 60 days ago. Set
 * SHOTS=<dir> for the PR's screenshots. The sheet itself: usage-sheet.spec.ts.
 */

test.beforeEach(async () => {
  await resetMock();
});

const page_ = (page: Page) => page.getByTestId("usage-page");
const button = (page: Page) => page.getByTestId("status-usage");

async function openUsage(page: Page) {
  await openApp(page);
  await expect(button(page)).toBeEnabled();
  await button(page).click();
  await expect(page_(page)).toBeVisible();
  await expect(page.getByTestId("usage-page-model-row").first()).toBeVisible();
  // Done fading in (a screenshot taken earlier shows the window through the sheet).
  await expect(page.getByTestId("usage-sheet")).toHaveCSS("opacity", "1");
}

async function cacheSavings(page: Page): Promise<number> {
  const t = (await page.getByTestId("usage-page-cache-savings").textContent()) ?? "";
  return Number(t.replace(/^Cache savings/, "").replace(/[$,]/g, ""));
}

async function total(page: Page): Promise<number> {
  const t = (await page.getByTestId("usage-page-total").textContent()) ?? "";
  return Number(t.replace(/[$,]/g, ""));
}

/** Clicks where the chart button is: under the open sheet that hits the backdrop over it. */
async function clickButtonSpot(page: Page) {
  const box = await button(page).boundingBox();
  if (!box) throw new Error("no usage button");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("the status-row button toggles the sheet; a selection closes it; the CLI only shows it", async ({ page }) => {
  await openApp(page);
  // Right of the palette button.
  const order = await page.getByTestId("sidebar-status").locator("[data-command-button]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(order.slice(0, 2)).toEqual(["status-palette", "status-usage"]);
  await expect(button(page)).toHaveAttribute("aria-pressed", "false");

  await button(page).click();
  await expect(page_(page)).toBeVisible();
  await expect(button(page)).toHaveAttribute("aria-pressed", "true");
  // Under the backdrop: a click there closes the sheet, so the button stays a toggle.
  await clickButtonSpot(page);
  await expect(page_(page)).toHaveCount(0);
  await expect(button(page)).toHaveAttribute("aria-pressed", "false");

  // A selection change (the sidebar is under the backdrop: the keyboard, the palette or the CLI) closes it.
  await button(page).click();
  await expect(page_(page)).toBeVisible();
  expect(await emit({ showView: { name: "thread.next" } })).toBe(1);
  await expect(page_(page)).toHaveCount(0);

  // The CLI's view.usage (UiIntent.ShowView "usage") only shows: the open sheet stays.
  expect(await emit({ showView: { name: "usage" } })).toBe(1);
  await expect(page_(page)).toBeVisible();
  expect(await emit({ showView: { name: "usage" } })).toBe(1);
  await expect(page_(page)).toBeVisible();
  await clickButtonSpot(page);
  await expect(page_(page)).toHaveCount(0);
  // Closing, Escape and the settings sheet: usage-sheet.spec.ts.
});

test("range control filters by day and persists; the table lists unpriced and Other models by id", async ({ page }) => {
  await openUsage(page);
  await expect(page.getByTestId("usage-page-range-30")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("usage-page-day")).toHaveCount(30);
  const t30 = await total(page);
  expect(t30).toBeGreaterThan(0);

  // The bucket strip ends with Cache savings, right-aligned at the strip's edge.
  const savings = page.getByTestId("usage-page-cache-savings");
  await expect(savings).toContainText(/^Cache savings\$[\d,]+\.\d{2}$/);
  const s30 = await cacheSavings(page);
  expect(s30).toBeGreaterThan(0);
  const strip = await page.getByTestId("usage-page-buckets").boundingBox();
  const cell = await savings.boundingBox();
  expect(Math.round((strip?.x ?? 0) + (strip?.width ?? 0) - ((cell?.x ?? 0) + (cell?.width ?? 0)))).toBe(0);

  const unpriced = page.locator('[data-testid="usage-page-model-row"][data-model="claude-opus-5"]');
  await expect(unpriced.getByTestId("usage-page-unpriced")).toBeVisible();
  await expect(unpriced.locator("td").nth(3)).toHaveText("—");
  await expect(page.locator('[data-testid="usage-page-model-row"][data-model="claude-opus-4-8"]')).toBeVisible();
  await expect(page.getByTestId("usage-page-legend").locator("[data-series]")).toHaveText(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5", "Other"]);
  // Sorted by cost.
  await expect(page.getByTestId("usage-page-model-row").first()).toHaveAttribute("data-model", "claude-opus-5-5");

  await page.getByTestId("usage-page-range-90").click();
  await expect(page.getByTestId("usage-page-day")).toHaveCount(90);
  expect(await total(page)).toBeGreaterThan(t30);
  // The retired opus 33 and 60 days ago saved on cache reads too.
  expect(await cacheSavings(page)).toBeGreaterThan(s30);

  await page.getByTestId("usage-page-range-7").click();
  await expect(page.getByTestId("usage-page-day")).toHaveCount(7);
  expect(await total(page)).toBeLessThan(t30);
  // claude-opus-4-8 is 12 days old: out of a week.
  await expect(page.locator('[data-testid="usage-page-model-row"][data-model="claude-opus-4-8"]')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("thread-list").locator("[data-row-key]").first()).toBeVisible();
  await button(page).click();
  await expect(page.getByTestId("usage-page-range-7")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("usage-page-day")).toHaveCount(7);
});

// Tokens / Cost, the axis and a day's tooltip: unit-tested in src/components/usage/UsageSheet.test.tsx.

/** SHOTS=<dir>: the PR screenshots, WebKit, 1440x900, dark and light, tokens and cost. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openUsage(page);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/usage-page${suffix}.png` });
    await page.getByTestId("usage-page-mode-cost").click();
    await page.getByTestId("usage-page-day").nth(-4).hover();
    await expect(page.getByTestId("usage-page-tooltip")).toBeVisible();
    await page.screenshot({ path: `${String(shots)}/usage-page-cost${suffix}.png` });
  });
}
