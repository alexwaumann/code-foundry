import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, resetMock, mockPost, row, threadPrompt, infoCardOff } from "./fixtures";

// A long user message's fold (docs/notes/user-message-fold.md), only what needs a browser:
// the real fold height and mask, the row's measured height, where the list stays when it
// opens and closes (pinned or not), find and Go to source reaching text under the fold,
// and a selection across it. The toggle's states, the threshold, who keeps the choice and
// which messages fold: vitest (src/components/thread/MessageFold.test.tsx). Over the mock's
// idle s-r1 "Fix stale PR badge". SHOTS=<dir> saves screenshots.

test.beforeEach(async () => {
  await resetMock();
  // Written for a conversation with no card beside it (layout.thread_info is on by default).
  await infoCardOff();
  await mockPost("thread?state=idle");
});

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

const pane = (page: Page) => page.getByTestId("thread-pane");
const timeline = (page: Page) => pane(page).getByTestId("thread-timeline");
const LINE = "Here is what I want from this pass on the sidebar and the thread pane. I went through the app this morning and wrote down everything that felt off, in the order I hit it.";

/** A message of `lines` paragraphs, each its own line; `tail` closes it. */
function longMessage(lines: number, tail = "the end of it"): string {
  return `${`${LINE}\n\n`.repeat(lines)}${tail}`;
}

async function openThread(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(pane(page).locator('[data-testid="thread-text"][data-final]').last()).toBeVisible();
}

/** Sends a message through the composer and waits for its turn to end. */
async function send(page: Page, text: string): Promise<void> {
  const items = () =>
    page.evaluate(async () => {
      const m = await (window as unknown as { __cfModule: (p: string) => Promise<{ useThreadStore: { getState: () => { logs: Record<string, { order: string[] }> } } }> }).__cfModule("/src/stores/thread.ts");
      return m.useThreadStore.getState().logs["s-r1"]?.order.length ?? 0;
    });
  const before = await items();
  await threadPrompt(page).click();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
  // The message, a reply and the turn's end (the rows may not render: the list can be scrolled up).
  await expect.poll(items).toBeGreaterThanOrEqual(before + 3);
  await expect(page.getByTestId("thread-working")).toHaveCount(0);
}

/** The fold box of the message holding `text`. */
const fold = (page: Page, text: string) => pane(page).getByTestId("thread-user-fold").filter({ hasText: text });
/** The toggle of the message holding `text`. */
const toggle = (page: Page, text: string) => fold(page, text).locator("xpath=..").getByTestId("thread-user-fold-toggle");

/** Each frame's top of `el` (viewport px) while `act` runs and for half a second after. */
async function topsDuring(page: Page, el: Locator, act: () => Promise<void>): Promise<number[]> {
  await el.evaluate((node) => {
    const w = window as unknown as { __tops: number[]; __stop: boolean };
    w.__tops = [];
    w.__stop = false;
    const tick = () => {
      w.__tops.push(node.getBoundingClientRect().top);
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const w = window as unknown as { __tops: number[]; __stop: boolean };
    w.__stop = true;
    return w.__tops;
  });
}

/** How far the frames' tops strayed from each other. */
const spread = (tops: readonly number[]) => Math.max(...tops) - Math.min(...tops);

/** Wheels the list until `el`'s top sits `at` px under the list's top (real input: it unpins the list). */
async function wheelTo(page: Page, el: Locator, at: number): Promise<void> {
  const list = await timeline(page).boundingBox();
  await page.mouse.move((list?.x ?? 0) + 200, (list?.y ?? 0) + 200);
  for (let i = 0; i < 6; i++) {
    const dy = await el.evaluate((b, a) => b.getBoundingClientRect().top - (b.closest(".scroller") as HTMLElement).getBoundingClientRect().top - a, at);
    if (Math.abs(dy) < 1) break;
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);
}

/** Whether the current find match's box is on screen, in the list's visible part. */
async function currentShows(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("cf-find-current");
    const r = h ? [...h][0] : undefined;
    const list = document.querySelector('[data-testid="thread-pane"] [data-testid="thread-timeline"]');
    const dock = document.querySelector('[data-testid="thread-pane"] .dock');
    if (!r || !list || !dock) return false;
    const b = r.getBoundingClientRect();
    return b.height > 0 && b.top >= list.getBoundingClientRect().top && b.bottom <= dock.getBoundingClientRect().top;
  });
}

test("a long message stops at the fold under a mask, its row measures that, and Show more grows the row in place", async ({ page }) => {
  await openThread(page);
  await send(page, longMessage(12));
  const box = fold(page, "the end of it");
  await expect(box).toHaveAttribute("data-folded", "true");
  const look = await box.evaluate((b) => {
    const s = getComputedStyle(b);
    return { height: (b as HTMLElement).offsetHeight, content: (b.firstElementChild as HTMLElement).offsetHeight, mask: s.getPropertyValue("mask-image") || s.getPropertyValue("-webkit-mask-image") };
  });
  expect(look.height).toBe(170);
  expect(look.content).toBeGreaterThan(600);
  expect(look.mask).toContain("gradient");
  // The toggle sits in the bubble, centred over the fade.
  const bubble = await box.locator("xpath=..").boundingBox();
  const button = await toggle(page, "the end of it").boundingBox();
  expect(Math.abs((button?.x ?? 0) + (button?.width ?? 0) / 2 - ((bubble?.x ?? 0) + (bubble?.width ?? 0) / 2))).toBeLessThan(1);
  expect((button?.y ?? 0) + (button?.height ?? 0)).toBeLessThan((bubble?.y ?? 0) + (bubble?.height ?? 0));
  await shot(page, "folded");

  // The reply under it moves down by what the row grew: the row's height is the virtualizer's.
  const reply = pane(page).locator('[data-testid="thread-text"][data-final]').last();
  const before = await reply.evaluate((r) => r.getBoundingClientRect().top);
  await toggle(page, "the end of it").click();
  await expect(box).toHaveAttribute("data-folded", "false");
  await expect.poll(() => reply.evaluate((r, from) => r.getBoundingClientRect().top - from, before)).toBeGreaterThan(look.content - 200);
  await shot(page, "unfolded");
});

test("a pinned list's newest message: Show more keeps its top, stops following the bottom and offers Jump to bottom", async ({ page }) => {
  await openThread(page);
  await send(page, longMessage(12));
  await expect(page.getByTestId("thread-jump-bottom")).not.toHaveAttribute("data-shown", "true");
  const box = fold(page, "the end of it");
  const tops = await topsDuring(page, box, () => toggle(page, "the end of it").click());
  expect(spread(tops)).toBeLessThan(1);
  await expect(page.getByTestId("thread-jump-bottom")).toHaveAttribute("data-shown", "true");
  // Back to the bottom, and Show less there: it settles over the composer, with no blank spacer, still following.
  await page.getByTestId("thread-jump-bottom").click();
  await expect(page.getByTestId("thread-jump-bottom")).not.toHaveAttribute("data-shown", "true");
  await toggle(page, "the end of it").click();
  await expect(box).toHaveAttribute("data-folded", "true");
  await expect(timeline(page)).toHaveAttribute("data-at-bottom", "true");
  expect(await pane(page).getByTestId("thread-timeline-spacer").evaluate((s) => (s as HTMLElement).offsetHeight)).toBe(0);
  await send(page, "and this one follows");
  await expect(timeline(page)).toHaveAttribute("data-at-bottom", "true");
});

test("scrolled up: Show more keeps the text's top with the top off screen; Show less keeps the top in view, or the button when the top is off screen", async ({ page }) => {
  await openThread(page);
  await send(page, longMessage(12));
  await send(page, "something after it");
  await send(page, "and more after that");
  const box = fold(page, "the end of it");
  const button = toggle(page, "the end of it");

  // The top is off screen, the toggle is not: the text carries on down from where it was.
  await wheelTo(page, box, -40);
  expect(spread(await topsDuring(page, box, () => button.click()))).toBeLessThan(1);

  // Show less at the end of it, the top far above: the button stays under the pointer, in every frame.
  await wheelTo(page, button, 320);
  expect(await box.evaluate((b) => b.getBoundingClientRect().top < 0)).toBe(true);
  expect(spread(await topsDuring(page, button, () => button.click()))).toBeLessThan(2);
  await expect(box).toBeInViewport();

  // A shorter message, all of it on screen: Show less keeps its top.
  await send(page, longMessage(5, "a medium one"));
  await send(page, longMessage(12, "long below it"));
  await send(page, "after them");
  const medium = fold(page, "a medium one");
  await toggle(page, "a medium one").click();
  await wheelTo(page, medium, 30);
  expect(spread(await topsDuring(page, medium, () => toggle(page, "a medium one").click()))).toBeLessThan(1);
});

test("an opened message stays open when its row unmounts and across a visit to another thread", async ({ page }) => {
  await openThread(page);
  await send(page, longMessage(12));
  await toggle(page, "the end of it").click();
  await row(page, "s:s-1").click();
  await expect(pane(page).getByTestId("thread-user-fold").filter({ hasText: "the end of it" })).toHaveCount(0);
  await row(page, "s:s-r1").click();
  await timeline(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(fold(page, "the end of it")).toHaveAttribute("data-folded", "false");
});

test("find: a match under the fold opens the message and shows; closing the bar folds it; a match that shows opens nothing", async ({ page }) => {
  await openThread(page);
  await send(page, longMessage(12, "needle under the fold"));
  await send(page, "after it");
  const box = fold(page, "needle under the fold");
  await page.keyboard.press("Meta+f");
  await page.getByTestId("thread-find-input").fill("needle under");
  await expect(box).toHaveAttribute("data-folded", "false");
  await expect.poll(() => currentShows(page)).toBe(true);
  await shot(page, "find-opened");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("thread-find")).toHaveCount(0);
  await expect(box).toHaveAttribute("data-folded", "true");

  // The message's first words show under the fold: it stays folded, the match lit.
  await page.keyboard.press("Meta+f");
  await page.getByTestId("thread-find-input").fill("Here is what I want");
  await expect(page.getByTestId("thread-find-count")).toContainText("1 of");
  await expect.poll(() => currentShows(page)).toBe(true);
  await expect(box).toHaveAttribute("data-folded", "true");
});

test("find at 125% zoom: the fold's edge is in zoomed px, so a match under it still opens the message", async ({ page }) => {
  await openThread(page);
  await send(page, longMessage(12, "needle under the fold"));
  await page.evaluate(async () => {
    const m = await (window as unknown as { __cfModule: (p: string) => Promise<{ useUiStore: { setState: (s: { zoom: number }) => void } }> }).__cfModule("/src/stores/ui.ts");
    m.useUiStore.setState({ zoom: 125 });
  });
  await expect(page.locator("html")).toHaveAttribute("data-zoom", "125");
  await page.keyboard.press("Meta+f");
  await page.getByTestId("thread-find-input").fill("needle under");
  await expect(fold(page, "needle under the fold")).toHaveAttribute("data-folded", "false");
  await expect.poll(() => currentShows(page)).toBe(true);
});

test("Go to source: a quote under the fold opens the message and stays open; a selection across the fold has the whole text", async ({ page }) => {
  await openThread(page);
  await send(page, longMessage(12, "the quoted words at the end"));
  await send(page, "after it");
  const box = fold(page, "the quoted words at the end");
  const itemId = await box.getByTestId("thread-user-content").getAttribute("data-find-item");

  // A drag from the first line into the reply below it: the whole text, not the button's label.
  const first = await box.boundingBox();
  const reply = await pane(page).locator('[data-testid="thread-text"][data-final]').nth(-2).boundingBox();
  await page.mouse.move((first?.x ?? 0) + 2, (first?.y ?? 0) + 8);
  await page.mouse.down();
  await page.mouse.move((reply?.x ?? 0) + 40, (reply?.y ?? 0) + 8, { steps: 6 });
  await page.mouse.up();
  const selected = await page.evaluate(() => getSelection()?.toString() ?? "");
  expect(selected).toContain("the quoted words at the end");
  expect(selected).not.toContain("Show more");
  await page.evaluate(() => getSelection()?.removeAllRanges());

  await page.evaluate(async (id) => {
    const m = await (window as unknown as { __cfModule: (p: string) => Promise<{ requestFlash: (t: string, c: unknown) => void }> }).__cfModule("/src/stores/cite.ts");
    m.requestFlash("s-r1", { threadId: "s-r1", itemId: id, text: "the quoted words", comment: "", start: -1, end: -1, prefix: "", suffix: "" });
  }, itemId);
  await expect(box).toHaveAttribute("data-folded", "false");
  await expect(box.getByText("the quoted words at the end")).toBeInViewport();
  // Past the flash (1600 ms): it stays open.
  await page.waitForTimeout(2000);
  await expect(box).toHaveAttribute("data-folded", "false");
});

test("edge shapes: one long word wraps and folds, a code paste folds, a column of short lines widens to its button; zoom keeps the fold", async ({ page }) => {
  await openThread(page);
  await send(page, `${"x".repeat(9000)} oneword`);
  await expect(fold(page, "oneword")).toHaveAttribute("data-folded", "true");
  expect(await fold(page, "oneword").evaluate((b) => (b as HTMLElement).offsetWidth >= b.scrollWidth)).toBe(true);

  await send(page, Array.from({ length: 60 }, (_, i) => `const line${String(i)} = compute(${String(i)});`).join("\n") + "\ncodepaste");
  await expect(fold(page, "codepaste")).toHaveAttribute("data-folded", "true");

  await send(page, `${"a\n".repeat(40)}z`);
  const narrow = fold(page, "a\na").last();
  await expect(narrow).toHaveAttribute("data-folded", "true");
  const bubble = await narrow.locator("xpath=..").boundingBox();
  const button = await narrow.locator("xpath=..").getByTestId("thread-user-fold-toggle").boundingBox();
  expect(button?.width ?? 0).toBeLessThanOrEqual(bubble?.width ?? 0);

  await page.evaluate(async () => {
    const m = await (window as unknown as { __cfModule: (p: string) => Promise<{ useUiStore: { setState: (s: { zoom: number }) => void } }> }).__cfModule("/src/stores/ui.ts");
    m.useUiStore.setState({ zoom: 150 });
  });
  await expect(page.locator("html")).toHaveAttribute("data-zoom", "150");
  await expect(narrow).toHaveAttribute("data-folded", "true");
  expect(await narrow.evaluate((b) => (b as HTMLElement).offsetHeight)).toBe(170);
  const tops = await topsDuring(page, narrow, () => narrow.locator("xpath=..").getByTestId("thread-user-fold-toggle").click());
  expect(spread(tops)).toBeLessThan(1.5);
});

test("the prompt rail's jump lands on a prompt below an opened message", async ({ page }) => {
  await openThread(page);
  await send(page, longMessage(12));
  await send(page, "the prompt after it");
  await toggle(page, "the end of it").click();
  const rail = page.getByTestId("prompt-rail");
  await expect(rail).toBeVisible();
  await rail.locator("button").last().click();
  const target = pane(page).getByTestId("thread-user").filter({ hasText: "the prompt after it" });
  await expect(target).toBeInViewport();
});

test("the fold in both schemes (screenshots)", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  await openThread(page);
  await send(page, longMessage(12));
  await send(page, "Both are running in the background. Tell me when they end.");
  await wheelTo(page, fold(page, "the end of it"), 40);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.mouse.move(700, 20);
    await page.waitForTimeout(300);
    await shot(page, `folded-${scheme}`);
    await toggle(page, "the end of it").hover();
    await page.waitForTimeout(200);
    await shot(page, `folded-hover-${scheme}`);
    await toggle(page, "the end of it").click();
    await page.mouse.move(700, 20);
    await page.waitForTimeout(300);
    await shot(page, `open-${scheme}`);
    await toggle(page, "the end of it").click();
    await wheelTo(page, fold(page, "the end of it"), 40);
  }
});

test("a steer's fold (screenshot)", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  await mockPost("thread?state=streaming");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await threadPrompt(page).click();
  await page.keyboard.insertText(longMessage(10, "a long steer"));
  await page.keyboard.press("Enter");
  await expect(pane(page).getByTestId("thread-steer").getByTestId("thread-user-fold")).toHaveAttribute("data-folded", "true");
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await shot(page, `steer-${scheme}`);
  }
});
