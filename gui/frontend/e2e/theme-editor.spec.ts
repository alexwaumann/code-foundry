import { expect, test, type Page } from "@playwright/test";
import { mockUrl, openApp, resetMock } from "./fixtures";

// The theme editor on the Themes page (docs/notes/theme-editor.md). The mock seeds Ocean
// Dusk (dark, from Catppuccin Mocha, one pin: --cf-sidebar-row-selected #1e2e3c); the
// slots start on GitHub Dark and Light, the browser is dark.

test.beforeEach(async () => {
  await resetMock();
});

async function raw(key: string): Promise<string | undefined> {
  const res = await fetch(`${mockUrl}/__mock/settings`);
  return ((await res.json()) as { raw: Record<string, string> }).raw[key];
}

interface MockTheme {
  id: string;
  name: string;
  base: { canvas: string };
  overrides?: Record<string, string>;
}

async function mockTheme(id: string): Promise<MockTheme | undefined> {
  const res = await fetch(`${mockUrl}/__mock/themes`);
  return ((await res.json()) as { themes: MockTheme[] }).themes.find((t) => t.id === id);
}

const option = (page: Page, name: string) => page.getByTestId("themes-list").getByRole("option", { name, exact: true });
const scope = (page: Page) => page.getByTestId("theme-scope").first();
const inspector = (page: Page) => page.getByTestId("theme-inspector");
const scopeVar = (page: Page, name: string) => page.getByTestId("themes-page").locator('[data-testid="theme-scope"]').last().evaluate((el, n) => (el as HTMLElement).style.getPropertyValue(n), name);

async function openThemes(page: Page) {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId("choose-theme-dark").click();
  await expect(page.getByTestId("themes-page")).toBeVisible();
}

async function editOceanDusk(page: Page) {
  await openThemes(page);
  const row = option(page, "Ocean Dusk");
  await row.hover();
  await row.getByRole("button", { name: "Edit Ocean Dusk" }).click();
  await expect(inspector(page)).toBeVisible();
}

/** Opens a base colour's view and types a hex into it. */
async function setBase(page: Page, key: string, hex: string) {
  await inspector(page).getByTestId(`editor-base-${key}`).click();
  await expect(page.getByTestId("base-view")).toHaveAttribute("data-base", key);
  const field = page.getByTestId("colour-hex");
  await field.fill(hex);
  await field.press("Enter");
  await page.getByTestId("editor-back").click();
  await expect(page.getByTestId("editor-slots")).toBeVisible();
}

test("edit, pin, go stale, drill in, save and apply, revert", async ({ page }) => {
  await editOceanDusk(page);
  await expect(page.getByTestId("themes-edit-bar")).toContainText("Editing Ocean Dusk · from Catppuccin Mocha");
  await expect(option(page, "Ocean Dusk").getByTestId("theme-origin")).toHaveText("editing · 1 pinned");
  await expect(page.getByTestId("editor-slots-summary")).toHaveText("1 pinned");
  // Every slot, Terminal and Syntax collapsed.
  await expect(page.getByTestId("editor-filter")).toHaveAttribute("placeholder", "Filter 102 slots");
  await expect(page.getByTestId("editor-group-terminal").getByTestId("editor-slot-terminal-fg")).toHaveCount(0);
  await expect(page.getByTestId("editor-slot-sidebar-row-selected")).toHaveAttribute("data-pinned", "true");

  // A base colour: the gallery repaints, the window does not.
  await setBase(page, "canvas", "#202830");
  expect(await scopeVar(page, "--cf-canvas")).toBe("#202830");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "github-dark");
  // The seed pin keeps its value; its slot derives from the canvas, so it is stale now.
  await expect(page.getByTestId("editor-slot-sidebar-row-selected")).toHaveAttribute("data-stale", "true");
  await expect(page.getByTestId("editor-slots-summary")).toContainText("1 pinned · 1 stale");

  // Pin a slot: touching its colour pins it.
  await page.getByTestId("editor-slot-sidebar-row-hover").click();
  await expect(page.getByTestId("slot-view")).toHaveAttribute("data-slot", "--cf-sidebar-row-hover");
  await expect(page.getByTestId("slot-view")).toContainText("Change the colour below to pin it.");
  await page.getByTestId("colour-hex").fill("#334455");
  await page.getByTestId("colour-hex").press("Enter");
  await expect(page.getByTestId("slot-view-yours")).toContainText("#334455");
  await expect(page.getByTestId("slot-view-derived")).toBeVisible();
  expect(await scopeVar(page, "--cf-sidebar-row-hover")).toBe("#334455");
  // Escape goes back to the list (the page stays open).
  await page.getByTestId("colour-plane").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("editor-slots")).toBeVisible();
  await expect(page.getByTestId("themes-page")).toBeVisible();
  await expect(page.getByTestId("editor-slot-sidebar-row-hover")).toHaveAttribute("data-pinned", "true");
  await expect(page.getByTestId("editor-slot-sidebar-row-hover")).not.toHaveAttribute("data-stale", "true");

  // Another base change: the new pin goes stale too.
  await setBase(page, "canvas", "#2a3440");
  await expect(page.getByTestId("editor-slots-summary")).toContainText("2 pinned · 2 stale");
  await expect(page.getByTestId("editor-slot-sidebar-row-hover")).toContainText("pinned · would now derive #");

  // The slot view says why and offers Reset to derived.
  await page.getByTestId("editor-slot-sidebar-row-hover").click();
  await expect(page.getByTestId("slot-view-stale")).toContainText("it would now derive #");
  await expect(page.getByTestId("editor-pairs")).toContainText("sidebar-muted-foreground on it");
  await page.getByTestId("slot-reset").click();
  await expect(page.getByTestId("slot-view-stale")).toHaveCount(0);
  await page.getByTestId("editor-back").click();
  await expect(page.getByTestId("editor-slots-summary")).toContainText("2 pinned · 1 stale");

  // Pinned only.
  await page.getByTestId("editor-pinned-only").click();
  await expect(page.getByTestId("editor-slots").locator("[data-testid^=editor-slot-]")).toHaveCount(2);
  await page.getByTestId("editor-pinned-only").click();

  // Save: the stale pin is listed; Re-derive unpins it; "use now" is checked (dark is in use).
  await page.getByTestId("themes-save").click();
  const dialog = page.getByTestId("theme-save-dialog");
  await expect(dialog).toContainText("From Catppuccin Mocha · dark · 2 slots pinned");
  await expect(dialog.getByTestId("theme-save-stale")).toContainText("sidebar-row-selected pinned before the base changed");
  await dialog.getByTestId("theme-save-rederive").click();
  await expect(dialog).toContainText("1 slot pinned");
  await expect(dialog.getByTestId("theme-save-apply")).toHaveAttribute("aria-checked", "true");
  await dialog.getByTestId("theme-save-name").fill("Ocean Dusk, deeper");
  await expect(dialog.getByTestId("theme-save-submit")).toHaveText("Save and apply");
  await dialog.getByTestId("theme-save-submit").click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => raw("appearance.theme_dark")).toBe("ocean-dusk");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ocean-dusk");
  const saved = await mockTheme("ocean-dusk");
  expect(saved?.name).toBe("Ocean Dusk, deeper");
  expect(saved?.base.canvas).toBe("#2a3440");
  expect(Object.keys(saved?.overrides ?? {})).toEqual(["--cf-sidebar-row-hover"]);
  expect(await page.locator("html").evaluate((el) => getComputedStyle(el).getPropertyValue("--cf-canvas").trim())).toBe("#2a3440");
  await expect(page.getByTestId("themes-revert")).toBeDisabled();

  // Revert goes back to what was saved.
  await setBase(page, "canvas", "#101418");
  await expect(page.getByTestId("themes-edit-bar")).toContainText("unsaved");
  await page.getByTestId("themes-revert").click();
  expect(await scopeVar(page, "--cf-canvas")).toBe("#2a3440");
  await expect(page.getByTestId("themes-revert")).toBeDisabled();
});

test("Customise opens the editor on the copy; leaving with changes asks first", async ({ page }) => {
  await openThemes(page);
  const dracula = option(page, "Dracula");
  await dracula.hover();
  await dracula.getByRole("button", { name: "Customise Dracula" }).click();
  await expect(page.getByTestId("themes-editing-name")).toHaveText("Dracula copy");
  await expect(scope(page)).toHaveAttribute("data-theme", "dracula-copy");
  await setBase(page, "accent", "#ff79c6");
  // Another row: the editor would drop the change, so it asks.
  await option(page, "Nord").getByTestId("theme-name").click();
  await expect(page.getByTestId("confirm-dialog")).toContainText("Dracula copy has changes that are not saved.");
  await page.getByTestId("confirm-cancel").click();
  await expect(inspector(page)).toBeVisible();
  // Closing the page asks too; Discard leaves.
  await page.getByRole("button", { name: "Close themes" }).click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("themes-page")).toHaveCount(0);
  // Nothing was written.
  expect((await mockTheme("dracula-copy"))?.base).not.toHaveProperty("accent", "#ff79c6");
});

test("a contrast failure shows its ratio and Fix pins a value that reads", async ({ page }) => {
  await editOceanDusk(page);
  await page.getByTestId("editor-filter").fill("message-surface");
  await page.getByTestId("editor-slot-message-surface").click();
  // The bubble's tint at full strength in the text colour: the bubble's text cannot read on it.
  await page.getByTestId("colour-hex").fill("#d7e3eaff");
  await page.getByTestId("colour-hex").press("Enter");
  await expect(page.getByTestId("editor-pairs").locator("[data-pass=false]").first()).toBeVisible();
  await page.getByTestId("editor-back").click();
  await page.getByTestId("editor-filter").fill("message");
  await expect(page.getByTestId("editor-slot-message-foreground").getByTestId("slot-contrast")).toHaveText(/^1\.\d+:1$/);
  await expect(page.getByTestId("editor-group-thread")).toContainText("1 contrast");
  await page.getByTestId("themes-save").click();
  const dialog = page.getByTestId("theme-save-dialog");
  await expect(dialog.getByTestId("theme-save-contrast")).toContainText("message-foreground on message-surface");
  await dialog.getByTestId("theme-save-fix").click();
  await expect(dialog.getByTestId("theme-save-contrast")).toHaveCount(0);
  await expect(page.getByTestId("editor-slot-message-foreground")).toHaveAttribute("data-pinned", "true");
});
