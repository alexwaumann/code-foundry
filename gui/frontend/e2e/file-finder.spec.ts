import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";
import { keyboardPane, paneWith } from "./shell-surfaces";

/**
 * The file finder (file.find, cmd+P; docs/notes/file-finder-2-gui.md) for what only the
 * whole app shows: the chord through the keymap from a thread's prompt, the dialog taking
 * the keyboard, Enter landing a File tab beside the thread (the keyboard moving into it), ⌥⏎ landing an @ file tag in the real ProseMirror prompt. Its rows,
 * groups, search and actions are
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

test("cmd+p from a thread's prompt opens the finder; Enter opens the file in a tab beside the thread; ⌥⏎ tags it in the prompt", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(threadPrompt(page)).toBeFocused();
  await expect(page.getByTestId("shell-pane")).toHaveCount(1);

  await openFinder(page);
  await page.keyboard.type("app");
  await expect(palette(page).getByTestId("finder-row").first()).toHaveAttribute("data-path", "src/app.ts");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByTestId("file-tab")).toBeVisible();
  // A tab linked to the thread, in a pane of its own beside it.
  const filePane = paneWith(page, "file");
  await expect(filePane.locator('[data-testid="shell-tab"][data-kind="file"]')).toHaveAttribute("data-active", "true");
  await expect(filePane.locator('[data-testid="shell-tab"][data-kind="thread"]')).toHaveCount(0);
  // The keyboard went to the file's pane, not back to the prompt.
  const paneId = String(await filePane.getAttribute("data-pane-id"));
  await expect.poll(() => keyboardPane(page)).toBe(paneId);

  await threadPrompt(page).click();
  await openFinder(page);
  await page.keyboard.type("x.md");
  await expect(palette(page).getByTestId("finder-row").first()).toHaveAttribute("data-path", "docs/notes/x.md");
  await page.keyboard.press("Alt+Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(threadPrompt(page).getByTestId("prompt-tag")).toHaveText("x.md");
  await expect(threadPrompt(page)).toBeFocused();
});

// The same, without where the keyboard goes after Enter, while the gap above stands.
test("cmd+p from a thread's prompt opens the finder; Enter opens the file in a tab beside the thread, shown; ⌥⏎ tags it in the prompt", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(threadPrompt(page)).toBeFocused();
  await expect(page.getByTestId("shell-pane")).toHaveCount(1);

  await openFinder(page);
  await page.keyboard.type("app");
  await expect(palette(page).getByTestId("finder-row").first()).toHaveAttribute("data-path", "src/app.ts");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByTestId("file-tab")).toBeVisible();
  // A tab linked to the thread, in a pane of its own beside it.
  const filePane = paneWith(page, "file");
  await expect(filePane.locator('[data-testid="shell-tab"][data-kind="file"]')).toHaveAttribute("data-active", "true");
  await expect(filePane.locator('[data-testid="shell-tab"][data-kind="thread"]')).toHaveCount(0);

  await threadPrompt(page).click();
  await openFinder(page);
  await page.keyboard.type("x.md");
  await expect(palette(page).getByTestId("finder-row").first()).toHaveAttribute("data-path", "docs/notes/x.md");
  await page.keyboard.press("Alt+Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(threadPrompt(page).getByTestId("prompt-tag")).toHaveText("x.md");
  await expect(threadPrompt(page)).toBeFocused();
});
