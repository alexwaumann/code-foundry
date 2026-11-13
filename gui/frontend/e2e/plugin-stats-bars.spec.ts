import { expect, test, type Page } from "@playwright/test";
import { openHelloDemo, resetMock } from "./fixtures";
import { fullScreenSurface, setSurfaceWidth } from "./shell-surfaces";

/**
 * Plugin stats and bars in a real browser (docs/notes/plugin-stats-bars.md): what the unit
 * tests cannot see. The figures fit their cards in a narrow pane and full screen (real text
 * widths), a pointer over the chart shows the one tooltip inside the surface, and the
 * Failing toggle narrows the chart through the mock's hello demo. Set SHOTS=<dir> to save
 * the PR's screenshots.
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");
const stats = (page: Page) => surface(page).getByTestId("plugin-stats");
const plot = (page: Page) => surface(page).getByTestId("plugin-bars-plot");
const tip = (page: Page) => surface(page).getByTestId("plugin-bar-tip");

async function openDemo(page: Page): Promise<void> {
  await openHelloDemo(page);
  await expect(stats(page)).toBeVisible();
}

/** Every figure's text fits its box on one line, and nothing in the surface scrolls sideways. */
async function figuresFit(page: Page): Promise<void> {
  const fits = await stats(page)
    .getByTestId("plugin-stat-value")
    .evaluateAll((els) => els.map((e) => ({ text: e.textContent, fits: e.scrollWidth <= e.clientWidth && e.getBoundingClientRect().height < 40 })));
  expect(fits.filter((f) => !f.fits)).toEqual([]);
  const body = surface(page);
  expect(await body.evaluate((e) => e.scrollWidth - e.clientWidth)).toBe(0);
}

test.beforeEach(async () => {
  await resetMock();
});

test("stats wrap to two by two in a narrow pane and one row full screen, figures on one line", async ({ page }) => {
  await openDemo(page);
  await setSurfaceWidth(page, "plugin-surface", 420);
  await expect(stats(page)).toHaveAttribute("data-columns", "2");
  await expect(stats(page)).toHaveAttribute("data-role", "text-title");
  await figuresFit(page);
  await fullScreenSurface(page, "plugin-surface");
  await expect(stats(page)).toHaveAttribute("data-columns", "4");
  await expect(stats(page)).toHaveAttribute("data-role", "text-display-sm");
  await figuresFit(page);
  // Cards of a row are equally wide and tall.
  const boxes = await stats(page).getByTestId("plugin-stat").evaluateAll((els) => els.map((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]));
  expect(new Set(boxes.map((b) => b.join("x"))).size).toBe(1);
});

test("a pointer over a bar shows its tooltip inside the panel and dims the others; the toggle narrows the chart", async ({ page }) => {
  await openDemo(page);
  const box = await plot(page).boundingBox();
  if (!box) throw new Error("no plot");
  const panel = await surface(page).boundingBox();
  if (!panel) throw new Error("no panel");
  // Every bar, the middle ones included, keeps its tooltip inside the panel.
  for (const f of [0.02, 0.45, 0.55, 0.98]) {
    await page.mouse.move(box.x + box.width * f, box.y + box.height / 2);
    await expect(tip(page)).toBeVisible();
    const t = await tip(page).boundingBox();
    expect(t && t.x >= panel.x && t.x + t.width <= panel.x + panel.width).toBe(true);
  }
  await expect(tip(page)).toHaveAttribute("data-key", "build-1288");
  await expect(tip(page)).toContainText("#1288 · running 2m 10s");
  await expect(surface(page).locator('[data-testid="plugin-bar"][data-active="true"]')).toHaveAttribute("fill-opacity", "0.3");
  await expect(surface(page).locator('[data-testid="plugin-bar"][data-key="build-1259"]')).toHaveAttribute("fill-opacity", String(0.85 * 0.4));
  await page.mouse.move(box.x + box.width / 2, box.y - 60);
  await expect(tip(page)).toHaveCount(0);

  await surface(page).getByRole("button", { name: /Failing/ }).click();
  await expect(surface(page).getByRole("button", { name: /Failing/ })).toHaveAttribute("aria-pressed", "true");
  await expect(surface(page).getByTestId("plugin-bar")).toHaveCount(4);
  await expect(surface(page).getByTestId("plugin-bars-axis")).toHaveText("#1264#1285");
});

/** SHOTS=<dir>: the PR's screenshots, WebKit, 1280x800 at 2x, dark and light: a narrow pane and full screen, a bar hovered. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2 });
    test("stats and bars", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      test.setTimeout(60_000);
      const dir = String(shots);
      const settle = () => page.waitForTimeout(350);
      await openDemo(page);
      await setSurfaceWidth(page, "plugin-surface", 420);
      const hover = async (f: number) => {
        const box = await plot(page).boundingBox();
        if (!box) throw new Error("no plot");
        await page.mouse.move(box.x + box.width * f, box.y + box.height / 2);
        await expect(tip(page)).toBeVisible();
      };
      await hover(0.55);
      await settle();
      await page.screenshot({ path: `${dir}/stats-bars-panel-${scheme}.png` });
      await fullScreenSurface(page, "plugin-surface");
      await expect(stats(page)).toHaveAttribute("data-columns", "4");
      await hover(0.72);
      await settle();
      await page.screenshot({ path: `${dir}/stats-bars-wide-${scheme}.png` });
      await surface(page).getByRole("button", { name: /Failing/ }).click();
      await expect(surface(page).getByTestId("plugin-bar")).toHaveCount(4);
      await hover(0.4);
      await settle();
      await page.screenshot({ path: `${dir}/stats-bars-filtered-${scheme}.png` });
    });
  });
}
