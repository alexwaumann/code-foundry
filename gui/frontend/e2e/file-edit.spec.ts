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

/** The tab's draft key, for asking the library about it. */
async function stateKey(page: Page): Promise<string> {
  return page.evaluate(`__cfModule("/src/stores/fileEdit.ts").then((m) => Object.values(m.useFileEditStore.getState().sessions)[0]?.stateKey ?? "")`);
}

/** The text the library holds for a key, on or off screen. */
async function held(page: Page, key: string): Promise<string | null> {
  return page.evaluate(`__cfModule("/src/lib/codeEditor.ts").then((m) => m.draftText(${JSON.stringify(key)}))`);
}

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
  await expect(tabs(page)).toHaveText([/ vs /, "app.ts"]);

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

test("a rendered file edits as source: the editor mounts in place of the preview", async ({ page }) => {
  await openFile(page, "README.md");
  await expect(file(page).getByTestId("file-markdown")).toBeVisible();
  await startEditing(page);
  await expect(file(page)).toHaveAttribute("data-mode", "source");
  await page.keyboard.type("Hello ");
  await expect(status(page)).toHaveText("Unsaved");
  await page.keyboard.press("Meta+s");
  await expect.poll(() => disk(`${CF}/README.md`)).toMatch(/^Hello # code-foundry/);
  await file(page).getByTestId("file-edit").click();
  await expect(file(page).getByTestId("file-markdown")).toContainText("Hello");
});

test("Keep editing puts the caret back in the editor", async ({ page }) => {
  await openFile(page, "src/app.ts");
  await startEditing(page);
  await line(page, 1).click();
  await page.keyboard.press("Home");
  await page.keyboard.type("a");
  await page.keyboard.press("Meta+w");
  await page.getByTestId("confirm-cancel").click();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await page.keyboard.type("b");
  await expect(line(page, 1)).toContainText("abimport");
});

test("contents leave the library: on leaving a saved tab, on Discard, on the pencil, on closing", async ({ page }) => {
  const env = `${CF}/.env`;
  await writeDisk(env, "SECRET=1\n");
  await openFile(page, ".env");
  const thenLeft = async (leave: () => Promise<void>, key: string) => {
    await leave();
    await expect.poll(() => held(page, key)).toBeNull();
  };

  await startEditing(page);
  await page.keyboard.type("x");
  const saved = await stateKey(page);
  await page.keyboard.press("Meta+s");
  await expect(status(page)).toHaveText("Editing");
  expect(await held(page, saved)).toContain("xSECRET");
  await thenLeft(() => tabs(page).filter({ hasText: " vs " }).click(), saved);

  await tabs(page).filter({ hasText: ".env" }).click();
  await expect(status(page)).toHaveText("Editing");
  await line(page, 1).click();
  await page.keyboard.type("y");
  const discarded = await stateKey(page);
  await thenLeft(() => file(page).getByTestId("file-discard").click(), discarded);

  const stopped = await stateKey(page);
  await expect.poll(() => held(page, stopped)).not.toBeNull();
  await thenLeft(() => file(page).getByTestId("file-edit").click(), stopped);

  await startEditing(page);
  await page.keyboard.type("z");
  const closed = await stateKey(page);
  await page.keyboard.press("Meta+w");
  await thenLeft(() => page.getByTestId("confirm-alternate").click(), closed);
});

test("cmd+S saves the editor with the keyboard, not the focused group's tab, and never a hidden draft", async ({ page }) => {
  const a = `${CF}/a.txt`;
  const b = `${CF}/b.txt`;
  await writeDisk(a, "a\n");
  await writeDisk(b, "b\n");
  await openFile(page, "a.txt");
  await startEditing(page);
  await page.keyboard.type("A");
  // a.txt and a dirty b.txt side by side, then the keyboard in a.txt with group focus on b's.
  await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => m.splitPanel("current"))`);
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${JSON.stringify({ project: "repo-cf", base: CF, path: "b.txt" })}))`);
  const shown = (path: string) => page.locator(`[data-testid="file-tab"][data-path="${path}"]`);
  await shown(b).getByTestId("file-edit").click();
  await page.keyboard.type("B");
  await expect(shown(b).getByTestId("file-edit-status")).toHaveText("Unsaved");
  await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => {
    const tab = m.allTabs(m.getPanel("current")).find((t) => t.title === "b.txt");
    m.movePanelTabToGroup("current", tab.id, 0);
  })`);
  await expect(shown(a)).toBeVisible();
  await expect(shown(b)).toBeVisible();
  await shown(a).locator('[data-content][contenteditable="true"]').evaluate((el) => {
    (el as HTMLElement).focus();
  });
  await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => m.focusPanelGroup("current", 0))`);
  await page.keyboard.press("Meta+s");
  await expect.poll(() => disk(a)).toBe("Aa\n");
  expect(await disk(b)).toBe("b\n");

  // The panel closed, with the keyboard nowhere near: b's draft stays a draft.
  await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => m.togglePanel("current", false))`);
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
  await page.locator("body").click();
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(200);
  expect(await disk(b)).toBe("b\n");
});

test("a clean document following the file keeps the keyboard and the caret", async ({ page }) => {
  const notes = `${CF}/notes.txt`;
  await writeDisk(notes, "one\ntwo\n");
  await openFile(page, "notes.txt");
  await startEditing(page);
  await line(page, 2).click();
  await page.keyboard.press("End");
  await writeDisk(notes, "one\ntwo!\nthree\n");
  await page.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
  await page.evaluate(`document.querySelector('[data-testid="file-refresh"]').click()`);
  await expect(line(page, 3)).toContainText("three");
  await expect(file(page).locator("diffs-container")).toBeFocused();
  await page.keyboard.type("X");
  await expect(line(page, 2)).toContainText("twoX!");
});

test("moving a clean tab to the other group keeps its document and undo", async ({ page }) => {
  const notes = `${CF}/notes.txt`;
  await writeDisk(notes, "one\n");
  await openFile(page, "notes.txt");
  await startEditing(page);
  await page.keyboard.type("x");
  await page.keyboard.press("Meta+s");
  await expect(status(page)).toHaveText("Editing");
  const key = await stateKey(page);
  const id = await file(page).evaluate((el) => el.closest<HTMLElement>('[data-testid="panel-body"]')?.dataset.tabId ?? "");
  await page.evaluate(`__cfModule("/src/stores/panel.ts").then((m) => { m.splitPanel("current"); m.movePanelTabToGroup("current", ${JSON.stringify(id)}, 1); })`);
  await expect(editor(page)).toBeVisible();
  await page.waitForTimeout(100);
  expect(await stateKey(page)).toBe(key);
  await editor(page).evaluate((el) => {
    (el as HTMLElement).focus();
  });
  await page.keyboard.press("Meta+z");
  await expect(status(page)).toHaveText("Unsaved");
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

  await tabs(page).filter({ hasText: " vs " }).click();
  await expect(page.getByTestId("diff-compare-bar")).toBeVisible();
  await expect(page.getByTestId("tab-unsaved")).toBeVisible();
  await tabs(page).filter({ hasText: "long.txt" }).click();
  await expect(status(page)).toHaveText("Unsaved");
  await file(page).getByTestId("file-save").click();
  await expect(status(page)).toHaveText("Editing");
  await expect.poll(() => disk(long)).toMatch(/line 600\ntail$/);
});
