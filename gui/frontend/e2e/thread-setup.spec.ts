import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * A thread's setup in its timeline (docs/notes/instant-threads-3-gui.md), scripted through
 * POST /__mock/thread/setup: what only a browser shows, that the rows sit between the
 * message and the turn and nothing above them moves, and that the fold line keeps its place
 * as it opens. Labels, order, the 300ms rule and the fold's contents are vitest's
 * (lib/threadSetup.test.ts, components/thread/SetupRow.test.tsx). Set SHOTS=<dir> to save
 * the PR's screenshots (WebKit, dark and light).
 */

const THREAD = "s-3";

const setup = (state: string, id = THREAD) => mockPost(`thread/setup?id=${id}&state=${state}`);
const bubble = (page: Page) => page.locator('[data-row-type="user"]').first();
const top = async (l: Locator) => (await l.boundingBox())?.y ?? Number.NaN;
const bottom = async (l: Locator) => {
  const b = await l.boundingBox();
  // The list lays rows out on whole pixels, under a row's fractional height.
  return b ? Math.floor(b.y + b.height) : Number.NaN;
};

test.beforeEach(async ({ page }) => {
  await resetMock();
  await openApp(page);
});

test("the rows arrive under the message without moving it, and the turn's header arrives below the fold", async ({ page }) => {
  await setup("fresh");
  await row(page, `s:${THREAD}`).click();
  await expect(bubble(page)).toBeVisible();
  const at = await top(bubble(page));

  const live = page.getByTestId("thread-setup-live");
  await expect(live).toBeVisible();
  expect(await top(live)).toBeGreaterThanOrEqual(await bottom(bubble(page)));
  expect(await top(bubble(page))).toBe(at);

  await setup("running");
  const rows = page.getByTestId("thread-setup-line");
  await expect(rows).toHaveCount(4);
  expect(await top(rows.first())).toBeGreaterThanOrEqual(await bottom(live));

  await setup("done");
  const fold = page.getByTestId("thread-setup-fold");
  await expect(fold).toBeVisible();
  const working = page.getByTestId("thread-working");
  await expect(working).toBeVisible();
  expect(await top(fold)).toBeGreaterThanOrEqual(await bottom(bubble(page)));
  expect(await top(working)).toBeGreaterThanOrEqual(await bottom(fold));
  expect(await top(bubble(page))).toBe(at);
});

test("the fold line keeps its place on screen as it opens and closes, in a list that scrolls", async ({ page }) => {
  // Short enough that the list scrolls under the window shell's top bar and tab strip.
  await page.setViewportSize({ width: 1000, height: 400 });
  await setup("done");
  await row(page, `s:${THREAD}`).click();
  const fold = page.getByTestId("thread-setup-fold");
  await expect(fold).toBeVisible();
  const at = await top(fold);

  await fold.click();
  await expect(page.getByTestId("thread-setup-line")).toHaveCount(4);
  expect(await top(fold)).toBe(at);
  expect(await page.getByTestId("thread-timeline").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  await fold.click();
  await expect(page.getByTestId("thread-setup-line")).toHaveCount(0);
  expect(await top(fold)).toBe(at);
});

/** SHOTS=<dir>: the PR's screenshots: every state of the timeline, then the sidebar's rows. */
for (const scheme of ["dark", "light"] as const) {
  test(`setup screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1000, height: 640 });
    await setup("running");
    await row(page, `s:${THREAD}`).click();
    await expect(page.getByTestId("thread-setup-line")).toHaveCount(4);
    await page.mouse.move(600, 400);
    const shot = (name: string) => page.screenshot({ path: `${shots ?? ""}/${name}-${scheme}.png` });
    await shot("running");
    for (const state of ["warn", "multi", "failed", "cancelled", "done", "done-warn"]) {
      await setup(state);
      await expect(page.locator(`[data-testid="thread-setup"][data-phase]`)).toBeVisible();
      await shot(state);
    }
    await page.getByTestId("thread-setup-fold").click();
    await expect(page.getByTestId("thread-setup-line")).toHaveCount(4);
    await shot("done-open");

    await setup("running", "s-3");
    await setup("failed", "s-4");
    await setup("cancelled", "s-6");
    await page.mouse.move(600, 400);
    const sidebar = await page.getByTestId("sidebar").boundingBox();
    if (!sidebar) throw new Error("no sidebar");
    await page.screenshot({ path: `${shots ?? ""}/sidebar-${scheme}.png`, clip: sidebar });
  });
}
