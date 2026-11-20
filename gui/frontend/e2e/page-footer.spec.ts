import { expect, test, type Page } from "@playwright/test";
import { CF, mockPost, openApp, openThreadChanges, resetMock, row } from "./fixtures";

/**
 * SHOTS=<dir> only: the File tab's footer in each state of a page (docs/notes/pages-tab-polish.md),
 * dark and light, for the pull request. The words per state are src/components/files/pageFooter.test.ts's
 * and HtmlPreview.consent.test.tsx's.
 */

const shots = process.env.SHOTS;
const PAGE = "<!doctype html><html><head><title>p</title></head><body><p>A page</p></body></html>";
/** mock/files.ts BOARD_PAGE: under home, in no project and no thread's pages directory; it loads the bridge. */
const BOARD = "/Users/dev/notes/board.html";

async function open(page: Page, path: string): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${JSON.stringify({ project: "repo-cf", base: CF, path })}))`);
  await expect(page.getByTestId("file-html-frame")).toBeVisible();
}

test.beforeEach(async () => {
  await resetMock();
});

test("SHOTS: the File tab's footer per page state", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only");
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1400, height: 820 });
  for (const [name, owner] of [
    ["own", "s-1"],
    ["other", "s-2"],
    ["plain", ""],
  ] as const) {
    const abs = `${CF}/docs/${name}.html`;
    await mockPost(`fs/write?path=${encodeURIComponent(abs)}&text=${encodeURIComponent(PAGE)}`);
    if (owner) await mockPost(`page?path=${encodeURIComponent(abs)}&owner=${owner}&how=written`);
  }
  await mockPost(`page?path=${encodeURIComponent(`${CF}/docs/refused.html`)}&consent=refused`);
  await mockPost(`fs/write?path=${encodeURIComponent(`${CF}/docs/refused.html`)}&text=${encodeURIComponent(PAGE)}`);
  await openApp(page);
  await row(page, "s:s-1").click();
  await openThreadChanges(page);
  const footer = page.getByTestId("file-html-footer");
  const shot = async (name: string) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await footer.screenshot({ path: `${shots ?? ""}/footer-${name}-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  };
  for (const name of ["own", "other", "plain", "refused"]) {
    await open(page, `docs/${name}.html`);
    await expect(footer).toHaveAttribute("data-consent", /.+/);
    await shot(name);
  }
  await open(page, BOARD);
  await expect(page.getByTestId("page-consent")).toBeVisible();
  await shot("asking");
  await page.getByTestId("page-consent-allow").click();
  await expect(page.getByTestId("page-consent")).toHaveCount(0);
  await shot("allowed");
});
