import { expect, test, type Locator, type Page } from "@playwright/test";
import { infoCardOff, mockPost, openApp, resetMock } from "./fixtures";
import { openRowThread } from "./shell-threads";

/**
 * A finished turn's Fork from here (docs/notes/fork-from-here-button.md). Which turns show it,
 * what it runs, its held and disabled states: components/thread/ForkFromHere.test.tsx. The
 * gutter's height and hover: thread.spec.ts. SHOTS=<dir> saves the pull request's screenshots.
 */

test.beforeEach(async () => {
  await resetMock();
  await infoCardOff();
});

const gutters = (page: Page) => page.getByTestId("thread-turn-gutter");

test("screenshots: the latest turn's gutter at rest, an older turn hovered, the tooltip", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  const shots = process.env.SHOTS ?? "";
  await page.setViewportSize({ width: 1280, height: 1100 });
  await mockPost("thread?state=idle");
  await openApp(page);
  await openRowThread(page, "s-r1");
  await expect(gutters(page)).toHaveCount(2);
  const timeline = page.getByTestId("thread-timeline");
  /** The timeline's left part from a little above the turn's gutter to under it. */
  const shoot = async (name: string, gutter: Locator, hover?: () => Promise<void>) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.mouse.move(5, 5);
      await page.waitForTimeout(300);
      if (hover) await hover();
      const g = await gutter.boundingBox();
      const t = await timeline.boundingBox();
      if (!g || !t) throw new Error(`no box for ${name}`);
      await page.screenshot({ path: `${shots}/${name}-${scheme}.png`, clip: { x: t.x, y: g.y - 96, width: Math.min(t.width, 680), height: g.height + 120 } });
    }
  };
  const finals = page.locator('[data-testid="thread-text"][data-final]');
  await shoot("latest-at-rest", gutters(page).last());
  await shoot("older-hovered", gutters(page).first(), async () => {
    await finals.first().hover();
  });
  const fork = gutters(page).last().getByTestId("thread-fork-here");
  if ((await fork.count()) > 0) {
    await shoot("tooltip", gutters(page).last(), async () => {
      await fork.hover();
      await expect(page.getByRole("tooltip")).toHaveText("Fork from here");
    });
  }
});
