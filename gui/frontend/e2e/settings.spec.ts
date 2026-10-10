import { expect, test, type Page } from "@playwright/test";
import { emit, invocations, mockPost, mockUrl, openApp, resetMock, row, selectWorktree } from "./fixtures";

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

test("cmd+, opens settings rendered from the schema", async ({ page }) => {
  const settings = await openSettings(page);
  for (const title of ["Sessions", "GitHub", "Repositories", "Appearance", "Keybindings", "Advanced"]) {
    await expect(settings.getByRole("heading", { name: title, exact: true })).toBeVisible();
  }
  await expect(setting(page, "appearance.font_size").getByRole("spinbutton")).toHaveValue("13");
  await expect(setting(page, "sessions.default_model").getByRole("combobox")).toHaveValue("opus");
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

test("changing a bool and an enum saves to the file and applies live", async ({ page }) => {
  await openSettings(page);
  const autoName = setting(page, "sessions.auto_name").getByRole("switch");
  await expect(autoName).toHaveAttribute("aria-checked", "true");
  await autoName.click();
  await expect(autoName).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Saved Name sessions automatically")).toBeVisible();
  await expect.poll(async () => (await mockSettings()).raw["sessions.auto_name"]).toBe("false");

  await setting(page, "appearance.theme").getByRole("combobox").selectOption("light");
  await expect.poll(async () => (await mockSettings()).raw["appearance.theme"]).toBe("light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await setting(page, "appearance.theme").getByRole("combobox").selectOption("dark");
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
  await selectWorktree(page, "repo-cf", `/Users/dev/src/code-foundry`);
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

  // cmd+= saves the font size to the file.
  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => (await mockSettings()).raw["appearance.font_size"]).toBe("14");
});

test("reveal settings file runs settings.reveal", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("reveal-settings").click();
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("settings.reveal");
});

test("cmd+/ opens the help overlay listing commands and app chords", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Slash");
  const help = page.getByTestId("help-overlay");
  await expect(help).toBeVisible();
  await expect(help.getByRole("heading", { name: "How code-foundry works" })).toBeVisible();
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
  await row(page, "t:t-logs").click();
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await emit({ showView: { name: "help" } });
  await expect(page.getByTestId("help-overlay")).toBeVisible();
});

test("destructive commands ask first; cancel keeps, confirm runs", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click();
  const remove = page.getByTestId("remove-session");
  await remove.click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Remove session s-3?");
  await dialog.getByTestId("confirm-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "s:s-3")).toBeVisible();
  let calls = (await invocations()).filter((i) => i.name === "session.remove");
  expect(calls.map((c) => (c as { confirmed?: boolean }).confirmed)).toEqual([false]);

  await remove.click();
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm-ok").click();
  await expect(row(page, "s:s-3")).toHaveCount(0);
  calls = (await invocations()).filter((i) => i.name === "session.remove");
  expect(calls.map((c) => (c as { confirmed?: boolean }).confirmed)).toEqual([false, false, true]);
});
