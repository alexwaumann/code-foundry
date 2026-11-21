import { expect, test, type Page } from "@playwright/test";
import { infoCardOff, mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

// A steered turn split at each steer (docs/notes/steer-segments.md), only what needs a
// browser: a queued message turning solid where it is when Claude reads it, folding one
// stretch leaving the rest in place, and a message too late for its turn becoming the next
// one's prompt where it waits. The segments, captions, headers and gutter: vitest
// (src/lib/steerSegments.test.ts, src/components/thread/steerRows.test.tsx). Over the mock's
// s-r1 "Fix stale PR badge" (streaming), with steers held queued (/__mock/thread/steer).
// SHOTS=<dir> saves the PR's screenshots.

test.beforeEach(async () => {
  await resetMock();
  await infoCardOff();
});

const pane = (page: Page) => page.getByTestId("thread-pane");
const timeline = (page: Page) => pane(page).getByTestId("thread-timeline");
const headers = (page: Page) => pane(page).getByTestId("thread-turn-header");

/** Each mounted row's key and top inside the list's content (its box plus the scroll), so scrolling is no move. */
const tops = (page: Page) =>
  timeline(page)
    .locator("[data-index]")
    .evaluateAll((rows) => {
      let s: HTMLElement | null = rows[0]?.parentElement ?? null;
      while (s && !["auto", "scroll"].includes(getComputedStyle(s).overflowY)) s = s.parentElement;
      const base = s ? s.getBoundingClientRect().top - s.scrollTop : 0;
      return rows.map((r) => `${r.getAttribute("data-index") ?? ""} ${String(Math.round(r.getBoundingClientRect().top - base))}`);
    });

async function openStreaming(page: Page): Promise<void> {
  await mockPost("thread?state=streaming");
  await mockPost("thread/steer?do=hold");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(timeline(page).locator("[data-row-type]").first()).toBeVisible();
}

async function steer(page: Page, text: string): Promise<void> {
  await threadPrompt(page).click();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
  await expect(pane(page).locator('[data-delivery="queued"]').last()).toBeVisible();
}

test("a queued steer is the last row and turns solid where it is when Claude reads it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await openStreaming(page);
  await steer(page, "Also add a README table");
  // What arrives while it waits goes above it.
  await mockPost("thread/tool?command=bun%20test%20sidebar");
  const last = timeline(page).locator("[data-index]").last();
  await expect(last.locator('[data-delivery="queued"]')).toBeVisible();
  const before = await tops(page);
  const queuedBox = await last.locator(".bubble").boundingBox();
  await mockPost("thread/steer?id=s-r1&do=read&reply=0");
  await expect(pane(page).locator('[data-testid="thread-steer"][data-delivery="read"]')).toBeVisible();
  // Every row up to the message keeps its place; a live header is appended under it.
  const after = await tops(page);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after).toHaveLength(before.length + 1);
  const readBubble = await pane(page).locator('[data-testid="thread-steer"][data-delivery="read"] .bubble').boundingBox();
  expect(readBubble?.width).toBe(queuedBox?.width);
  expect(readBubble?.height).toBe(queuedBox?.height);
  await expect(headers(page)).toHaveCount(2);
  await expect(headers(page).last()).toHaveAttribute("data-live", "true");
});

test("folding one stretch leaves the other stretches and the messages in place", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await openStreaming(page);
  await steer(page, "Also add a README table");
  await mockPost("thread/steer?id=s-r1&do=read&reply=0");
  await mockPost("thread/tool?command=bun%20test%20readme");
  await mockPost("thread/finish");
  await expect(headers(page)).toHaveCount(2);
  const second = headers(page).nth(1).locator("button");
  await expect(second).toHaveAttribute("aria-expanded", "false");
  const steerTop = await pane(page).getByTestId("thread-steer").boundingBox();
  const firstHeader = await headers(page).first().boundingBox();
  await second.click();
  await expect(second).toHaveAttribute("aria-expanded", "true");
  await expect(pane(page).getByText("bun test readme")).toBeVisible();
  // The first stretch stays folded; its header and the message keep their places on screen.
  await expect(headers(page).first().locator("button")).toHaveAttribute("aria-expanded", "false");
  expect(await headers(page).first().boundingBox()).toEqual(firstHeader);
  expect(await pane(page).getByTestId("thread-steer").boundingBox()).toEqual(steerTop);
});

test("too late: a message still queued when the turn ends waits under it and becomes the next turn's prompt where it is", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await openStreaming(page);
  await steer(page, "One more thing: bump the version");
  await mockPost("thread/finish");
  const waiting = pane(page).locator('[data-testid="thread-user"][data-delivery="queued"]');
  await expect(waiting).toBeVisible();
  await expect(timeline(page).locator("[data-index]").last().locator('[data-delivery="queued"]')).toBeVisible();
  const before = await tops(page);
  /** The bubble's top and right edge inside its row: the pinned list scrolls for the new header, which is no move. */
  const inRow = (bubble: ReturnType<Page["locator"]>) =>
    bubble.evaluate((b) => {
      const r = b.closest("[data-index]")?.getBoundingClientRect();
      const x = b.getBoundingClientRect();
      return r ? [Math.round(x.top - r.top), Math.round(r.right - x.right)] : null;
    });
  const was = await inRow(waiting.locator(".bubble"));
  await mockPost("thread/steer?id=s-r1&do=read&reply=0");
  const prompt = pane(page).locator('[data-testid="thread-user"][data-delivery="read"]');
  await expect(prompt).toBeVisible();
  await expect(prompt).not.toHaveClass(/small/);
  // Above it nothing moved, nor its row; the bubble keeps its top and right edge and grows to a prompt's size.
  expect((await tops(page)).slice(0, before.length)).toEqual(before);
  expect(await inRow(prompt.locator(".bubble"))).toEqual(was);
  await expect(headers(page).last()).toHaveAttribute("data-live", "true");
});

/** SHOTS=<dir>: the PR's screenshots, WebKit at 2x, dark and light, after. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2, viewport: { width: 1100, height: 760 } });
    test("every state of a steered turn", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      test.setTimeout(90_000);
      const dir = String(shots);
      const shot = async (name: string) => {
        await page.waitForTimeout(400);
        await pane(page).screenshot({ path: `${dir}/${name}-${scheme}.png` });
      };
      await openStreaming(page);
      await steer(page, "Also add a README table listing each algorithm with its average time complexity.");
      await mockPost("thread/tool?command=python3%20bench.py&done=1");
      await mockPost("thread/tool?command=python3%20bubble_sort.py");
      await shot("live-queued");
      await mockPost("thread/steer?id=s-r1&do=read&reply=0");
      await mockPost("thread/tool?command=python3%20insertion_sort.py&done=1");
      await page.waitForTimeout(2500);
      await shot("live-read");
      await mockPost("thread/tool?command=python3%20heap_sort.py&done=1");
      await page.waitForTimeout(2500);
      await steer(page, "And keep the table sorted by name.");
      // Read, and answered: the mock's reply ends the turn.
      await mockPost("thread/steer?id=s-r1&do=read");
      await expect(page.getByTestId("thread-working")).toHaveCount(0);
      await shot("two-steers-folded");
      // The two stretches after the steers open; the first (the scripted turn's long work) stays folded.
      for (const i of [1, 2]) await headers(page).nth(-i).locator("button").click();
      await headers(page).nth(-3).scrollIntoViewIfNeeded();
      await shot("two-steers-open");
      // Too late: sent as the turn ends, it waits under it; then it is the next prompt.
      await mockPost("thread/status?id=s-r1&status=busy");
      await steer(page, "One more thing: bump the version.");
      await shot("too-late-waiting");
      await mockPost("thread/steer?id=s-r1&do=read&reply=0");
      await page.waitForTimeout(1200);
      await shot("too-late-started");
      // Never read: the process ends with a steer queued.
      await steer(page, "Then open a PR.");
      await mockPost("thread/stop?id=s-r1&reason=crashed&code=1");
      await expect(pane(page).locator('[data-delivery="unsent"]')).toBeVisible();
      // The live header lingers 2s past a stop (components/thread/activity.ts).
      await expect(page.getByTestId("thread-working")).toHaveCount(0);
      await shot("not-sent");
    });
  });
}
