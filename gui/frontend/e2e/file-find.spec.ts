import { expect, test, type Page } from "@playwright/test";
import { CF, mockPost, openApp, openThreadChanges, resetMock, row, threadPrompt } from "./fixtures";

/**
 * Find in a File tab (docs/notes/file-find-in-file.md), for what only a browser shows: the
 * chord reaching the tab from its code, its editor and the thread's prompt, the matches
 * painted on @pierre/diffs' lines in its shadow root (Custom Highlights), a match off a long
 * file's virtualized screen scrolled to, at 125% zoom too, and the keyboard and selection
 * after Escape. The counting, stepping, routing and the bar's place are vitest's
 * (lib/fileFind.test.ts, stores/fileFind.test.ts, keys/bindings.test.ts, FileTab.test.tsx).
 */

const file = (page: Page) => page.getByTestId("file-tab");
const code = (page: Page) => file(page).getByTestId("file-code");
const bar = (page: Page) => page.getByTestId("file-find");
const field = (page: Page) => page.getByTestId("file-find-input");
const count = (page: Page) => page.getByTestId("file-find-count");

async function openFile(page: Page, path: string): Promise<void> {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await openThreadChanges(page);
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${JSON.stringify({ project: "repo-cf", base: CF, path })}))`);
  await expect(code(page).locator('[data-content] [data-line="1"]')).toBeVisible();
}

/** The current match as painted: its line, its text, and whether it lies inside the code's scroll box. */
async function current(page: Page): Promise<{ line: string; text: string; inView: boolean; size: number } | null> {
  return page.evaluate(() => {
    const h = CSS.highlights.get("cf-file-find-current");
    const all = CSS.highlights.get("cf-file-find");
    const r = h ? ([...h][0] as Range | undefined) : undefined;
    const box = document.querySelector('[data-testid="file-code"]');
    if (!r || !box) return null;
    const scroller = box.hasAttribute("data-virtual") ? (box.firstElementChild as Element) : box;
    const a = r.getBoundingClientRect();
    const b = scroller.getBoundingClientRect();
    const line = r.startContainer.parentElement?.closest("[data-line]")?.getAttribute("data-line") ?? "";
    return { line, text: r.toString(), inView: a.top >= b.top && a.bottom <= b.bottom && a.left >= b.left && a.right <= b.right, size: all?.size ?? 0 };
  });
}

const longText = `${Array.from({ length: 600 }, (_, i) => `line ${String(i + 1)} fox${i % 50 === 0 ? " dog" : ""}`).join("\n")}\n`;

test.beforeEach(async () => {
  await resetMock();
});

test("from the code: cmd+f finds in the file, steps scroll a long file to matches off screen, Escape selects the match", async ({ page }) => {
  await mockPost(`fs/write?path=${encodeURIComponent(`${CF}/long.txt`)}&text=${encodeURIComponent(longText)}`);
  await openFile(page, "long.txt");
  await expect(code(page)).toHaveAttribute("data-virtual", "");
  await code(page).locator('[data-content] [data-line="3"]').click();
  await expect(code(page)).toBeFocused();
  await page.keyboard.press("Meta+f");
  await expect(bar(page)).toBeVisible();
  await expect(page.getByTestId("thread-find")).toHaveCount(0);
  await expect(field(page)).toBeFocused();
  await page.keyboard.type("dog");
  await expect(count(page)).toHaveText("1 of 12");
  await expect.poll(() => current(page)).toMatchObject({ line: "1", text: "dog", inView: true });

  // Line 301 is far outside what the virtualizer has rendered: Enter scrolls there and paints it.
  for (let i = 0; i < 6; i++) await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("7 of 12");
  await expect.poll(() => current(page)).toMatchObject({ line: "301", text: "dog", inView: true });
  await page.keyboard.press("Shift+Enter");
  await expect.poll(() => current(page)).toMatchObject({ line: "251", inView: true });

  // Escape: the bar and its paint go, the code has the keyboard and the match is the selection.
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await expect(code(page)).toBeFocused();
  await expect.poll(() => page.evaluate(() => [getSelection()?.toString(), CSS.highlights.get("cf-file-find-current")?.size ?? 0])).toEqual(["dog", 0]);
  // The keyboard is still the tab's: cmd+g opens the bar again.
  await page.keyboard.press("Meta+g");
  await expect(bar(page)).toBeVisible();
});

test("at 125% zoom a stepped-to match is scrolled into view and painted on its text", async ({ page }) => {
  await mockPost(`fs/write?path=${encodeURIComponent(`${CF}/long.txt`)}&text=${encodeURIComponent(longText)}`);
  await openFile(page, "long.txt");
  await page.evaluate(`__cfModule("/src/stores/ui.ts").then((m) => m.useUiStore.getState().setZoom(125))`);
  await code(page).locator('[data-content] [data-line="2"]').click();
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("dog");
  for (let i = 0; i < 9; i++) await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("10 of 12");
  await expect.poll(() => current(page)).toMatchObject({ line: "451", text: "dog", inView: true });
  // The paint is the text's own range: its box starts where "dog" starts in the line.
  const offset = await page.evaluate(() => {
    const r = [...(CSS.highlights.get("cf-file-find-current") ?? [])][0] as Range;
    const line = r.startContainer.parentElement?.closest("[data-line]");
    const text = line?.textContent ?? "";
    const whole = document.createRange();
    whole.selectNodeContents(line as Node);
    const per = whole.getBoundingClientRect().width / text.length;
    return (r.getBoundingClientRect().left - whole.getBoundingClientRect().left) / per - text.indexOf("dog");
  });
  expect(Math.abs(offset)).toBeLessThan(0.25);
});

test("in the editor cmd+f is the tab's bar, not the library's panel; the bar and its match stay across the pencil", async ({ page }) => {
  await openFile(page, "src/app.ts");
  await file(page).getByTestId("file-edit").click();
  const editor = file(page).locator('[data-content][contenteditable="true"]');
  await expect(editor).toBeVisible();
  await page.keyboard.press("Meta+f");
  await expect(bar(page)).toBeVisible();
  await expect(file(page).locator("[data-search-panel]")).toHaveCount(0);
  await page.keyboard.type("value3");
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("2 of 9");
  await expect.poll(() => current(page)).toMatchObject({ text: "value3" });
  const line = (await current(page))?.line;

  await file(page).getByTestId("file-edit").click();
  await expect(editor).toHaveCount(0);
  await expect(count(page)).toHaveText("2 of 9");
  await expect.poll(() => current(page)).toMatchObject({ line, text: "value3" });
  await file(page).getByTestId("file-edit").click();
  await expect(editor).toBeVisible();
  await expect(count(page)).toHaveText("2 of 9");

  // Escape in edit mode: the editor has the keyboard with the match selected; typing replaces it.
  await field(page).press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await page.keyboard.type("Z");
  const key = await page.evaluate(`__cfModule("/src/stores/fileEdit.ts").then((m) => Object.values(m.useFileEditStore.getState().sessions)[0]?.stateKey ?? "")`);
  const draft = await page.evaluate(`__cfModule("/src/lib/codeEditor.ts").then((m) => m.draftText(${JSON.stringify(key)}))`);
  expect(String(draft).split("\n")[Number(line) - 1]).toMatch(/^const Z\d* = /);
});

test("cmd+f in the thread's prompt stays the thread's find with a File tab open", async ({ page }) => {
  await openFile(page, "src/app.ts");
  await code(page).click();
  await page.keyboard.press("Meta+f");
  await expect(bar(page)).toBeVisible();
  await threadPrompt(page).click();
  await page.keyboard.press("Meta+f");
  await expect(page.getByTestId("thread-find")).toBeVisible();
  await expect(page.getByTestId("thread-find-input")).toBeFocused();
  await expect(bar(page)).toBeVisible();
});

test("Rendered markdown: the page's text is searched and painted", async ({ page }) => {
  await openFile(page, "src/app.ts");
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${JSON.stringify({ project: "repo-cf", base: CF, path: "README.md" })}))`);
  const md = file(page).getByTestId("file-markdown");
  await expect(md.locator("h1")).toBeVisible();
  await md.locator("p").first().click();
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("worktree");
  await expect(count(page)).toHaveText(/^1 of \d+$/);
  const painted = await page.evaluate(() => {
    const r = [...(CSS.highlights.get("cf-file-find-current") ?? [])][0] as Range | undefined;
    return r ? [r.toString(), Boolean(r.startContainer.parentElement?.closest('[data-testid="file-markdown"]'))] : null;
  });
  expect(painted).toEqual(["worktree", true]);
});

/** SHOTS=<dir>: the bar under the header with matches painted, in view and edit mode, dark and light (2x). */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2 });
    test("the find bar in a File tab", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      const dir = String(shots);
      await openFile(page, "src/app.ts");
      await code(page).locator('[data-content] [data-line="2"]').click();
      await page.keyboard.press("Meta+f");
      await page.keyboard.type("value2");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${dir}/file-find-view-${scheme}.png` });
      await file(page).getByTestId("file-edit").click();
      await expect(file(page).locator('[data-content][contenteditable="true"]')).toBeVisible();
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${dir}/file-find-edit-${scheme}.png` });
    });
  });
}
