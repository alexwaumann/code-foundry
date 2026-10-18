import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, openStreams, resetMock, row } from "./fixtures";

/**
 * Plugin thread and terminal nodes within the connection budget
 * (docs/notes/plugins-12-renderer-defects.md). The mock's hello demo "stress" tab shows two
 * thread nodes and a terminal: with the content pane's thread, the event stream and the
 * surface's own stream that was one stream per WebKit connection to the daemon, and every
 * act hung. Now two inline nodes go live, the third offers Attach, the app never holds more
 * than five streams, and acts complete.
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

test("two threads and a terminal in one view: two go live, the third offers Attach, and acts still complete", async ({ page }) => {
  await openStress(page);
  const threads = surface(page).getByTestId("plugin-thread");
  const term = surface(page).getByTestId("plugin-terminal");
  await expect(threads).toHaveCount(2);
  await expect(threads.nth(0)).toHaveAttribute("data-live", "true");
  await expect(threads.nth(1)).toHaveAttribute("data-live", "true");
  await expect(term.getByTestId("plugin-live-paused")).toHaveAttribute("data-reason", "budget");
  await expect.poll(totalStreams).toBeLessThanOrEqual(5);

  // An act goes through (it hung with six streams open).
  await surface(page).locator('[data-testid="plugin-button"][data-key="click"]').click();
  await expect(page.getByTestId("plugin-header")).toContainText("1 click");

  // Attach takes the oldest live node's place.
  await term.getByTestId("plugin-live-attach").click();
  await expect(term.getByTestId("plugin-terminal-host")).toHaveAttribute("data-terminal-id", "t-hello-clock");
  await expect(threads.nth(0)).not.toHaveAttribute("data-live", "true");
  await expect(threads.nth(0).getByTestId("plugin-live-attach")).toBeVisible();
  await expect.poll(totalStreams).toBeLessThanOrEqual(5);
  await surface(page).locator('[data-testid="plugin-button"][data-key="click"]').click();
  await expect(page.getByTestId("plugin-header")).toContainText("2 clicks");

  // Switching the view tab lets the inline streams go at once, so the tab act is not held up.
  await surface(page).locator('[data-testid="plugin-tab"][data-key="overview"]').click();
  await expect(surface(page).locator('[data-testid="plugin-tab"][data-key="overview"]')).toHaveAttribute("aria-selected", "true");
  await expect(surface(page).getByTestId("plugin-thread")).toHaveCount(0);
});

test("a shell in the bottom panel outranks an inline node; the node says it waits for a connection", async ({ page }) => {
  await openStress(page);
  const threads = surface(page).getByTestId("plugin-thread");
  const term = surface(page).getByTestId("plugin-terminal");
  await expect(threads.nth(1)).toHaveAttribute("data-live", "true");
  // The bottom panel's Attach is a core stream: the newest inline Watch gives way.
  await term.getByTestId("plugin-terminal-open-bottom").click();
  await expect(page.getByTestId("bottom-terminal-host")).toHaveAttribute("data-terminal-id", "t-hello-clock");
  await expect(term.getByTestId("plugin-terminal-in-bottom")).toBeVisible();
  await expect(surface(page).locator('[data-testid="plugin-live-paused"][data-reason="connections"]')).toHaveCount(1);
  await expect.poll(totalStreams).toBeLessThanOrEqual(5);
  await surface(page).locator('[data-testid="plugin-button"][data-key="click"]').click();
  await expect(page.getByTestId("plugin-header")).toContainText("1 click");
});
