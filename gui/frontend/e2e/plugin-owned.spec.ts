import { expect, test, type Page } from "@playwright/test";
import { expectTerminalText, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * A plugin's own thread and terminal in its surface (docs/notes/plugins-6-thread-terminal.md)
 * against the mock's hello demo: the Assistant tab shows the plugin's hidden thread with its
 * composer, the Shell tab its clock terminal with Open in bottom panel.
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");
const tab = (page: Page, key: string) => surface(page).locator(`[data-testid="plugin-tab"][data-key="${key}"]`);
const button = (page: Page, key: string) => surface(page).locator(`[data-testid="plugin-button"][data-key="${key}"]`);

async function acts(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/plugin/acts`);
  return (await res.json()) as string[];
}

/** Thread s-3 selected, its panel showing the hello demo on a tab. */
async function openDemoTab(page: Page, key: string): Promise<void> {
  await openApp(page);
  await row(page, "s:s-3").click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Hello Demo");
  await page.getByTestId("palette").locator('[data-command="plugin.hello.show.demo"]').click();
  await expect(surface(page)).toHaveAttribute("data-phase", "live");
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
  await expect.poll(async () => (await acts()).some((a) => a.includes(" send-hello "))).toBe(true);
  await expect(thread.getByTestId("thread-timeline").getByText("say hello in one line")).toHaveCount(2);

  // Typing in the inline composer sends to the plugin's thread.
  await thread.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
  await page.keyboard.type("and once more");
  await page.keyboard.press("Enter");
  await expect(thread.getByTestId("thread-timeline")).toContainText("and once more");
});

test("Ask the main thread acts with the panel's context: the plugin sends to the thread the panel shows", async ({ page }) => {
  await openDemoTab(page, "assistant");
  await button(page, "ask-main").click();
  await expect.poll(async () => (await acts()).some((a) => a.includes(" ask-main viewer=s-3 "))).toBe(true);
  await expect(page.getByTestId("thread-pane").getByTestId("thread-timeline")).toContainText("The hello plugin says hi from its Assistant tab");
});

test("the Shell tab attaches the plugin's terminal; Open in bottom panel moves it to a bottom tab", async ({ page }) => {
  await openDemoTab(page, "shell");
  const term = surface(page).getByTestId("plugin-terminal");
  await expect(term).toHaveAttribute("data-terminal-id", "t-hello-clock");
  await expect(term.getByTestId("plugin-terminal-host")).toHaveAttribute("data-terminal-id", "t-hello-clock");
  await expectTerminalText(page, /\d\d:\d\d:\d\d/);

  await term.getByTestId("plugin-terminal-open-bottom").click();
  const bottom = page.getByTestId("bottom-panel");
  await expect(bottom.locator('[data-tab-id="t-hello-clock"]')).toContainText("Clock");
  await expect(page.getByTestId("bottom-terminal-host")).toHaveAttribute("data-terminal-id", "t-hello-clock");
  // One view of a terminal at a time: the node says where it is.
  await expect(term.getByTestId("plugin-terminal-in-bottom")).toBeVisible();

  // Closing the tab leaves the terminal running: the node attaches again.
  await bottom.locator('[data-tab-id="t-hello-clock"]').getByRole("button", { name: "Close Clock" }).click();
  await expect(bottom.locator('[data-tab-id="t-hello-clock"]')).toHaveCount(0);
  await expect(term.getByTestId("plugin-terminal-host")).toHaveAttribute("data-terminal-id", "t-hello-clock");
});
