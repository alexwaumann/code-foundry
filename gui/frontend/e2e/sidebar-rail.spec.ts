import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, setZoom } from "./fixtures";

/**
 * The collapsed sidebar's rail (docs/notes/sidebar-rail.md), what only a browser shows: its
 * width at 100% and zoomed, Needs you and Active scrolling on their own without a scrollbar and
 * fading only the edge with more, a hover card landing beside the rail, and a Working, Snoozed or
 * Archived card landing beside it, staying open while the pointer crosses into it, its list capped
 * at 300px and scrolling inside it. Which icon a row gets, the sections, the separators, the cap,
 * what a click, a hover and a right click do, a card's rows and the update tile are vitest's
 * (components/sidebar/rail/*.test.ts*, components/update/UpdateTile.test.tsx). SHOTS=<dir> for the
 * PR's screenshots (WebKit, dark and light).
 */

async function collapse(page: Page): Promise<void> {
  await page.getByTestId("top-bar-sidebar-toggle").click();
  await expect(page.getByTestId("sidebar-rail")).toBeVisible();
}

/** Wait out finite animations (a card's fade, a menu's); a spinner or the flame runs for ever. */
async function still(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

const fades = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((el: HTMLElement) => ({ top: el.hasAttribute("data-fade-top"), bottom: el.hasAttribute("data-fade-bottom"), mask: el.style.maskImage, scrollbar: el.offsetWidth - el.clientWidth }));

test.beforeEach(async () => {
  await resetMock();
  await mockPost("status-kinds");
});

test("the rail is 40px wide and zooms with the page; the pane starts a shell gap after it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await collapse(page);
  const rail = page.getByTestId("sidebar-rail");
  expect((await rail.boundingBox())?.width).toBe(40);
  const grid = await page.getByTestId("shell-grid").boundingBox();
  expect(Math.round(grid?.x ?? 0)).toBe(52);
  await setZoom(page, 150);
  await expect.poll(async () => Math.round((await rail.boundingBox())?.width ?? 0)).toBe(60);
});

test("Needs you and Active scroll on their own, without a scrollbar, fading only the edge with more", async ({ page }) => {
  await mockPost("threads?project=repo-cf&count=30&status=idle");
  // Two more permission asks: six under Needs you, past its four.
  const asks = (await mockPost("threads?project=repo-cf&count=2&status=idle&prefix=Ask")) as string[];
  for (const id of asks) await mockPost(`thread/status?id=${id}&status=attention&reason=permission`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await collapse(page);
  const needs = page.getByTestId("rail-needs");
  const active = page.getByTestId("rail-active");
  // Needs you is four icons tall (4 × 26 + 3 × 2) and has more below.
  expect((await needs.boundingBox())?.height).toBe(110);
  expect(await fades(page, "rail-needs")).toMatchObject({ top: false, bottom: true, scrollbar: 0 });
  expect(await fades(page, "rail-active")).toMatchObject({ top: false, bottom: true, scrollbar: 0 });
  expect((await fades(page, "rail-active")).mask).toContain("linear-gradient");
  // Scrolling Active moves neither Needs you nor the footer; it then fades at both edges.
  const footer = await page.getByTestId("rail-footer").boundingBox();
  await active.hover();
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await fades(page, "rail-active")).top).toBe(true);
  expect(await needs.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await page.getByTestId("rail-footer").boundingBox()).toEqual(footer);
  // At its end: only the top fades.
  await active.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => fades(page, "rail-active")).toMatchObject({ top: true, bottom: false });
});

test("a Needs you icon's card opens beside the rail", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await collapse(page);
  const icon = page.getByTestId("rail-needs").getByTestId("rail-row").first();
  await icon.hover();
  const card = page.getByTestId("needs-card");
  await expect(card).toBeVisible();
  const [i, c] = [await icon.boundingBox(), await card.boundingBox()];
  expect(c?.x ?? 0).toBeGreaterThanOrEqual((i?.x ?? 0) + (i?.width ?? 0));
  expect(c?.x ?? 0).toBeLessThan(60);
});

/** Archives `count` new idle threads: a long Archived card. */
async function archiveMany(count: number): Promise<void> {
  const ids = (await mockPost(`threads?project=repo-cf&count=${String(count)}&status=idle&prefix=Spike`)) as string[];
  for (const id of ids) await mockPost(`thread/archive?id=${id}`);
}

test("a section's card opens beside the rail and stays open while the pointer crosses from the icon into it", async ({ page }) => {
  await mockPost("threads?project=repo-cf&count=2&status=busy");
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await collapse(page);
  const icon = page.getByTestId("rail-working");
  const card = page.getByTestId("rail-working-card");
  await icon.hover();
  await expect(card).toBeVisible();
  const [i, c] = [await icon.boundingBox(), await card.boundingBox()];
  expect(c?.x ?? 0).toBeGreaterThanOrEqual((i?.x ?? 0) + (i?.width ?? 0));
  expect(c?.x ?? 0).toBeLessThan(60);
  // Beside the icon: the card spans its height (shifted up when it would not fit below).
  expect(c?.y ?? 0).toBeLessThanOrEqual(i?.y ?? 0);
  expect((c?.y ?? 0) + (c?.height ?? 0)).toBeGreaterThanOrEqual((i?.y ?? 0) + (i?.height ?? 0));
  // Across the gap and into a row, slowly: still open.
  const row = card.locator("[data-row-key]").first();
  const r = await row.boundingBox();
  await page.mouse.move((r?.x ?? 0) + 20, (r?.y ?? 0) + 10, { steps: 15 });
  await page.waitForTimeout(500);
  await expect(card).toBeVisible();
  // Out of both: it closes.
  await page.mouse.move(900, 300, { steps: 5 });
  await expect(card).toHaveCount(0);
});

test("a long Archived card caps its list at 300px and scrolls inside it, without a scrollbar, fading the edge with more", async ({ page }) => {
  await archiveMany(40);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await collapse(page);
  await page.getByTestId("rail-archived").hover();
  const rows = page.getByTestId("rail-archived-rows");
  await expect(rows).toBeVisible();
  expect((await rows.boundingBox())?.height).toBe(300);
  expect(await fades(page, "rail-archived-rows")).toMatchObject({ top: false, bottom: true, scrollbar: 0 });
  expect((await fades(page, "rail-archived-rows")).mask).toContain("linear-gradient");
  // Fewer rows than are listed: virtualized.
  expect(await rows.locator("[data-row-key]").count()).toBeLessThan(41);
  await rows.hover();
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await fades(page, "rail-archived-rows")).top).toBe(true);
  await rows.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => fades(page, "rail-archived-rows")).toMatchObject({ top: true, bottom: false });
  await expect(page.getByTestId("rail-archived-card")).toBeVisible();
});

/** Checks for updates from the palette (the mock finds `update/latest`) and shuts the dialog it opens. */
async function checkForUpdate(page: Page): Promise<void> {
  await page.keyboard.press("Meta+k");
  const item = page.getByTestId("palette").locator('[data-command="app.update.check"]');
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("update-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("update-dialog")).toHaveCount(0);
}

/** SHOTS=<dir>: each section's card, a long Archived card, the update tile downloading and ready; dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`sidebar rail card and update screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    test.setTimeout(60_000);
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await mockPost("ember?enabled=true");
    await mockPost("threads?project=repo-cf&count=2&status=busy");
    // Held in Downloading for the first shot.
    await mockPost("update/latest?version=v0.2.0&stepMs=600000");
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page);
    await collapse(page);
    for (const section of ["working", "snoozed", "archived"]) {
      await page.mouse.move(900, 700);
      await expect(page.locator('[data-testid$="-card"][data-state]')).toHaveCount(0);
      await page.getByTestId(`rail-${section}`).hover();
      await expect(page.getByTestId(`rail-${section}-card`)).toBeVisible();
      await still(page);
      await page.screenshot({ path: at(`rail-${section}-card`) });
    }

    await page.mouse.move(900, 700);
    await checkForUpdate(page);
    const tile = page.getByTestId("update-tile");
    await expect(tile).toHaveAttribute("data-kind", "downloading");
    await tile.hover();
    await expect(page.getByTestId("update-tile-tip")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("rail-update-downloading") });

    // A fresh world: the download finishes; and a long Archived list.
    await resetMock();
    await mockPost("status-kinds");
    await mockPost("ember?enabled=true");
    await mockPost("threads?project=repo-cf&count=2&status=busy");
    await archiveMany(20);
    await mockPost("update/latest?version=v0.2.0");
    // The rail stays collapsed across the reload (openApp waits for the expanded list's rows).
    await page.reload();
    await expect(page.getByTestId("rail-active").locator("[data-row-key]").first()).toBeVisible();
    await checkForUpdate(page);
    await expect(tile).toHaveAttribute("data-kind", "downloaded", { timeout: 10_000 });
    await tile.hover();
    await expect(page.getByTestId("update-tile-tip")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("rail-update-ready") });

    await page.mouse.move(900, 700);
    await page.getByTestId("rail-archived").hover();
    await expect(page.getByTestId("rail-archived-rows")).toHaveAttribute("data-fade-bottom", "true");
    await still(page);
    await page.screenshot({ path: at("rail-archived-long") });
  });
}

/** SHOTS=<dir>: the rail, a Needs you card, an icon's menu, a long list scrolled; dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`sidebar rail screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    await mockPost("ember?enabled=true");
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page);
    await collapse(page);
    await page.mouse.move(900, 700);
    await still(page);
    await page.screenshot({ path: at("rail") });

    await page.getByTestId("rail-needs").getByTestId("rail-row").nth(1).hover();
    await expect(page.getByTestId("needs-card")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("rail-needs-card") });

    await page.mouse.move(900, 700);
    await expect(page.getByTestId("needs-card")).toHaveCount(0);
    await page.getByTestId("rail-active").getByTestId("rail-row").nth(2).click({ button: "right" });
    await expect(page.getByTestId("row-menu")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("rail-menu") });
    await page.keyboard.press("Escape");

    await mockPost("threads?project=repo-cf&count=30&status=idle");
    await expect(page.getByTestId("rail-active")).toHaveAttribute("data-fade-bottom", "true");
    await page.getByTestId("rail-active").evaluate((el) => {
      el.scrollTop = 84;
    });
    await expect(page.getByTestId("rail-active")).toHaveAttribute("data-fade-top", "true");
    await page.getByTestId("rail-active").getByTestId("rail-row").nth(5).hover();
    await expect(page.getByTestId("thread-tooltip")).toBeVisible();
    await still(page);
    await page.screenshot({ path: at("rail-long") });
  });
}
