import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The bridge (docs/notes/bridge-2-gui.md): mock/bridge-page.html, shown inline by the
 * scripted thread's "bridge" state (mock/thread.ts, a working turn), loads the mock's
 * /cf/bridge.js and calls Code Foundry through its frame's host. SHOTS=<dir> saves the card
 * in both schemes.
 */

test.beforeEach(async () => {
  await resetMock();
});

const shots = process.env.SHOTS;

const card = (page: Page) => page.getByTestId("thread-html").filter({ hasText: "bridge.html" }).getByTestId("thread-html-card");
const doc = (page: Page) => card(page).frameLocator('[data-testid="thread-html-frame"]');

async function openBridgeThread(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 900 });
  await mockPost("thread?state=bridge");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(card(page)).toBeVisible();
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "1");
}

interface Counters {
  hosts: number;
  subscriptions: number;
  posts: number;
}

/** The app's dev hook (stores/bridgeHost.ts): live hosts, their subscriptions, posts so far. */
const bridgeCounters = (page: Page): Promise<Counters> => page.evaluate(() => ({ ...((window as { __cfBridge?: Counters }).__cfBridge ?? { hosts: -1, subscriptions: -1, posts: -1 }) }));

test("a page in a thread is ready with its thread, the read-only verbs and the sources", async ({ page }) => {
  await openBridgeThread(page);
  const body = doc(page).locator("body");
  await expect(doc(page).locator("#thread")).not.toHaveText("no thread");
  await expect(doc(page).locator("#thread")).not.toHaveText("…");
  await expect(body).toHaveAttribute("data-sources", /thread-list/);
  expect(Number(await body.getAttribute("data-readonly"))).toBeGreaterThan(0);
  // The page keeps its storage: same-origin frames.
  await expect(doc(page).locator("#visits")).toHaveText("1");
});

test("cf:run reads and mutates in the thread's context; the daemon's errors come back mapped", async ({ page }) => {
  await openBridgeThread(page);
  await doc(page).locator("#list").click();
  await expect(doc(page).locator("#list-out")).toHaveText(/^\{"threads":\d+\}$/);
  await doc(page).locator("#notify").click();
  await expect(doc(page).locator("#notify-out")).toHaveText("ok");
  await expect(page.getByText("Test info")).toBeVisible();
  const notify = (await invocations()).find((i) => i.name === "ui.notify");
  expect(notify?.context?.activeThreadId).toBe("s-r1");
  expect(notify?.context?.activeView).toBe("thread");
  expect(notify?.args).toEqual({ level: "info" });
  await doc(page).locator("#missing").click();
  await expect(doc(page).locator("#error-out")).toHaveText(/^unavailable: /);
  await doc(page).locator("#invalid").click();
  await expect(doc(page).locator("#error-out")).toHaveText(/^invalid: .*level/);
  if (shots) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await card(page).screenshot({ path: `${shots}/bridge-card-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: null });
  }
});

test("a verb that asks opens the app's confirm dialog: no is declined, yes runs it confirmed", async ({ page }) => {
  await openBridgeThread(page);
  await doc(page).locator("#archive").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("confirm-caller")).toContainText("bridge.html, a page in");
  if (shots) await page.screenshot({ path: `${shots}/bridge-confirm.png` });
  await dialog.getByTestId("confirm-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(doc(page).locator("#archive-out")).toHaveText(/^declined: /);
  expect((await invocations()).filter((i) => i.name === "thread.archive").map((i) => i.confirmed)).toEqual([false]);
  await doc(page).locator("#archive").click();
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm-ok").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.archive").map((i) => i.confirmed)).toEqual([false, false, true]);
});

test("a subscription delivers the snapshot, then every change; closing the card lets go of everything", async ({ page }) => {
  await openBridgeThread(page);
  const rows = doc(page).locator("#rows");
  await expect(rows).not.toHaveText("–");
  const before = Number(await rows.textContent());
  expect(Number(await doc(page).locator("#events").textContent())).toBeGreaterThanOrEqual(1);
  await mockPost(`threads?project=repo-cf&count=2&status=idle&prefix=Bridge`);
  await expect(rows).toHaveText(String(before + 2));
  await expect.poll(async () => (await bridgeCounters(page)).subscriptions).toBe(1);
  // Close the card: its frame goes, and its host stops.
  await page.getByTestId("thread-html").filter({ hasText: "bridge.html" }).getByTestId("thread-html-row").click();
  await expect(card(page)).toHaveCount(0);
  await expect.poll(async () => bridgeCounters(page)).toMatchObject({ hosts: 0, subscriptions: 0 });
  const posts = (await bridgeCounters(page)).posts;
  await mockPost(`threads?project=repo-cf&count=2&status=idle&prefix=After`);
  await page.waitForTimeout(400);
  expect((await bridgeCounters(page)).posts).toBe(posts);
});

test("storage survives a reload; a theme switch reaches the page without one", async ({ page }) => {
  await openBridgeThread(page);
  await expect(doc(page).locator("#visits")).toHaveText("1");
  // Closing and opening the card loads the page again.
  const pageRow = page.getByTestId("thread-html").filter({ hasText: "bridge.html" }).getByTestId("thread-html-row");
  await pageRow.click();
  await expect(card(page)).toHaveCount(0);
  await pageRow.click();
  await expect(doc(page).locator("body")).toHaveAttribute("data-ready", "1");
  await expect(doc(page).locator("#visits")).toHaveText("2");
  const scheme = await doc(page).locator("#theme").textContent();
  await page.emulateMedia({ colorScheme: scheme === "dark" ? "light" : "dark" });
  await expect(doc(page).locator("#theme")).toHaveText(scheme === "dark" ? "light" : "dark");
  // It acked (the stand-in script does for a page with a theme listener): no reload, the same visit.
  await page.waitForTimeout(600);
  await expect(doc(page).locator("#visits")).toHaveText("2");
});

test("a File tab on a page its thread did not show gets a bridge that refuses calls", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openApp(page);
  await row(page, "s:s-1").click();
  const target = JSON.stringify({ project: "repo-cf", base: CF, path: "docs/bridge.html" });
  await page.evaluate(`import("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
  const inner = page.frameLocator('[data-testid="file-html-frame"]');
  await expect(inner.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(inner.locator("#thread")).toHaveText("no thread");
  await expect(inner.locator("body")).toHaveAttribute("data-readonly", "0");
  await expect(inner.locator("body")).toHaveAttribute("data-sources", "");
  await inner.locator("#notify").click();
  await expect(inner.locator("#notify-out")).toHaveText("unavailable: this page is not shown in a thread");
  expect((await invocations()).some((i) => i.name === "ui.notify")).toBe(false);
});

test("the File tab of a page its thread showed has that thread's bridge", async ({ page }) => {
  await openBridgeThread(page);
  await card(page).getByTestId("thread-html-panel").click();
  const inner = page.frameLocator('[data-testid="file-html-frame"]');
  await expect(inner.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(inner.locator("#thread")).not.toHaveText("no thread");
  await inner.locator("#notify").click();
  await expect(inner.locator("#notify-out")).toHaveText("ok");
});
