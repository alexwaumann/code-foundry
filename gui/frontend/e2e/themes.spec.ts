import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { componentValues, resolveSlots, type ThemeFile } from "../src/themes/slots";
import { emit, mockUrl, openApp, resetMock } from "./fixtures";

// The Themes page (theme.pick, docs/notes/theme-engine-4-picker.md). The mock starts on the
// defaults: scheme system (the browser is dark, playwright.config), GitHub Dark and Light.

// The generated catalog, read as a file: Playwright's loader refuses a JSON import without
// an import attribute, which src/themes (bundled by Vite) does not carry. Its entries are
// theme files; the values the page shows are resolved by the same rules (src/themes/slots.ts).
const files = JSON.parse(fs.readFileSync(new URL("../src/themes/catalog.json", import.meta.url), "utf8")) as ThemeFile[];
const catalog = files.map((t) => {
  const slots = resolveSlots(t);
  return { ...t, vars: { ...slots, ...componentValues(slots) } };
});
const themeById = new Map(catalog.map((t) => [t.id, t]));
const themesFor = (scheme: "dark" | "light") => catalog.filter((t) => t.scheme === scheme);

test.beforeEach(async () => {
  await resetMock();
});

async function raw(key: string): Promise<string | undefined> {
  const res = await fetch(`${mockUrl}/__mock/settings`);
  return ((await res.json()) as { raw: Record<string, string> }).raw[key];
}

const page$ = (page: Page) => page.getByTestId("themes-page");
const scope = (page: Page) => page.getByTestId("theme-scope");
const option = (page: Page, name: string) => page.getByTestId("themes-list").getByRole("option", { name, exact: true });
const html = (page: Page) => page.locator("html");

async function openFromSettings(page: Page, slot: "dark" | "light") {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId(`choose-theme-${slot}`).click();
  await expect(page$(page)).toBeVisible();
  await expect(page.getByTestId(`themes-slot-${slot}`)).toHaveAttribute("aria-pressed", "true");
}

async function openFromPalette(page: Page) {
  await openApp(page);
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await palette.locator('[data-command="theme.pick"]').click();
  await expect(palette).toHaveCount(0);
  await expect(page$(page)).toBeVisible();
}

test("Choose… in Settings opens the page on that slot, listing only its scheme's themes", async ({ page }) => {
  await openFromSettings(page, "light");
  await expect(page.getByTestId("themes-list").getByTestId("theme-name")).toHaveText(themesFor("light").map((t) => t.name));
  await expect(option(page, "GitHub Light")).toHaveAttribute("data-current", "true");
  await page.getByTestId("themes-slot-dark").click();
  await expect(page.getByTestId("themes-list").getByTestId("theme-name")).toHaveText(themesFor("dark").map((t) => t.name));
  // The dark slot is the one in use (the browser is dark): the badge and the sentence say so.
  await expect(page.getByTestId("themes-slot-dark")).toContainText("in use");
  await expect(page.getByTestId("themes-slot-light")).not.toContainText("in use");
  await expect(page.getByTestId("themes-scheme-note")).toHaveText("Follows macOS: dark now, showing GitHub Dark");
  // The close button goes back to Settings, where it came from.
  await page.getByRole("button", { name: "Close themes" }).click();
  await expect(page$(page)).toHaveCount(0);
  await expect(page.getByTestId("settings-page")).toBeVisible();
});

test("a previewed theme paints the gallery, not the window; Apply paints the window and saves the slot", async ({ page }) => {
  await openFromSettings(page, "dark");
  await expect(html(page)).toHaveAttribute("data-theme", "github-dark");
  await expect(page.getByTestId("themes-apply")).toBeDisabled();

  await option(page, "Dracula").click();
  await expect(scope(page)).toHaveAttribute("data-theme", "dracula");
  await expect(page.getByTestId("themes-previewed-name")).toHaveText("Dracula");
  // The gallery's pane is Dracula's; the window keeps GitHub Dark's.
  const pane = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).getPropertyValue("--pane").trim());
  expect(await pane('[data-testid="gallery-thread"]')).toBe(themeById.get("dracula")?.vars["--pane"]);
  expect(await pane("html")).toBe(themeById.get("github-dark")?.vars["--pane"]);
  await expect(html(page)).toHaveAttribute("data-theme", "github-dark");
  expect(await raw("appearance.theme_dark")).toBeUndefined();

  // Back to current, then preview again and apply.
  await page.getByTestId("themes-reset").click();
  await expect(scope(page)).toHaveAttribute("data-theme", "github-dark");
  await expect(page.getByTestId("themes-apply")).toBeDisabled();
  await option(page, "Dracula").click();
  await page.getByTestId("themes-apply").click();
  await expect.poll(() => raw("appearance.theme_dark")).toBe("dracula");
  await expect(html(page)).toHaveAttribute("data-theme", "dracula");
  await expect(option(page, "Dracula")).toHaveAttribute("data-current", "true");
  await expect(page.getByTestId("themes-apply")).toBeDisabled();
  // Dracula has no light companion: no suggestion.
  await expect(page.getByTestId("themes-pair-hint")).toHaveCount(0);
});

test("Escape discards the preview and closes; the next visit starts from the applied theme", async ({ page }) => {
  await openFromSettings(page, "dark");
  await option(page, "Gruvbox Dark").click();
  await expect(scope(page)).toHaveAttribute("data-theme", "gruvbox-dark");
  await page.keyboard.press("Escape");
  await expect(page$(page)).toHaveCount(0);
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(html(page)).toHaveAttribute("data-theme", "github-dark");
  expect(await raw("appearance.theme_dark")).toBeUndefined();
  await page.getByTestId("choose-theme-dark").click();
  await expect(scope(page)).toHaveAttribute("data-theme", "github-dark");
});

test("after Apply, the companion theme is suggested for the other slot, and one click uses it", async ({ page }) => {
  await openFromSettings(page, "dark");
  await option(page, "Gruvbox Dark").click();
  await page.getByTestId("themes-apply").click();
  const hint = page.getByTestId("themes-pair-hint");
  await expect(hint).toContainText("Gruvbox Light is this theme’s light companion. Use it for light?");
  // Suggest only: the light slot is untouched until the button.
  expect(await raw("appearance.theme_light")).toBeUndefined();
  await page.getByTestId("themes-pair-accept").click();
  await expect.poll(() => raw("appearance.theme_light")).toBe("gruvbox-light");
  await expect(hint).toHaveCount(0);
  await expect(html(page)).toHaveAttribute("data-theme", "gruvbox-dark");

  // Applying GitHub Dark back: GitHub Light is not the light slot any more, so it is suggested; dismissed, it goes.
  await option(page, "GitHub Dark").click();
  await page.getByTestId("themes-apply").click();
  await expect(hint).toContainText("GitHub Light");
  await page.getByRole("button", { name: "Dismiss suggestion" }).click();
  await expect(hint).toHaveCount(0);
  expect(await raw("appearance.theme_light")).toBe("gruvbox-light");
});

test("the keyboard: arrows preview, Enter applies, / searches, Escape clears then closes", async ({ page }) => {
  await openFromPalette(page);
  await expect(page.getByTestId("themes-slot-dark")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("themes-list")).toBeFocused();
  const dark = themesFor("dark");
  await page.keyboard.press("ArrowDown");
  await expect(scope(page)).toHaveAttribute("data-theme", dark[1]?.id ?? "");
  await page.keyboard.press("ArrowDown");
  await expect(scope(page)).toHaveAttribute("data-theme", dark[2]?.id ?? "");
  await page.keyboard.press("ArrowUp");
  await expect(scope(page)).toHaveAttribute("data-theme", dark[1]?.id ?? "");
  await page.keyboard.press("Enter");
  await expect.poll(() => raw("appearance.theme_dark")).toBe(dark[1]?.id);
  await expect(html(page)).toHaveAttribute("data-theme", dark[1]?.id ?? "");

  await page.keyboard.press("/");
  const search = page.getByRole("searchbox", { name: "Search themes" });
  await expect(search).toBeFocused();
  await page.keyboard.type("nord");
  await expect(page.getByTestId("themes-list").getByTestId("theme-name")).toHaveText(["Nord"]);
  await page.keyboard.press("ArrowDown");
  await expect(scope(page)).toHaveAttribute("data-theme", "nord");
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page$(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page$(page)).toHaveCount(0);
  // Not applied: the window keeps the theme Enter applied.
  await expect(html(page)).toHaveAttribute("data-theme", dark[1]?.id ?? "");
});

test("a light preview inside the dark window renders with the light rules", async ({ page }) => {
  await openFromSettings(page, "light");
  await option(page, "Solarized Light").click();
  await expect(scope(page)).toHaveAttribute("data-theme", "solarized-light");
  await expect(scope(page)).toHaveClass(/\blight\b/);
  await expect(html(page)).toHaveClass(/\bdark\b/);
  const thread = page.getByTestId("gallery-thread");
  const t = themeById.get("solarized-light");
  // Every syntax colour is the scope's, not the window's dark aliases or its theme's patch.
  for (const k of ["--syn-kw", "--syn-com", "--syn-fn"])
    expect(await thread.evaluate((el, key) => getComputedStyle(el).getPropertyValue(key).trim(), k)).toBe(t?.vars[k]);
  // Text set by a type role is the preview's foreground, not the window's (the roles once
  // read Tailwind's --color-foreground, which resolves on :root).
  const rgb = (hex = "") => `rgb(${[1, 3, 5].map((i) => String(parseInt(hex.slice(i, i + 2), 16))).join(", ")})`;
  expect(await thread.locator(".cf-markdown p").first().evaluate((el) => getComputedStyle(el).color)).toBe(rgb(t?.vars["--foreground"]));
  // dark: utilities stay off: a shadcn Input is transparent in light (dark:bg-input/30 in dark).
  const input = scope(page).getByRole("textbox", { name: "Branch" });
  expect(await input.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
});

test("the scheme control writes appearance.theme and the slot in use follows", async ({ page }) => {
  await openFromPalette(page);
  await page.getByTestId("themes-scheme").getByRole("radio", { name: "Light" }).click();
  await expect.poll(() => raw("appearance.theme")).toBe("light");
  await expect(html(page)).toHaveAttribute("data-theme", "github-light");
  await expect(page.getByTestId("themes-slot-light")).toContainText("in use");
  await expect(page.getByTestId("themes-scheme-note")).toHaveText("Always light, showing GitHub Light");
  await page.getByTestId("themes-scheme").getByRole("radio", { name: "System" }).click();
  await expect.poll(() => raw("appearance.theme")).toBe("system");
  await expect(html(page)).toHaveAttribute("data-theme", "github-dark");
});

test("theme pick from the CLI (ShowView themes.light) opens the page on that slot; Settings' Browse themes row opens it too", async ({ page }) => {
  await openApp(page);
  await expect.poll(() => emit({ showView: { name: "themes.light" } })).toBeGreaterThan(0);
  await expect(page$(page)).toBeVisible();
  await expect(page.getByTestId("themes-slot-light")).toHaveAttribute("aria-pressed", "true");
  // Opened from nowhere, closing returns to the selection, not Settings.
  await page.getByRole("button", { name: "Close themes" }).click();
  await expect(page$(page)).toHaveCount(0);
  await expect(page.getByTestId("settings-page")).toHaveCount(0);

  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-appearance").click();
  // The slot selects name the theme whole: no " (default)" beside the Choose… button.
  for (const [key, name] of [["appearance.theme_dark", "GitHub Dark"], ["appearance.theme_light", "GitHub Light"]] as const)
    await expect(page.locator(`[data-setting="${key}"] [data-slot="select-trigger"]`)).toHaveText(name);
  await page.getByTestId("settings-themes-link").click();
  await expect(page$(page)).toBeVisible();
  await expect(page.getByTestId("themes-slot-dark")).toHaveAttribute("aria-pressed", "true");
  // Closing goes back to Settings on Appearance, where it came from.
  await page.getByRole("button", { name: "Close themes" }).click();
  await expect(page.getByTestId("settings-body")).toHaveAttribute("data-page", "appearance");
});
