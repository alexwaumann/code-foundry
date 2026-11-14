import { expect, test, type Locator, type Page } from "@playwright/test";
import { CF, mockPost, mockUrl, openApp, openThreadChanges, resetMock, row, setZoom } from "./fixtures";
import { openShellApp, paneNode, rowNode, seedLayout, threadTab } from "./shell";
import { diffTab, paneWith, stripTabs } from "./shell-surfaces";

/**
 * Editing a file in the File tab (docs/notes/file-edit-2-gui.md), for what only a browser
 * shows: @pierre/diffs' editor in its shadow root taking keys, chords and a paste, and its
 * document surviving what a re-read would do to it. The states, guards, conflicts, the
 * close dialog and what writeFile is called with are src/components/files/FileTab.test.tsx's
 * and src/stores/fileEdit.test.ts's.
 */

const file = (page: Page) => page.getByTestId("file-tab");
/** The tabs of the pane beside the thread's that holds its diff and its files. */
const tabs = (page: Page) => stripTabs(paneWith(page, "diff"));
/** The thread's Diff tab: named "Diff" until its surface has drawn once and titled it with its compare. */
const diffTabButton = (page: Page) => paneWith(page, "diff").locator('[data-testid="shell-tab"][data-kind="diff"] [role="tab"]');
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

/** Opens a thread's tab, its diff and a file linked to it (beside the thread, with the diff), ready to edit. */
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
  // Letters that would be shortcuts elsewhere are text here.
  await page.keyboard.press("Home");
  await page.keyboard.type("fdwc ");
  await expect(line(page, 1)).toContainText("fdwc import");
  await expect(tabs(page)).toHaveText([/ vs |^Diff$/, "app.ts"]);

  // cmd+F is the tab's find (e2e/file-find.spec.ts), not the thread's.
  await page.keyboard.press("Meta+f");
  await expect(page.getByTestId("file-find-input")).toBeFocused();
  await expect(page.getByTestId("thread-find")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("file-find")).toHaveCount(0);
  await line(page, 1).click();

  // cmd+] indents, where it would otherwise be Forward.
  await page.keyboard.press("Meta+]");
  await expect(line(page, 1)).toContainText("    fdwc import");
  // A chord bound to a command still works, as in a thread's prompt: cmd+j from a linked surface
  // goes to its thread and opens its quick terminal.
  await page.keyboard.press("Meta+j");
  await expect(page.getByTestId("quick-terminal")).toBeVisible();
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
  await thenLeft(() => diffTabButton(page).click(), saved);

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

test("a dirty file put away with its thread keeps its edits: cmd+w on the thread asks nothing, and the file comes back unsaved", async ({ page }) => {
  const env = `${CF}/.env`;
  await writeDisk(env, "SECRET=1\n");
  await openFile(page, ".env");
  await startEditing(page);
  await page.keyboard.type("x");
  await expect(status(page)).toHaveText("Unsaved");
  // The thread's own tab closes the thread from its space, its linked tabs with it.
  await page.locator('[data-testid="shell-tab"][data-kind="thread"] [role="tab"]').first().click();
  await page.keyboard.press("Meta+w");
  await expect(page.getByTestId("thread-pane")).toHaveCount(0);
  await expect(file(page)).toHaveCount(0);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  // The thread again, and its file: the edits are there, still unsaved, nothing written.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${JSON.stringify({ project: "repo-cf", base: CF, path: ".env" })}))`);
  await expect(status(page)).toHaveText("Unsaved");
  await expect(line(page, 1)).toContainText("xSECRET=1");
  expect(await disk(env)).toBe("SECRET=1\n");
});

test("cmd+S saves the editor with the keyboard, not the focused pane's tab, and never a hidden draft", async ({ page }) => {
  const a = `${CF}/a.txt`;
  const b = `${CF}/b.txt`;
  await writeDisk(a, "a\n");
  await writeDisk(b, "b\n");
  // a.txt and b.txt side by side, each in its own pane beside the thread, b's over the thread's diff.
  const fileOf = (id: string, path: string) => ({ id, kind: "file", thread: "s-1", params: { project: "repo-cf", base: CF, path }, title: path.split("/").pop() });
  // Wide enough for three panes at their 480px minimum (docs/notes/shell-25f-sizes.md).
  await page.setViewportSize({ width: 1800, height: 900 });
  await seedLayout(rowNode([paneNode("p-1", [threadTab("s-1")]), paneNode("p-2", [fileOf("t-a", a)]), paneNode("p-3", [fileOf("t-b", b), diffTab("s-1")])], [0.34, 0.33, 0.33]), "p-1");
  await openShellApp(page);
  const shown = (path: string) => page.locator(`[data-testid="file-tab"][data-path="${path}"]`);
  // The pencil, then a press at the start of the line (the press also focuses the pane).
  const typeAt = async (path: string, text: string) => {
    await shown(path).getByTestId("file-edit").click();
    const first = shown(path).locator('[data-content][contenteditable="true"] [data-line="1"]');
    await first.click();
    await page.keyboard.press("Home");
    await page.keyboard.type(text);
  };
  await typeAt(a, "A");
  await expect(shown(a).getByTestId("file-edit-status")).toHaveText("Unsaved");
  await typeAt(b, "B");
  await expect(shown(b).getByTestId("file-edit-status")).toHaveText("Unsaved");
  // The keyboard in a.txt's editor, with the focused pane b's.
  await shown(a).locator('[data-content][contenteditable="true"]').evaluate((el) => {
    (el as HTMLElement).focus();
  });
  await page.evaluate(`__cfModule("/src/stores/layout.ts").then((m) => m.focusPane("p-3"))`);
  await expect(page.locator('[data-testid="shell-pane"][data-pane-id="p-3"]')).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("Meta+s");
  await expect.poll(() => disk(a)).toBe("Aa\n");
  expect(await disk(b)).toBe("b\n");

  // b's tab behind the diff, with the keyboard nowhere near: its draft stays a draft.
  await page.locator('[data-testid="shell-pane"][data-pane-id="p-3"] [data-testid="shell-tab"][data-kind="diff"] [role="tab"]').click();
  await expect(shown(b)).toHaveCount(0);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
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

test("moving a clean tab to another pane keeps its document and undo", async ({ page }) => {
  // Tall enough for a pane under the diff's, both at their 400px minimum.
  await page.setViewportSize({ width: 1280, height: 900 });
  const notes = `${CF}/notes.txt`;
  await writeDisk(notes, "one\n");
  await openFile(page, "notes.txt");
  await startEditing(page);
  await page.keyboard.type("x");
  await page.keyboard.press("Meta+s");
  await expect(status(page)).toHaveText("Editing");
  const key = await stateKey(page);
  // Into a pane of its own below the diff's (what dropping it on that pane's bottom edge sends).
  const id = await page.locator('[data-testid="shell-tab"][data-kind="file"]').getAttribute("data-tab-id");
  const pane = await paneWith(page, "file").getAttribute("data-pane-id");
  await page.evaluate(`__cfModule("/src/api/layout.ts").then((m) => m.applyLayoutOp({ op: "move_tab", tab: ${JSON.stringify(id)}, pane: ${JSON.stringify(pane)}, edge: "bottom" }))`);
  await expect(paneWith(page, "file")).not.toHaveAttribute("data-pane-id", String(pane));
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

  await diffTabButton(page).click();
  await expect(page.getByTestId("diff-compare-bar")).toBeVisible();
  await expect(page.getByTestId("tab-unsaved")).toBeVisible();
  await tabs(page).filter({ hasText: "long.txt" }).click();
  await expect(status(page)).toHaveText("Unsaved");
  await file(page).getByTestId("file-save").click();
  await expect(status(page)).toHaveText("Editing");
  await expect.poll(() => disk(long)).toMatch(/line 600\ntail$/);
});

/**
 * Where grapheme `index` of line `n` starts, and its row's middle, in viewport px: the grapheme
 * wrapped in a span, in a copy of the row laid out beside it and removed in the same task, so
 * the editor never sees it. Not a Range over the row's own text: WebKit floors a Range's left
 * inside a text run to a whole zoomed px, so with a fractional advance (7.2 layout px, 12.6 at
 * 175%) it reads up to 1 viewport px left of where the glyph is laid out and painted, while an
 * element's rect is exact (docs/notes/shell-25h-caret.md).
 */
async function glyph(page: Page, n: number, index: number): Promise<{ x: number; y: number }> {
  return line(page, n).evaluate((row, i) => {
    const seg = [...new Intl.Segmenter().segment(row.textContent)][i];
    if (!seg) throw new Error(`no grapheme ${String(i)}`);
    const copy = row.cloneNode(true) as HTMLElement;
    row.after(copy);
    try {
      const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
      let start = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        if (seg.index < start + text.length) {
          const own = text.splitText(seg.index - start);
          own.splitText(seg.segment.length);
          const mark = document.createElement("span");
          own.replaceWith(mark);
          mark.append(own);
          const r = mark.getBoundingClientRect();
          const shift = row.getBoundingClientRect().top - copy.getBoundingClientRect().top;
          return { x: r.left, y: (r.top + r.bottom) / 2 + shift };
        }
        start += text.length;
      }
      throw new Error(`grapheme ${String(i)} is not in one text node`);
    } finally {
      copy.remove();
    }
  }, index);
}

/** How far the drawn caret is from the start of grapheme `index` of line `n`, in viewport px (half the vertical distance counts). */
async function caretOff(page: Page, n: number, index: number, zoom: number): Promise<number> {
  const at = await glyph(page, n, index);
  const caret = await file(page)
    .locator("[data-caret]")
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: (r.top + r.bottom) / 2 };
    });
  // The library centres its 2px caret on the boundary: one layout px to the left of it.
  return Math.round(Math.max(Math.abs(caret.x + zoom - at.x), Math.abs(caret.y - at.y) / 2) * 10) / 10;
}

test("caret and selection sit on an emoji line's text at 125%, wrapped or not, and follow it when the zoom changes", async ({ page }) => {
  // Emoji and ZWJ sequences are measured in the DOM (docs/notes/file-edit-zoom.md); the long line wraps in the pane.
  const wide = `${"abcdefghijklmnopqrstuvwxyz".split("").map((c) => `${c}😀`).join("")} and the end`;
  const wideLine = `const wide = "${wide}";`;
  await writeDisk(`${CF}/src/emoji.ts`, `const emoji = "😀 smile 👨‍👩‍👧 family after";\n${wideLine}\n`);
  await openFile(page, "src/emoji.ts");
  await startEditing(page);
  await setZoom(page, 125);
  const after = 33; // the "f" of "after"
  const smile = 17; // the "s" of "smile"
  // The "n" of "end": the emoji run wraps anywhere, so its rows move with the zoom; a word's second letter never starts one.
  const end = [...new Intl.Segmenter().segment(wideLine.slice(0, wideLine.indexOf("end")))].length + 1;

  let at = await glyph(page, 1, after);
  await page.mouse.click(at.x + 1, at.y);
  await expect.poll(() => caretOff(page, 1, after, 1.25)).toBeLessThan(1);
  const from = await glyph(page, 1, smile);
  await page.keyboard.down("Shift");
  await page.mouse.click(from.x + 1, from.y);
  await page.keyboard.up("Shift");
  await expect(file(page).locator("[data-selection-range]")).toHaveCount(1);
  const range = await file(page)
    .locator("[data-selection-range]")
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
  expect(Math.abs(range.left - from.x)).toBeLessThan(1);
  expect(Math.abs(range.right - at.x)).toBeLessThan(1);

  await page.evaluate(`__cfModule("/src/stores/codeView.ts").then((m) => m.setWrap(true))`);
  await expect.poll(() => line(page, 2).evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(50);
  at = await glyph(page, 2, end);
  await page.mouse.click(at.x + 1, at.y);
  await expect.poll(() => caretOff(page, 2, end, 1.25)).toBeLessThan(1);

  // To 90% with the editor open: the caret follows its text on its own (an emoji's layout width differs per
  // zoom, and so may the wrap points), and no width measured at 125% is reused.
  await setZoom(page, 90);
  await expect.poll(() => caretOff(page, 2, end, 0.9)).toBeLessThan(1);
  at = await glyph(page, 2, end);
  await page.mouse.click(at.x + 1, at.y);
  await expect.poll(() => caretOff(page, 2, end, 0.9)).toBeLessThan(1);
  at = await glyph(page, 1, after);
  await page.mouse.click(at.x + 1, at.y);
  await expect.poll(() => caretOff(page, 1, after, 0.9)).toBeLessThan(1);
});

/**
 * Resolves once a ResizeObserver made now on the editor's content has been called. Observers are
 * called in the order they were made, so the editor's own (made when it mounted) has by then
 * handled every resize so far. Its handler re-applies the selection the editor holds, so a click
 * in the same frame as the resize, before that handler, would be undone before the editor read it
 * (docs/notes/shell-25h-caret.md).
 */
async function editorSawResize(page: Page): Promise<void> {
  await file(page)
    .locator("[data-content]")
    .evaluate(
      (el) =>
        new Promise<void>((resolve) => {
          const observer = new ResizeObserver(() => {
            observer.disconnect();
            resolve();
          });
          observer.observe(el);
        }),
    );
}

// The pane widths include the ones where the Range-based measure read the caret 1 px off (2450 and
// 2500 at 175%): each width moves the wrap points, so the clicked graphemes land on other columns.
for (const zoom of [150, 175]) {
  test(`at ${String(zoom)}% the caret sits on its text on every row of a wrapped ASCII line, at every pane width`, async ({ page }) => {
    // From 2305 the file's pane stays open beside the thread's at 175%.
    await page.setViewportSize({ width: 2305, height: 1100 });
    const words = Array.from({ length: 6 }, () => "lorem ipsum dolor sit amet consectetur adipiscing elit").join(" ");
    await writeDisk(`${CF}/src/words.ts`, `const words = "${words}";\n`);
    await openFile(page, "src/words.ts");
    await page.evaluate(`__cfModule("/src/stores/codeView.ts").then((m) => m.setWrap(true))`);
    await startEditing(page);
    await setZoom(page, zoom);
    const text = `const words = "${words}";`;
    // The "o" of the last "lorem", the "i" of the last "elit", the "p" of the first "ipsum", the "i" of
    // the last "sit": second letters, so never a row's first, on rows from the first to the last.
    const indexes = [text.lastIndexOf("lorem") + 1, text.lastIndexOf("elit") + 1, text.indexOf("ipsum") + 1, text.lastIndexOf("sit") + 1];
    const content = file(page).locator("[data-content]");
    const contentWidth = () => content.evaluate((el) => el.getBoundingClientRect().width);
    for (const width of [2305, 2350, 2400, 2425, 2450, 2475, 2500]) {
      const before = await contentWidth();
      await page.setViewportSize({ width, height: 1100 });
      // The pane, and the editor's text in it, takes the new width before anything is measured.
      if (width !== 2305) await expect.poll(contentWidth).not.toBe(before);
      await editorSawResize(page);
      for (const index of indexes) {
        const at = await glyph(page, 1, index);
        await page.mouse.click(at.x + 1, at.y);
        await expect.poll(() => caretOff(page, 1, index, zoom / 100), `${String(width)} px, grapheme ${String(index)}`).toBeLessThan(0.1);
      }
    }
  });
}
