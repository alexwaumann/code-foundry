import { expect, test, type Page } from "@playwright/test";
import { emit, openApp, resetMock, row } from "./fixtures";

/**
 * The Usage page (view.usage) over the mock's usage buckets (mock/usage.ts): two weeks
 * of four models on s-1..s-4, an unpriced claude-opus-5 on s-3, and a retired ledger
 * with claude-opus-4-8 ("Other") 12 days ago and opus 20, 33 and 60 days ago. Set
 * SHOTS=<dir> for the notes' screenshots.
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
  await expect(page.getByTestId("usage-model-row").first()).toBeVisible();
}

async function total(page: Page): Promise<number> {
  const t = (await page.getByTestId("usage-total").textContent()) ?? "";
  return Number(t.replace(/[$,]/g, ""));
}

test("the status-row button toggles the page; x, Escape and a selection close it", async ({ page }) => {
  await openApp(page);
  // Right of the palette button.
  const order = await page.getByTestId("sidebar-status").locator("[data-command-button]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(order.slice(0, 2)).toEqual(["status-palette", "status-usage"]);
  await expect(button(page)).toHaveAttribute("aria-pressed", "false");

  await button(page).click();
  await expect(page_(page)).toBeVisible();
  await expect(button(page)).toHaveAttribute("aria-pressed", "true");
  await button(page).click();
  await expect(page_(page)).toHaveCount(0);
  await expect(button(page)).toHaveAttribute("aria-pressed", "false");

  await button(page).click();
  await page.getByTestId("usage-close").click();
  await expect(page_(page)).toHaveCount(0);

  await button(page).click();
  await expect(page_(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page_(page)).toHaveCount(0);

  await button(page).click();
  await row(page, "s:s-1").click();
  await expect(page_(page)).toHaveCount(0);

  // Settings and usage replace each other.
  await button(page).click();
  await page.getByTestId("status-settings").click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(page_(page)).toHaveCount(0);
  await button(page).click();
  await expect(page_(page)).toBeVisible();
  await expect(page.getByTestId("settings-page")).toHaveCount(0);

  // The CLI's view.usage (UiIntent.ShowView "usage") toggles too.
  expect(await emit({ showView: { name: "usage" } })).toBe(1);
  await expect(page_(page)).toHaveCount(0);
  expect(await emit({ showView: { name: "usage" } })).toBe(1);
  await expect(page_(page)).toBeVisible();
});

test("range control filters by day and persists; the table lists unpriced and Other models by id", async ({ page }) => {
  await openUsage(page);
  await expect(page.getByTestId("usage-range-30")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("usage-day")).toHaveCount(30);
  const t30 = await total(page);
  expect(t30).toBeGreaterThan(0);

  const unpriced = page.locator('[data-testid="usage-model-row"][data-model="claude-opus-5"]');
  await expect(unpriced.getByTestId("usage-unpriced")).toBeVisible();
  await expect(unpriced.locator("td").nth(3)).toHaveText("—");
  await expect(page.locator('[data-testid="usage-model-row"][data-model="claude-opus-4-8"]')).toBeVisible();
  await expect(page.getByTestId("usage-legend").locator("[data-series]")).toHaveText(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5", "Other"]);
  // Sorted by cost.
  await expect(page.getByTestId("usage-model-row").first()).toHaveAttribute("data-model", "claude-fable-5-1");

  await page.getByTestId("usage-range-90").click();
  await expect(page.getByTestId("usage-day")).toHaveCount(90);
  expect(await total(page)).toBeGreaterThan(t30);

  await page.getByTestId("usage-range-7").click();
  await expect(page.getByTestId("usage-day")).toHaveCount(7);
  expect(await total(page)).toBeLessThan(t30);
  // claude-opus-4-8 is 12 days old: out of a week.
  await expect(page.locator('[data-testid="usage-model-row"][data-model="claude-opus-4-8"]')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("thread-list").locator("[data-row-key]").first()).toBeVisible();
  await button(page).click();
  await expect(page.getByTestId("usage-range-7")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("usage-day")).toHaveCount(7);
});

test("Tokens / Cost switches the chart; a day shows its tooltip", async ({ page }) => {
  await openUsage(page);
  const chart = page.getByTestId("usage-chart");
  await expect(chart).toHaveAttribute("data-mode", "tokens");
  await expect(page.getByTestId("usage-mode-tokens")).toHaveAttribute("aria-pressed", "true");
  await expect(chart.locator("svg text").first()).toHaveText("0");

  const today = page.getByTestId("usage-day").last();
  await today.hover();
  const tip = page.getByTestId("usage-tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("claude-opus-5-5");
  await expect(tip).toContainText(/Total\s*[\d.]+M/);

  await page.getByTestId("usage-mode-cost").click();
  await expect(chart).toHaveAttribute("data-mode", "cost");
  await today.hover();
  await expect(tip).toContainText(/Total\s*\$[\d,.]+/);
  await expect(chart.locator("svg text").filter({ hasText: /^\$/ }).first()).toBeVisible();
});

/** SHOTS=<dir>: the notes' screenshots, WebKit, 1400x900, dark and light, tokens and cost. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await openUsage(page);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/usage-page${suffix}.png` });
    await page.getByTestId("usage-mode-cost").click();
    await page.getByTestId("usage-day").nth(-4).hover();
    await expect(page.getByTestId("usage-tooltip")).toBeVisible();
    await page.screenshot({ path: `${String(shots)}/usage-page-cost${suffix}.png` });
  });
}
