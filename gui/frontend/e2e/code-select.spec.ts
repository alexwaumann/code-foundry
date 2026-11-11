import { expect, test, type Locator, type Page } from "@playwright/test";
import { CF, openApp, openThreadChanges, resetMock, row } from "./fixtures";

/**
 * Selecting and copying read-only code (docs/notes/file-view-select.md): @pierre/diffs draws
 * in a shadow root, which inherited the body's `user-select: none` until the code column
 * opted back in (components/code/codeCss.ts). Only a browser lays out a selection, so all of
 * this is here.
 */

const file = (page: Page) => page.getByTestId("file-tab");
const line = (page: Page, n: number): Locator => file(page).getByTestId("file-code").locator(`[data-content] [data-line="${String(n)}"]`);

async function openFile(page: Page, path: string, at?: number): Promise<void> {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await openThreadChanges(page);
  const target = JSON.stringify({ project: "repo-cf", base: CF, path, ...(at ? { line: at } : {}) });
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
  await expect(line(page, 1)).toBeVisible();
}

/** Records the selection's text at each copy event: WebKit lets no test read the clipboard back. */
async function recordCopies(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    document.addEventListener("copy", () => w.__copied.push(getSelection()?.toString() ?? ""), true);
  });
}

const copies = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
const selected = (page: Page) => page.evaluate(() => getSelection()?.toString() ?? "");

async function box(l: Locator): Promise<{ x: number; y: number; w: number; h: number }> {
  // The line's text: from its first token's left to its last token's right.
  const first = await l.locator("span").first().boundingBox();
  const last = await l.locator("span").last().boundingBox();
  if (!first || !last) throw new Error("line not laid out");
  return { x: first.x, y: first.y, w: last.x + last.width - first.x, h: first.height };
}

test.beforeEach(async () => {
  await resetMock();
});

test("the File tab's code selects by drag, double-click and shift-click and copies without line numbers", async ({ page }) => {
  await openFile(page, "src/app.ts");
  await recordCopies(page);
  const two = await box(line(page, 2));
  const four = await box(line(page, 4));

  // A drag from the middle of line 2 to the end of line 4: text only, the gutter left out.
  await page.mouse.move(two.x + 6 * 7.2, two.y + two.h / 2);
  await page.mouse.down();
  await page.mouse.move(four.x + four.w + 20, four.y + four.h / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => selected(page)).toBe("value2 = 2 * 2;\n/** Starts the app on a port. */\nconst value4 = 4 * 2;");
  await page.keyboard.press("Meta+c");
  await expect.poll(() => copies(page)).toEqual(["value2 = 2 * 2;\n/** Starts the app on a port. */\nconst value4 = 4 * 2;"]);

  // A drag that starts on the line numbers selects nothing.
  const gutter = await file(page).getByTestId("file-code").locator('[data-column-number="2"]').boundingBox();
  if (!gutter) throw new Error("no gutter");
  await page.mouse.move(gutter.x + gutter.width / 2, gutter.y + gutter.height / 2);
  await page.mouse.down();
  await page.mouse.move(four.x + four.w, four.y + four.h / 2, { steps: 5 });
  await page.mouse.up();
  expect(await selected(page)).not.toMatch(/\d\n\d/);

  // A double-click takes the word; shift-click extends to where it lands.
  await page.mouse.dblclick(two.x + 8 * 7.2, two.y + two.h / 2);
  await expect.poll(() => selected(page)).toBe("value2");
  await page.keyboard.down("Shift");
  await page.mouse.click(four.x + 5 * 7.2, four.y + four.h / 2);
  await page.keyboard.up("Shift");
  await expect.poll(() => selected(page)).toMatch(/^value2 = 2 \* 2;\n\/\*\* Starts the app on a port\. \*\/\ncons/);

  // The selection takes the theme's colour inside the shadow root.
  const colours = await page.evaluate(() => {
    const host = document.querySelector('[data-testid="file-tab"] diffs-container');
    const el = host?.shadowRoot?.querySelector('[data-content] [data-line="2"]');
    return el ? [getComputedStyle(el, "::selection").backgroundColor, getComputedStyle(document.body).getPropertyValue("--cf-selection").trim()] : [];
  });
  expect(colours[0]).not.toBe("");
  expect(colours[0]).not.toBe("rgba(0, 0, 0, 0)");
});

test("a marked line stays marked while text around it is selected", async ({ page }) => {
  await openFile(page, "src/app.ts", 3);
  const marked = file(page).getByTestId("file-code").locator('[data-line="3"][data-selected-line]').first();
  await expect(marked).toBeVisible();
  const two = await box(line(page, 2));
  await page.mouse.dblclick(two.x + 8 * 7.2, two.y + two.h / 2);
  await expect.poll(() => selected(page)).toBe("value2");
  await expect(marked).toBeVisible();
});
