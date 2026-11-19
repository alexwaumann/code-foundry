import { expect, test, type Page } from "@playwright/test";
import { CF, openApp, resetMock, threadsOpenAsTabs } from "./fixtures";
import { openThread } from "./shell";
import { paneWith } from "./shell-surfaces";

/**
 * A page no thread owns (docs/notes/page-ownership-gui.md), in a real frame through the real
 * /cf/bridge.js: the band asks once the page loads the bridge, and Allow brings it to life
 * without a thread (storage kept by the daemon per file, a live source); Stop allowing takes
 * it away. Which command each answer runs, the footer's states and the held ready's messages
 * are src/components/files/HtmlPreview.consent.test.tsx's and stores/bridgeHost.test.ts's.
 * SHOTS=<dir> saves the band, allowed and not allowed, dark and light.
 */

/** mock/files.ts BOARD_PAGE: under home, in no project and no thread's pages directory. */
const BOARD = "/Users/dev/notes/board.html";
const inner = (page: Page) => page.frameLocator('[data-testid="file-html-frame"]');
const body = (page: Page) => inner(page).locator("body");

/** A File tab on the board, linked to thread s-1 (as a path chip opens one): s-1 does not own it. */
async function openBoard(page: Page): Promise<void> {
  await openApp(page);
  await openThread(page, "s-1");
  const target = JSON.stringify({ project: "repo-cf", base: CF, path: BOARD });
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
  await expect(page.getByTestId("file-html-frame")).toBeVisible();
}

/** What the daemon keeps for the page (PageService.PageStorage), or the error's message. */
const stored = (page: Page) => page.evaluate(`__cfModule("/src/api/page.ts").then((m) => m.getPageFileStorage(${JSON.stringify(BOARD)})).then((v) => v["board:visits"] ?? "", (e) => e.message)`);

test.beforeEach(async () => {
  await resetMock();
  await threadsOpenAsTabs();
});

test("asks once the page loads the bridge; allowed, the page works without a thread and keeps its storage across a reload; Stop allowing takes it away", async ({ page }) => {
  await openBoard(page);
  await expect(page.getByTestId("page-consent")).toBeVisible();
  // The page waits in its own loading state, its cf.ready held (that it never times out: lib/cfBridgeScript.test.ts).
  await expect(body(page)).not.toHaveAttribute("data-ready");
  await page.getByTestId("page-consent-allow").click();
  await expect(page.getByTestId("page-consent")).toHaveCount(0);
  await expect(body(page)).toHaveAttribute("data-ready", "1");
  await expect(body(page)).toHaveAttribute("data-thread", "none");
  await expect(body(page)).toHaveAttribute("data-rows", /^[1-9]/);
  await expect(inner(page).locator("#visits")).toHaveText("1");
  // The write reached the daemon before the reload.
  await expect.poll(() => stored(page)).toBe("1");
  await page.getByTestId("file-refresh").click();
  await expect(inner(page).locator("#visits")).toHaveText("2");
  // Stop allowing: the frame loads again, and the real bridge refuses, saying why.
  await page.getByTestId("file-html-consent").click();
  await expect(body(page)).toHaveAttribute("data-error", /the user has not allowed this page to use Code Foundry$/);
  await expect(page.getByTestId("file-html-consent")).toHaveText("Allow Code Foundry");
  await expect(page.getByTestId("page-consent")).toHaveCount(0);
});

// ---- screenshots (SHOTS=<dir>) ------------------------------------------------------

const shots = process.env.SHOTS;

test("SHOTS: the band asking, allowed, not allowed", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only");
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1400, height: 820 });
  await openBoard(page);
  const pane = paneWith(page, "file");
  const shot = async (name: string) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await pane.screenshot({ path: `${shots ?? ""}/${name}-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  };
  await expect(page.getByTestId("page-consent")).toBeVisible();
  await shot("page-consent-asking");
  await page.getByTestId("page-consent-allow").click();
  await expect(body(page)).toHaveAttribute("data-rows", /^[1-9]/);
  await shot("page-consent-allowed");
  await page.getByTestId("file-html-consent").click();
  await expect(page.getByTestId("file-html-consent")).toHaveText("Allow Code Foundry");
  await expect(body(page)).toHaveAttribute("data-error", /not allowed/);
  await shot("page-consent-not-allowed");
});
