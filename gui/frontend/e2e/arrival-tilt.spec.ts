import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock } from "./fixtures";

/**
 * The arrival tilt (docs/notes/arrival-tilt.md), what only a browser shows: the stylesheet's
 * animation running on the icon once, with Reduce motion on, and not again after a reload. When
 * something arrives and which element tilts in each place are vitest's (src/lib/arrivals.test.ts,
 * src/stores/arrivals.test.tsx, src/components/sidebar/arrivalTilt.test.tsx,
 * src/components/notifications/NotificationBellTilt.test.tsx). SHOTS=<dir> for the PR's
 * screenshots (WebKit, dark and light).
 */

test.beforeEach(async () => {
  await resetMock();
});

/** The arrival tilt's animations on the page: where each runs and its timing. */
function tilts(page: Page): Promise<{ testId: string | null; iterations: number; duration: number }[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a): a is CSSAnimation => a instanceof CSSAnimation && a.animationName === "cf-arrival-tilt")
      .map((a) => {
        const t = a.effect?.getComputedTiming();
        const el = a.effect instanceof KeyframeEffect ? a.effect.target : null;
        return { testId: el?.getAttribute("data-testid") ?? null, iterations: Number(t?.iterations), duration: Number(t?.duration) };
      }),
  );
}

test("a thread entering Needs you tilts its icon once, with Reduce motion on, and a reload does not replay it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  await mockPost("thread/status?id=s-1&status=busy");
  const row = page.locator('[data-row-key="s:s-1"]');
  await expect(row).toHaveAttribute("data-section", "working");
  expect(await tilts(page)).toEqual([]);
  await mockPost(`thread/status?id=s-1&status=attention&reason=${encodeURIComponent("question: Which?")}`);
  await expect(row).toHaveAttribute("data-section", "needs");
  expect(await tilts(page)).toEqual([{ testId: "row-ask-icon", iterations: 1, duration: 1400 }]);
  // It ends on its own and does not start again.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))).then(() => undefined));
  expect(await tilts(page)).toEqual([]);
  await page.reload();
  await expect(page.locator('[data-row-key="s:s-1"]')).toHaveAttribute("data-section", "needs");
  expect(await tilts(page)).toEqual([]);
});

/** Holds every arrival tilt at its first swing (8%, 20°), so a screenshot shows the tilt. */
async function holdTilt(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      if (!(a instanceof CSSAnimation) || a.animationName !== "cf-arrival-tilt") continue;
      a.pause();
      a.currentTime = 112;
    }
  });
}

/** Sets the arrivals as the store notes them; set by hand, nothing forgets them. */
async function arrive(page: Page, bell: boolean, threads: string[]): Promise<void> {
  await page.evaluate(
    ([b, ids]) =>
      (window as unknown as { __cfModule: (p: string) => Promise<{ useArrivalsStore: { setState: (s: unknown) => void } }> })
        .__cfModule("/src/stores/arrivals.ts")
        .then((m) => {
          const now = Date.now();
          m.useArrivalsStore.setState({ bell: b ? now : null, threads: Object.fromEntries(ids.map((id) => [id, now])) });
        }),
    [bell, threads] as const,
  );
}

async function setExpanded(page: Page, expanded: boolean): Promise<void> {
  await page.evaluate(
    (e) =>
      (window as unknown as { __cfModule: (p: string) => Promise<{ useUiStore: { setState: (s: unknown) => void } }> })
        .__cfModule("/src/stores/ui.ts")
        .then((m) => {
          m.useUiStore.setState({ sidebarExpanded: e });
        }),
    expanded,
  );
}

test("SHOTS: the bell, a Needs you row and a woken row, still and mid-tilt, expanded and on the rail", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
  const shots = process.env.SHOTS ?? "";
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await mockPost("notifications/seed?quiet=1");
  await mockPost("thread/status?id=s-5&status=attention&reason=snooze%20ended");
  await expect(page.locator('[data-row-key="s:s-5"]')).toBeVisible();
  await page.mouse.move(640, 700);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const expanded of [true, false]) {
      const where = expanded ? "expanded" : "rail";
      await setExpanded(page, expanded);
      await arrive(page, false, []);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/tilt-${where}-before-${scheme}.png`, clip: { x: 0, y: 0, width: 1280, height: 320 } });
      await arrive(page, true, ["s-2", "s-5"]);
      await holdTilt(page);
      await page.screenshot({ path: `${shots}/tilt-${where}-after-${scheme}.png`, clip: { x: 0, y: 0, width: 1280, height: 320 } });
    }
  }
});
