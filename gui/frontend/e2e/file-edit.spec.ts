import { expect, test, type Locator, type Page } from "@playwright/test";
import { CF, mockPost, mockUrl, openApp, openThreadChanges, resetMock, row } from "./fixtures";

/**
 * Editing a file in the File tab (docs/notes/file-edit-2-gui.md), for what only a browser
 * shows: @pierre/diffs' editor in its shadow root taking keys, chords and a paste, and its
 * document surviving what a re-read would do to it. The states, guards, conflicts, the
 * close dialog and what writeFile is called with are src/components/files/FileTab.test.tsx's
 * and src/stores/fileEdit.test.ts's.
 */

const file = (page: Page) => page.getByTestId("file-tab");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const status = (page: Page) => page.getByTestId("file-edit-status");
/** The library's contenteditable; CSS locators pierce its shadow root. */
const editor = (page: Page): Locator => file(page).locator('[data-content][contenteditable="true"]');
const line = (page: Page, n: number) => editor(page).locator(`[data-line="${String(n)}"]`);

async function disk(path: string): Promise<string | null> {
  const res = await fetch(`${mockUrl}/__mock/fs/text?path=${encodeURIComponent(path)}`);
  return ((await res.json()) as { text: string | null }).text;
}

async function writeDisk(path: string, text: string): Promise<void> {
  await mockPost(`fs/write?path=${encodeURIComponent(path)}&text=${encodeURIComponent(text)}`);
}

/** Selects a thread and opens a file in its panel, ready to edit. */
async function openFile(page: Page, path: string): Promise<void> {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await openThreadChanges(page);
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${JSON.stringify({ project: "repo-cf", base: CF, path })}))`);
  await expect(file(page).getByTestId("file-edit")).toBeVisible();
}

/** Turns the editor on; the pencil puts the caret in it. */
async function startEditing(page: Page): Promise<void> {
  await file(page).getByTestId("file-edit").click();
  await expect(editor(page)).toBeVisible();
  await expect(status(page)).toHaveText("Editing");
}

test.beforeEach(async () => {
  await resetMock();
});

test("typing goes into the document and cmd+S saves it from inside the shadow root, line endings as they were", async ({ page }) => {
  const env = `${CF}/.env`;
  await writeDisk(env, "A=1\r\nB=2\r\n");
  await openFile(page, ".env");
  await startEditing(page);
  await line(page, 1).click();
  await page.keyboard.press("End");
  await page.keyboard.type("0");
  await expect(status(page)).toHaveText("Unsaved");
  await page.keyboard.press("Meta+s");
  await expect(status(page)).toHaveText("Editing");
  await expect.poll(() => disk(env)).toBe("A=10\r\nB=2\r\n");
  // Enter takes the document's line ending, and the tab stays in edit mode.
  await page.keyboard.press("Enter");
  await page.keyboard.type("C=3");
  await page.keyboard.press("Meta+s");
  await expect.poll(() => disk(env)).toBe("A=10\r\nC=3\r\nB=2\r\n");
  await expect(editor(page)).toBeVisible();
});

test("with the caret in the editor, its chords are its own and typing fires no shortcut", async ({ page }) => {
  await openFile(page, "src/app.ts");
  await startEditing(page);
  await line(page, 1).click();
  // The letters that open surfaces while the panel has focus are text here.
  await page.keyboard.press("Home");
  await page.keyboard.type("fdwc ");
  await expect(line(page, 1)).toContainText("fdwc import");
  await expect(tabs(page)).toHaveText(["Changes", "app.ts"]);

  // cmd+F is the editor's find, not the thread's.
  await page.keyboard.press("Meta+f");
  await expect(file(page).locator("[data-search-panel] input").first()).toBeFocused();
  await expect(page.getByTestId("thread-find")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(file(page).locator("[data-search-panel]")).toHaveCount(0);
  await line(page, 1).click();

  // cmd+] indents, where it would otherwise be Forward.
  await page.keyboard.press("Meta+]");
  await expect(line(page, 1)).toContainText("    fdwc import");
  // A chord bound to a command still works, as in a thread's prompt.
  await page.keyboard.press("Meta+j");
  await expect(page.getByTestId("bottom-panel")).toBeVisible();
});

test("a paste lands at the caret and takes the document's line endings", async ({ page }) => {
  const env = `${CF}/.env`;
  await writeDisk(env, "A=1\r\n");
  await openFile(page, ".env");
  await startEditing(page);
  await line(page, 1).click();
  await page.keyboard.press("End");
  await editor(page).evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text", "\nB=2\nC=3");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true, composed: true }));
  });
  await expect(status(page)).toHaveText("Unsaved");
  await page.keyboard.press("Meta+s");
  await expect.poll(() => disk(env)).toBe("A=1\r\nB=2\r\nC=3\r\n");
});

test("a write from outside never reaches a draft: the band offers Reload and Overwrite", async ({ page }) => {
  const notes = `${CF}/notes.txt`;
  await writeDisk(notes, "mine\n");
  await openFile(page, "notes.txt");
  await startEditing(page);
  await line(page, 1).click();
  await page.keyboard.press("Home");
  await page.keyboard.type("draft ");
  await writeDisk(notes, "theirs\n");
  await file(page).getByTestId("file-refresh").click();
  await expect(file(page).getByTestId("file-conflict")).toContainText("Changed on disk");
  await expect(line(page, 1)).toContainText("draft mine");

  await file(page).getByTestId("file-overwrite").click();
  await expect(file(page).getByTestId("file-conflict")).toHaveCount(0);
  await expect.poll(() => disk(notes)).toBe("draft mine\n");

  await line(page, 1).click();
  await page.keyboard.type("x");
  await writeDisk(notes, "theirs again\n");
  await file(page).getByTestId("file-refresh").click();
  await file(page).getByTestId("file-reload").click();
  await expect(line(page, 1)).toContainText("theirs again");
  await expect(status(page)).toHaveText("Editing");
});

test("a draft survives leaving the tab, and a long file edits through the virtualizer", async ({ page }) => {
  const long = `${CF}/long.txt`;
  await writeDisk(long, `${Array.from({ length: 600 }, (_, i) => `line ${String(i + 1)}`).join("\n")}\n`);
  await openFile(page, "long.txt");
  await expect(file(page).getByTestId("file-code")).toHaveAttribute("data-virtual", "");
  await startEditing(page);
  await line(page, 1).click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("tail");
  await expect(status(page)).toHaveText("Unsaved");
  await expect(page.getByTestId("tab-unsaved")).toBeVisible();

  await tabs(page).filter({ hasText: "Changes" }).click();
  await expect(page.getByTestId("worktree-changes")).toBeVisible();
  await expect(page.getByTestId("tab-unsaved")).toBeVisible();
  await tabs(page).filter({ hasText: "long.txt" }).click();
  await expect(status(page)).toHaveText("Unsaved");
  await file(page).getByTestId("file-save").click();
  await expect(status(page)).toHaveText("Editing");
  await expect.poll(() => disk(long)).toMatch(/line 600\ntail$/);
});
