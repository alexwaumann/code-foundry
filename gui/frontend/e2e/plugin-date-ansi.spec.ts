import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock, row } from "./fixtures";

/**
 * The date field's popover in a real browser (docs/notes/plugin-date-ansi.md): the keyboard
 * reaches the calendar, Enter on a day picks it (the browser's button activation) and the
 * focus goes back to the field, as it does on Escape. The calendar's days, keys, picks and
 * bounds are src/components/plugin/DateControl.test.tsx's; the coloured log's spans are
 * logAnsi.test.tsx's. Set SHOTS=<dir> for the PR's screenshots (WebKit, dark and light).
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");
const tab = (page: Page, key: string) => surface(page).locator(`[data-testid="plugin-tab"][data-key="${key}"]`);
const due = (page: Page) => surface(page).locator('[data-testid="plugin-date"][data-name="due"]');
const popover = (page: Page) => page.getByTestId("plugin-date-popover");
const focusedDay = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-day") ?? null);

/** Thread s-3 selected, its panel showing the hello demo (opened from the palette). */
async function openDemo(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-3").click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Hello Demo");
  await page.getByTestId("palette").locator('[data-command="plugin.hello.show.demo"]').click();
  await expect(surface(page)).toHaveAttribute("data-phase", "live");
}

test.beforeEach(async () => {
  await resetMock();
});

test("the date field: the keyboard opens the calendar on today, Enter picks a day, Escape closes, the focus comes back", async ({ page }) => {
  await openDemo(page);
  await tab(page, "form").click();
  await expect(due(page)).toHaveText(/No due date/);
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  await due(page).focus();
  await page.keyboard.press("Enter");
  await expect(popover(page)).toBeVisible();
  await expect.poll(() => focusedDay(page)).toBe(today);
  await page.keyboard.press("ArrowDown");
  const weekOn = await focusedDay(page);
  expect(weekOn).not.toBe(today);
  await page.keyboard.press("Enter");
  await expect(popover(page)).toBeHidden();
  await expect(due(page)).toHaveAttribute("data-value", weekOn ?? "");
  await expect(due(page)).toBeFocused();
  // Space opens it again on the picked day; Escape closes and leaves the field as it was.
  await page.keyboard.press("Space");
  await expect.poll(() => focusedDay(page)).toBe(weekOn);
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(due(page)).toBeFocused();
  await expect(due(page)).toHaveAttribute("data-value", weekOn ?? "");
});

/** SHOTS=<dir>: the date popover and the coloured log for the PR, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`date and ANSI log screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const dir = shots ?? "";
    const suffix = scheme === "light" ? "-light" : "";
    // A fixed day, so the shots show the same month.
    await page.clock.setFixedTime(new Date(2026, 10, 11, 10));
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await openDemo(page);
    await tab(page, "form").click();
    await due(page).click();
    await popover(page).locator('[data-day="2026-11-14"]').click();
    await expect(due(page)).toHaveAttribute("data-value", "2026-11-14");
    await due(page).scrollIntoViewIfNeeded();
    await due(page).click();
    await expect(popover(page)).toBeVisible();
    // Past the popover's fade-in.
    await popover(page).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${dir}/date-popover${suffix}.png` });
    await page.keyboard.press("Escape");
    await tab(page, "log").click();
    const log = surface(page).locator('[data-testid="plugin-log"]').filter({ hasText: "tests (ANSI)" });
    await log.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/ansi-log${suffix}.png` });
    await page.getByTestId("panel-expand").click();
    await log.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/ansi-log-wide${suffix}.png` });
  });
}
