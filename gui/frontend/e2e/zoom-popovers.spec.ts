import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, resetMock, row } from "./fixtures";

/**
 * Floating surfaces under page zoom (CSS zoom on <html>, lib/zoom.ts). Radix positions
 * them with a translate in viewport px; without the counter-zoom on the popper wrapper
 * (index.css) that translate was scaled again by the zoom, so at 125% a picker opened a
 * quarter of its offset further down and right. docs/notes/zoom-popovers.md.
 */

test.beforeEach(async () => {
  await resetMock();
});

async function setZoom(page: Page, percent: number): Promise<void> {
  await page.evaluate(`import("/src/stores/ui.ts").then((m) => m.useUiStore.getState().setZoom(${String(percent)}))`);
  await expect(page.locator("html")).toHaveAttribute("data-zoom", String(percent));
}

async function compose(page: Page): Promise<void> {
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
  await page.keyboard.press("Meta+1");
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

async function rect(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height };
}

// 90% is the bottom of the zoom ladder (stores/ui.ts ZOOM_LEVELS).
for (const zoom of [90, 100, 125, 150]) {
  test(`the composer model picker opens right under its trigger at ${String(zoom)}%`, async ({ page }) => {
    // Tall enough that the whole model list fits below the trigger at 150%.
    await page.setViewportSize({ width: 1280, height: 1100 });
    await openApp(page);
    await setZoom(page, zoom);
    await compose(page);
    const trigger = page.getByTestId("composer-model");
    await trigger.click();
    const list = page.getByTestId("composer-model-list");
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute("data-side", "bottom");
    // sideOffset 6 grows with the zoom; start-aligned to the trigger's left edge.
    await expect
      .poll(async () => {
        const [t, l] = [await rect(trigger), await rect(list)];
        return { gap: Math.abs(l.top - t.bottom - 6 * (zoom / 100)) <= 1, left: Math.abs(l.left - t.left) <= 1 };
      })
      .toEqual({ gap: true, left: true });
    // The surface is zoomed like the page: an option is as tall as at 100% times the zoom.
    const option = await rect(list.getByRole("option").first());
    expect(option.height / (zoom / 100)).toBeGreaterThan(20);
    expect(option.height / (zoom / 100)).toBeLessThan(40);
  });
}

test("at 150% a picker without room below flips above its trigger, the same gap away", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await openApp(page);
  await setZoom(page, 150);
  await compose(page);
  const trigger = page.getByTestId("composer-model");
  await trigger.click();
  const list = page.getByTestId("composer-model-list");
  await expect(list).toHaveAttribute("data-side", "top");
  const [t, l] = [await rect(trigger), await rect(list)];
  expect(Math.round(t.top - l.bottom)).toBe(9);
  expect(l.top).toBeGreaterThanOrEqual(0);
});

test("at 125% a row's context menu opens at the pointer and stays inside the window near the bottom", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await openApp(page);
  await setZoom(page, 125);
  // The top row (the waiting thread): room below for the menu.
  const r = await rect(row(page, "s:s-2"));
  await page.mouse.click(r.left + 30, r.top + 5, { button: "right" });
  const menu = page.getByTestId("row-menu");
  await expect(menu).toBeVisible();
  // Radix puts a context menu 2px right of the pointer (its own sideOffset, not scaled).
  await expect
    .poll(async () => {
      const m = await rect(menu);
      return Math.abs(m.left - (r.left + 30)) <= 3 && Math.abs(m.top - (r.top + 5)) <= 1;
    })
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // Off the list, so no thread tooltip is open (or, through Radix's skip delay, opens at once
  // on the next row) when the next right-click lands.
  await page.mouse.move(900, 300);
  await expect(page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])')).toHaveCount(0);

  // The lowest thread row inside the list's viewport (rows the virtual list renders below it
  // are "visible" to Playwright but clipped): the menu is taller than the room below, so it moves up.
  const listBox = await rect(page.getByTestId("thread-list"));
  const rows = page.getByTestId("thread-list").locator('[data-row-key^="s:"]');
  let low = rows.first();
  for (let i = (await rows.count()) - 1; i >= 0; i--) {
    const b = await rows.nth(i).boundingBox();
    if (b && b.y >= listBox.top && b.y + b.height <= listBox.bottom) {
      low = rows.nth(i);
      break;
    }
  }
  const lr = await rect(low);
  await page.mouse.click(lr.left + 30, lr.top + 5, { button: "right" });
  await expect(menu).toBeVisible();
  await expect.poll(async () => (await rect(menu)).bottom).toBeLessThanOrEqual(640.5);
  const m = await rect(menu);
  expect(m.top).toBeLessThan(lr.top + 5);
  expect(Math.abs(m.left - (lr.left + 30))).toBeLessThanOrEqual(3);
});

test("at 125% the thread tooltip sits beside its row, its 12px offset zoomed", async ({ page }) => {
  await openApp(page);
  await setZoom(page, 125);
  const target = row(page, "s:s-3");
  await target.hover();
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');
  await expect(tip).toBeVisible();
  const r = await rect(target);
  await expect
    .poll(async () => {
      const t = await rect(tip);
      return Math.abs(t.left - r.right - 12 * 1.25) <= 1 && Math.abs(t.top - r.top) <= 1;
    })
    .toBe(true);
});

test("at 125% the usage chart tooltip follows the pointer", async ({ page }) => {
  await openApp(page);
  await setZoom(page, 125);
  await page.getByTestId("status-usage").click();
  // 13 days back of 30: it has usage (the mock's last two weeks), and the tooltip is not
  // clamped at the chart's right edge.
  const day = page.getByTestId("usage-page-day").nth(-13);
  const d = await rect(day);
  await page.mouse.move(d.left + d.width / 2, d.top + 60);
  const tip = page.getByTestId("usage-page-tooltip");
  await expect(tip).toBeVisible();
  const t = await rect(tip);
  // 14 layout px right of and 10 above the pointer, in viewport px at 125%.
  expect(Math.abs(t.left - (d.left + d.width / 2) - 14 * 1.25)).toBeLessThanOrEqual(1);
  expect(Math.abs(t.top - (d.top + 60) + 10 * 1.25)).toBeLessThanOrEqual(1);
});

for (const zoom of [100, 125]) {
  test(`a settings select opens under its trigger, as wide, at ${String(zoom)}%`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await openApp(page);
    await setZoom(page, zoom);
    await page.keyboard.press("Meta+Comma");
    const trigger = page.locator('[data-setting="appearance.theme"] [data-slot="select-trigger"]');
    await trigger.click();
    const list = page.locator('[data-slot="select-content"]');
    await expect(list).toHaveAttribute("data-side", "bottom");
    // The shadcn Select is a popper (ui/select.tsx): sideOffset 4 grows with the zoom, and the
    // trigger's width (a viewport-px --radix-* length) is divided back by it.
    await expect
      .poll(async () => {
        const [t, l] = [await rect(trigger), await rect(list)];
        return { gap: Math.abs(l.top - t.bottom - 4 * (zoom / 100)) <= 1, left: Math.abs(l.left - t.left) <= 1, width: Math.abs(l.width - t.width) <= 1 };
      })
      .toEqual({ gap: true, left: true, width: true });
  });
}
