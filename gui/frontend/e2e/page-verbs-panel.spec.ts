import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, invokeAs, openApp, resetMock, row } from "./fixtures";
import { paneWith, stripTabs, threadTabOpen } from "./shell-surfaces";

/**
 * view.panel.page (docs/notes/page-verbs.md): thread s-1 opens an HTML page as a tab linked to
 * it, beside its own, as its page's bridge would (cf.run in the thread's context). The File tab is
 * titled, runs the page with s-1's bridge, and no card is added to the conversation.
 * SHOTS=<dir> saves screenshots.
 */

const PAGE = `${CF}/docs/bridge.html`;
/** The pane of the thread's linked tabs, beside its own. */
const panel = (page: Page) => paneWith(page, "file");
const tabs = (page: Page) => stripTabs(panel(page));
const inner = (page: Page) => page.frameLocator('[data-testid="file-html-frame"]');

/** Runs a command as the CLI (or a page's bridge) inside thread s-1 would: no active view. */
function inS1(name: string, args: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  return invokeAs("s-1", name, args);
}

const shots = process.env.SHOTS;

test.beforeEach(async () => {
  await resetMock();
});

test("view.panel.page opens the page in a tab beside the thread with its bridge, and adds no card", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-1");
  await threadTabOpen("s-1");
  const cards = page.getByTestId("thread-html");
  await expect(cards).toHaveCount(0);

  expect(await inS1("view.panel.page", { path: PAGE, title: "Welcome" })).toEqual({ ok: true, message: "opened a file tab for thread s-1" });

  await expect(tabs(page)).toHaveText(["Welcome"]);
  await expect(panel(page).locator('[data-testid="shell-tab"][data-kind="file"]')).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("file-tab")).toHaveAttribute("data-path", PAGE);
  // The thread's bridge, though no html item names the page.
  await expect(inner(page).locator("body")).toHaveAttribute("data-ready", "1");
  await expect(inner(page).locator("#thread")).not.toHaveText("no thread");
  await inner(page).locator("#notify").click();
  await expect(inner(page).locator("#notify-out")).toHaveText("ok");
  const notify = (await invocations()).find((i) => i.name === "ui.notify");
  expect(notify?.context).toMatchObject({ activeThreadId: "s-1", activeView: "" });
  // No card in the conversation, and the verb did not show one inline.
  await expect(cards).toHaveCount(0);
  expect((await invocations()).some((i) => i.name === "view.inline")).toBe(false);
  if (shots) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/view-panel-page-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  }
});

// view.panel.page refusing a file that is not a page (not html, missing, a directory): the daemon's, internal/command/commands_view_panel_page_test.go.
