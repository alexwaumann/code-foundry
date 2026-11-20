import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";
import { openPrBesidePage } from "./shell-pages";

/**
 * The working and waiting circle (components/status/StatusCircle.tsx, docs/notes/working-circle.md):
 * what only a real browser shows, the compiled turn (index.css --animate-status-*) and that it
 * keeps turning under prefers-reduced-motion. Which mark goes where is vitest's. SHOTS=<dir> saves the PR's
 * screenshots: the live turn header, the sidebar's working and waiting rows, a running checks card.
 */

const shots = process.env.SHOTS;

test.beforeEach(async () => {
  await resetMock();
});

async function openStreaming(page: Page): Promise<void> {
  await mockPost("thread?state=streaming");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-working")).toBeVisible();
}

/** The circle's running animations (name, duration in ms, iterations); null when the element went (a remount), to poll again. */
function turns(circle: Locator): Promise<{ name: string; duration: number; iterations: number }[] | null> {
  return circle.evaluate((el) =>
    el.isConnected
      ? el.getAnimations().map((a) => {
          const t = a.effect?.getComputedTiming();
          return { name: (a as CSSAnimation).animationName, duration: Number(t?.duration ?? 0), iterations: t?.iterations ?? 0 };
        })
      : null,
  );
}

test("the working circle turns once in 5s and the waiting one in 11s, forever", async ({ page }) => {
  await mockPost("live-count");
  await openStreaming(page);
  const working = page.getByTestId("thread-working").locator('svg[data-status-circle="working"]');
  // Polled: the live header mounts its circle again as the thread view settles.
  await expect.poll(() => turns(working)).toEqual([{ name: "cf-status-turn", duration: 5000, iterations: Infinity }]);
  // The box does not move: the turn is a transform on the icon's own fixed size.
  expect(await working.evaluate((el) => getComputedStyle(el).width)).toBe("14px");
  const waiting = page.getByTestId("thread-list").locator('svg[data-status-circle="waiting"]').first();
  await expect.poll(() => turns(waiting)).toEqual([{ name: "cf-status-turn", duration: 11000, iterations: Infinity }]);
});

test("under prefers-reduced-motion the circle still turns: it says something is running", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openStreaming(page);
  const working = page.getByTestId("thread-working").locator('svg[data-status-circle="working"]');
  await expect.poll(() => turns(working)).toEqual([{ name: "cf-status-turn", duration: 5000, iterations: Infinity }]);
});

async function clipAround(page: Page, target: Locator, name: string, pad = { x: 12, y: 12, width: 420 }): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error(`${name}: no box`);
  await page.screenshot({ path: `${shots ?? ""}/${name}.png`, clip: { x: Math.max(0, box.x - pad.x), y: Math.max(0, box.y - pad.y), width: Math.max(box.width, pad.width) + 2 * pad.x, height: box.height + 2 * pad.y }, scale: "device" });
}

for (const scheme of ["dark", "light"] as const) {
  test(`status circle screenshots (${scheme})`, async ({ page }, info) => {
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await mockPost("status-kinds");
    await mockPost("live-count");
    await openStreaming(page);
    await page.mouse.move(1390, 890);
    const working = page.getByTestId("thread-working");
    // The live header sits above the streamed reply: scroll the timeline up to it.
    const timeline = page.getByTestId("thread-timeline");
    await timeline.hover();
    await page.mouse.wheel(0, -4000);
    await timeline.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect.poll(async () => (await working.boundingBox())?.y ?? -1).toBeGreaterThan(40);
    await page.mouse.move(1390, 890);
    await clipAround(page, working, `turn-header-${scheme}`, { x: 24, y: 16, width: 320 });
    await page.screenshot({ path: `${shots ?? ""}/sidebar-${scheme}.png`, clip: { x: 0, y: 0, width: 256, height: 900 }, scale: "device" });

    await openPrBesidePage(page, 163, 520);
    await page.mouse.move(2, 2);
    const card = page.getByTestId("pr-readiness").locator('[data-row="checks"]');
    await expect(card).toBeVisible();
    await clipAround(page, card, `pr-checks-${scheme}`, { x: 12, y: 12, width: 0 });
  });
}
