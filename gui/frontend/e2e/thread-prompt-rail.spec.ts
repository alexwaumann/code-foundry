import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockPost, openApp, openTooltip, resetMock, row, threadPrompt } from "./fixtures";

/**
 * The thread's prompt rail (components/thread/PromptRail.tsx, docs/notes/thread-prompt-rail.md):
 * one tick per prompt in the timeline's left gutter over the mock's scripted "Fix stale PR
 * badge" (mock/thread.ts; idle has two prompts, streaming one). Set SHOTS=<dir> to save
 * screenshots with a tick's tooltip open, in both schemes.
 */

test.beforeEach(async () => {
  await resetMock();
});

async function openThread(page: Page, state: "idle" | "streaming", scheme: "dark" | "light" = "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await mockPost(`thread?state=${state}`);
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(page.getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
}

function rail(page: Page): Locator {
  return page.getByRole("navigation", { name: "Prompts" });
}

function ticks(page: Page): Locator {
  return rail(page).getByTestId("prompt-rail-tick");
}

/** Which ticks are the one in view, as "1"/"0" per tick. */
async function inView(page: Page): Promise<string> {
  return (await ticks(page).evaluateAll((els) => els.map((e) => (e.hasAttribute("data-current") ? "1" : "0")))).join("");
}

async function scrollTimeline(page: Page, to: "top" | "bottom"): Promise<void> {
  const timeline = page.getByTestId("thread-timeline");
  // A wheel first, so the list counts the scroll as the user's and stops following the bottom.
  const box = await timeline.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.wheel(0, to === "top" ? -400 : 400);
  }
  await timeline.evaluate((el, top) => {
    el.scrollTop = top ? 0 : el.scrollHeight;
  }, to === "top");
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

test("the idle thread's two prompts get a rail in the left gutter, clear of the rows and the composer", async ({ page }) => {
  await openThread(page, "idle");
  await expect(rail(page)).toBeVisible();
  await expect(ticks(page)).toHaveCount(2);
  await expect(ticks(page).nth(0)).toHaveAttribute("aria-label", "Prompt 1 of 2: The PR badge in the sidebar stays green after a force-push,…");
  await expect(ticks(page).nth(1)).toHaveAttribute("aria-label", "Prompt 2 of 2: Looks good. Run the full suite, then push the branch.");
  await expect(rail(page)).toHaveAttribute("data-gap", "6");

  // Inside the 40px gutter the rows leave: the rail adds no width and covers no row.
  const pane = await page.getByTestId("thread-timeline").boundingBox();
  const railBox = await rail(page).boundingBox();
  const firstRow = await page.getByTestId("thread-timeline").locator("[data-index]").first().boundingBox();
  const composer = await page.getByTestId("thread-composer").boundingBox();
  if (!pane || !railBox || !firstRow || !composer) throw new Error("no boxes");
  expect(railBox.x).toBeGreaterThanOrEqual(pane.x);
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(firstRow.x);
  expect(firstRow.x - pane.x).toBe(40);
  // The ticks themselves sit above the composer.
  const lastTick = await ticks(page).nth(1).boundingBox();
  if (!lastTick) throw new Error("no tick");
  expect(lastTick.y + lastTick.height).toBeLessThan(composer.y);
  // The bar: 8×2.
  const bar = await ticks(page).nth(0).locator("span").boundingBox();
  expect(bar?.width).toBe(8);
  expect(bar?.height).toBe(2);
});

// One prompt, no rail; a tick's tooltip text (the image left out, tags as labels, when it was
// sent, n of m): unit-tested in src/components/thread/PromptRail.test.tsx. Left here: the clamp,
// the width cap and the side, which need a layout.
test("a tick's tooltip is two lines at most, within the 260px cap, to the tick's right", async ({ page }) => {
  await openThread(page, "idle");
  await page.mouse.move(0, 0);
  await ticks(page).nth(0).hover();
  const tip = openTooltip(page);
  await expect(tip).toBeVisible();
  const clamp = tip.locator(".line-clamp-2");
  const lines = await clamp.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines).toBe(2);
  expect((await tip.boundingBox())?.width ?? 0).toBeLessThanOrEqual(260);
  const tickBox = await ticks(page).nth(0).boundingBox();
  const tipBox = await tip.boundingBox();
  expect(tipBox?.x ?? 0).toBeGreaterThan((tickBox?.x ?? 0) + (tickBox?.width ?? 0));
});

test("clicking a tick scrolls its prompt near the top and leaves the focus where it was", async ({ page }) => {
  await openThread(page, "idle");
  const timeline = page.getByTestId("thread-timeline");
  await expect(timeline).toHaveAttribute("data-at-bottom", "true");
  await threadPrompt(page).click();
  await expect(threadPrompt(page)).toBeFocused();

  await ticks(page).nth(0).click();
  const first = timeline.locator('[data-row-type="user"]').first();
  await expect(first).toBeVisible();
  await expect
    .poll(async () => {
      const t = await timeline.boundingBox();
      const r = await first.boundingBox();
      return t && r ? Math.round(r.y - t.y) : -1;
    })
    .toBeLessThanOrEqual(40);
  await expect(page.getByTestId("thread-user").first()).toBeInViewport();
  await expect(threadPrompt(page)).toBeFocused();
  // The list stopped following the bottom (it stays at the prompt).
  await page.waitForTimeout(300);
  await expect(timeline).not.toHaveAttribute("data-at-bottom", "true");
  await expect.poll(() => inView(page)).toBe("10");

  // And back to the second.
  await ticks(page).nth(1).click();
  await expect(page.getByTestId("thread-user").nth(1)).toBeInViewport();
  await expect.poll(() => inView(page)).toBe("01");
});

test("the tick in view follows the timeline's scroll", async ({ page }) => {
  await openThread(page, "idle");
  // At the bottom (pinned): the last prompt's turn.
  await expect.poll(() => inView(page)).toBe("01");
  await expect(ticks(page).nth(1)).toHaveAttribute("aria-current", "location");
  await scrollTimeline(page, "top");
  await expect.poll(() => inView(page)).toBe("10");
  await expect(ticks(page).nth(0)).toHaveAttribute("aria-current", "location");
  await scrollTimeline(page, "bottom");
  await expect.poll(() => inView(page)).toBe("01");
});

test("a tick is reachable by keyboard and jumps on Enter", async ({ page }) => {
  await openThread(page, "idle");
  await ticks(page).nth(0).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => inView(page)).toBe("10");
  await expect(ticks(page).nth(0)).toBeFocused();
});

// Ticks added as prompts arrive (labels, n of m, the newest in view): unit-tested in
// src/components/thread/PromptRail.test.tsx. Left here: one real send, after which the list is
// pinned at its end and the new tick is the one in view.
const schemes = process.env.SHOTS ? (["dark", "light"] as const) : (["dark"] as const);

for (const scheme of schemes) {
  test(`a sent prompt adds a tick, in view (${scheme})`, async ({ page }) => {
    await openThread(page, "idle", scheme);
    await threadPrompt(page).click();
    await page.keyboard.type("Also check the poller's interval: the note says 30 s, but settings say 20. Which one is right?");
    await page.keyboard.press("Enter");
    await expect(ticks(page)).toHaveCount(3);
    await expect(page.getByTestId("thread-timeline").getByText("Got it: I'll take a look now.")).toHaveCount(1, { timeout: 5000 });
    await expect.poll(() => inView(page)).toBe("001");
    if (process.env.SHOTS) {
      await page.mouse.move(0, 0);
      await ticks(page).nth(2).hover();
      await expect(openTooltip(page)).toContainText(" · 3 of 3");
      await page.waitForTimeout(250);
      await shot(page, `prompt-rail-${scheme}`);
    }
  });
}
