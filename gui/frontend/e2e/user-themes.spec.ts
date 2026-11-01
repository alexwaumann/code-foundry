import { expect, test, type Page } from "@playwright/test";
import { mockUrl, openApp, resetMock } from "./fixtures";

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

async function mockThemes(): Promise<{ themes: { id: string }[]; calls: string[] }> {
  return (await (await fetch(`${mockUrl}/__mock/themes`)).json()) as { themes: { id: string }[]; calls: string[] };
}

const yours = (page: Page) => page.getByTestId("themes-yours");
const option = (page: Page, name: string) => page.getByTestId("themes-list").getByRole("option", { name, exact: true });
const scope = (page: Page) => page.getByTestId("theme-scope");

async function openThemes(page: Page, slot: "dark" | "light" = "dark") {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId(`choose-theme-${slot}`).click();
  await expect(page.getByTestId("themes-page")).toBeVisible();
}

// Yours above Curated, each theme's origin, the files that did not load and the search: unit-tested in src/components/themes/ThemesPage.test.tsx.

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
  // Wide enough for the full list beside the editor (its rows' second lines).
  await page.setViewportSize({ width: 1600, height: 900 });
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
  // Customise again: the first copy was never saved, so it goes before the next is made, which takes its id.
  await option(page, "Dracula").hover();
  await option(page, "Dracula").getByRole("button", { name: "Customise Dracula" }).click();
  await expect.poll(async () => (await mockThemes()).calls.filter((c) => /^theme\.(duplicate|delete)/.test(c))).toEqual(["theme.duplicate dracula", "theme.delete dracula-copy", "theme.duplicate dracula"]);
  await expect(scope(page)).toHaveAttribute("data-theme", "dracula-copy");
  await expect(yours(page).getByTestId("theme-name")).toHaveText(["Dracula copy", "Mocha, warmer", "Ocean Dusk"]);
  // Saved once, a copy stays: the next Customise numbers past it.
  await page.getByTestId("themes-save").click();
  await page.getByTestId("theme-save-submit").click();
  await expect(page.getByTestId("theme-save-dialog")).toHaveCount(0);
  await option(page, "Dracula").hover();
  await option(page, "Dracula").getByRole("button", { name: "Customise Dracula" }).click();
  await expect(scope(page)).toHaveAttribute("data-theme", "dracula-copy-2");
  await expect(yours(page).getByTestId("theme-name")).toHaveText(["Dracula copy", "Dracula copy 2", "Mocha, warmer", "Ocean Dusk"]);
});

// Delete asking first and the slot falling back to the theme's origin: the daemon's (internal/command/commands_theme_test.go, "delete the theme in use"); the row's Delete is src/components/themes/ThemesPage.test.tsx, the confirm's text and label src/components/confirm/ConfirmDialog.test.tsx, a slot change on html src/stores/settings.test.ts.

// A file that did not load and its Delete: unit-tested in src/components/themes/ThemesPage.test.tsx (its question: internal/command).

// A theme arriving live, the empty Yours line and the schema reload for the slot selects: unit-tested in src/components/themes/ThemesPage.test.tsx.
