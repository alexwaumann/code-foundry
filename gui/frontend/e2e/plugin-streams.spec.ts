import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, openStreams, resetMock, row } from "./fixtures";

/**
 * Plugin thread and terminal nodes each hold their own stream, with nothing rationing them
 * (docs/notes/ws-remove-slots.md). The mock's hello demo "stress" tab shows two thread nodes
 * and a terminal: beside the event stream, the content pane's thread and the surface's own
 * stream that is six. It was once a stream for each of WebKit's connections to the daemon,
 * and every act hung behind them. Streams now ride sockets, which leave those connections
 * to calls, so all of them stay live and acts complete.
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");

async function totalStreams(): Promise<number> {
  return Object.values(await openStreams()).reduce((a, b) => a + b, 0);
}

async function openStress(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-3").click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Hello Demo");
  await page.getByTestId("palette").locator('[data-command="plugin.hello.show.demo"]').click();
  await expect(surface(page)).toHaveAttribute("data-phase", "live");
  await mockPost("plugin/demotab?tab=stress");
  await expect(surface(page).locator('[data-testid="plugin-tab"][data-key="stress"]')).toHaveAttribute("aria-selected", "true");
}

test.beforeEach(async () => {
  await resetMock();
});

test("two threads and a terminal in one view: all live at once, past the old limit, and acts still complete", async ({ page }) => {
  await openStress(page);
  const threads = surface(page).getByTestId("plugin-thread");
  const term = surface(page).getByTestId("plugin-terminal");
  await expect(threads).toHaveCount(2);
  await expect(threads.nth(0)).toHaveAttribute("data-live", "true");
  await expect(threads.nth(1)).toHaveAttribute("data-live", "true");
  await expect(term.getByTestId("plugin-terminal-host")).toHaveAttribute("data-terminal-id", "t-hello-clock");
  await expect.poll(totalStreams).toBeGreaterThanOrEqual(6);

  // An act goes through (it hung with six streams open on fetch).
  await surface(page).locator('[data-testid="plugin-button"][data-key="click"]').click();
  await expect(page.getByTestId("plugin-header")).toContainText("1 click");

  // Leaving the view tab ends the nodes' streams with the view.
  const before = await openStreams();
  await surface(page).locator('[data-testid="plugin-tab"][data-key="overview"]').click();
  await expect(surface(page).locator('[data-testid="plugin-tab"][data-key="overview"]')).toHaveAttribute("aria-selected", "true");
  await expect(surface(page).getByTestId("plugin-thread")).toHaveCount(0);
  await expect.poll(async () => (await openStreams())["TerminalService/Attach"] ?? 0).toBe((before["TerminalService/Attach"] ?? 0) - 1);
});

test("a shell in the bottom panel adds a stream and takes none from a node", async ({ page }) => {
  await openStress(page);
  const threads = surface(page).getByTestId("plugin-thread");
  const term = surface(page).getByTestId("plugin-terminal");
  await expect(threads.nth(1)).toHaveAttribute("data-live", "true");
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(3);
  await term.getByTestId("plugin-terminal-open-bottom").click();
  await expect(page.getByTestId("bottom-terminal-host")).toHaveAttribute("data-terminal-id", "t-hello-clock");
  await expect(term.getByTestId("plugin-terminal-in-bottom")).toBeVisible();
  await expect(threads.nth(0)).toHaveAttribute("data-live", "true");
  await expect(threads.nth(1)).toHaveAttribute("data-live", "true");
  expect((await openStreams())["ThreadService/WatchThread"]).toBe(3);
  await surface(page).locator('[data-testid="plugin-button"][data-key="click"]').click();
  await expect(page.getByTestId("plugin-header")).toContainText("1 click");
});
