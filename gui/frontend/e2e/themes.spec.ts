import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { componentValues, resolveSlots, type ThemeFile } from "../src/themes/slots";
import { mockUrl, openApp, resetMock } from "./fixtures";

// The Themes page (theme.pick, docs/notes/theme-engine-4-picker.md). The mock starts on the
// defaults: scheme system (the browser is dark, playwright.config), GitHub Dark and Light.
// The user's own themes (the Yours section) are e2e/user-themes.spec.ts.

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

// Choose… opening the page on its slot, the scheme's themes, the in-use badge, back to Settings: unit-tested in src/components/themes/ThemesPage.test.tsx.

// The preview's name, Back to current, Apply disabled until a preview, the row marked current, the
// saved slot, no companion for Dracula: src/components/themes/ThemesPage.test.tsx ("previewing paints…").
test("a previewed theme paints the gallery, not the window; Apply paints the window", async ({ page }) => {
  await openFromSettings(page, "dark");
  await option(page, "Dracula").click();
  await expect(scope(page)).toHaveAttribute("data-theme", "dracula");
  // The gallery's pane is Dracula's; the window keeps GitHub Dark's.
  const pane = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).getPropertyValue("--pane").trim());
  expect(await pane('[data-testid="gallery-thread"]')).toBe(themeById.get("dracula")?.vars["--pane"]);
  expect(await pane("html")).toBe(themeById.get("github-dark")?.vars["--pane"]);
  await expect(html(page)).toHaveAttribute("data-theme", "github-dark");
  await page.getByTestId("themes-apply").click();
  await expect(html(page)).toHaveAttribute("data-theme", "dracula");
  expect(await pane("html")).toBe(themeById.get("dracula")?.vars["--pane"]);
});

// Escape discarding the preview and the next visit starting from the applied theme: src/components/themes/ThemesPage.test.tsx ("Escape drops the preview and goes back to Settings…").

// The companion suggested after Apply, accepted or dismissed: src/components/themes/ThemesPage.test.tsx ("previewing paints the gallery's scope…; a companion is suggested, accepted or dismissed").

// Arrows previewing, Enter applying, / searching, Escape clearing then closing:
// src/components/themes/ThemesPage.test.tsx ("the keyboard…").
test("opened from the palette the list has the keyboard: real arrows preview and Enter applies to the window", async ({ page }) => {
  await openFromPalette(page);
  await expect(page.getByTestId("themes-list")).toBeFocused();
  const dark = themesFor("dark");
  await page.keyboard.press("ArrowDown");
  await expect(scope(page)).toHaveAttribute("data-theme", dark[1]?.id ?? "");
  await page.keyboard.press("Enter");
  await expect(html(page)).toHaveAttribute("data-theme", dark[1]?.id ?? "");
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: "Search themes" })).toBeFocused();
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

// The saved appearance.theme, the "in use" badge and the scheme note: src/components/themes/ThemesPage.test.tsx
// ("the scheme control saves appearance.theme").
test("the scheme control: Light paints the window light; System follows the browser's dark", async ({ page }) => {
  await openFromPalette(page);
  await page.getByTestId("themes-scheme").getByRole("radio", { name: "Light" }).click();
  await expect(html(page)).toHaveAttribute("data-theme", "github-light");
  await page.getByTestId("themes-scheme").getByRole("radio", { name: "System" }).click();
  await expect(html(page)).toHaveAttribute("data-theme", "github-dark");
});

// ShowView themes.light opening the page on the light slot, closing from nowhere not going to
// Settings: src/stores/themePicker.test.ts; the slot selects without " (default)" and Browse themes
// opening on the slot in use and coming back to Settings: src/components/settings/SettingRow.test.tsx.
