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

test("the theme card shows the saved theme; Undo puts the slot back and turns into Undone; Edit opens the editor", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await mockPost("thread?state=theme");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByTestId("thread-theme-name")).toHaveText("Ocean Dusk");
  await expect(card(page)).toContainText("dark · from Catppuccin Mocha");
  await expect(card(page).getByTestId("thread-theme-applied")).toHaveText("applied");
  await expect(card(page).getByTestId("thread-theme-swatches").locator("span")).toHaveCount(9);
  // The canvas swatch is the file's canvas, not the window's.
  await expect(card(page).getByTestId("thread-theme-swatches").locator("span").first()).toHaveCSS("background-color", "rgb(11, 20, 28)");
  await expect(card(page).getByTestId("thread-theme-summary")).toHaveText(/^1 pinned · (contrast ok|\d+ contrast issues?)$/);
  // The card stays when its turn is folded (every finished turn is).
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ocean-dusk");
  await shot(page, "theme-card", () => page.getByTestId("thread-pane"));

  const undo = card(page).getByTestId("thread-theme-undo");
  await expect(undo).toHaveText("Undo");
  await undo.click();
  await expect.poll(() => raw("appearance.theme_dark")).toBe("catppuccin-mocha");
  await expect(undo).toHaveText("Undone");
  await expect(undo).toBeDisabled();
  await expect(invocations()).resolves.toContainEqual(expect.objectContaining({ name: "theme.set-dark", args: { theme: "catppuccin-mocha" } }));

  await card(page).getByTestId("thread-theme-edit").click();
  await expect(page.getByTestId("theme-inspector")).toBeVisible();
  await expect(page.getByTestId("themes-editing-name")).toHaveText("Ocean Dusk");
});

test("a theme a thread applies shows a toast with Edit and Undo, except over the Themes page", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openApp(page);
  await row(page, "s:s-1").click();
  await mockPost("themes/card?thread=s-1&theme=ocean-dusk&apply=true");
  const toast = toastOf(page, "Ocean Dusk applied to dark");
  await expect(toast).toBeVisible();
  await expect(toast.getByRole("button")).toHaveText(["Edit", "Undo"]);
  await expect.poll(() => raw("appearance.theme_dark")).toBe("ocean-dusk");
  await shot(page, "theme-toast", () => toast);
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => raw("appearance.theme_dark")).toBe("github-dark");
  await expect(toast).toHaveCount(0);

  // The thread got its card (s-1 is the selected thread).
  await expect(card(page)).toHaveCount(1);
  await expect(card(page).getByTestId("thread-theme-undo")).toHaveText("Undone");

  // Over the Themes page, which shows the change already: no toast.
  await openThemes(page);
  await mockPost("themes/card?thread=s-1&theme=ocean-dusk&apply=true");
  await expect.poll(() => raw("appearance.theme_dark")).toBe("ocean-dusk");
  await page.waitForTimeout(400);
  await expect(toastOf(page, "Ocean Dusk applied to dark")).toHaveCount(0);

  // A save the slot does not show (not applied) toasts nothing either, anywhere.
  await page.keyboard.press("Escape");
  await mockPost("themes/card?thread=s-1&theme=latte-softer");
  await page.waitForTimeout(400);
  await expect(toastOf(page, "Latte, softer")).toHaveCount(0);
});

test("Ask the model starts a no-project thread with the description and opens it", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openApp(page);
  await openThemes(page);
  await page.getByTestId("themes-ask").click();
  const pop = page.getByTestId("themes-ask-popover");
  await expect(pop).toBeVisible();
  const input = pop.getByTestId("themes-ask-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("placeholder", "Describe a theme… warm dark, teal accent, quieter sidebar");
  await expect(pop.getByTestId("themes-ask-send")).toBeDisabled();
  await input.fill("a dark theme that feels like a tide pool at night, teal accent, quieter sidebar than Mocha");
  await shot(page, "theme-ask", () => page.getByTestId("themes-page"));
  await input.press("Enter");
  await expect(pop).toHaveCount(0);
  await expect(page.getByTestId("themes-page")).toHaveCount(0);
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  const ask = (await invocations()).find((i) => i.name === "theme.ask");
  expect(ask?.args).toEqual({ description: "a dark theme that feels like a tide pool at night, teal accent, quieter sidebar than Mocha" });
  expect(ask?.context?.activeView).toBe("themes");
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

test("a card saved without applying offers Apply, which sets the slot and shows the badge", async ({ page }) => {
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

test("theme save from a thread prints the app's contrast check, theme check reads it again, and a pair-only save toasts nothing", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openApp(page);
  await row(page, "s:s-1").click();
  // Counts the "applied" toasts as they appear (a toast may expire before the next lands).
  await page.evaluate(() => {
    const w = window as unknown as { appliedToasts: number };
    w.appliedToasts = 0;
    const seen = new WeakSet<Element>();
    new MutationObserver(() => {
      for (const el of document.querySelectorAll("[data-sonner-toast]")) {
        if (seen.has(el) || !el.textContent.includes("Ocean Dusk applied to dark")) continue;
        seen.add(el);
        w.appliedToasts++;
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const toasts = () => page.evaluate(() => (window as unknown as { appliedToasts: number }).appliedToasts);
  const file = JSON.parse((await invoke("theme.show", { theme: "ocean-dusk" })).message ?? "{}") as { base: { surface: string }; overrides?: Record<string, string> };
  const fromThread = { activeThreadId: "s-1" };
  // A warning text pinned to the pane's own colour fails its pairs.
  const failing = { ...file, overrides: { ...file.overrides, "--cf-warning-text": file.base.surface } };
  const saved = await invoke("theme.save", { data: JSON.stringify(failing), apply: "true" }, fromThread);
  expect(saved.message).toMatch(/\ncontrast: \d+ issues — warning-text on surface 1\.00:1 \(needs 4\.5\)/);
  expect(saved.message).toContain("\nstale pins: 0\n");
  const checked = await invoke("theme.check", { theme: "ocean-dusk" });
  expect(checked.message).toMatch(/^Ocean Dusk \(ocean-dusk\), a dark theme\ncontrast: \d+ issues\n {2}warning-text on surface 1\.00:1 \(needs 4\.5\)\n/);

  // The fix: the pin goes, and the save says ok.
  const fixed = await invoke("theme.save", { data: JSON.stringify(file), apply: "true" }, fromThread);
  expect(fixed.message).toContain("\ncontrast: ok\nstale pins: 0\n");
  await expect.poll(toasts).toBe(2);
  // Only pair set: a card, but the slot shows the same colours, so no toast.
  await invoke("theme.save", { data: JSON.stringify({ ...file, pair: "latte-softer" }), apply: "true" }, fromThread);
  await expect(card(page)).toHaveCount(3);
  await page.waitForTimeout(400);
  expect(await toasts()).toBe(2);
});

// The one Undo rule (docs/notes/theme-fuzz-daemon.md): what the slot showed just before the
// save, only while the slot still shows the card's colours.
test("Undo hides once the slot moves on, is disabled when its theme is deleted, and a refinement's Undo restores the colours before", async ({ page }) => {
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
