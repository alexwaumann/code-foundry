import { expect, test, type Page } from "@playwright/test";
import { emit, openApp, openTooltip, resetMock, row, threadPrompt } from "./fixtures";

// The Usage page in a modal sheet over the window (docs/notes/usage-sheet.md), the same
// size as the settings sheet (settings-sheet.spec.ts): centred, at most 1280x800, never
// closer than 48px to a window edge.

test.beforeEach(async () => {
  await resetMock();
});

const sheet = (page: Page) => page.getByTestId("usage-sheet");
const usagePage = (page: Page) => page.getByTestId("usage-page");
const chartButton = (page: Page) => page.getByTestId("status-usage");

async function openUsage(page: Page) {
  await chartButton(page).click();
  await expect(usagePage(page)).toBeVisible();
  await expect(sheet(page)).toHaveCSS("opacity", "1");
}

async function rect(page: Page) {
  return sheet(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

/** Clicks the page where `testId` is: under the open sheet that hits the backdrop. */
async function clickUnder(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`no ${testId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

for (const [w, h, want] of [
  // The cap: 1280x800 centred.
  [1440, 900, { x: 80, y: 50, width: 1280, height: 800 }],
  // Margin-limited: 48px from every edge.
  [1000, 700, { x: 48, y: 48, width: 904, height: 604 }],
] as const) {
  test(`at ${String(w)}x${String(h)} the sheet is ${String(want.width)}x${String(want.height)} with a 44px header`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openApp(page);
    await openUsage(page);
    await expect(sheet(page)).toHaveAttribute("role", "dialog");
    await expect(sheet(page)).toHaveAttribute("data-size", "sheet");
    await expect(page.getByRole("dialog", { name: "Usage" })).toBeVisible();
    expect(await rect(page)).toEqual(want);
    await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(1);
    // The header: the title, the note, the range control and the ×, not a window drag surface.
    const header = sheet(page).locator("[data-sheet-header]");
    expect((await header.boundingBox())?.height).toBe(44);
    await expect(header).toContainText("Usage");
    await expect(header).toContainText("Code Foundry threads only");
    await expect(header.getByTestId("usage-page-range")).toBeVisible();
    await expect(header.getByTestId("usage-page-close")).toBeVisible();
    expect(await header.evaluate((el) => getComputedStyle(el).getPropertyValue("--wails-draggable").trim())).not.toBe("drag");
    // The body scrolls inside the sheet: nothing spills out of it.
    const body = await sheet(page).evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(body.scroll).toBe(body.client);
    // Nothing of it is left in the content pane.
    await expect(page.getByTestId("content-pane").getByTestId("usage-page")).toHaveCount(0);
  });
}

test("the chart button toggles it; Escape, the backdrop and the × close it, and the thread's prompt takes the keyboard back", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await openUsage(page);
  await expect(chartButton(page)).toHaveAttribute("aria-pressed", "true");
  // The page takes the keyboard, not its first button.
  await expect(usagePage(page)).toBeFocused();
  // The thread stays laid out under the backdrop.
  await expect(page.getByTestId("thread-header")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(chartButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(threadPrompt(page)).toBeFocused();

  await openUsage(page);
  await page.mouse.click(8, 8);
  await expect(sheet(page)).toHaveCount(0);
  await expect(threadPrompt(page)).toBeFocused();

  await openUsage(page);
  await page.getByTestId("usage-page-close").click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(threadPrompt(page)).toBeFocused();

  // Under the backdrop the button stays pressed, and a click there closes the sheet.
  await openUsage(page);
  await clickUnder(page, "status-usage");
  await expect(sheet(page)).toHaveCount(0);
  await expect(chartButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(threadPrompt(page)).toBeFocused();
});

test("the range and measure controls work inside the sheet, which stays open", async ({ page }) => {
  await openApp(page);
  await openUsage(page);
  await page.getByTestId("usage-page-range-7").click();
  await expect(page.getByTestId("usage-page-range-7")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("usage-page-day")).toHaveCount(7);
  await page.getByTestId("usage-page-mode-cost").click();
  await expect(page.getByTestId("usage-page-chart")).toHaveAttribute("data-mode", "cost");
  await expect(sheet(page)).toBeVisible();
  // A tooltip's Escape is its own; the next one closes the sheet.
  await page.getByTestId("usage-page-close").hover();
  await expect(openTooltip(page)).toHaveText("Close (Esc)");
  await page.keyboard.press("Escape");
  await expect(openTooltip(page)).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
});

test("Escape in the palette or help over the sheet leaves it open", async ({ page }) => {
  await openApp(page);
  await openUsage(page);
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();

  expect(await emit({ showView: { name: "help" } })).toBe(1);
  await expect(page.getByTestId("help-overlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help-overlay")).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
});

test("Settings and Usage are exclusive: one sheet, one backdrop", async ({ page }) => {
  await openApp(page);
  await openUsage(page);
  // cmd+, from the usage sheet: the settings sheet replaces it.
  await page.keyboard.press("Meta+Comma");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(1);
  await expect(page.getByTestId("status-settings")).toHaveAttribute("aria-pressed", "true");
  await expect(chartButton(page)).toHaveAttribute("aria-pressed", "false");

  // The CLI's view.usage replaces Settings.
  expect(await emit({ showView: { name: "usage" } })).toBe(1);
  await expect(usagePage(page)).toBeVisible();
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByTestId("status-settings")).toHaveAttribute("aria-pressed", "false");
  await expect(chartButton(page)).toHaveAttribute("aria-pressed", "true");

  // theme.pick (the Themes body of the settings sheet) replaces it too.
  expect(await emit({ showView: { name: "themes" } })).toBe(1);
  await expect(page.getByTestId("themes-page")).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);
});

test("the side and bottom panels stay laid out under it", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await page.getByTestId("thread-header").getByTestId("panel-toggle").click();
  await expect(page.getByTestId("side-panel")).toBeVisible();
  await page.getByTestId("bottom-toggle").click();
  await expect(page.getByTestId("bottom-panel")).toBeVisible();
  await openUsage(page);
  await expect(page.getByTestId("side-panel")).toBeVisible();
  await expect(page.getByTestId("bottom-panel")).toBeVisible();
  // The content pane still shows the thread.
  await expect(page.getByTestId("content-pane").getByTestId("thread-header")).toBeVisible();

  // A shell this window starts (cmd+t) takes the keyboard, which it could not under a
  // modal: the sheet closes, as the settings sheet does.
  // Not getByRole: the modal hides everything else from the accessibility tree.
  const tabs = page.getByTestId("bottom-panel").locator('[role="tab"]');
  // The mock's s-1 has one shell.
  await expect(tabs).toHaveCount(1);
  await page.keyboard.press("Meta+t");
  await expect(tabs).toHaveCount(2);
  await expect(sheet(page)).toHaveCount(0);
});
