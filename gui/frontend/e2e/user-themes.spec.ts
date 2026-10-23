import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock } from "./fixtures";

// The user's own themes on the Themes page (docs/notes/user-themes.md). The mock seeds three
// (mock/userThemes.ts): Ocean Dusk (dark, from Catppuccin Mocha, by thread s-1), Mocha,
// warmer (dark, from Catppuccin Mocha) and Latte, softer (light, by s-3), and a file that
// does not load. The slots start on GitHub Dark and Light, the browser is dark.

test.beforeEach(async () => {
  await resetMock();
});

async function raw(key: string): Promise<string | undefined> {
  const res = await fetch(`${mockUrl}/__mock/settings`);
  return ((await res.json()) as { raw: Record<string, string> }).raw[key];
}

const yours = (page: Page) => page.getByTestId("themes-yours");
const curated = (page: Page) => page.getByTestId("themes-curated");
const option = (page: Page, name: string) => page.getByTestId("themes-list").getByRole("option", { name, exact: true });
const scope = (page: Page) => page.getByTestId("theme-scope");

async function openThemes(page: Page, slot: "dark" | "light" = "dark") {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId(`choose-theme-${slot}`).click();
  await expect(page.getByTestId("themes-page")).toBeVisible();
}

test("Yours lists the scheme's own themes above the curated ones, with where each came from", async ({ page }) => {
  await openThemes(page);
  await expect(yours(page).getByTestId("theme-name")).toHaveText(["Mocha, warmer", "Ocean Dusk"]);
  await expect(yours(page)).toContainText("Yours · 2");
  await expect(curated(page)).toContainText("Curated · 15");
  await expect(option(page, "Ocean Dusk").getByTestId("theme-origin")).toHaveText("from Catppuccin Mocha · by a thread");
  await expect(option(page, "Mocha, warmer").getByTestId("theme-origin")).toHaveText("from Catppuccin Mocha");
  await expect(curated(page).getByTestId("theme-origin")).toHaveCount(0);
  await expect(page.getByTestId("themes-issues")).toContainText('draft.json did not load: base.accent: "#5fb3" is not #rrggbb');
  await expect(page.getByRole("searchbox", { name: "Search themes" })).toHaveAttribute("placeholder", "Search 17 dark themes");
  // The light slot has its own.
  await page.getByTestId("themes-slot-light").click();
  await expect(yours(page).getByTestId("theme-name")).toHaveText(["Latte, softer"]);
  // A search that none of yours match hides the section.
  await page.getByTestId("themes-slot-dark").click();
  await page.getByRole("searchbox", { name: "Search themes" }).fill("nord");
  await expect(yours(page)).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search themes" }).fill("ocean");
  await expect(page.getByTestId("themes-list").getByTestId("theme-name")).toHaveText(["Ocean Dusk"]);
});

test("a user theme previews and applies like a curated one", async ({ page }) => {
  await openThemes(page);
  await option(page, "Ocean Dusk").getByTestId("theme-name").click();
  await expect(scope(page)).toHaveAttribute("data-theme", "ocean-dusk");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "github-dark");
  await page.getByTestId("themes-apply").click();
  await expect.poll(() => raw("appearance.theme_dark")).toBe("ocean-dusk");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ocean-dusk");
  await expect(page.getByTestId("themes-slot-dark")).toContainText("Ocean Dusk");
  // Its colours are its own: the pane is the file's surface.
  expect(await page.locator("html").evaluate((el) => getComputedStyle(el).getPropertyValue("--pane").trim())).toBe("#16232f");
});

test("Customise copies a theme into Yours, previews the copy and edits it", async ({ page }) => {
  await openThemes(page);
  const dracula = option(page, "Dracula");
  // Folded away until the row is hovered (still focusable).
  await expect(dracula.getByTestId("theme-row-actions")).toHaveCSS("opacity", "0");
  await dracula.hover();
  await expect(dracula.getByTestId("theme-row-actions")).toHaveCSS("opacity", "1");
  await expect(dracula.getByRole("button", { name: "Delete Dracula" })).toHaveCount(0);
  await dracula.getByRole("button", { name: "Customise Dracula" }).click();
  await expect(yours(page).getByTestId("theme-name")).toHaveText(["Dracula copy", "Mocha, warmer", "Ocean Dusk"]);
  await expect(option(page, "Dracula copy")).toHaveAttribute("aria-selected", "true");
  // The editor opens on the copy (theme-editor.spec.ts); its row says so instead of where it came from.
  await expect(option(page, "Dracula copy").getByTestId("theme-origin")).toHaveText("editing · 0 pinned");
  await expect(page.getByTestId("themes-edit-bar")).toContainText("Editing Dracula copy · from Dracula");
  await expect(scope(page)).toHaveAttribute("data-theme", "dracula-copy");
  // Previewed, not applied.
  expect(await raw("appearance.theme_dark")).toBeUndefined();
  // A second copy gets the next id.
  await option(page, "Dracula").hover();
  await option(page, "Dracula").getByRole("button", { name: "Customise Dracula" }).click();
  await expect(scope(page)).toHaveAttribute("data-theme", "dracula-copy-2");
  await expect(option(page, "Dracula copy 2")).toBeVisible();
});

test("Delete asks first; deleting the theme in use moves the slot to the theme it came from", async ({ page }) => {
  await mockPost("settings/external?appearance.theme_dark=ocean-dusk");
  await openThemes(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ocean-dusk");
  const ocean = option(page, "Ocean Dusk");
  await ocean.hover();
  await ocean.getByRole("button", { name: "Delete Ocean Dusk" }).click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Delete the theme Ocean Dusk? Its file in the themes directory is removed. It is your dark theme; the dark theme becomes Catppuccin Mocha.");
  await expect(page.getByTestId("confirm-ok")).toHaveText("Delete");
  await page.getByTestId("confirm-cancel").click();
  await expect(ocean).toBeVisible();

  await ocean.hover();
  await ocean.getByRole("button", { name: "Delete Ocean Dusk" }).click();
  await page.getByTestId("confirm-ok").click();
  await expect(ocean).toHaveCount(0);
  await expect(yours(page).getByTestId("theme-name")).toHaveText(["Mocha, warmer"]);
  await expect.poll(() => raw("appearance.theme_dark")).toBe("catppuccin-mocha");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "catppuccin-mocha");
});

test("a theme written by hand arrives live; with none, Yours says how to make one", async ({ page }) => {
  await mockPost("themes?set=empty");
  await openThemes(page);
  await expect(yours(page)).toContainText("Yours · 0");
  await expect(yours(page)).toContainText("Customise a theme to make one of your own.");
  await mockPost("themes?set=seed");
  await expect(yours(page).getByTestId("theme-name")).toHaveText(["Mocha, warmer", "Ocean Dusk"]);
  // The settings' Dark theme select lists them too, first.
  await page.getByRole("button", { name: "Close themes" }).click();
  await page.locator('[data-setting="appearance.theme_dark"] [data-slot="select-trigger"]').click();
  await expect(page.locator('[data-slot="select-content"]').getByRole("option").first()).toHaveText("Mocha, warmer");
});
