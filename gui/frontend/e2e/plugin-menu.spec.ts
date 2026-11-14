import { expect, test, type Page } from "@playwright/test";
import { openHelloDemo, pluginActs, resetMock } from "./fixtures";
import { setSurfaceWidth } from "./shell-surfaces";

/**
 * Plugin menus in a real browser (docs/notes/plugin-menu.md) against the mock's hello demo:
 * a right-click opens a row's menu at the pointer, Escape gives focus back to the row or
 * the ⋯, the keyboard opens both, its pane's width folds Build #2's buttons into its ⋯, and
 * a pick in a submenu reaches the plugin and comes back checked. What the menus hold and
 * which act a pick sends: src/components/plugin/menu.test.tsx.
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");
const buildRow = (page: Page) => surface(page).locator('[data-testid="plugin-row"][data-key="run-2"]');

/** Thread s-3 open, the hello demo's Overview in a tab beside it, Build #2 in view. */
async function openDemo(page: Page): Promise<void> {
  await openHelloDemo(page);
  await buildRow(page).scrollIntoViewIfNeeded();
}

/** The demo's pane `px` wide (the side panel's 420 was its narrow width). */
const panelWidth = (page: Page, px: number) => setSurfaceWidth(page, "plugin-surface", px);

test.beforeEach(async () => {
  await resetMock();
});

test("a right-click opens a row's menu at the pointer; the keyboard opens it and Escape gives focus back", async ({ page }) => {
  await openDemo(page);
  // Narrow, as the demo's pane opened before every pane kept 480px: the row's buttons fold into its ⋯.
  await panelWidth(page, 420);
  const r = await buildRow(page).boundingBox();
  if (!r) throw new Error("no row");
  const at = { x: r.x + 120, y: r.y + 12 };
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.getByTestId("plugin-row-menu");
  await expect(menu).toBeVisible();
  const m = await menu.boundingBox();
  expect(m && Math.abs(m.x - at.x) <= 6 && Math.abs(m.y - at.y) <= 6).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(buildRow(page)).toBeFocused();

  // Shift+F10 on the focused row opens the same menu at the row's start; Escape comes back.
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  const m2 = await menu.boundingBox();
  // At the row's start, under it unless the window's bottom pushes it up.
  expect(m2 && Math.abs(m2.x - (r.x + 24)) <= 6 && m2.y <= r.y + r.height + 6 && m2.y + m2.height >= r.y + r.height - 6).toBe(true);
  await page.keyboard.press("Escape");
  await expect(buildRow(page)).toBeFocused();

  // Option+Tab (WebKit reaches buttons with it) goes to the row's ⋯, shown while focused; Enter opens
  // it, Escape gives focus back to it.
  const more = buildRow(page).getByRole("button", { name: "More options" });
  await page.keyboard.press("Alt+Tab");
  await expect(more).toBeFocused();
  await expect(more).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("plugin-more-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
});

test("a narrow row folds its buttons into the ⋯; a pick in the Priority submenu comes back checked; widening shows the buttons", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 800 });
  await openDemo(page);
  await panelWidth(page, 420);
  await expect(buildRow(page)).toHaveAttribute("data-folded", "true");
  await expect(buildRow(page).getByTestId("plugin-button")).toHaveCount(0);
  await buildRow(page).hover();
  await buildRow(page).getByRole("button", { name: "More options" }).click();
  const menu = page.getByTestId("plugin-more-menu");
  await expect(menu.getByTestId("plugin-menu-item").first()).toHaveText("Rerun");
  // Priority ▸ High: the plugin answers with a view whose check moved.
  await menu.locator('[data-testid="plugin-menu-sub"]').hover();
  const sub = page.getByTestId("plugin-menu-submenu");
  await expect(sub).toBeVisible();
  await sub.locator('[data-key="run-2-p-high"]').click();
  await expect(menu).toHaveCount(0);
  await expect.poll(async () => (await pluginActs()).some((a) => a.includes(" run-2-p-high "))).toBe(true);
  await buildRow(page).hover();
  await buildRow(page).getByRole("button", { name: "More options" }).click();
  await menu.locator('[data-testid="plugin-menu-sub"]').hover();
  await expect(sub.locator('[data-key="run-2-p-high"]')).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await panelWidth(page, 920);
  await expect(buildRow(page)).not.toHaveAttribute("data-folded");
  await expect(buildRow(page).getByTestId("plugin-button")).toHaveText(["Rerun", "Open log", "Copy error"]);
});

/** Waits until no finite animation runs (a menu's fade-in), so a screenshot shows it settled. */
async function settled(page: Page): Promise<void> {
  // Spinners run forever: only finite animations are waited for.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity));
}

/** SHOTS=<dir>: the PR's screenshots, WebKit, 1440x900, dark and light: the narrow row's menu with its submenu, the header's and the More ▾ menus, the wide row. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDemo(page);
    await panelWidth(page, 420);
    const r = await buildRow(page).boundingBox();
    if (!r) throw new Error("no row");
    await page.mouse.click(r.x + 90, r.y + 12, { button: "right" });
    await page.getByTestId("plugin-row-menu").locator('[data-testid="plugin-menu-sub"]').hover();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("plugin-menu-submenu")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("plugin-menu-submenu").locator('[data-key="run-2-p-normal"]')).toBeFocused();
    await settled(page);
    await page.screenshot({ path: `${shots ?? ""}/menu-row-${scheme}.png` });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await surface(page).getByTestId("plugin-header-more").click();
    await expect(page.getByTestId("plugin-header-more-menu")).toBeVisible();
    await settled(page);
    await page.screenshot({ path: `${shots ?? ""}/menu-header-${scheme}.png` });
    await page.keyboard.press("Escape");

    const more = surface(page).locator('[data-testid="plugin-button"][data-key="bar-more"]');
    await more.scrollIntoViewIfNeeded();
    await more.click();
    await expect(page.getByTestId("plugin-button-bar-more-menu")).toBeVisible();
    await settled(page);
    await page.screenshot({ path: `${shots ?? ""}/menu-button-${scheme}.png` });
    await page.keyboard.press("Escape");

    await panelWidth(page, 840);
    await buildRow(page).scrollIntoViewIfNeeded();
    await buildRow(page).hover();
    await buildRow(page).getByRole("button", { name: "More options" }).click();
    await expect(page.getByTestId("plugin-more-menu")).toBeVisible();
    await settled(page);
    await page.screenshot({ path: `${shots ?? ""}/menu-wide-${scheme}.png` });
  });
}
