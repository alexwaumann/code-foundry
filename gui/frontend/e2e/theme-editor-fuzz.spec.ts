import { expect, test, type Page } from "@playwright/test";
import { emit, openApp, resetMock, row } from "./fixtures";

// The theme editor's fuzz fixes (docs/notes/theme-fuzz-editor.md), by finding. The mock seeds
// Ocean Dusk (dark, from Catppuccin Mocha, one pin) and Mocha, warmer; the slots start on
// GitHub Dark and Light, the browser is dark.

test.beforeEach(async () => {
  await resetMock();
});

const option = (page: Page, name: string) => page.getByTestId("themes-list").getByRole("option", { name, exact: true });
const inspector = (page: Page) => page.getByTestId("theme-inspector");
const focusedTestId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? "");

async function openThemes(page: Page) {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId("choose-theme-dark").click();
  await expect(page.getByTestId("themes-page")).toBeVisible();
}

/** theme.edit's view, as the CLI, the card's Edit and the toast's Edit send it. */
async function themeEdit(id: string) {
  await expect.poll(() => emit({ showView: { name: `themes.edit.${id}` } })).toBeGreaterThan(0);
}

async function editOceanDusk(page: Page) {
  await openThemes(page);
  await themeEdit("ocean-dusk");
  await expect(inspector(page)).toBeVisible();
}

async function setBase(page: Page, key: string, hex: string) {
  await inspector(page).getByTestId(`editor-base-${key}`).click();
  await expect(page.getByTestId("base-view")).toHaveAttribute("data-base", key);
  const field = page.getByTestId("colour-hex");
  await field.fill(hex);
  await field.press("Enter");
  await page.getByTestId("editor-back").click();
  await expect(page.getByTestId("editor-slots")).toBeVisible();
}

// 1: a save from outside, Reload and Keep mine: unit-tested in src/components/themes/ThemesPage.test.tsx.

for (const width of [900, 1100, 1200, 1440]) {
  test(`2: at ${String(width)}px the edit bar, its buttons and the editing name stay on the page`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await editOceanDusk(page);
    await setBase(page, "accent", "#ff00ff");
    const pageBox = await page.getByTestId("themes-page").boundingBox();
    for (const id of ["themes-revert", "themes-save", "themes-edit-done"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0), id).toBeLessThanOrEqual(width);
    }
    expect((await page.getByTestId("themes-editing-name").boundingBox())?.width ?? 0).toBeGreaterThan(40);
    // Focus on Save… does not scroll the page sideways (the sheet hides its overflow).
    await page.getByTestId("themes-save").focus();
    expect((await page.getByTestId("themes-page").boundingBox())?.x).toBe(pageBox?.x);
    // The list folds to a strip below a body of 1220px (its full columns): the sheet is 1280
    // wide from a 1376px window (48px margins), narrower below. A row still leaves for its theme.
    await expect(page.getByTestId("themes-body")).toHaveAttribute("data-list", width >= 1440 ? "full" : "strip");
    await option(page, "Nord").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText("Ocean Dusk has changes that are not saved.");
    await page.getByTestId("confirm-cancel").click();
    await page.getByTestId("themes-save").click();
    const dialog = page.getByTestId("theme-save-dialog");
    const submit = await dialog.getByTestId("theme-save-submit").boundingBox();
    expect((submit?.x ?? 0) + (submit?.width ?? 0)).toBeLessThanOrEqual(width);
  });
}

test("2: with the side panel open on a thread, the Themes page still fits at 900px", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  await page.getByTestId("thread-header").getByTestId("panel-toggle").click();
  await expect(page.getByTestId("panel-resize-handle")).toBeVisible();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId("choose-theme-dark").click();
  await themeEdit("ocean-dusk");
  const save = await page.getByTestId("themes-save").boundingBox();
  expect((save?.x ?? 0) + (save?.width ?? 0)).toBeLessThanOrEqual(900);
});

// 3: Escape with edits asks and the question stays; clean, it leaves the editor (the list keeps the keyboard), then the page: src/components/themes/ThemesPage.test.tsx ("Escape with edits asks…").

// 4: an unfixable pair: unit-tested in src/components/themes/ThemesPage.test.tsx.

// 5: a light surface on a dark theme refused in the editor, the save modal's refusals and hints, Cancel handing the keyboard back to Save: src/components/themes/ThemesPage.test.tsx ("a light surface on a dark theme is refused…"); the name rule is theme.save's (internal/command).

// 6: Ask the model over unsaved edits: unit-tested in src/components/themes/ThemesPage.test.tsx.

// 7: a double-click on Customise, and its copy closed unsaved: unit-tested in src/components/themes/ThemesPage.test.tsx.

test("8, 9: focus follows the views; the list's arrows stay in the editor", async ({ page }) => {
  await editOceanDusk(page);
  // A new editor puts the keyboard on its first row; ↑↓ walk the rows.
  expect(await focusedTestId(page)).toBe("editor-base-canvas");
  await page.keyboard.press("ArrowDown");
  expect(await focusedTestId(page)).toBe("editor-base-surface");
  // Enter opens the colour's view on its hex field; Escape comes back to the row.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("base-view")).toHaveAttribute("data-base", "surface");
  expect(await focusedTestId(page)).toBe("colour-hex");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("editor-slots")).toBeVisible();
  expect(await focusedTestId(page)).toBe("editor-base-surface");
  // ↓ from the filter reaches the slots.
  await page.getByTestId("editor-filter").fill("sidebar-row");
  await page.getByTestId("editor-filter").press("ArrowDown");
  expect(await focusedTestId(page)).toMatch(/^editor-slot-sidebar-row/);
  // The theme list's arrows no longer leave the editor; its footer says what Escape does.
  await page.getByTestId("themes-list").focus();
  await page.keyboard.press("ArrowDown");
  await expect(inspector(page)).toBeVisible();
});

// 10, 11: the hex, L and hue fields: unit-tested in src/components/themes/ThemesPage.test.tsx.

// 12, 16: Pinned only, the filter and the group headers: unit-tested in src/components/themes/ThemesPage.test.tsx.

// 14: Cancel on leaving through a selection change: unit-tested in src/components/themes/ThemesPage.test.tsx.

// 16: the theme search keeping the files that did not load: unit-tested in src/components/themes/ThemesPage.test.tsx.
