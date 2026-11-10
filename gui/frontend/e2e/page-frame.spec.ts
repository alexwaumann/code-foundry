import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, openApp, openThreadChanges, resetMock, row } from "./fixtures";

/**
 * What a page's frame cannot do by itself, in a real browser (docs/notes/page-frame-links.md):
 * the script the daemon writes into the document sends a link to another site to the
 * browser and leaves the frame where it is, answers a dialog, and Refresh brings back a
 * page that went elsewhere. The script's rules are src/lib/cfFrameScript.test.ts and what
 * the app does with its messages is src/components/files/HtmlFrame.test.tsx.
 */

const PAGE = `<!doctype html><html><head><title>links</title></head><body>
<a id="out" href="https://example.com/out">out</a>
<a id="blank" href="https://example.com/blank" target="_blank">blank</a>
<button id="open" onclick="window.open('https://example.com/opened')">open</button>
<button id="ask" onclick="this.textContent = String(confirm('Sure?'))">ask</button>
<a id="next" href="tall.html">next</a>
</body></html>`;

const frame = (page: Page) => page.frameLocator('[data-testid="file-html-frame"]');

/** The URLs view.open.url was asked to open, in order. */
async function opened(): Promise<string[]> {
  return (await invocations()).filter((i) => i.name === "view.open.url").map((i) => i.args.url ?? "");
}

test.beforeEach(async () => {
  await resetMock();
});

test("a page's links to other sites open in the browser, a dialog answers and is reported, and Refresh brings the page back", async ({ page }) => {
  await mockPost(`fs/write?path=${encodeURIComponent(`${CF}/docs/plain.html`)}&text=${encodeURIComponent(PAGE)}`);
  await mockPost(`fs/write?path=${encodeURIComponent(`${CF}/docs/tall.html`)}&text=${encodeURIComponent('<!doctype html><p id="other">the other page</p>')}`);
  await openApp(page);
  await row(page, "s:s-1").click();
  await openThreadChanges(page);
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${JSON.stringify({ project: "repo-cf", base: CF, path: "docs/plain.html" })}))`);
  const f = frame(page);

  // A plain link and a _blank one: the browser, and the frame still shows the page.
  await f.locator("#out").click();
  await expect.poll(opened).toEqual(["https://example.com/out"]);
  await expect(f.locator("#out")).toBeVisible();
  await expect.poll(async () => {
    await f.locator("#blank").click();
    return opened();
  }).toEqual(["https://example.com/out", "https://example.com/blank"]);

  // window.open from a click.
  await expect.poll(async () => {
    await f.locator("#open").click();
    return opened();
  }).toEqual(["https://example.com/out", "https://example.com/blank", "https://example.com/opened"]);

  // confirm() answers false without a dialog, and the footer's badge says so.
  await f.locator("#ask").click();
  await expect(f.locator("#ask")).toHaveText("false");
  await page.getByTestId("file-html-footer").getByRole("button").click();
  await expect(page.getByTestId("page-error")).toContainText("confirm()");
  await page.keyboard.press("Escape");

  // The page's own other file loads in the frame; Refresh loads the page again.
  await f.locator("#next").click();
  await expect(f.locator("#other")).toBeVisible();
  await page.getByTestId("file-refresh").click();
  await expect(f.locator("#out")).toBeVisible();
});
