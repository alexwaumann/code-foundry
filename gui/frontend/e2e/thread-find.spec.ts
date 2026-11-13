import { expect, test, type Page } from "@playwright/test";
import { infoCardOff, mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

// The in-thread find (docs/notes/search-2-thread-find.md), only what needs a browser: the
// cmd+f chord from the prompt, where the bar sits beside the thread info card, the
// painted ranges, scrolling to a match and unfolding a folded question. Counting, smart
// case and navigation are vitest (lib/threadFind, FindBar). Over the mock's idle s-r1
// "Fix stale PR badge". SHOTS=<dir> saves screenshots.

test.beforeEach(async () => {
  await resetMock();
  // The card off for threads never toggled (on by default), so its toggle shows it.
  await infoCardOff();
  await mockPost("thread?state=idle");
});

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

const bar = (page: Page) => page.getByTestId("thread-find");
const field = (page: Page) => page.getByTestId("thread-find-input");
const count = (page: Page) => page.getByTestId("thread-find-count");
const timeline = (page: Page) => page.getByTestId("thread-pane").getByTestId("thread-timeline");

async function openThread(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane").locator('[data-testid="thread-text"][data-final]').last()).toBeVisible();
}

/** The painted ranges' text by highlight name. */
async function painted(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const name of ["cf-find", "cf-find-current"]) {
      const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(name);
      out[name] = h ? [...h].map((r) => r.toString()) : [];
    }
    return out;
  });
}

/** The current match's box and the list's visible part (to the composer's top). */
async function currentBox(page: Page): Promise<{ top: number; bottom: number; listTop: number; dockTop: number } | null> {
  return page.evaluate(() => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("cf-find-current");
    const r = h ? [...h][0] : undefined;
    const list = document.querySelector('[data-testid="thread-pane"] [data-testid="thread-timeline"]');
    const dock = document.querySelector('[data-testid="thread-pane"] .dock');
    if (!r || !list || !dock) return null;
    const b = r.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, listTop: list.getBoundingClientRect().top, dockTop: dock.getBoundingClientRect().top };
  });
}

/** The current tick's place along the map and its text's place in the list (fractions of the list's height). */
async function currentTick(page: Page): Promise<{ tick: number; text: number } | null> {
  return page.evaluate(() => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("cf-find-current");
    const r = h ? [...h][0] : undefined;
    const list = document.querySelector<HTMLElement>('[data-testid="thread-pane"] [data-testid="thread-timeline"]');
    const tick = document.querySelector<HTMLElement>('[data-testid="thread-find-map"] [data-current]');
    if (!r || !list || !tick) return null;
    const zoom = list.getBoundingClientRect().height / list.offsetHeight || 1;
    const text = (list.scrollTop + (r.getBoundingClientRect().top - list.getBoundingClientRect().top) / zoom) / list.scrollHeight;
    return { tick: parseFloat(tick.style.top) / 100, text };
  });
}

test("cmd+f from the prompt opens the bar over the card's column; matches paint, the card moves under it", async ({ page }) => {
  await openThread(page);
  await page.keyboard.press("Meta+Shift+I");
  const card = page.getByTestId("thread-pane").getByTestId("thread-info-card");
  await expect(card).toBeVisible();
  const before = await card.boundingBox();
  await threadPrompt(page).click();
  await page.keyboard.press("Meta+f");
  await expect(bar(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
  // Same x and width as the card; the card starts 8px under the bar.
  const b = await bar(page).boundingBox();
  const after = await card.boundingBox();
  expect(b && after && before).toBeTruthy();
  if (b && after && before) {
    expect(Math.abs(b.x - after.x)).toBeLessThan(1);
    expect(Math.abs(b.width - after.width)).toBeLessThan(1);
    expect(Math.abs(after.y - (b.y + b.height + 8))).toBeLessThan(1.5);
    expect(after.y - before.y).toBeCloseTo(46, 0);
  }
  await page.keyboard.type("fingerprint");
  await expect(count(page)).toHaveText(/^\d+ of 13$/);
  await expect.poll(async () => (await painted(page))["cf-find-current"]).toHaveLength(1);
  const p = await painted(page);
  expect([...(p["cf-find"] ?? []), ...(p["cf-find-current"] ?? [])].every((t) => t.toLowerCase() === "fingerprint")).toBe(true);
  // The match map: a tick per spot along the scrollbar, the current one marked.
  await expect(page.getByTestId("thread-find-map").locator("[data-current]")).toHaveCount(1);
  await shot(page, "find-typed");
  // cmd+f again selects the query.
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("head sha");
  await expect(field(page)).toHaveValue("head sha");
});

test("a match off screen scrolls to the middle of the visible part and the list stops following the bottom", async ({ page }) => {
  await openThread(page);
  await expect(timeline(page)).toHaveAttribute("data-at-bottom", "true");
  await page.keyboard.press("Meta+f");
  // The first message's only match, far above the bottom.
  await page.keyboard.type("stays green");
  await expect(count(page)).toHaveText("1 of 1");
  await expect.poll(async () => {
    const b = await currentBox(page);
    return b ? Math.abs((b.top + b.bottom) / 2 - (b.listTop + b.dockTop) / 2) < 40 || b.top - b.listTop < 60 : false;
  }).toBe(true);
  await expect(timeline(page)).not.toHaveAttribute("data-at-bottom", "true");
  // The current tick is at its text, and stays there as the list scrolls (no repaint on scroll where highlights work).
  const near = (t: { tick: number; text: number } | null) => (t ? Math.abs(t.tick - t.text) < 0.01 : false);
  await expect.poll(async () => near(await currentTick(page))).toBe(true);
  await timeline(page).hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => near(await currentTick(page))).toBe(true);
});

test("a match in a folded question unfolds its turn and opens the row; moving on or Escape puts them back", async ({ page }) => {
  await openThread(page);
  const detail = page.locator('[data-testid="thread-pane"] dl[data-find-item]');
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("head sha");
  await expect(count(page)).toHaveText(/ of 3$/);
  await expect(detail).toHaveCount(0);
  // The second match is the question's answer (the summary row repeating it is no match).
  for (let i = 0; i < 3 && (await count(page).textContent()) !== "2 of 3"; i++) await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("2 of 3");
  await expect(detail).toBeVisible();
  await expect.poll(async () => (await painted(page))["cf-find-current"]).toEqual(["Head SHA"]);
  expect(await detail.evaluate((dl) => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("cf-find-current");
    const r = h ? [...h][0] : undefined;
    return r ? dl.contains(r.startContainer) : false;
  })).toBe(true);
  await shot(page, "find-question");
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("3 of 3");
  await expect(detail).toHaveCount(0);
  await page.keyboard.press("Shift+Enter");
  await expect(detail).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await expect(detail).toHaveCount(0);
  await expect(threadPrompt(page)).toBeFocused();
  expect(await painted(page)).toEqual({ "cf-find": [], "cf-find-current": [] });
});

test("a hand-off before the thread is selected (openThreadFind, then the row click) opens the bar on that item's match", async ({ page }) => {
  // The question's item id, read on a first load; a reload starts the stores afresh (no cached log).
  await openThread(page);
  const question = await page.evaluate(`__cfModule("/src/stores/thread.ts").then((m) => m.getThreadItems("s-r1").find((it) => it.kind === "question")?.id ?? "")`);
  expect(question).not.toBe("");
  await openApp(page);
  await page.evaluate(`__cfModule("/src/stores/threadFind.ts").then((m) => m.openThreadFind("s-r1", "head sha", { itemId: ${JSON.stringify(question)} }))`);
  await row(page, "s:s-r1").click();
  // StrictMode replays WatchedThread's effect on mount: the session must outlive that.
  await expect(bar(page)).toBeVisible();
  await expect(field(page)).toHaveValue("head sha");
  await expect(count(page)).toHaveText("2 of 3");
  await expect(page.locator('[data-testid="thread-pane"] dl[data-find-item]')).toBeVisible();
  await expect.poll(async () => (await painted(page))["cf-find-current"]).toEqual(["Head SHA"]);
});
