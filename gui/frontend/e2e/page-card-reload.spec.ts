import { expect, test, type Page } from "@playwright/test";
import { CF, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * An inline page's card reloads when its file is written, however it is written
 * (docs/notes/page-card-reload.md): the mock's thread in its "html" state shows
 * docs/hello.html, and /__mock/fs/write rewrites it (an editor's save, `cp` over it) or only
 * moves its time (`touch`). No tool call of the thread names the file: the card hears the
 * file's stamp (stores/fileStamps.ts), not the log.
 */

test.beforeEach(async () => {
  await resetMock();
});

const FILE = `${CF}/docs/hello.html`;
const card = (page: Page) => page.getByTestId("thread-html").filter({ hasText: "hello.html" }).getByTestId("thread-html-card");
const doc = (page: Page) => card(page).frameLocator('[data-testid="thread-html-frame"]');

async function openHtmlThread(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 900 });
  await mockPost("thread?state=html");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(doc(page).locator("#hello")).toHaveText("Hello");
}

async function write(text: string): Promise<void> {
  await mockPost(`fs/write?path=${encodeURIComponent(FILE)}&text=${encodeURIComponent(text)}`);
}

async function touch(): Promise<void> {
  await mockPost(`fs/write?path=${encodeURIComponent(FILE)}&touch=1`);
}

const healthy = (title: string) => `<!doctype html><html><body><h1 id="hello">${title}</h1><button id="wave" type="button" onclick="this.textContent='Waved'">Wave</button></body></html>`;

/**
 * A page that fails as it loads, as the user's did: bridge.js throws on a source that does
 * not exist, and the page's own handler draws a red box (jsx.js's, there). Each load stamps
 * the box, so a reload shows even when the contents are the same.
 */
const broken = `<!doctype html><html><head><script src="/cf/bridge.js"></script></head><body>
<div id="hello" style="color:red"></div>
<script>
addEventListener("error", (e) => { const box = document.getElementById("hello"); box.textContent = "Error: " + e.message; box.dataset.load = String(Math.random()); });
cf.on("project-list", () => {});
</script>
</body></html>`;

test("a healthy page reloads on a write in place, a rewrite of the same size, and a touch", async ({ page }) => {
  await openHtmlThread(page);
  await write(healthy("Edited"));
  await expect(doc(page).locator("#hello")).toHaveText("Edited");
  // cp over the file with contents of the same length: only the time tells.
  await write(healthy("Edytid"));
  await expect(doc(page).locator("#hello")).toHaveText("Edytid");
  // touch: the page runs again (its state goes), contents unchanged.
  await doc(page).locator("#wave").click();
  await expect(doc(page).locator("#wave")).toHaveText("Waved");
  await touch();
  await expect(doc(page).locator("#wave")).toHaveText("Wave");
  // Nothing written: no reload.
  await doc(page).locator("#wave").click();
  await page.waitForTimeout(2500);
  await expect(doc(page).locator("#wave")).toHaveText("Waved");
});

test("a page that errored on load reloads when it is fixed, and when it is only touched", async ({ page }) => {
  await openHtmlThread(page);
  await write(broken);
  const box = doc(page).locator("#hello");
  await expect(box).toHaveText(/^Error: .*no source project-list/);
  // Touched only: it runs (and fails) again.
  const first = await box.getAttribute("data-load");
  await touch();
  await expect(box).not.toHaveAttribute("data-load", first ?? "");
  await expect(box).toHaveText(/^Error: /);
  // Fixed (cp of the corrected file over it).
  await write(healthy("Fixed"));
  await expect(box).toHaveText("Fixed");
});

test("the expanded page reloads on a write too", async ({ page }) => {
  await openHtmlThread(page);
  await card(page).getByTestId("thread-html-expand").click();
  const big = page.getByTestId("thread-html-lightbox").frameLocator('[data-testid="thread-html-lightbox-frame"]');
  await expect(big.locator("#hello")).toHaveText("Hello");
  await write(healthy("Edited"));
  await expect(big.locator("#hello")).toHaveText("Edited");
});
