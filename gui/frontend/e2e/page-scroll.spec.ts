import { expect, test, type Page } from "@playwright/test";
import { CF, mockPost, openApp, openThreadChanges, resetMock, row } from "./fixtures";

/**
 * A page behind another tab is unloaded and loads afresh when shown again; it opens where the
 * reader left it (docs/notes/pages-tab-polish.md). What only a real browser shows: the frame
 * script reporting a wheel scroll, and putting it back after the load once the page has drawn
 * enough to reach it (a ResizeObserver in WebKit). Which places keep what, and when the page or
 * the user wins: src/lib/cfFrameScript.test.ts, src/components/files/HtmlFrame.test.tsx.
 */

// A page drawn after its load (its data came), tall enough to scroll.
const TALL = `<!doctype html><html><head><title>tall</title></head><body style="margin:0">
<p id="top">top</p>
<script>
setTimeout(() => {
  const list = document.createElement("ol");
  for (let i = 1; i <= 200; i++) { const li = document.createElement("li"); li.textContent = "row " + i; li.style.height = "30px"; list.append(li); }
  document.body.append(list);
}, 300);
</script>
</body></html>`;

const frame = (page: Page) => page.frameLocator('[data-testid="file-html-frame"]');
const scrollY = (page: Page) => frame(page).locator("body").evaluate(() => window.scrollY);

async function openFile(page: Page, path: string): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${JSON.stringify({ project: "repo-cf", base: CF, path })}))`);
}

test.beforeEach(async () => {
  await resetMock();
});

test("a page shown again after another tab opens where the reader left it", async ({ page }) => {
  await mockPost(`fs/write?path=${encodeURIComponent(`${CF}/docs/tall.html`)}&text=${encodeURIComponent(TALL)}`);
  await openApp(page);
  await row(page, "s:s-1").click();
  await openThreadChanges(page);
  await openFile(page, "docs/tall.html");
  await expect(frame(page).getByText("row 200")).toBeAttached();

  // The reader scrolls the page with the wheel.
  await page.getByTestId("file-html-frame").hover();
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(500);
  // Settled: the frame script reports once a frame.
  let left = -1;
  await expect.poll(async () => {
    const y = await scrollY(page);
    const same = y === left;
    left = y;
    return same;
  }).toBe(true);

  // Another tab in front: the page's frame goes.
  await openFile(page, "README.md");
  await expect(page.getByTestId("file-html-frame")).toHaveCount(0);

  // Back: the page loads afresh, draws its rows late, and is put back where it was.
  await page.locator('[data-testid="shell-tab"][data-kind="file"]').filter({ hasText: "tall.html" }).getByRole("tab").click();
  await expect(frame(page).getByText("row 200")).toBeAttached();
  await expect.poll(() => scrollY(page)).toBe(left);
});
