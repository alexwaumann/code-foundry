import { expect, test, type Page } from "@playwright/test";
import { mockUrl, openApp, resetMock, row } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

interface MockSettings {
  raw: Record<string, string>;
  values: Record<string, string>;
}

async function mockSettings(): Promise<MockSettings> {
  const res = await fetch(`${mockUrl}/__mock/settings`);
  return (await res.json()) as MockSettings;
}

/** Opens the app and its settings page, on General or the page asked for. */
async function openSettings(page: Page, pageId?: string) {
  await openApp(page);
  // cmd+, is view.settings's registry chord; a chord pressed before the command list
  // arrives is looked up again once it does (keys/bindings.ts).
  await page.keyboard.press("Meta+Comma");
  const settings = page.getByTestId("settings-page");
  await expect(settings).toBeVisible();
  await expect(settings.locator("[data-setting]").first()).toBeVisible();
  if (pageId) await goTo(page, pageId);
  return settings;
}

function setting(page: Page, key: string) {
  return page.locator(`[data-setting="${key}"]`);
}

/**
 * An enum setting's select trigger: the shadcn Select, a combobox button whose data-value is
 * the setting's value. Found by its slot, not its role: while the list is open Radix hides
 * everything else from the accessibility tree (aria-hidden), the trigger too.
 */
function select(page: Page, key: string) {
  return setting(page, key).locator('[data-slot="select-trigger"]');
}

/** The open select's list (portaled, outside the row; the sidebar is a listbox too). */
function listbox(page: Page) {
  return page.locator('[data-slot="select-content"]');
}

/** Picks an enum setting's option by its label. */
async function pick(page: Page, key: string, label: string) {
  await select(page, key).click();
  await listbox(page).getByRole("option", { name: label, exact: true }).click();
  await expect(listbox(page)).toHaveCount(0);
}

/** Shows a page of the settings page from its left nav. */
async function goTo(page: Page, id: string) {
  await page.getByTestId(`settings-nav-${id}`).click();
  await expect(page.getByTestId(`settings-nav-${id}`)).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", id);
}

// The nav, General's sections, the raw key hidden, enum values and option lists (" (default)"),
// units, restart hints, the settings path and a keybinding's default chord:
// src/components/settings/SettingsPage.test.tsx ("the settings page", "Keybindings"); Escape outside
// a field closing it: the same file; the real schema's pages and models: internal/store/settings.
test("cmd+, opens settings on General and closes it; reopened it is on General again; the trigger hides (default)", async ({ page }) => {
  const settings = await openSettings(page);
  await expect(page.getByTestId("settings-nav-general")).toHaveAttribute("aria-current", "page");
  // The list's " (default)" is hidden on the trigger by CSS.
  await expect(select(page, "threads.default_model")).toHaveText("Sonnet 5", { useInnerText: true });
  await goTo(page, "keybindings");
  await page.keyboard.press("Meta+Comma");
  await expect(settings).toHaveCount(0);
  await page.keyboard.press("Meta+Comma");
  await expect(page.getByTestId("settings-nav-general")).toHaveAttribute("aria-current", "page");
});

// Model and effort sharing a row: unit-tested in src/components/settings/SettingsPage.test.tsx.

// The dimming, its sentence across sections and the editor staying enabled:
// src/components/settings/SettingsPage.test.tsx ("a dependent row dims…").
test("a dependent row is indented under its toggle", async ({ page }) => {
  await openSettings(page, "notifications");
  const volume = setting(page, "notifications.sound_volume");
  const sound = setting(page, "notifications.sound");
  const indent = (await volume.locator(".text-label").first().boundingBox())?.x ?? 0;
  const parent = (await sound.locator(".text-label").first().boundingBox())?.x ?? 0;
  expect(indent - parent).toBeGreaterThanOrEqual(16);
});

// Keybindings' Bound only (the buckets, the tooltip, the persisted choice): unit-tested in src/components/settings/SettingsPage.test.tsx.

// The search (results, crumbs, nav counts, Escape, nav while searching): unit-tested in src/components/settings/SettingsPage.test.tsx.

// The dark and light theme rows (the field's options, the pick saved, Choose…):
// src/components/settings/SettingRow.test.tsx; the per-scheme lists: internal/store/settings
// theme_test.go; the slots on html[data-theme] and the dark class: src/stores/settings.test.ts and
// src/lib/theme.test.ts.

// A bool saving (toast), Light/Dark on html.dark, an out-of-range number refused inline and the restart badge: src/components/settings/SettingsPage.test.tsx ("a bool saves and says so…"), src/stores/settings.test.ts ("applies theme…") and src/lib/theme.test.ts. An enum saving is the keyboard test below.

test("an enum select works from the keyboard", async ({ page }) => {
  await openSettings(page, "appearance");
  const trigger = select(page, "appearance.thread_width");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const list = listbox(page);
  await expect(list).toBeVisible();
  // The selected item has the focus; ArrowDown moves to the next and Enter picks it.
  await expect(list.getByRole("option", { name: "Comfortable (default)" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  // Radix moves the focus in a timeout; Enter picks whichever option has it.
  await expect(list.getByRole("option", { name: "Full" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(trigger).toHaveAttribute("data-value", "full");
  await expect(trigger).toBeFocused();
  await expect.poll(async () => (await mockSettings()).raw["appearance.thread_width"]).toBe("full");
  // Escape on the closed trigger leaves the page open, as on a field.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-page")).toBeVisible();
});

// A number reverting on Escape and committing on Enter: unit-tested in src/components/settings/SettingsPage.test.tsx.

// The backdrop gallery: unit-tested in src/components/settings/BackdropEditor.test.tsx.

// appearance.thread_width on html[data-thread-width]: unit-tested in src/stores/settings.test.ts.

// The reserved chord's message, the daemon's collision refusal shown, a valid chord saved and
// Escape cancelling a recording before it closes the sheet: src/components/settings/SettingsPage.test.tsx
// ("the recorder…"); the collision rule: internal/store/settings.
test("a recording recorder swallows cmd+k before the global keymap; the new chord reaches the palette", async ({ page }) => {
  await openSettings(page, "keybindings");
  const recorder = setting(page, "keybindings.thread.new").getByRole("button", { name: /shortcut/ });
  await recorder.click();
  await page.keyboard.press("Meta+k");
  await expect(setting(page, "keybindings.thread.new").getByTestId("setting-error")).toHaveText("cmd+k is reserved by the app");
  await expect(page.getByTestId("palette")).toHaveCount(0);

  await recorder.click();
  await page.keyboard.press("Meta+Shift+y");
  await expect(recorder).toHaveText("⇧⌘Y");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-sheet")).toHaveCount(0);
  // CommandService.List reports the override: the palette shows the new chord.
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette").locator('[data-command="thread.new"]')).toContainText("⇧⌘Y");
});

// Hand edits reaching the open page and a file that does not parse: src/components/settings/SettingsPage.test.tsx;
// density on html[data-density]: src/stores/settings.test.ts.
test("cmd+= zooms the whole page (CSS zoom on <html>) and saves it; cmd+0 resets", async ({ page }) => {
  await openSettings(page, "appearance");
  await page.keyboard.press("Meta+Equal");
  await expect(page.locator("html")).toHaveCSS("zoom", "1.1");
  await expect.poll(async () => (await mockSettings()).raw["appearance.zoom"]).toBe("110");
  await page.keyboard.press("Meta+Digit0");
  await expect(page.locator("html")).toHaveCSS("zoom", "1");
  await expect.poll(async () => (await mockSettings()).raw["appearance.zoom"]).toBeUndefined();
});

// Open settings file in Finder: unit-tested in src/components/settings/SettingsPage.test.tsx.

// cmd+/, the guide tab and Escape: help.spec.ts. The guide's wording, the App section's chords and a command's chord: src/components/help/HelpOverlay.test.tsx; no thread.close or thread.reconnect: internal/command/commands_thread_lifecycle_test.go.

// ShowView settings, thread.next and help: unit-tested in src/stores/intents.test.ts.

// Remove in the row menu and the confirm dialog: unit-tested in src/components/sidebar/RowMenu.test.tsx and src/components/confirm/ConfirmDialog.test.tsx.
