import { expect, test, type Page } from "@playwright/test";
import { emit, openApp, resetMock, row, threadPrompt } from "./fixtures";

// Settings and Themes in one modal sheet over the window (docs/notes/settings-sheet.md):
// centred, at most 1280x1280, never closer than 48px to a window edge.

test.beforeEach(async () => {
  await resetMock();
});

const sheet = (page: Page) => page.getByTestId("settings-sheet");
const settingsPage = (page: Page) => page.getByTestId("settings-page");
const themesPage = (page: Page) => page.getByTestId("themes-page");

async function openSettings(page: Page) {
  await page.keyboard.press("Meta+Comma");
  await expect(settingsPage(page)).toBeVisible();
  await expect(sheet(page)).toHaveCSS("opacity", "1");
}

async function rect(page: Page) {
  return sheet(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

/** Clicks the backdrop at a window corner, outside the sheet. */
async function clickBackdrop(page: Page) {
  await page.mouse.click(8, 8);
}

test.describe("size", () => {
  for (const [w, h, want] of [
    // The cap: 1280x1280 centred, with room to spare around it.
    [1500, 1400, { x: 110, y: 60, width: 1280, height: 1280 }],
    // Width at the cap, height margin-limited: a common laptop window.
    [1440, 900, { x: 80, y: 48, width: 1280, height: 804 }],
    // Margin-limited: 48px from every edge.
    [1280, 800, { x: 48, y: 48, width: 1184, height: 704 }],
    [1000, 700, { x: 48, y: 48, width: 904, height: 604 }],
  ] as const) {
    test(`at ${String(w)}x${String(h)} the sheet is ${String(want.width)}x${String(want.height)}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await openApp(page);
      await openSettings(page);
      await expect(sheet(page)).toHaveAttribute("role", "dialog");
      await expect(sheet(page)).toHaveAttribute("data-size", "sheet");
      expect(await rect(page)).toEqual(want);
      // One backdrop, the shared one (modal-backdrop.spec.ts).
      await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(1);
    });
  }

  test("the 48px margin holds under page zoom", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page);
    await page.keyboard.press("Meta+Equal");
    await expect(page.locator("html")).toHaveAttribute("data-zoom", "110");
    await openSettings(page);
    const r = await rect(page);
    // Viewport px: the margin zooms with the page (48 * 1.1), the sheet stays inside the window.
    expect(Math.round(r.x)).toBe(53);
    expect(Math.round(r.y)).toBe(53);
    expect(Math.round(r.x + r.width)).toBe(1280 - 53);
    expect(Math.round(r.y + r.height)).toBe(800 - 53);
  });
});

test("the gear opens the sheet on General with the search focused; Escape, the backdrop and the gear close it", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  const gear = page.getByTestId("status-settings");
  await gear.click();
  await expect(settingsPage(page)).toBeVisible();
  await expect(gear).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "general");
  await expect(page.getByRole("searchbox", { name: "Search settings" })).toBeFocused();
  // The thread stays laid out under the backdrop.
  await expect(page.getByTestId("thread-header")).toBeVisible();

  // Escape on the empty search closes it; the thread's prompt takes the keyboard back.
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(gear).toHaveAttribute("aria-pressed", "false");
  await expect(threadPrompt(page)).toBeFocused();

  // A click on the backdrop closes it.
  await openSettings(page);
  await clickBackdrop(page);
  await expect(sheet(page)).toHaveCount(0);
  await expect(threadPrompt(page)).toBeFocused();

  // The gear is a toggle: under the backdrop it stays pressed, and a click there closes the sheet.
  await gear.click();
  await expect(sheet(page)).toBeVisible();
  const box = await gear.boundingBox();
  if (!box) throw new Error("no gear");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(sheet(page)).toHaveCount(0);

  // So does the × and cmd+,.
  await openSettings(page);
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await openSettings(page);
  await page.keyboard.press("Meta+Comma");
  await expect(sheet(page)).toHaveCount(0);
});

test("a link to a settings page opens the sheet there", async ({ page }) => {
  await openApp(page);
  expect(await emit({ notify: { level: "LEVEL_INFO", title: "Remembered", body: "", link: "settings:memory", linkLabel: "Open Memory" } })).toBe(1);
  await page.getByRole("button", { name: "Open Memory" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "memory");
  await expect(page.getByTestId("settings-nav-memory")).toHaveAttribute("aria-current", "page");

  // A toast's button works over the open sheet, and a click on it is not a backdrop click.
  await page.getByTestId("settings-nav-general").click();
  expect(await emit({ notify: { level: "LEVEL_INFO", title: "Remembered again", body: "", link: "settings:memory", linkLabel: "Show Memory" } })).toBe(1);
  await page.getByRole("button", { name: "Show Memory" }).click();
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "memory");
  await expect(sheet(page)).toHaveCSS("opacity", "1");
});

test("Escape in a nested dialog, a select, the palette or the key recorder leaves the sheet open", async ({ page }) => {
  await openApp(page);
  await openSettings(page);

  // An open select's list: Escape closes the list only.
  await page.getByTestId("settings-nav-general").click();
  await page.locator('[data-setting="threads.default_effort"] [data-slot="select-trigger"]').click();
  await expect(page.locator('[data-slot="select-content"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="select-content"]')).toHaveCount(0);
  await expect(settingsPage(page)).toBeVisible();

  // The palette over the sheet.
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(settingsPage(page)).toBeVisible();

  // The keybinding recorder records Escape as a cancel.
  await page.getByTestId("settings-nav-keybindings").click();
  const recorder = page.locator('[data-setting="keybindings.thread.new"]').getByRole("button", { name: /shortcut/ });
  await recorder.click();
  await page.keyboard.press("Escape");
  await expect(recorder).toHaveText("⌘N");
  await expect(settingsPage(page)).toBeVisible();

  // A dialog over the sheet (help here; the theme editor's Save… and confirm below).
  await page.getByRole("heading", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Meta+Slash");
  await expect(page.getByTestId("help-overlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help-overlay")).toHaveCount(0);
  await expect(settingsPage(page)).toBeVisible();

  // A plain Escape now closes the sheet.
  await page.getByRole("heading", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
});

test("Themes opens inside the sheet and goes back to Appearance; theme.pick alone closes it", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-appearance").click();
  const before = await rect(page);
  await page.getByTestId("choose-theme-dark").click();
  // The same sheet, now showing Themes: no second dialog, no page in the content pane.
  await expect(sheet(page).getByTestId("themes-page")).toBeVisible();
  await expect(sheet(page)).toHaveAttribute("data-body", "themes");
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await expect(settingsPage(page)).toHaveCount(0);
  expect(await rect(page)).toEqual(before);
  await expect(page.getByTestId("status-settings")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("themes-list")).toBeFocused();

  // Escape goes back to Settings on Appearance, inside the sheet.
  await page.keyboard.press("Escape");
  await expect(themesPage(page)).toHaveCount(0);
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "appearance");
  await expect(page.getByRole("searchbox", { name: "Search settings" })).toBeFocused();

  // So does its ×.
  await page.getByTestId("choose-theme-light").click();
  await expect(themesPage(page)).toBeVisible();
  await page.getByRole("button", { name: "Close themes" }).click();
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "appearance");

  // And the Settings crumb in its header (Settings › Themes).
  await page.getByTestId("choose-theme-dark").click();
  await expect(themesPage(page)).toBeVisible();
  await expect(page.getByTestId("themes-crumbs")).toHaveText(/Settings.*Themes/);
  await page.getByTestId("themes-crumb-settings").click();
  await expect(themesPage(page)).toHaveCount(0);
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "appearance");

  // The backdrop closes the whole sheet, Themes or not.
  await page.getByTestId("choose-theme-dark").click();
  await expect(themesPage(page)).toBeVisible();
  await clickBackdrop(page);
  await expect(sheet(page)).toHaveCount(0);

  // theme.pick from outside Settings: Escape closes the sheet.
  expect(await emit({ showView: { name: "themes" } })).toBe(1);
  await expect(sheet(page).getByTestId("themes-page")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);

  // theme.pick from outside Settings: the crumb still leads to Settings → Appearance.
  expect(await emit({ showView: { name: "themes" } })).toBe(1);
  await expect(sheet(page).getByTestId("themes-page")).toBeVisible();
  await page.getByTestId("themes-crumb-settings").click();
  await expect(themesPage(page)).toHaveCount(0);
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "appearance");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
});

test("the theme editor: Save… stacks a dialog over the sheet; Escape there closes only it; Discard changes? stacks too", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId("choose-theme-dark").click();
  const row_ = page.getByTestId("themes-list").getByRole("option", { name: "Ocean Dusk", exact: true });
  await row_.hover();
  await row_.getByRole("button", { name: "Edit Ocean Dusk" }).click();
  await expect(page.getByTestId("theme-inspector")).toBeVisible();

  // An edit, then Save…: its dialog sits over the sheet.
  await page.getByTestId("theme-inspector").getByTestId("editor-base-accent").click();
  const field = page.getByTestId("colour-hex");
  await field.fill("#ff00ff");
  await field.press("Enter");
  await page.getByTestId("editor-back").click();
  await page.getByTestId("themes-save").click();
  await expect(page.getByTestId("theme-save-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("theme-save-dialog")).toHaveCount(0);
  await expect(page.getByTestId("theme-inspector")).toBeVisible();

  // Closing Themes with changes asks over the sheet; Escape on the confirm keeps everything.
  await page.getByRole("button", { name: "Close themes" }).click();
  await expect(page.getByTestId("confirm-dialog")).toContainText("Ocean Dusk has changes that are not saved.");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(page.getByTestId("theme-inspector")).toBeVisible();

  // The backdrop asks too; Discard closes the whole sheet.
  await clickBackdrop(page);
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(sheet(page)).toBeVisible();
  await page.getByTestId("confirm-ok").click();
  await expect(sheet(page)).toHaveCount(0);
});

test("the theme editor fits the sheet at a small window", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await openApp(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId("choose-theme-dark").click();
  const row_ = page.getByTestId("themes-list").getByRole("option", { name: "Ocean Dusk", exact: true });
  await row_.hover();
  await row_.getByRole("button", { name: "Edit Ocean Dusk" }).click();
  await expect(page.getByTestId("theme-inspector")).toBeVisible();
  const s = await rect(page);
  expect(s).toEqual({ x: 48, y: 48, width: 804, height: 504 });
  for (const id of ["theme-inspector", "themes-save", "themes-edit-done"]) {
    const b = await page.getByTestId(id).boundingBox();
    expect(b, id).not.toBeNull();
    if (!b) continue;
    expect(b.x, id).toBeGreaterThanOrEqual(s.x);
    expect(b.x + b.width, id).toBeLessThanOrEqual(s.x + s.width);
    expect(b.y, id).toBeGreaterThanOrEqual(s.y);
    expect(b.y + Math.min(b.height, 40), id).toBeLessThanOrEqual(s.y + s.height);
  }
});
