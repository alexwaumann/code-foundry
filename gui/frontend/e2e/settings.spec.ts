import { expect, test, type Page } from "@playwright/test";
import { emit, invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

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

async function openSettings(page: Page) {
  await openApp(page);
  // cmd+, is view.settings's registry chord; a chord pressed before the command list
  // arrives is looked up again once it does (keys/bindings.ts).
  await page.keyboard.press("Meta+Comma");
  const settings = page.getByTestId("settings-page");
  await expect(settings).toBeVisible();
  await expect(settings.locator("[data-setting]").first()).toBeVisible();
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

test("cmd+, opens settings rendered from the schema", async ({ page }) => {
  const settings = await openSettings(page);
  for (const title of ["Sessions", "GitHub", "Repositories", "Appearance", "Keybindings", "Advanced"]) {
    await expect(settings.getByRole("heading", { name: title, exact: true })).toBeVisible();
  }
  await expect(setting(page, "appearance.font_size").getByRole("spinbutton")).toHaveValue("13");
  await expect(select(page, "sessions.default_model")).toHaveAttribute("data-value", "claude-opus-4-8[1m]");
  await expect(select(page, "sessions.default_model")).toHaveText("Opus 4.8 (default)");
  // The model registry's labels; the setting's own default is marked.
  await expectOptions(page, "sessions.default_model", [
    "Opus 5.5",
    "Opus 4.8 (default)",
    "Opus 4.7",
    "Sonnet 5.5",
    "Sonnet 5",
    "Sonnet 4.6",
    "Haiku 5.5",
    "Haiku 4.5",
  ]);
  // Where new threads work: a dropdown with plain-language labels, a fresh copy by default.
  await expect(setting(page, "sessions.default_worktree")).toContainText("New threads work in");
  await expect(select(page, "sessions.default_worktree")).toHaveAttribute("data-value", "new");
  await expectOptions(page, "sessions.default_worktree", ["A fresh copy of the project (default)", "The project folder itself"]);
  // The naming model is its own live setting, defaulting to Sonnet 5.
  await expect(select(page, "sessions.naming_model")).toHaveAttribute("data-value", "claude-sonnet-5[1m]");
  await expect(select(page, "sessions.naming_model")).toHaveText("Sonnet 5 (default)");
  await expect(setting(page, "sessions.naming_model").getByTestId("restart-hint")).toHaveCount(0);
  // Every thread is rendered: no view setting (the schema has none).
  await expect(setting(page, "sessions.render")).toHaveCount(0);
  // Restart-required fields say so; live ones do not.
  await expect(setting(page, "sessions.scrollback_lines").getByTestId("restart-hint")).toBeVisible();
  await expect(setting(page, "appearance.theme").getByTestId("restart-hint")).toHaveCount(0);
  // One keybinding field per registry command, with its default chord.
  await expect(setting(page, "keybindings.session.new").getByRole("button", { name: /shortcut/ })).toHaveText("⌘N");
  await expect(page.getByTestId("settings-path")).toContainText("settings.toml");

  // Search narrows the form.
  await settings.getByRole("searchbox", { name: "Search settings" }).fill("font");
  await expect(setting(page, "appearance.font_size")).toBeVisible();
  await expect(setting(page, "appearance.font_family")).toBeVisible();
  await expect(setting(page, "sessions.auto_name")).toHaveCount(0);

  // Escape (outside a field) closes the page.
  await settings.getByRole("searchbox", { name: "Search settings" }).fill("");
  await page.getByRole("heading", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
});

test("the dark and light theme rows offer their scheme's themes and apply live", async ({ page }) => {
  await openSettings(page);
  await pick(page, "appearance.theme", "Dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "catppuccin-mocha");
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

test("changing a bool and an enum saves to the file and applies live", async ({ page }) => {
  await openSettings(page);
  const autoName = setting(page, "sessions.auto_name").getByRole("switch");
  await expect(autoName).toHaveAttribute("aria-checked", "true");
  await autoName.click();
  await expect(autoName).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Saved Name sessions automatically")).toBeVisible();
  await expect.poll(async () => (await mockSettings()).raw["sessions.auto_name"]).toBe("false");

  await pick(page, "appearance.theme", "Light");
  await expect.poll(async () => (await mockSettings()).raw["appearance.theme"]).toBe("light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await pick(page, "appearance.theme", "Dark");
  await expect(page.locator("html")).toHaveClass(/dark/);

  // An out-of-range number is rejected inline and not saved.
  const size = setting(page, "appearance.font_size").getByRole("spinbutton");
  await size.fill("99");
  await size.press("Enter");
  await expect(setting(page, "appearance.font_size").getByTestId("setting-error")).toHaveText("Want 9 to 28");
  expect((await mockSettings()).raw["appearance.font_size"]).toBeUndefined();

  // The restart-required field shows a pending badge once changed.
  const scroll = setting(page, "sessions.scrollback_lines").getByRole("spinbutton");
  await scroll.fill("20000");
  await scroll.press("Enter");
  await expect(setting(page, "sessions.scrollback_lines").getByTestId("restart-pending")).toBeVisible();
});

test("an enum select works from the keyboard and its list is themed", async ({ page }) => {
  await openSettings(page);
  const trigger = select(page, "appearance.thread_width");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const list = listbox(page);
  await expect(list).toBeVisible();
  // Drawn with the popover tokens, under its trigger and as wide (once the zoom-in is done).
  await list.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const box = await list.boundingBox();
  const tbox = await trigger.boundingBox();
  if (!box || !tbox) throw new Error("no boxes");
  expect(box.y).toBeGreaterThanOrEqual(tbox.y + tbox.height);
  expect(box.x).toBeCloseTo(tbox.x, 0);
  expect(box.width).toBeCloseTo(tbox.width, 0);
  const bg = await page.locator('[data-slot="select-content"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  const popover = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "bg-popover";
    document.body.append(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  });
  expect(bg).toBe(popover);
  // The selected item has the focus; ArrowDown moves to the next and Enter picks it.
  await expect(list.getByRole("option", { name: "comfortable (default)" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  // Radix moves the focus in a timeout; Enter picks whichever option has it.
  await expect(list.getByRole("option", { name: "full" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(trigger).toHaveAttribute("data-value", "full");
  await expect(trigger).toBeFocused();
  await expect.poll(async () => (await mockSettings()).raw["appearance.thread_width"]).toBe("full");
  // Escape on the closed trigger leaves the page open, as on a field.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-page")).toBeVisible();
});

test("a text setting reverts on Escape and commits on Enter", async ({ page }) => {
  await openSettings(page);
  const size = setting(page, "appearance.font_size").getByRole("spinbutton");
  await size.fill("15");
  await size.press("Escape");
  await expect(size).toHaveValue("13");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  expect((await mockSettings()).raw["appearance.font_size"]).toBeUndefined();
  await size.fill("15");
  await size.press("Enter");
  await expect.poll(async () => (await mockSettings()).raw["appearance.font_size"]).toBe("15");
});

test("appearance.thread_width sets data-thread-width on <html>, live", async ({ page }) => {
  await openSettings(page);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-thread-width", "comfortable");
  await expect(select(page, "appearance.thread_width")).toHaveAttribute("data-value", "comfortable");
  await pick(page, "appearance.thread_width", "full");
  await expect.poll(async () => (await mockSettings()).raw["appearance.thread_width"]).toBe("full");
  await expect(html).toHaveAttribute("data-thread-width", "full");
  await pick(page, "appearance.thread_width", "compact");
  await expect(html).toHaveAttribute("data-thread-width", "compact");
  // A hand edit back to the default.
  await mockPost("settings/external?appearance.thread_width=");
  await expect(html).toHaveAttribute("data-thread-width", "comfortable");
});

test("a keybinding override rejects a reserved chord and applies a valid one", async ({ page }) => {
  await openSettings(page);
  const recorder = setting(page, "keybindings.session.new").getByRole("button", { name: /shortcut/ });
  await recorder.click();
  await page.keyboard.press("Meta+k");
  await expect(setting(page, "keybindings.session.new").getByTestId("setting-error")).toHaveText("cmd+k is reserved by the app");
  // Recording swallowed the chord: the palette did not open.
  await expect(page.getByTestId("palette")).toHaveCount(0);
  expect((await mockSettings()).raw["keybindings.session.new"]).toBeUndefined();

  // Colliding with another command's chord is rejected by the daemon.
  await recorder.click();
  await page.keyboard.press("Meta+t");
  await expect(setting(page, "keybindings.session.new").getByTestId("setting-error")).toContainText("already bound to terminal.new");

  await recorder.click();
  await page.keyboard.press("Meta+Shift+y");
  await expect(recorder).toHaveText("⇧⌘Y");
  await expect.poll(async () => (await mockSettings()).raw["keybindings.session.new"]).toBe("cmd+shift+y");

  // CommandService.List reports the override: the palette shows the new chord.
  await page.keyboard.press("Escape");
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette").locator('[data-command="session.new"]')).toContainText("⇧⌘Y");
});

test("hand edits to the file update the open page and the terminal font", async ({ page }) => {
  await openSettings(page);
  await mockPost("settings/external?appearance.font_size=18&appearance.density=comfortable");
  await expect(setting(page, "appearance.font_size").getByRole("spinbutton")).toHaveValue("18");
  await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");

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

test("reveal settings file runs settings.reveal", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("reveal-settings").click();
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("settings.reveal");
});

test("the alert volume is a slider saved per step, with Play running notifications.test", async ({ page }) => {
  await openSettings(page);
  const row = setting(page, "notifications.sound_volume");
  const thumb = row.getByRole("slider", { name: "Alert volume" });
  await expect(thumb).toHaveAttribute("aria-valuenow", "50");
  await thumb.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(row.getByTestId("volume-value")).toHaveText("48%");
  await expect.poll(async () => (await mockSettings()).raw["notifications.sound_volume"]).toBe("48");
  await expect(thumb).toBeFocused();
  await row.getByRole("button", { name: "Play alert sound" }).click();
  await expect.poll(async () => (await invocations()).at(-1)).toMatchObject({ name: "notifications.test", args: { volume: "48" } });
});

test("cmd+/ opens the help overlay; its shortcuts tab lists commands and app chords", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Slash");
  const help = page.getByTestId("help-overlay");
  await expect(help).toBeVisible();
  await expect(page.getByTestId("help-tab-guide")).toHaveAttribute("data-state", "active");
  // Threads never need closing or reconnecting: a message always continues one.
  await expect(page.getByTestId("help-guide")).toContainText("a thread keeps its history, and a message always continues it.");
  await expect(help).not.toContainText(/disconnected|Reconnect/);
  await page.getByTestId("help-tab-shortcuts").click();
  await expect(help.locator('[data-help-command="session.close"], [data-help-command="session.reconnect"]')).toHaveCount(0);
  await expect(help.locator('[data-help-section="App"]')).toContainText("Command palette");
  await expect(help.locator('[data-help-section="App"]')).toContainText("⌘K");
  // Registry commands with their effective chords, grouped by category; unavailable
  // ones (session.new without a worktree) are still listed.
  await expect(help.locator('[data-help-command="session.new"]')).toContainText("⌘N");
  await expect(help.locator('[data-help-command="terminal.new"]')).toContainText("⌘T");
  await expect(help.locator('[data-help-command="view.settings"]')).toContainText("⌘,");
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});

test("ShowView intents from the daemon open settings and help", async ({ page }) => {
  await openApp(page);
  expect(await emit({ showView: { name: "settings" } })).toBe(1);
  await expect(page.getByTestId("settings-page")).toBeVisible();
  // Selecting something in the sidebar leaves the page.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await emit({ showView: { name: "help" } });
  await expect(page.getByTestId("help-overlay")).toBeVisible();
});

test("destructive commands ask first; cancel keeps, confirm runs", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click();
  // The thread row's menu: Remove… (session.remove).
  const remove = async () => {
    await row(page, "s:s-3").click({ button: "right" });
    await page.getByTestId("row-menu").getByText("Remove…").click();
  };
  await remove();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Remove session s-3?");
  await dialog.getByTestId("confirm-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "s:s-3")).toBeVisible();
  let calls = (await invocations()).filter((i) => i.name === "session.remove");
  expect(calls.map((c) => (c as { confirmed?: boolean }).confirmed)).toEqual([false]);

  await remove();
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm-ok").click();
  await expect(row(page, "s:s-3")).toHaveCount(0);
  calls = (await invocations()).filter((i) => i.name === "session.remove");
  expect(calls.map((c) => (c as { confirmed?: boolean }).confirmed)).toEqual([false, false, true]);
});
