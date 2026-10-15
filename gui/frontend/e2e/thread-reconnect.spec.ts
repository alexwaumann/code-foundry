import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, openStreams, resetMock, row } from "./fixtures";

/**
 * The visible thread's Watch after the window was hidden, and the "reconnecting…" chip
 * (docs/notes/thread-render-stall.md). Playwright cannot hide the page, so these fake
 * document.visibilityState and dispatch visibilitychange as WKWebView does.
 */

test.beforeEach(async () => {
  await resetMock();
});

async function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

/** Counts ThreadService.Watch requests and records whether the chip ever showed. */
async function track(page: Page): Promise<{ watches: () => number }> {
  let watches = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/codefoundry.v1.ThreadService/Watch")) watches++;
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

test("showing the window again reopens the visible thread's Watch, without the reconnecting chip", async ({ page }) => {
  const t = await track(page);
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(timeline(page)).toBeVisible();
  // A thread switch and back: a fresh Watch each time, never "reconnecting".
  await row(page, "s:s-2").click();
  await row(page, "s:s-r1").click();
  await expect(timeline(page)).toBeVisible();
  await expect.poll(async () => (await openStreams())["ThreadService/Watch"] ?? 0).toBe(1);
  const before = t.watches();

  await setVisibility(page, "hidden");
  await setVisibility(page, "visible");
  await expect.poll(t.watches).toBe(before + 1);
  // The old Watch was closed: still one open.
  await expect.poll(async () => (await openStreams())["ThreadService/Watch"] ?? 0).toBe(1);
  await expect(timeline(page)).toBeVisible();
  expect(await chipSeen(page)).toBe(false);
});

test("a Watch that cannot reconnect shows the chip over the log until it is back", async ({ page }) => {
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(timeline(page)).toBeVisible();
  const chip = page.getByTestId("thread-catching-up");
  await expect(chip).toHaveCount(0);

  // The daemon is unreachable for the Watch; a resync drops the open one.
  await page.route("**/codefoundry.v1.ThreadService/Watch", (r) => r.abort());
  await setVisibility(page, "hidden");
  await setVisibility(page, "visible");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText("catching up…");
  // The log stays on screen under it.
  await expect(timeline(page)).toBeVisible();

  await page.unroute("**/codefoundry.v1.ThreadService/Watch");
  await expect(chip).toBeHidden({ timeout: 10_000 });
  await expect.poll(async () => (await openStreams())["ThreadService/Watch"] ?? 0).toBe(1);
});
