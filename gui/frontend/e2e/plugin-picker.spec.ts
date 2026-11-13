import { expect, test, type Page } from "@playwright/test";
import { openHelloDemo, resetMock } from "./fixtures";
import { paneShowingSurface, setSurfaceWidth } from "./shell-surfaces";

/**
 * The plugin picker (pluginsdk/ui Select.Search; docs/notes/plugin-picker.md) against the
 * mock's hello demo: its Layout toolbar's branch picker and its form's reviewers picker.
 * What the picker lists, which acts it sends, tokens, Backspace, Enter, Esc and focus going
 * back to the trigger: src/components/plugin/PickerControl.test.tsx and picker.test.ts. Here
 * only what needs the browser and the mock's streams: the popover fits a pane the side panel's default width (420 px), a
 * typed query reaches the plugin and its answer comes back as a new view, and a pick filters
 * the runs.
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");
const tab = (page: Page, key: string) => surface(page).locator(`[data-testid="plugin-tab"][data-key="${key}"]`);
const picker = (page: Page) => page.getByTestId("plugin-picker");

async function openDemo(page: Page, tabKey: string): Promise<void> {
  await openHelloDemo(page);
  await tab(page, tabKey).click();
  await expect(tab(page, tabKey)).toHaveAttribute("aria-selected", "true");
}

/** Types into the open picker and waits for the plugin's answer. */
async function search(page: Page, query: string): Promise<void> {
  await page.getByTestId("plugin-picker-search").fill(query);
  await expect(page.getByTestId("plugin-picker-list")).toHaveAttribute("data-shows", "results");
}

test.beforeEach(async () => {
  await resetMock();
});

test("a toolbar picker opens inside its pane, searches the plugin and filters the runs", async ({ page }) => {
  await openDemo(page, "layout");
  await setSurfaceWidth(page, "plugin-surface", 420);
  const trigger = surface(page).locator('[data-testid="plugin-select"][data-name="branch"]');
  await expect(trigger).toHaveAttribute("data-style", "picker-compact");
  await trigger.click();
  const panel = await paneShowingSurface(page, "plugin-surface").getByTestId("shell-pane-body").boundingBox();
  const pop = await picker(page).boundingBox();
  expect(panel && pop && pop.x >= panel.x && pop.x + pop.width <= panel.x + panel.width + 1).toBe(true);
  await search(page, "cf/");
  await page.getByTestId("plugin-picker-option").and(page.locator('[data-option="cf/retry"]')).click();
  await expect(page.getByTestId("plugin-picker-token")).toHaveText(["cf/retry"]);
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText(/Branch\s*cf\/retry/);
  await expect(surface(page).getByTestId("plugin-footer")).toContainText("1 of 6 runs");
});

/** SHOTS=<dir>: the PR's screenshots, WebKit, dark and light: the toolbar picker searching, the form's reviewers picker. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2 });
    test("the toolbar picker and the form's picker", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      const shot = (name: string) => page.screenshot({ path: `${shots ?? ""}/picker-${name}-${scheme}.png` });
      await openDemo(page, "layout");
      const branch = surface(page).locator('[data-testid="plugin-select"][data-name="branch"]');
      await branch.click();
      await search(page, "cf/");
      await page.getByTestId("plugin-picker-option").and(page.locator('[data-option="cf/fix"]')).click();
      await page.getByTestId("plugin-picker-option").and(page.locator('[data-option="cf/retry"]')).click();
      await expect(page.getByTestId("plugin-picker-token")).toHaveCount(2);
      await page.getByTestId("plugin-picker-search").fill("main");
      await page.waitForTimeout(400);
      await shot("toolbar");
      await page.keyboard.press("Escape");
      await expect(picker(page)).toHaveCount(0);
      await shot("toolbar-closed");

      await tab(page, "form").click();
      const reviewers = surface(page).locator('[data-testid="plugin-select"][data-name="reviewers"]');
      await reviewers.scrollIntoViewIfNeeded();
      await reviewers.click();
      await expect(page.getByTestId("plugin-picker-list")).toHaveAttribute("data-shows", "options");
      await page.waitForTimeout(350);
      await shot("form-recent");
      await search(page, "ale");
      await page.getByTestId("plugin-picker-option").first().click();
      await page.waitForTimeout(350);
      await shot("form-search");
    });
  });
}
