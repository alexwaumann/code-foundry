import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

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

/** Opens an enum setting's select and lists its options, then closes it with Escape (which leaves the page open). */
async function expectOptions(page: Page, key: string, labels: string[]) {
  await select(page, key).click();
  await expect(listbox(page).getByRole("option")).toHaveText(labels);
  await page.keyboard.press("Escape");
  await expect(listbox(page)).toHaveCount(0);
  await expect(page.getByTestId("settings-page")).toBeVisible();
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

test("cmd+, opens settings on General; the nav switches pages, one at a time", async ({ page }) => {
  const settings = await openSettings(page);
  const nav = settings.getByRole("navigation", { name: "Settings pages" });
  await expect(nav.getByRole("button")).toHaveText(["General", "Appearance", "Notifications", "Source control", "Ember", "Keybindings", "Advanced", "Plugins", "Skills", "Memory"]);
  await expect(page.getByTestId("settings-nav-general")).toHaveAttribute("aria-current", "page");
  await expect(settings.getByRole("heading", { name: "General", level: 2 })).toBeVisible();
  // General's sections, each a card; only this page's fields render.
  await expect(settings.getByTestId("settings-section").locator("h3")).toHaveText(["Threads", "Text generation", "Lifecycle", "Dictation", "Updates"]);
  await expect(setting(page, "appearance.font_size")).toHaveCount(0);
  // The raw key is not shown under a row any more.
  await expect(setting(page, "threads.auto_name").getByTestId("setting-key")).toHaveCount(0);
  await expect(setting(page, "threads.auto_name")).not.toContainText("threads.auto_name");

  await expect(select(page, "threads.default_model")).toHaveAttribute("data-value", "claude-sonnet-5[1m]");
  // The trigger names the value alone; the list marks the setting's own default.
  await expect(select(page, "threads.default_model")).toHaveText("Sonnet 5", { useInnerText: true });
  await expect(select(page, "threads.default_effort")).toHaveAttribute("data-value", "medium");
  await expectOptions(page, "threads.default_model", [
    "Opus 5.5",
    "Opus 4.8",
    "Opus 4.7",
    "Sonnet 5.5",
    "Sonnet 5 (default)",
    "Sonnet 4.6",
    "Haiku 5.5",
    "Haiku 4.5",
  ]);
  // Where new threads work: a dropdown with plain-language labels, the project folder by default.
  await expect(setting(page, "threads.default_worktree")).toContainText("New threads work in");
  await expect(select(page, "threads.default_worktree")).toHaveAttribute("data-value", "current");
  await expectOptions(page, "threads.default_worktree", ["A fresh copy of the project", "The project folder itself (default)"]);
  // The naming model is its own live setting, defaulting to Sonnet 4.6.
  await expect(select(page, "threads.naming_model")).toHaveAttribute("data-value", "claude-sonnet-4-6[1m]");
  await expect(setting(page, "threads.naming_model").getByTestId("restart-hint")).toHaveCount(0);
  // Every thread is rendered: no view setting (the schema has none).
  await expect(setting(page, "threads.render")).toHaveCount(0);
  // A unit sits inside the number input.
  await expect(setting(page, "threads.cache_ttl_seconds").getByTestId("setting-unit")).toHaveText("s");
  await expect(setting(page, "threads.cache_ttl_seconds").getByRole("spinbutton")).toHaveValue("3600");
  await expect(page.getByTestId("settings-path")).toContainText("settings.toml");

  await goTo(page, "appearance");
  await expect(settings.getByRole("heading", { name: "Appearance", level: 2 })).toBeVisible();
  await expect(setting(page, "threads.auto_name")).toHaveCount(0);
  await expect(setting(page, "appearance.font_size").getByRole("spinbutton")).toHaveValue("13");
  await expect(setting(page, "appearance.font_size").getByTestId("setting-unit")).toHaveText("pt");
  // Restart-required fields say so; live ones do not. Scrollback shows under Terminal.
  await expect(settings.locator('[data-section="terminal"] [data-setting="threads.scrollback_lines"]').getByTestId("restart-hint")).toBeVisible();
  await expect(setting(page, "appearance.theme").getByTestId("restart-hint")).toHaveCount(0);

  await goTo(page, "keybindings");
  // One keybinding field per bindable registry command, with its default chord.
  await expect(setting(page, "keybindings.thread.new").getByRole("button", { name: /shortcut/ })).toHaveText("⌘N");

  // Leaving and coming back lands on General again.
  await page.keyboard.press("Meta+Comma");
  await expect(settings).toHaveCount(0);
  await page.keyboard.press("Meta+Comma");
  await expect(page.getByTestId("settings-nav-general")).toHaveAttribute("aria-current", "page");

  // Escape (outside a field) closes the page.
  await page.getByRole("heading", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
});

// Model and effort sharing a row: unit-tested in src/components/settings/SettingsPage.test.tsx.

test("a dependent row is indented under its toggle and dims while it is off; across sections it says why", async ({ page }) => {
  await openSettings(page);
  // Naming model (Text generation) depends on Name threads automatically (Threads).
  const naming = setting(page, "threads.naming_model");
  await expect(naming).not.toHaveAttribute("data-dimmed");
  await setting(page, "threads.auto_name").getByRole("switch").click();
  await expect(naming).toHaveAttribute("data-dimmed", "true");
  await expect(naming).toContainText("Not used while Name threads automatically is off.");
  // Dimmed, not disabled.
  await expect(select(page, "threads.naming_model")).toBeEnabled();

  await goTo(page, "notifications");
  const volume = setting(page, "notifications.sound_volume");
  const sound = setting(page, "notifications.sound");
  // Alert sound is off by default: the volume row sits indented under it, dimmed.
  await expect(volume).toHaveAttribute("data-dimmed", "true");
  await expect(volume).not.toContainText("Not used while");
  const v = await volume.boundingBox();
  const s = await sound.boundingBox();
  if (!v || !s) throw new Error("no boxes");
  const indent = (await volume.locator(".text-label").first().boundingBox())?.x ?? 0;
  const parent = (await sound.locator(".text-label").first().boundingBox())?.x ?? 0;
  expect(indent - parent).toBeGreaterThanOrEqual(16);
  await sound.getByRole("switch").click();
  await expect(volume).not.toHaveAttribute("data-dimmed");
});

// Keybindings' Bound only (the buckets, the tooltip, the persisted choice): unit-tested in src/components/settings/SettingsPage.test.tsx.

// The search (results, crumbs, nav counts, Escape, nav while searching): unit-tested in src/components/settings/SettingsPage.test.tsx.

test("the dark and light theme rows offer their scheme's themes and apply live", async ({ page }) => {
  await openSettings(page, "appearance");
  await pick(page, "appearance.theme", "Dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "github-dark");
  await pick(page, "appearance.theme_dark", "Dracula");
  await expect.poll(async () => (await mockSettings()).raw["appearance.theme_dark"]).toBe("dracula");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
  await expect(page.locator("html")).toHaveClass(/dark/);

  await select(page, "appearance.theme_light").click();
  await expect(listbox(page).getByRole("option", { name: "Rosé Pine Dawn", exact: true })).toBeVisible();
  await expect(listbox(page).getByRole("option", { name: "Dracula", exact: true })).toHaveCount(0);
  await listbox(page).getByRole("option", { name: "Rosé Pine Dawn", exact: true }).click();
  await expect.poll(async () => (await mockSettings()).raw["appearance.theme_light"]).toBe("rose-pine-dawn");
  // The dark scheme still shows Dracula; flipping the scheme shows the light slot.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
  await pick(page, "appearance.theme", "Light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "rose-pine-dawn");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

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

test("a keybinding override rejects a reserved chord and applies a valid one", async ({ page }) => {
  await openSettings(page, "keybindings");
  const recorder = setting(page, "keybindings.thread.new").getByRole("button", { name: /shortcut/ });
  await recorder.click();
  await page.keyboard.press("Meta+k");
  await expect(setting(page, "keybindings.thread.new").getByTestId("setting-error")).toHaveText("cmd+k is reserved by the app");
  // Recording swallowed the chord: the palette did not open.
  await expect(page.getByTestId("palette")).toHaveCount(0);
  expect((await mockSettings()).raw["keybindings.thread.new"]).toBeUndefined();

  // Colliding with another command's chord is rejected by the daemon.
  await recorder.click();
  await page.keyboard.press("Meta+t");
  await expect(setting(page, "keybindings.thread.new").getByTestId("setting-error")).toContainText("already bound to terminal.new");

  await recorder.click();
  await page.keyboard.press("Meta+Shift+y");
  await expect(recorder).toHaveText("⇧⌘Y");
  await expect.poll(async () => (await mockSettings()).raw["keybindings.thread.new"]).toBe("cmd+shift+y");

  // An idle recorder lets Escape close the sheet (only a recording one keeps it).
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-sheet")).toHaveCount(0);

  // CommandService.List reports the override: the palette shows the new chord.
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette").locator('[data-command="thread.new"]')).toContainText("⇧⌘Y");
});

test("hand edits to the file update the open page and the terminal font", async ({ page }) => {
  await openSettings(page, "appearance");
  // Comfortable is the default density; a hand edit to compact applies live.
  await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");
  await mockPost("settings/external?appearance.font_size=18&appearance.density=compact");
  await expect(setting(page, "appearance.font_size").getByRole("spinbutton")).toHaveValue("18");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");

  await mockPost("settings/external?loadError=toml%3A+line+2%3A+expected+%27%5D%27");
  await expect(page.getByTestId("settings-load-error")).toContainText("expected ']'");
  await mockPost("settings/external?appearance.font_size=");
  await expect(page.getByTestId("settings-load-error")).toHaveCount(0);
  await expect(setting(page, "appearance.font_size").getByRole("spinbutton")).toHaveValue("13");

  // cmd+= zooms the whole page (CSS zoom on <html>) and saves the zoom to the file.
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
