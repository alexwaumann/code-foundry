import { expect, test, type Page } from "@playwright/test";
import { openHelloDemo, pluginActs, resetMock } from "./fixtures";
import { fullScreenSurface, setSurfaceWidth } from "./shell-surfaces";

/**
 * Plugin tables in a real browser (docs/notes/plugin-table.md) against the mock's hello
 * demo (the Runs tab's Builds table): in a pane the side panel's width the least important
 * columns are gone and no cell reaches past the table's edge, the header lines up with the
 * cells, the pane full screen brings every column and the Rerun buttons back, and a header click
 * comes back from the plugin sorted. Which columns show at which width, the sort acts, the
 * groups and the menus: src/components/plugin/table.test.ts and tablenode.test.tsx.
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");
const builds = (page: Page) => surface(page).locator('[data-testid="plugin-table"][data-key="builds"]');
const box = (page: Page) => builds(page).getByTestId("plugin-table-box");

/** Thread s-3 open, the hello demo's Runs tab beside it, the Builds table in view. */
async function openRuns(page: Page): Promise<void> {
  await openHelloDemo(page);
  await surface(page).getByRole("tab", { name: "Runs" }).click();
  await builds(page).scrollIntoViewIfNeeded();
}

/** The table's right edge, and every shown cell's and header's box (x, right) in the first rows. */
async function geometry(page: Page) {
  return box(page).evaluate((el) => {
    const right = el.getBoundingClientRect().right;
    const head = [...(el.firstElementChild?.querySelectorAll<HTMLElement>("[data-col]") ?? [])].map((h) => ({ col: h.dataset.col ?? "", x: h.getBoundingClientRect().x, right: h.getBoundingClientRect().right }));
    const cells = [...el.querySelectorAll<HTMLElement>('[data-testid="plugin-table-row"] [data-col]')].slice(0, 40).map((c) => ({ col: c.dataset.col ?? "", x: c.getBoundingClientRect().x, right: c.getBoundingClientRect().right }));
    const overflow = [...el.querySelectorAll<HTMLElement>('[data-testid="plugin-table-row"] *')].filter((c) => c.getBoundingClientRect().right > right + 0.5).length;
    return { right, head, cells, overflow };
  });
}

test.beforeEach(async () => {
  await resetMock();
});

test("a narrow pane drops columns without overflow; full screen, every column and the buttons; the header lines up with the cells", async ({ page }) => {
  await openRuns(page);
  await setSurfaceWidth(page, "plugin-surface", 420);
  await expect(box(page)).toHaveAttribute("data-columns", "b-num,b-branch,b-dur,b-age");
  await expect(box(page)).toHaveAttribute("data-folded", "true");
  let g = await geometry(page);
  expect(g.overflow).toBe(0);
  for (const c of g.cells) {
    const h = g.head.find((x) => x.col === c.col);
    expect(h && Math.abs(h.x - c.x) <= 1).toBe(true);
  }

  await fullScreenSurface(page, "plugin-surface");
  await expect(box(page)).toHaveAttribute("data-columns", "b-num,b-status,b-branch,b-cause,b-by,b-dur,b-age");
  await expect(box(page)).not.toHaveAttribute("data-folded");
  await expect(builds(page).locator('[data-testid="plugin-table-row"][data-key="b-1285"]').getByTestId("plugin-button")).toHaveText("Rerun");
  g = await geometry(page);
  expect(g.overflow).toBe(0);
  for (const c of g.cells) {
    const h = g.head.find((x) => x.col === c.col);
    // An end-aligned column lines up on its right edge.
    expect(h && (Math.abs(h.x - c.x) <= 1 || Math.abs(h.right - c.right) <= 1)).toBe(true);
  }
});

test("a header click comes back from the plugin sorted, its arrow on the column", async ({ page }) => {
  await openRuns(page);
  const first = () => builds(page).getByTestId("plugin-table-row").first();
  await expect(first()).toHaveAttribute("data-key", "b-1288");
  await builds(page).getByRole("button", { name: "Sort by Duration" }).click();
  await expect(first()).toHaveAttribute("data-key", "b-1285");
  await expect(builds(page).getByRole("button", { name: "Duration, sorted descending" })).toBeVisible();
  await expect.poll(async () => (await pluginActs()).some((a) => a.includes(" b-dur ") && a.includes("value=desc"))).toBe(true);
});

/** Waits until no finite animation runs (a menu's fade-in), so a screenshot shows it settled. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity));
}

/** SHOTS=<dir>: the PR's screenshots, WebKit, 1440x900, dark and light: the narrow pane's table with a row's menu, the table full screen, the grouped table. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openRuns(page);
    await setSurfaceWidth(page, "plugin-surface", 420);
    const failed = builds(page).locator('[data-testid="plugin-table-row"][data-key="b-1285"]');
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${shots ?? ""}/table-panel-${scheme}.png` });
    const r = await failed.boundingBox();
    if (!r) throw new Error("no row");
    await page.mouse.click(r.x + 150, r.y + 14, { button: "right" });
    await expect(page.getByTestId("plugin-row-menu")).toBeVisible();
    await settled(page);
    await page.screenshot({ path: `${shots ?? ""}/table-menu-${scheme}.png` });
    await page.keyboard.press("Escape");

    await fullScreenSurface(page, "plugin-surface");
    await expect(box(page)).not.toHaveAttribute("data-folded");
    await builds(page).scrollIntoViewIfNeeded();
    await builds(page).locator('[data-testid="plugin-table-row"][data-key="b-1287"]').hover();
    await settled(page);
    await page.screenshot({ path: `${shots ?? ""}/table-wide-${scheme}.png` });

    const tests = surface(page).locator('[data-testid="plugin-table"][data-key="tests"]');
    await tests.getByRole("button", { name: /Passed/ }).click();
    await tests.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await settled(page);
    await page.screenshot({ path: `${shots ?? ""}/table-groups-${scheme}.png` });
  });
}
