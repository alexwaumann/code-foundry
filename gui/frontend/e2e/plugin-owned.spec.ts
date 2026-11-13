import { expect, test, type Page } from "@playwright/test";
import { expectTerminalText, openHelloDemo, pluginActs, resetMock, row } from "./fixtures";
import { paneOf, paneShowing } from "./shell";

/**
 * A plugin's own thread and terminal in its surface (docs/notes/plugins-6-thread-terminal.md)
 * against the mock's hello demo: the Assistant tab shows the plugin's hidden thread with its
 * composer, the Shell tab its clock terminal with Open in a tab.
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");
const tab = (page: Page, key: string) => surface(page).locator(`[data-testid="plugin-tab"][data-key="${key}"]`);
const button = (page: Page, key: string) => surface(page).locator(`[data-testid="plugin-button"][data-key="${key}"]`);

/** Thread s-3 selected, its panel showing the hello demo on a tab. */
async function openDemoTab(page: Page, key: string): Promise<void> {
  await openHelloDemo(page);
  await tab(page, key).click();
  await expect(tab(page, key)).toHaveAttribute("aria-selected", "true");
}

test.beforeEach(async () => {
  await resetMock();
});

test("the Assistant tab shows the plugin's thread inline with its composer; it is not in the sidebar", async ({ page }) => {
  await openDemoTab(page, "assistant");
  const thread = surface(page).getByTestId("plugin-thread");
  await expect(thread).toHaveAttribute("data-thread-id", "s-hello-assistant");
  await expect(thread.getByTestId("thread-timeline")).toContainText("say hello in one line");
  await expect(thread.getByTestId("thread-composer")).toBeVisible();
  // Hidden from the user's lists, and the content pane keeps its own thread and composer.
  await expect(row(page, "s:s-hello-assistant")).toHaveCount(0);
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-3");

  // Send hello reaches the plugin, which sends to its own thread: the reply streams in here.
  await button(page, "send-hello").click();
  await expect.poll(async () => (await pluginActs()).some((a) => a.includes(" send-hello "))).toBe(true);
  await expect(thread.getByTestId("thread-timeline").getByText("say hello in one line")).toHaveCount(2);

  // Typing in the inline composer sends to the plugin's thread.
  await thread.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
  await page.keyboard.type("and once more");
  await page.keyboard.press("Enter");
  await expect(thread.getByTestId("thread-timeline")).toContainText("and once more");
});

// Ask the main thread acting with the panel's context: src/components/plugin/PluginSurface.watch.test.tsx (the watch opens with the panel's thread) and src/stores/pluginAct.test.ts (an act carries its watch's context); what the hello plugin does with it is the mock's.

test("the Shell tab attaches the plugin's terminal; Open in a tab moves it to a terminal tab", async ({ page }) => {
  await openDemoTab(page, "shell");
  const term = surface(page).getByTestId("plugin-terminal");
  await expect(term).toHaveAttribute("data-terminal-id", "t-hello-clock");
  await expect(term.getByTestId("plugin-terminal-host")).toHaveAttribute("data-terminal-id", "t-hello-clock");
  await expectTerminalText(page, /\d\d:\d\d:\d\d/);

  // ui.focus.terminal: the terminal's tab, by the placement rules, shown and attached.
  await term.getByTestId("plugin-terminal-open-tab").click();
  const clock = page.locator('[data-testid="shell-tab"][data-kind="terminal"]');
  // Named by what runs in it (lib/terminalName.test.ts), not the plugin's title.
  await expect(clock).toHaveCount(1);
  await expect(page.getByTestId("shell-terminal-host")).toHaveAttribute("data-terminal-id", "t-hello-clock");
  await expect(page.getByTestId("shell-terminal-host")).toHaveAttribute("data-attach-phase", "live");
  // It opened in the focused pane, over the surface. Moved beside it (to the thread's pane): one
  // view of a terminal at a time, so the node says where it is.
  const tabId = (await clock.getAttribute("data-tab-id")) ?? "";
  const threadPane = (await paneShowing(page, "thread").getAttribute("data-pane-id")) ?? "";
  await page.evaluate(`__cfModule("/src/stores/layout.ts").then((m) => m.applyLayout({ op: "move_tab", tab: ${JSON.stringify(tabId)}, pane: ${JSON.stringify(threadPane)} }))`);
  await expect(paneOf(page, threadPane).locator('[data-testid="shell-tab"][data-kind="terminal"][data-active]')).toHaveCount(1);
  await page.locator('[data-testid="shell-tab"][data-kind^="plugin."] [role="tab"]').click();
  await expect(term.getByTestId("plugin-terminal-in-tab")).toBeVisible();
  await expect(term.getByTestId("plugin-terminal-host")).toHaveCount(0);
  await expect(page.getByTestId("shell-terminal-host")).toHaveAttribute("data-attach-phase", "live");

  // Closing the tab leaves the plugin's terminal running: the node attaches again.
  await clock.hover();
  await clock.getByTestId("shell-tab-close").click();
  await expect(clock).toHaveCount(0);
  await expect(term.getByTestId("plugin-terminal-host")).toHaveAttribute("data-terminal-id", "t-hello-clock");
  await expect(term.getByTestId("plugin-terminal-host")).toHaveAttribute("data-attach-phase", "live");
});

test("cmd+f in the plugin's terminal opens the find bar on it, and Escape gives the keyboard back", async ({ page }) => {
  await openDemoTab(page, "shell");
  const host = surface(page).getByTestId("plugin-terminal-host");
  await expectTerminalText(page, /\d\d:\d\d:\d\d/);
  await host.locator(".xterm-screen").click();
  await page.keyboard.press("Meta+f");
  const field = surface(page).getByTestId("terminal-find-input");
  await expect(field).toBeFocused();
  await expect(page.getByTestId("thread-find")).toHaveCount(0);
  await page.keyboard.type(":");
  await expect(surface(page).getByTestId("terminal-find-count")).toHaveText(/^\d+ of \d+$/);
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-terminal-host]")?.getAttribute("data-testid"))).toBe("plugin-terminal-host");
});
