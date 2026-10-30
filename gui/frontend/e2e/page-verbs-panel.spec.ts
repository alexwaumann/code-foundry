import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { CF, invocations, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * view.panel.page (docs/notes/page-verbs.md): thread s-1 opens an HTML page in its own side
 * panel only, as its page's bridge would (cf.run in the thread's context). The File tab is
 * titled, runs the page with s-1's bridge, and no card is added to the conversation.
 * SHOTS=<dir> saves screenshots.
 */

const PAGE = `${CF}/docs/bridge.html`;
const panel = (page: Page) => page.getByTestId("side-panel");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const inner = (page: Page) => page.frameLocator('[data-testid="file-html-frame"]');

/** Runs a command as the CLI (or a page's bridge) inside thread s-1 would: no active view. */
async function inS1(name: string, args: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name, args, context: { activeThreadId: "s-1" } }),
  });
  return { ok: res.ok, message: ((await res.json()) as { message?: string }).message ?? "" };
}

const shots = process.env.SHOTS;

test.beforeEach(async () => {
  await resetMock();
});

test("view.panel.page opens the page in the thread's side panel with its bridge, and adds no card", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-1");
  const cards = page.getByTestId("thread-html");
  await expect(cards).toHaveCount(0);

  expect(await inS1("view.panel.page", { path: PAGE, title: "Welcome" })).toEqual({ ok: true, message: "windows=1 thread=s-1" });

  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-1");
  await expect(tabs(page)).toHaveText(["Welcome"]);
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

test("view.panel.page refuses a file that is not a page", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  expect((await inS1("view.panel.page", { path: `${CF}/README.md` })).ok).toBe(false);
  await expect(panel(page)).toHaveCount(0);
});
