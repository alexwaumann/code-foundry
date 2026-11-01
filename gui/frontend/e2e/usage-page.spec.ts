import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock } from "./fixtures";

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

/** Clicks where the chart button is: under the open sheet that hits the backdrop over it. */
async function clickButtonSpot(page: Page) {
  const box = await button(page).boundingBox();
  if (!box) throw new Error("no usage button");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// The buttons' order, aria-pressed and the toggle: src/components/sidebar/SidebarStatus.test.tsx; a
// selection change closing it and the CLI's view.usage only showing: src/stores/views.test.ts ("the usage page").
test("under the open sheet a click on the status-row button lands on the backdrop, so it stays a toggle", async ({ page }) => {
  await openApp(page);
  await button(page).click();
  await expect(page_(page)).toBeVisible();
  await clickButtonSpot(page);
  await expect(page_(page)).toHaveCount(0);
  await expect(button(page)).toHaveAttribute("aria-pressed", "false");
});

// The range control (day slots, totals, cache savings, rows going out of range, persisting), the
// unpriced row, Other by id and the legend: src/components/usage/UsageSheet.test.tsx; usageRange
// persisted: src/stores/persisted.test.ts.
test("the bucket strip ends with Cache savings, right-aligned at the strip's edge", async ({ page }) => {
  await openUsage(page);
  const savings = page.getByTestId("usage-page-cache-savings");
  await expect(savings).toContainText(/^Cache savings\$[\d,]+\.\d{2}$/);
  const strip = await page.getByTestId("usage-page-buckets").boundingBox();
  const cell = await savings.boundingBox();
  expect(Math.round((strip?.x ?? 0) + (strip?.width ?? 0) - ((cell?.x ?? 0) + (cell?.width ?? 0)))).toBe(0);
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
