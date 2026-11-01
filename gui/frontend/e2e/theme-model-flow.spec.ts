import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * Asking the model for a theme (docs/notes/theme-model-flow.md). The mock's scripted thread
 * in its "theme" state (mock/thread.ts) made and applied the seeded Ocean Dusk (dark, from
 * Catppuccin Mocha, one pin) and shows its card, Undo back to Catppuccin Mocha; the dark
 * slot is on Ocean Dusk. POST /__mock/themes/card is theme save run from a thread (the card
 * and the toast). SHOTS=<dir> saves screenshots of the card, the toast and the popover in
 * both schemes.
 */

test.beforeEach(async () => {
  await resetMock();
});

async function raw(key: string): Promise<string | undefined> {
  const res = await fetch(`${mockUrl}/__mock/settings`);
  return ((await res.json()) as { raw: Record<string, string> }).raw[key];
}

const shots = process.env.SHOTS;
async function shot(page: Page, name: string, target: () => ReturnType<Page["getByTestId"]>): Promise<void> {
  if (!shots) return;
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await target().screenshot({ path: `${shots}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
}

const card = (page: Page) => page.getByTestId("thread-theme-card");
const toastOf = (page: Page, title: string) => page.locator("[data-sonner-toast]").filter({ hasText: title });

async function openThemes(page: Page) {
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId("choose-theme-dark").click();
  await expect(page.getByTestId("themes-page")).toBeVisible();
}

// The card's name, origin, applied badge, nine swatches, summary, Undo → Undone (theme.set-dark) and
// Edit (theme.edit): src/components/thread/ThemeCard.test.tsx.
test("the theme card's canvas swatch paints the file's colour; the window follows the slot, and Undo", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await mockPost("thread?state=theme");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(card(page)).toBeVisible();
  // The canvas swatch is the file's canvas, not the window's.
  await expect(card(page).getByTestId("thread-theme-swatches").locator("span").first()).toHaveCSS("background-color", "rgb(11, 20, 28)");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ocean-dusk");
  await shot(page, "theme-card", () => page.getByTestId("thread-pane"));
  await card(page).getByTestId("thread-theme-undo").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "catppuccin-mocha");
});

// The toast's Edit and Undo, and no toast over the Themes page: src/stores/intents.test.ts ("notify");
// its Undo: src/stores/notifyLinks.test.ts and src/stores/themeCards.test.ts (undoFromLink); no toast for
// a save not applied: the daemon's (internal/command/commands_theme_card_test.go).
test("screenshot: the toast a thread's applied theme shows", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only");
  await page.setViewportSize({ width: 1300, height: 900 });
  await openApp(page);
  await row(page, "s:s-1").click();
  await mockPost("themes/card?thread=s-1&theme=ocean-dusk&apply=true");
  const toast = toastOf(page, "Ocean Dusk applied to dark");
  await expect(toast).toBeVisible();
  await shot(page, "theme-toast", () => toast);
});

// theme.ask's args and context, the placeholder and the disabled Send: src/components/themes/ThemesPage.test.tsx ("Ask the model").
test("Ask the model: the popover's field takes the keyboard; Enter opens the new thread", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openApp(page);
  await openThemes(page);
  await page.getByTestId("themes-ask").click();
  const pop = page.getByTestId("themes-ask-popover");
  const input = pop.getByTestId("themes-ask-input");
  await expect(input).toBeFocused();
  await page.keyboard.type("a dark theme that feels like a tide pool at night, teal accent, quieter sidebar than Mocha");
  await shot(page, "theme-ask", () => page.getByTestId("themes-page"));
  await page.keyboard.press("Enter");
  await expect(pop).toHaveCount(0);
  await expect(page.getByTestId("themes-page")).toHaveCount(0);
  await expect(page.getByTestId("thread-pane")).toBeVisible();
});

// The save modal's Also make a light pair: unit-tested in src/components/themes/ThemesPage.test.tsx.

async function invoke(name: string, args: Record<string, string>, context: Record<string, string> | null = null): Promise<{ message?: string }> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name, args, ...(context ? { context } : {}), confirmed: true }),
  });
  expect(res.ok, await res.clone().text()).toBe(true);
  return (await res.json()) as { message?: string };
}

// Apply (the slot set, the badge instead) is src/components/thread/ThemeCard.test.tsx's ("a card saved
// without applying offers Apply…"); no toast for it is the daemon's (internal/command/commands_theme_card_test.go,
// "from the GUI: no card, no toast"). This keeps the card's screenshot.
test("a card saved without applying offers Apply, which sets the slot and shows the badge", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only");
  await page.setViewportSize({ width: 1300, height: 900 });
  await openApp(page);
  await row(page, "s:s-1").click();
  await mockPost("themes/card?thread=s-1&theme=latte-softer");
  const latte = card(page).filter({ hasText: "Latte, softer" });
  await expect(latte).toBeVisible();
  await expect(latte.getByTestId("thread-theme-applied")).toHaveCount(0);
  const apply = latte.getByTestId("thread-theme-apply");
  await expect(apply).toHaveText("Apply");
  await shot(page, "theme-card-apply", () => latte);
  await apply.click();
  await expect.poll(() => raw("appearance.theme_light")).toBe("latte-softer");
  await expect(latte.getByTestId("thread-theme-applied")).toHaveText("applied");
  await expect(apply).toHaveCount(0);
  await expect(invocations()).resolves.toContainEqual(expect.objectContaining({ name: "theme.set-light", args: { theme: "latte-softer" } }));
  // The toast rules are unchanged: an Apply on the card is the user's own act.
  await page.waitForTimeout(300);
  await expect(toastOf(page, "Latte, softer applied")).toHaveCount(0);
});

// theme.save from a thread printing the contrast check, theme.check reading it again, and which saves toast (a pair-only save none): the daemon's, internal/command/commands_theme_check_test.go (TestThemeSaveContrast, TestThemeCheck) and commands_theme_card_test.go (TestThemeSaveCardAndToast).

// The one Undo rule (docs/notes/theme-fuzz-daemon.md): what the slot showed just before the
// save, only while the slot still shows the card's colours.
// Every assertion here is src/components/thread/ThemeCard.test.tsx's ("Undo hides once the slot moves on…",
// "Undo is disabled, with why…") and src/stores/themeCards.test.ts's; this keeps the refinement's screenshot.
test("Undo hides once the slot moves on, is disabled when its theme is deleted, and a refinement's Undo restores the colours before", async ({ page }) => {
  test.skip(!shots, "SHOTS=<dir> only");
  await page.setViewportSize({ width: 1300, height: 900 });
  await openApp(page);
  await row(page, "s:s-1").click();
  await mockPost("themes/card?thread=s-1&theme=ocean-dusk&apply=true");
  const first = card(page).first();
  const undo = first.getByTestId("thread-theme-undo");
  await expect(undo).toHaveText("Undo");
  // The user picks another theme by hand: the card's Undo would replace it, so it goes.
  await invoke("theme.set-dark", { theme: "nord" });
  await expect(undo).toHaveCount(0);
  // Back on the card's theme: Undo again.
  await invoke("theme.set-dark", { theme: "ocean-dusk" });
  await expect(undo).toHaveText("Undo");
  await expect(undo).toBeEnabled();

  // A refinement of the theme in use: its Undo restores the colours it replaced, and the
  // earlier card hides (the slot no longer shows its colours).
  await mockPost(`themes/recolour?thread=s-1&theme=ocean-dusk&accent=${encodeURIComponent("#e0a060")}`);
  await expect(card(page)).toHaveCount(2);
  const second = card(page).nth(1);
  const undo2 = second.getByTestId("thread-theme-undo");
  await expect(undo2).toHaveText("Undo");
  await expect(undo).toHaveCount(0);
  await shot(page, "theme-card-undo-refinement", () => second);
  await undo2.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Undo restores the previous colours");
  await undo2.click();
  await expect(undo2).toHaveText("Undone");
  await expect(invocations()).resolves.toContainEqual(expect.objectContaining({ name: "theme.restore" }));
  // The first card's colours are back: its Undo (to GitHub Dark) is offered again.
  await expect(undo).toHaveText("Undo");

  // The theme it goes back to is deleted: disabled, with why.
  await invoke("theme.duplicate", { theme: "nord", name: "Nord, mine" });
  await invoke("theme.set-dark", { theme: "nord-copy" });
  await mockPost("themes/card?thread=s-1&theme=ocean-dusk&apply=true");
  const third = card(page).nth(2);
  await invoke("theme.delete", { theme: "nord-copy" });
  const undo3 = third.getByTestId("thread-theme-undo");
  await expect(undo3).toBeDisabled();
  await expect(undo3).toHaveAttribute("data-undo", "gone");
  await third.getByTestId("thread-theme-undo-tip").hover();
  await expect(page.getByRole("tooltip")).toHaveText("nord-copy was deleted");
  await shot(page, "theme-card-undo-gone", () => third);
});
