import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock } from "./fixtures";

// The user's own themes on the Themes page (docs/notes/user-themes.md). The mock seeds three
// (mock/userThemes.ts): Ocean Dusk (dark, from Catppuccin Mocha, by thread s-1), Mocha,
// warmer (dark, from Catppuccin Mocha) and Latte, softer (light, by s-3), and a file that
// does not load. The slots start on GitHub Dark and Light, the browser is dark.

test.beforeEach(async () => {
  await resetMock();
});

const option = (page: Page, name: string) => page.getByTestId("themes-list").getByRole("option", { name, exact: true });

async function openThemes(page: Page, slot: "dark" | "light" = "dark") {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId(`choose-theme-${slot}`).click();
  await expect(page.getByTestId("themes-page")).toBeVisible();
}

// Yours above Curated, each theme's origin, the files that did not load and the search: unit-tested in src/components/themes/ThemesPage.test.tsx.

// Previewing, Apply through theme.set-dark and the slot naming it: src/components/themes/ThemesPage.test.tsx.
test("an applied user theme paints the window with the file's own colours", async ({ page }) => {
  await openThemes(page);
  await option(page, "Ocean Dusk").getByTestId("theme-name").click();
  await page.getByTestId("themes-apply").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ocean-dusk");
  // The pane is the file's surface.
  expect(await page.locator("html").evaluate((el) => getComputedStyle(el).getPropertyValue("--pane").trim())).toBe("#16232f");
});

// Customise (no Delete on a curated row, the copy in Yours, selected and edited, previewed not applied,
// the unsaved copy going before the next, numbering past a saved one): src/components/themes/ThemesPage.test.tsx
// ("Customise copies into Yours…"); the "copy 2" names are the daemon's (internal/store/usertheme/usertheme_test.go).
test("a row's actions are folded away until the row is hovered", async ({ page }) => {
  await openThemes(page);
  const dracula = option(page, "Dracula");
  await expect(dracula.getByTestId("theme-row-actions")).toHaveCSS("opacity", "0");
  await dracula.hover();
  await expect(dracula.getByTestId("theme-row-actions")).toHaveCSS("opacity", "1");
});

// Delete asking first and the slot falling back to the theme's origin: the daemon's (internal/command/commands_theme_test.go, "delete the theme in use"); the row's Delete is src/components/themes/ThemesPage.test.tsx, the confirm's text and label src/components/confirm/ConfirmDialog.test.tsx, a slot change on html src/stores/settings.test.ts.

// A file that did not load and its Delete: unit-tested in src/components/themes/ThemesPage.test.tsx (its question: internal/command).

// A theme arriving live, the empty Yours line and the schema reload for the slot selects: unit-tested in src/components/themes/ThemesPage.test.tsx.
