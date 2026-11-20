import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";
import { openRowThread } from "./shell-threads";

/**
 * The row above a thread's composer and its pill (docs/notes/composer-row-pill.md) over the
 * mock's scripted thread s-r1. Which segments show, what they say and what each menu item runs
 * are src/components/thread/ComposerRow.test.tsx's and WaitingPanel.test.tsx's, the shortening
 * rule src/lib/composerPill.test.ts's; this keeps what needs a browser: nothing moves when the
 * pill comes and goes (the row 36px either way, the pill 8px above the composer card), the panel opens over the conversation, the list arrives over the
 * thread's stream, and all four segments fit a 480px pane. Set SHOTS=<dir> to save
 * screenshots (WebKit, dark and light).
 */

const pill = (page: Page) => page.getByTestId("composer-pill");
const kinds = (page: Page) => page.getByTestId("waiting-row").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.kind));

async function openWaiting(page: Page): Promise<void> {
  await mockPost("thread?state=waiting");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("pill-waiting")).toBeVisible();
}

/** s-r1 working (streaming), waiting on the sample wakes and snoozed (a message left the snooze in place), opened from the Snoozed footer. */
async function openAllButJump(page: Page): Promise<void> {
  await mockPost("thread?state=streaming");
  await mockPost("thread/wakes?id=s-r1");
  await mockPost("thread/snooze?id=s-r1&until=2h&live=1");
  await openApp(page);
  await page.getByTestId("snoozed-header").click();
  await row(page, "s:s-r1").click();
  await page.getByTestId("snoozed-header").click();
  await expect(page.getByTestId("pill-snooze")).toBeVisible();
}

/** Scrolls the list up: Jump to bottom joins the pill. */
async function scrollUp(page: Page): Promise<void> {
  const timeline = page.getByTestId("thread-timeline");
  const b = await timeline.boundingBox();
  if (!b) throw new Error("no timeline");
  await page.mouse.move(b.x + 200, b.y + 120);
  await page.mouse.wheel(0, -800);
  await expect(page.getByTestId("thread-jump-bottom")).toBeVisible();
}

/** Where the composer and the conversation's rows are on screen. */
function layout(page: Page) {
  return page.evaluate(() => {
    const composer = document.querySelector('[data-testid="thread-composer"]')?.getBoundingClientRect();
    const timeline = document.querySelector<HTMLElement>('[data-testid="thread-timeline"]');
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="thread-timeline"] [data-index]')].map((r) => `${r.dataset.index ?? ""}:${String(Math.round(r.getBoundingClientRect().top))}`);
    return { composer: composer ? [composer.top, composer.height] : null, scrollTop: timeline?.scrollTop, rows };
  });
}

/** The layout once two reads a frame apart agree (the list has rendered and measured its rows). */
async function settled(page: Page) {
  await expect(page.getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
  let prev = JSON.stringify(await layout(page));
  for (;;) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const now = JSON.stringify(await layout(page));
    if (now === prev) return JSON.parse(now) as Awaited<ReturnType<typeof layout>>;
    prev = now;
  }
}

/** The row's height and, with a pill, the gap between the pill's bottom and the composer card's top. */
function rowGap(page: Page) {
  return page.evaluate(() => {
    const r = document.querySelector('[data-testid="composer-row"]')?.getBoundingClientRect();
    const p = document.querySelector('[data-testid="composer-pill"]')?.getBoundingClientRect();
    const c = document.querySelector('[data-testid="thread-composer"]')?.getBoundingClientRect();
    return { row: r?.height ?? null, gap: p && c ? c.top - p.bottom : null };
  });
}

/** The pill fits its row: nothing in it is cut off. */
function fits(page: Page) {
  return page.evaluate(() => {
    const p = document.querySelector<HTMLElement>('[data-testid="composer-pill"]');
    const r = document.querySelector('[data-testid="composer-row"]')?.getBoundingClientRect();
    if (!p || !r) return null;
    const b = p.getBoundingClientRect();
    return { overflow: p.scrollWidth - p.clientWidth, inside: b.left >= r.left - 0.5 && b.right <= r.right + 0.5, step: p.dataset.step };
  });
}

test.beforeEach(async () => {
  await resetMock();
});

test("the pill coming and going moves neither the conversation nor the composer", async ({ page }) => {
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("composer-row")).toBeVisible();
  await expect(pill(page)).toHaveCount(0);
  const empty = await settled(page);
  expect(await rowGap(page)).toEqual({ row: 36, gap: null });
  await mockPost("thread/wakes?id=s-r1");
  await expect(page.getByTestId("pill-waiting")).toBeVisible();
  expect(await layout(page)).toEqual(empty);
  // The pill sits at the row's top, 8px above the composer card; the row keeps its 36px.
  expect(await rowGap(page)).toEqual({ row: 36, gap: 8 });
  for (const sub of ["sub-t1", "sub-t2", "sub-pr", "sub-timer"]) await mockPost(`thread/wake-fire?sub=${sub}`);
  await expect(pill(page)).toHaveCount(0);
  expect(await layout(page)).toEqual(empty);
});

test("the waiting panel opens upward over the conversation, leaving the composer where it is", async ({ page }) => {
  // React's warnings too: the row and the composer are siblings keyed by thread.
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("same key")) errors.push(m.text());
  });
  await openWaiting(page);
  const before = await settled(page);
  const seg = await page.getByTestId("pill-waiting").boundingBox();
  await page.getByTestId("pill-waiting").click();
  await expect(page.getByTestId("waiting-row")).toHaveCount(6);
  const panel = await page.getByTestId("waiting-panel").boundingBox();
  if (!seg || !panel) throw new Error("no boxes");
  expect(panel.y + panel.height).toBeLessThanOrEqual(seg.y);
  expect(await layout(page)).toEqual(before);
  // Every row shows: the list scrolls only past its cap.
  expect(await page.getByTestId("waiting-rows").evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("waiting-panel")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the list follows the thread's stream: a row removed, a status changed, a wake fired, then Stop waiting", async ({ page }) => {
  await openWaiting(page);
  await page.getByTestId("pill-waiting").click();
  await page.locator('[data-wake="sub-t1"]').getByTestId("waiting-remove").click();
  await expect(page.locator('[data-wake="sub-t1"]')).toHaveCount(0);
  await expect(page.getByTestId("waiting-panel-title")).toHaveText("Waiting on 5");
  await mockPost("thread/wake-status?sub=sub-pr&status=open%20·%20checks%20passed%20(4/4)");
  await expect(page.locator('[data-wake="sub-pr"]').getByTestId("waiting-row-status")).toHaveText("checks passed (4/4)");
  await mockPost("thread/wake-fire?sub=sub-pr");
  await expect(page.locator('[data-wake="sub-pr"]')).toHaveCount(0);

  await page.getByTestId("waiting-stop-all").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("npm run dev");
  await expect(dialog).toContainText("child threads keep working");
  await expect(dialog.getByTestId("confirm-ok")).toHaveText("Stop waiting");
  await dialog.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("waiting-sentence")).toHaveText("Waiting on 1 subagent");
  await expect(page.getByTestId("waiting-stop")).toHaveCount(0);
  if ((await page.getByTestId("waiting-panel").count()) === 0) await page.getByTestId("pill-waiting").click();
  await expect.poll(() => kinds(page)).toEqual(["subagent"]);
  await expect(page.getByTestId("waiting-stop-all")).toHaveCount(0);
});

test("back on a thread the waiting segment says what is true now, not what it said when left", async ({ page }) => {
  await openWaiting(page);
  // s-2 waits on the user: its row's first line opens it, a tab beside s-r1's.
  await openRowThread(page, "s-2");
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-2");
  await mockPost("thread/wake-fire?sub=sub-pr");
  await openRowThread(page, "s-r1");
  await expect(page.getByTestId("waiting-sentence")).toHaveText(/^Waiting on (2 threads, 1 timer, 1 shell and 1 subagent|5)$/);
});

for (const width of [480, 640]) {
  test(`all four segments fit a ${String(width)}px pane`, async ({ page }) => {
    await openAllButJump(page);
    await scrollUp(page);
    const pane = page.getByTestId("thread-pane");
    // The window's width less the sidebar's and the pane's frame: the pane at `width`.
    const extra = await page.evaluate(() => window.innerWidth - (document.querySelector('[data-testid="thread-pane"]')?.getBoundingClientRect().width ?? 0));
    await page.setViewportSize({ width: Math.round(width + extra), height: 800 });
    await expect.poll(async () => Math.round((await pane.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(width);
    for (const id of ["pill-working", "pill-snooze", "pill-waiting", "thread-jump-bottom"]) await expect(page.getByTestId(id)).toBeVisible();
    await expect.poll(() => fits(page)).toMatchObject({ overflow: 0, inside: true });
    await expect(page.getByTestId("thread-jump-bottom")).toHaveText("Jump to bottom");
  });
}

/** SHOTS=<dir>: the row in each state, WebKit, 1280x800 at 2x, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`composer row shots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });
    const shot = async (page: Page, name: string) => {
      await page.mouse.move(640, 200);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${String(process.env.SHOTS)}/row-${name}-${scheme}.png` });
    };
    test.beforeEach(({ browserName }) => {
      test.skip(!process.env.SHOTS || browserName !== "webkit", "SHOTS=<dir> with WebKit only");
    });

    test("empty", async ({ page }) => {
      await mockPost("thread?state=idle");
      await openApp(page);
      await row(page, "s:s-r1").click();
      await expect(page.getByTestId("composer-row")).toBeVisible();
      await shot(page, "empty");
    });

    test("working", async ({ page }) => {
      await mockPost("thread?state=streaming");
      await openApp(page);
      await row(page, "s:s-r1").click();
      await expect(page.getByTestId("pill-working")).toBeVisible();
      await shot(page, "working");
    });

    test("working, scrolled up", async ({ page }) => {
      await mockPost("thread?state=streaming");
      await openApp(page);
      await row(page, "s:s-r1").click();
      await expect(page.getByTestId("pill-working")).toBeVisible();
      await scrollUp(page);
      await shot(page, "working-jump");
    });

    test("working and waiting", async ({ page }) => {
      await mockPost("thread?state=streaming");
      await mockPost("thread/wakes?id=s-r1");
      await openApp(page);
      await row(page, "s:s-r1").click();
      await expect(page.getByTestId("pill-waiting")).toBeVisible();
      await shot(page, "working-waiting");
    });

    test("idle waiting, closed and opened", async ({ page }) => {
      await openWaiting(page);
      await shot(page, "waiting");
      await page.getByTestId("pill-waiting").click();
      await expect(page.getByTestId("waiting-row")).toHaveCount(6);
      await shot(page, "waiting-open");
    });

    test("snoozed, closed and opened", async ({ page }) => {
      await mockPost("thread?state=idle");
      await mockPost("thread/snooze?id=s-r1&until=2h&live=1");
      await openApp(page);
      await page.getByTestId("snoozed-header").click();
      await row(page, "s:s-r1").click();
      await page.getByTestId("snoozed-header").click();
      await expect(page.getByTestId("pill-snooze")).toBeVisible();
      await shot(page, "snoozed");
      await page.getByTestId("pill-snooze").click();
      await expect(page.getByTestId("snooze-menu")).toBeVisible();
      await shot(page, "snoozed-open");
    });

    test("snooze ended, closed and opened", async ({ page }) => {
      await mockPost("thread?state=idle");
      await mockPost("thread/snooze?id=s-r1&until=2m");
      await mockPost("thread/wake?id=s-r1");
      await openApp(page);
      await row(page, "s:s-r1").click();
      await expect(page.getByTestId("pill-snooze")).toHaveAttribute("data-kind", "woken");
      await shot(page, "snooze-ended");
      await page.getByTestId("pill-snooze").click();
      await expect(page.getByTestId("snooze-menu")).toBeVisible();
      await shot(page, "snooze-ended-open");
    });

    test("all four at 640px and 480px", async ({ page }) => {
      await openAllButJump(page);
      await scrollUp(page);
      const extra = await page.evaluate(() => window.innerWidth - (document.querySelector('[data-testid="thread-pane"]')?.getBoundingClientRect().width ?? 0));
      for (const width of [640, 480]) {
        await page.setViewportSize({ width: Math.round(width + extra), height: 800 });
        await expect.poll(() => fits(page)).toMatchObject({ overflow: 0, inside: true });
        await shot(page, `all-${String(width)}`);
      }
    });
  });
}
