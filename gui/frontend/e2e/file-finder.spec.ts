import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

/**
 * The file finder (file.find, cmd+P; docs/notes/file-finder-2-gui.md) for what only the
 * whole app shows: the chord through the keymap from a thread's prompt, the dialog taking
 * the keyboard, Enter landing a File tab in the side panel that was shut, ⌥⏎ landing an @
 * file tag in the real ProseMirror prompt. Its rows, groups, search and actions are
 * src/components/palette/FileFinder.test.tsx's and src/lib/fileFinder.test.ts's.
 */

const palette = (page: Page) => page.getByTestId("palette");
const finderInput = (page: Page) => palette(page).getByRole("combobox");

test.beforeEach(async () => {
  await resetMock();
  await mockPost(`files?project=repo-cf&${["README.md", "src/app.ts", "docs/notes/x.md"].map((f) => `path=${encodeURIComponent(f)}`).join("&")}`);
});

async function openFinder(page: Page): Promise<void> {
  await page.keyboard.press("Meta+p");
  await expect(palette(page)).toHaveAttribute("data-mode", "files");
  await expect(finderInput(page)).toBeFocused();
}

test("cmd+p from a thread's prompt opens the finder; Enter opens the file in the shut side panel; ⌥⏎ tags it in the prompt", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(threadPrompt(page)).toBeFocused();
  await expect(page.getByTestId("side-panel")).toHaveCount(0);

  await openFinder(page);
  await page.keyboard.type("app");
  await expect(palette(page).getByTestId("finder-row").first()).toHaveAttribute("data-path", "src/app.ts");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel-key", "thread:s-1");
  await expect(page.getByTestId("panel-tabs").locator('[role="tab"][aria-selected="true"]')).toHaveText("app.ts");
  await expect(page.getByTestId("file-tab")).toBeVisible();

  await threadPrompt(page).click();
  await openFinder(page);
  await page.keyboard.type("x.md");
  await expect(palette(page).getByTestId("finder-row").first()).toHaveAttribute("data-path", "docs/notes/x.md");
  await page.keyboard.press("Alt+Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(threadPrompt(page).getByTestId("prompt-tag")).toHaveText("x.md");
  await expect(threadPrompt(page)).toBeFocused();
});
