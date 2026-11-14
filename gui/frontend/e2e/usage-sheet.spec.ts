import { expect, test, type Page } from "@playwright/test";
import { emit, openApp, openTooltip, resetMock, row, threadPrompt } from "./fixtures";
import { openShellApp, tabOfKind } from "./shell";
import { diffTab, seedBeside } from "./shell-surfaces";

// The Usage page in a modal sheet over the window (docs/notes/usage-sheet.md), the same
// size as the settings sheet (settings-sheet.spec.ts): centred, at most 1280x1280, never
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

/** Clicks the page where `testId` is: under the open sheet that hits the backdrop. */
async function clickUnder(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`no ${testId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// The sheet's size at each window size is the shared sheet rule's: settings-sheet.spec.ts.
test("the sheet is a dialog with a 44px header, and its body scrolls inside it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await openUsage(page);
  await expect(sheet(page)).toHaveAttribute("role", "dialog");
  await expect(sheet(page)).toHaveAttribute("data-size", "sheet");
  await expect(page.getByRole("dialog", { name: "Usage" })).toBeVisible();
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
  // Nothing of it is left in the panes.
  await expect(page.getByTestId("shell-grid").getByTestId("usage-page")).toHaveCount(0);
});

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

// The range and measure controls: src/components/usage/UsageSheet.test.tsx.
test("a tooltip's Escape is its own; the next one closes the sheet", async ({ page }) => {
  await openApp(page);
  await openUsage(page);
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

// The status buttons' pressed state: src/components/sidebar/SidebarStatus.test.tsx; the CLI's view.usage
// and theme.pick replacing the other sheet: src/stores/views.test.ts ("the usage page").
test("cmd+, from the usage sheet: the settings sheet replaces it, one dialog and one backdrop", async ({ page }) => {
  await openApp(page);
  await openUsage(page);
  await page.keyboard.press("Meta+Comma");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(1);
});

test("the panes stay laid out under it", async ({ page }) => {
  // s-1's tab, its diff beside it, and its quick terminal open under the conversation.
  await seedBeside("s-1", [diffTab("s-1")]);
  await openShellApp(page);
  await page.locator('[data-testid="shell-pane"][data-pane-id="p-1"]').getByTestId("thread-pane-body").click({ position: { x: 20, y: 200 } });
  await page.keyboard.press("Meta+j");
  await expect(page.getByTestId("quick-terminal")).toBeVisible();
  await openUsage(page);
  await expect(page.getByTestId("shell-pane")).toHaveCount(2);
  await expect(page.getByTestId("diff-surface")).toBeVisible();
  await expect(page.getByTestId("quick-terminal")).toBeVisible();
  // The thread's pane still shows the thread.
  await expect(page.getByTestId("thread-header")).toBeVisible();

});

test("a terminal this window starts under it takes the keyboard: the sheet closes", async ({ page }) => {
  await seedBeside("s-1", [diffTab("s-1")]);
  await openShellApp(page);
  await page.locator('[data-testid="shell-pane"][data-pane-id="p-1"]').getByTestId("thread-pane-body").click({ position: { x: 20, y: 200 } });
  await openUsage(page);
  // A terminal this window starts (cmd+t: a tab linked to the thread) takes the keyboard, which it
  // could not under a modal: the sheet closes, as the settings sheet does.
  await expect(tabOfKind(page, "terminal")).toHaveCount(0);
  await page.keyboard.press("Meta+t");
  await expect(tabOfKind(page, "terminal")).toHaveCount(1);
  await expect(sheet(page)).toHaveCount(0);
});
