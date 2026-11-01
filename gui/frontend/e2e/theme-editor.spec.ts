import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock } from "./fixtures";

// The theme editor on the Themes page (docs/notes/theme-editor.md). The mock seeds Ocean
// Dusk (dark, from Catppuccin Mocha, one pin: --cf-sidebar-row-selected #1e2e3c); the
// slots start on GitHub Dark and Light, the browser is dark.
// Wide enough for the full theme list beside the editor (narrower windows fold it to a
// strip: theme-editor-fuzz.spec.ts).
test.use({ viewport: { width: 1600, height: 900 } });

test.beforeEach(async () => {
  await resetMock();
});

const option = (page: Page, name: string) => page.getByTestId("themes-list").getByRole("option", { name, exact: true });
const inspector = (page: Page) => page.getByTestId("theme-inspector");

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

// The edit bar, the origin, the summary, the filter's count, pins going stale, the slot view and
// Escape back to the list, Reset to derived, the save dialog (stale pins, Re-derive, use now), the
// saved file and Revert: src/components/themes/ThemesPage.test.tsx ("a base colour repaints the scope…").
test("Edit shows on hover; a base edit saved and applied paints the window's computed --cf-canvas", async ({ page }) => {
  await editOceanDusk(page);
  await setBase(page, "canvas", "#2a3440");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "github-dark");
  await page.getByTestId("themes-save").click();
  const dialog = page.getByTestId("theme-save-dialog");
  await expect(dialog.getByTestId("theme-save-submit")).toHaveText("Save and apply");
  await dialog.getByTestId("theme-save-submit").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ocean-dusk");
  expect(await page.locator("html").evaluate((el) => getComputedStyle(el).getPropertyValue("--cf-canvas").trim())).toBe("#2a3440");
});

// Customise opening the editor on the copy, and leaving with changes: unit-tested in src/components/themes/ThemesPage.test.tsx.

// A contrast failure and Fix: unit-tested in src/components/themes/ThemesPage.test.tsx.
