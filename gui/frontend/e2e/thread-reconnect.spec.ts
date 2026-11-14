import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { mockPost, openApp, openStreams, resetMock, row } from "./fixtures";
import { openRowThread } from "./shell-threads";

/**
 * The visible thread's Watch across a thread switch, and the "reconnecting…" chip when a
 * Watch is dropped and cannot come back. Hiding the window leaves the Watch alone
 * (`stores/watchVisibility.test.ts`; docs/notes/ws-stall-workarounds.md).
 */

test.beforeEach(async () => {
  await resetMock();
});

const WATCH = /\/stream\/codefoundry\.v1\.ThreadService\/WatchThread$/;

/** Counts ThreadService.WatchThread sockets and records whether the chip ever showed. */
async function track(page: Page): Promise<{ watches: () => number }> {
  let watches = 0;
  page.on("websocket", (ws) => {
    if (WATCH.test(ws.url())) watches++;
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __chipSeen: boolean };
    w.__chipSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="thread-catching-up"]')) w.__chipSeen = true;
    }).observe(document, { childList: true, subtree: true });
  });
  return { watches: () => watches };
}

const chipSeen = (page: Page) => page.evaluate(() => (window as unknown as { __chipSeen: boolean }).__chipSeen);
const timeline = (page: Page) => page.getByTestId("thread-timeline").locator("[data-row-type]").first();

test("a thread switch reopens the Watch without the reconnecting chip", async ({ page }) => {
  const t = await track(page);
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(timeline(page)).toBeVisible();
  const before = t.watches();
  // A thread switch and back (tabs of one pane: only the active one is drawn): a fresh Watch each
  // time, never "reconnecting". s-2 waits on the user: its row's first line opens it.
  await openRowThread(page, "s-2");
  await openRowThread(page, "s-r1");
  await expect(timeline(page)).toBeVisible();
  await expect.poll(t.watches).toBeGreaterThanOrEqual(before + 2);
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(1);
  expect(await chipSeen(page)).toBe(false);
});

test("a Watch that cannot reconnect shows the chip over the log until it is back", async ({ page }) => {
  // Routed from the start: a Watch reaches the mock until `refuse`, then its socket dies.
  let refuse = false;
  const live: WebSocketRoute[] = [];
  await page.routeWebSocket(WATCH, (ws) => {
    if (refuse) void ws.close({ code: 1011 });
    else {
      ws.connectToServer();
      live.push(ws);
    }
  });
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(timeline(page)).toBeVisible();
  const chip = page.getByTestId("thread-catching-up");
  await expect(chip).toHaveCount(0);

  // The daemon is unreachable for the Watch, and the open one drops.
  refuse = true;
  for (const ws of live.splice(0)) await ws.close({ code: 1011 });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText("catching up…");
  // The log stays on screen under it.
  await expect(timeline(page)).toBeVisible();

  refuse = false;
  await expect(chip).toBeHidden({ timeout: 10_000 });
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(1);
});
