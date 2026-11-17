import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, setZoom } from "./fixtures";

/**
 * The collapsed sidebar's rail (docs/notes/sidebar-rail.md), what only a browser shows: its
 * width at 100% and zoomed, Needs you and Active scrolling on their own without a scrollbar and
 * fading only the edge with more, and a hover card landing beside the rail. Which icon a row gets,
 * the sections, the separators, the cap and what a click, a hover and a right click do are vitest's
 * (components/sidebar/rail/*.test.ts*). SHOTS=<dir> for the PR's screenshots (WebKit, dark and light).
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
