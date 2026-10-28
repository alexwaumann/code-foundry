import { expect, test, type Page } from "@playwright/test";
import { emit, invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

// The theme editor's fuzz fixes (docs/notes/theme-fuzz-editor.md), by finding. The mock seeds
// Ocean Dusk (dark, from Catppuccin Mocha, one pin) and Mocha, warmer; the slots start on
// GitHub Dark and Light, the browser is dark.

test.beforeEach(async () => {
  await resetMock();
});

interface MockTheme {
  id: string;
  name: string;
  base: Record<string, string>;
}

async function mockThemes(): Promise<{ themes: MockTheme[]; calls: string[] }> {
  return (await (await fetch(`${mockUrl}/__mock/themes`)).json()) as { themes: MockTheme[]; calls: string[] };
}

const mockTheme = async (id: string) => (await mockThemes()).themes.find((t) => t.id === id);
const option = (page: Page, name: string) => page.getByTestId("themes-list").getByRole("option", { name, exact: true });
const inspector = (page: Page) => page.getByTestId("theme-inspector");
const scopeVar = (page: Page, name: string) => page.getByTestId("themes-page").locator('[data-testid="theme-scope"]').last().evaluate((el, n) => (el as HTMLElement).style.getPropertyValue(n), name);
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

test("1: a save from outside reaches the open editor; over unsaved edits it asks Reload or Keep mine", async ({ page }) => {
  await editOceanDusk(page);
  // Clean: it reloads by itself.
  await mockPost("themes/edit?theme=ocean-dusk&canvas=%23330000");
  await expect.poll(() => scopeVar(page, "--cf-canvas")).toBe("#330000");
  await expect(inspector(page).getByTestId("editor-base-canvas")).toContainText("#330000");
  await expect(page.getByTestId("themes-edit-bar")).not.toContainText("unsaved");
  // theme edit on the theme already open: still the newer file, nothing to ask.
  await themeEdit("ocean-dusk");
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(inspector(page).getByTestId("editor-base-canvas")).toContainText("#330000");

  // Unsaved edits: the editor keeps them and says the file changed.
  await setBase(page, "accent", "#ff00ff");
  await mockPost("themes/edit?theme=ocean-dusk&canvas=%23440000");
  await expect(page.getByTestId("editor-disk-notice")).toContainText("Changed on disk");
  expect(await scopeVar(page, "--cf-canvas")).toBe("#330000");
  // Reload takes the newer file and drops the edit.
  await page.getByTestId("editor-disk-reload").click();
  await expect(page.getByTestId("editor-disk-notice")).toHaveCount(0);
  expect(await scopeVar(page, "--cf-canvas")).toBe("#440000");
  await expect(page.getByTestId("themes-revert")).toBeDisabled();

  // Keep mine: the draft stays, and Save writes it over the newer file knowingly.
  await setBase(page, "accent", "#ff00ff");
  await mockPost("themes/edit?theme=ocean-dusk&canvas=%23550000");
  await page.getByTestId("editor-disk-keep").click();
  await expect(page.getByTestId("editor-disk-notice")).toHaveCount(0);
  await page.getByTestId("themes-save").click();
  await page.getByTestId("theme-save-apply").click();
  await page.getByTestId("theme-save-submit").click();
  await expect(page.getByTestId("theme-save-dialog")).toHaveCount(0);
  await expect.poll(async () => (await mockTheme("ocean-dusk"))?.base).toMatchObject({ canvas: "#440000", accent: "#ff00ff" });
});

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

test("3: Escape with edits asks and the question stays; clean, it leaves the editor, then the page", async ({ page }) => {
  await editOceanDusk(page);
  await setBase(page, "accent", "#ff00ff");
  await page.getByTestId("themes-list").focus();
  await page.keyboard.press("Escape");
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toContainText("Ocean Dusk has changes that are not saved.");
  await page.waitForTimeout(300);
  await expect(confirm).toBeVisible();
  await page.getByTestId("confirm-cancel").click();
  await expect(inspector(page)).toBeVisible();
  // A second Escape on the open confirm cancels it, and only it.
  await page.getByTestId("themes-list").focus();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(inspector(page)).toBeVisible();

  await page.getByTestId("themes-revert").click();
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toHaveCount(0);
  await expect(page.getByTestId("themes-preview-bar")).toBeVisible();
  // The list has the keyboard again: the arrows preview.
  expect(await focusedTestId(page)).toBe("themes-list");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("themes-page")).toHaveCount(0);
});

test("4: Fix on a pair no colour can mend leaves the slot alone and says why", async ({ page }) => {
  await editOceanDusk(page);
  // A mid-grey hovered row: muted text cannot hold 4.5:1 on it and on the dark panes at once.
  await page.getByTestId("editor-filter").fill("control-hover");
  await page.getByTestId("editor-slot-control-hover").click();
  await page.getByTestId("colour-hex").fill("#8a8a8a");
  await page.getByTestId("colour-hex").press("Enter");
  await page.getByTestId("editor-back").click();
  await page.getByTestId("themes-save").click();
  const dialog = page.getByTestId("theme-save-dialog");
  const unfixable = dialog.getByTestId("theme-save-unfixable").filter({ hasText: "No colour on control-hover reaches 4.5:1; change the surface or the base colour." });
  await expect(unfixable.first()).toBeVisible();
  await expect(dialog.getByTestId("theme-save-contrast").filter({ has: unfixable }).getByTestId("theme-save-fix")).toHaveCount(0);
  // Every Fix offered mends its row and does not come back.
  const before = await dialog.getByTestId("theme-save-contrast").count();
  const fix = dialog.getByTestId("theme-save-fix").first();
  if ((await fix.count()) > 0) {
    await fix.click();
    await expect(dialog.getByTestId("theme-save-contrast")).toHaveCount(before - 1);
  }
});

test("5: a light surface on a dark theme is refused in the editor, not by Save", async ({ page }) => {
  await editOceanDusk(page);
  await setBase(page, "surface", "#f0f0f0");
  const line = inspector(page).getByTestId("editor-refusal");
  await expect(line).toContainText("A dark theme needs a dark surface (OKLab lightness at most 0.45); #f0f0f0 is 0.9");
  await expect(inspector(page).getByTestId("editor-base-surface")).toHaveAttribute("data-problem", "true");
  await page.getByTestId("themes-save").click();
  const dialog = page.getByTestId("theme-save-dialog");
  await expect(dialog.getByTestId("theme-save-refusal")).toContainText("A dark theme needs a dark surface");
  await expect(dialog).not.toContainText("You can save anyway");
  await expect(dialog.getByTestId("theme-save-contrast")).toHaveCount(0);
  await expect(dialog.getByTestId("theme-save-submit")).toBeDisabled();
  // A name the daemon refuses holds Save the same way.
  await page.keyboard.press("Escape");
  await setBase(page, "surface", "#16232f");
  await page.getByTestId("themes-save").click();
  await dialog.getByTestId("theme-save-name").fill("Ocean\tDusk");
  await expect(dialog.getByTestId("theme-save-refusal")).toHaveText("Cannot save: name: no control or format characters");
  await expect(dialog.getByTestId("theme-save-submit")).toBeDisabled();
  // A name another of yours has, and one past 80 characters, say so (nothing is cut).
  await dialog.getByTestId("theme-save-name").fill("Mocha, warmer");
  await expect(dialog.getByTestId("theme-save-name-hint")).toHaveText("Another of your themes is called this.");
  await expect(dialog.getByTestId("theme-save-submit")).toBeEnabled();
  await dialog.getByTestId("theme-save-name").fill("x".repeat(90));
  await expect(dialog.getByTestId("theme-save-name-hint")).toHaveText("90/80");
  await expect(dialog.getByTestId("theme-save-submit")).toBeDisabled();
  // Closing the modal hands the keyboard back to Save….
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(await focusedTestId(page)).toBe("themes-save");
});

test("6: Ask the model with unsaved edits asks first; Cancel starts nothing", async ({ page }) => {
  await editOceanDusk(page);
  await setBase(page, "accent", "#ff00ff");
  await page.getByTestId("themes-ask").click();
  await page.getByTestId("themes-ask-input").fill("warmer");
  await page.getByTestId("themes-ask-send").click();
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toContainText("The model does not see them: asking starts a thread and leaves the editor.");
  await page.getByTestId("confirm-cancel").click();
  await expect(inspector(page)).toBeVisible();
  expect((await invocations()).some((i) => i.name === "theme.ask")).toBe(false);
  await page.getByTestId("themes-ask").click();
  await expect(page.getByTestId("themes-ask-input")).toHaveValue("warmer");
  await page.getByTestId("themes-ask-send").click();
  await page.getByTestId("confirm-ok").click();
  await expect.poll(async () => (await invocations()).some((i) => i.name === "theme.ask")).toBe(true);
});

test("7: a double-click on Customise makes one copy; closing it unsaved deletes it", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openThemes(page);
  const nord = option(page, "Nord");
  await nord.hover();
  await nord.getByRole("button", { name: "Customise Nord" }).dblclick();
  await expect(page.getByTestId("themes-editing-name")).toHaveText("Nord copy");
  await expect.poll(async () => (await mockThemes()).themes.map((t) => t.id).filter((id) => id.startsWith("nord"))).toEqual(["nord-copy"]);
  await page.getByTestId("themes-edit-done").click();
  await expect(inspector(page)).toHaveCount(0);
  await expect.poll(() => mockTheme("nord-copy")).toBeUndefined();
  await expect(option(page, "Nord copy")).toHaveCount(0);
  // The preview goes back to the slot's theme.
  await expect(page.getByTestId("themes-previewed-name")).toHaveText("GitHub Dark");
});

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

test("10, 11: the hex field takes #rgb, marks what it cannot take, and an emptied L reverts", async ({ page }) => {
  await editOceanDusk(page);
  await inspector(page).getByTestId("editor-base-accent").click();
  const hex = page.getByTestId("colour-hex");
  await hex.fill("#abc");
  await hex.press("Enter");
  await expect(hex).toHaveValue("#aabbcc");
  await hex.fill("rgb(1, 2, 3)");
  await hex.press("Enter");
  await expect(hex).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("colour-hex-invalid")).toHaveText("Use #rrggbb (or #rgb).");
  await hex.fill("");
  await hex.press("Enter");
  await expect(hex).toHaveValue("#aabbcc");
  await expect(page.getByTestId("colour-hex-invalid")).toHaveCount(0);
  const l = page.getByRole("textbox", { name: "Accent lightness" });
  await l.fill("");
  await l.press("Enter");
  await expect(hex).toHaveValue("#aabbcc");
  // The hue wraps.
  const h = page.getByRole("textbox", { name: "Accent hue" });
  await h.fill("-50");
  await h.press("Enter");
  await expect(h).toHaveValue("310");
});

test("12, 16: Pinned only with a filter that matches no pin says so; a group header changes nothing while filtered", async ({ page }) => {
  await editOceanDusk(page);
  await page.getByTestId("editor-pinned-only").click();
  await page.getByTestId("editor-filter").fill("zzz");
  await expect(page.getByTestId("editor-slots")).toContainText("No pinned slot matches “zzz”.");
  await page.getByTestId("editor-pinned-only").click();
  await page.getByTestId("editor-filter").fill("chrome");
  const surfaces = page.getByTestId("editor-group-surfaces");
  await expect(surfaces.getByTestId("editor-slot-chrome")).toBeVisible();
  await surfaces.getByRole("button").first().click();
  await expect(surfaces.getByTestId("editor-slot-chrome")).toBeVisible();
  await page.getByTestId("editor-filter").fill("");
  // Surfaces was open before the filter, and still is.
  await expect(surfaces.getByTestId("editor-slot-canvas")).toBeVisible();
});

test("14: Cancel on leaving through a selection change puts the selection back", async ({ page }) => {
  await editOceanDusk(page);
  await setBase(page, "accent", "#ff00ff");
  // The sheet's backdrop covers the sidebar: the selection changes from the keyboard or the
  // CLI (thread.next, the sidebar's next-thread chord).
  expect(await emit({ showView: { name: "thread.next" } })).toBeGreaterThan(0);
  await page.getByTestId("confirm-cancel").click();
  await expect(inspector(page)).toBeVisible();
  await expect(page.getByTestId("sidebar-dashboard")).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Close themes" }).click();
  await page.getByTestId("confirm-ok").click();
  // Back to Settings (the page was opened from there), not to the thread clicked and cancelled.
  await expect(page.getByTestId("themes-page")).toHaveCount(0);
  await expect(page.getByTestId("thread-header")).toHaveCount(0);
});

test("16: the theme search keeps the files that did not load that it matches", async ({ page }) => {
  await openThemes(page);
  await page.getByRole("searchbox", { name: "Search themes" }).fill("draft");
  await expect(page.getByTestId("themes-issues")).toContainText("draft.json did not load");
  await expect(page.getByTestId("themes-list")).not.toContainText("No dark themes match");
});
