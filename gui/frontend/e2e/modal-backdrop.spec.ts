import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

/** The open modal's backdrop: its colour and blur, read once the fade-in has settled. */
async function backdrop(page: Page): Promise<{ background: string; filter: string }> {
  const overlay = page.locator('[data-slot="dialog-overlay"]');
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toHaveCSS("opacity", "1");
  return overlay.evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, filter: s.backdropFilter || s.getPropertyValue("-webkit-backdrop-filter") };
  });
}

// The palette and help share Dialog's backdrop (docs/notes/modal-backdrop.md): the theme's
// --cf-scrim (black at 50% dark, 30% light) over a fixed 1px blur. Headless WebKit does not
// paint backdrop-filter, but it computes it.
for (const [scheme, alpha] of [
  ["dark", "0.5"],
  ["light", "0.3"],
] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test(`palette and help dim the window at ${alpha} over a 1px blur`, async ({ page }) => {
      await openApp(page);

      await page.keyboard.press("Meta+k");
      await expect(page.getByTestId("palette")).toBeVisible();
      const palette = await backdrop(page);
      expect(palette.filter).toBe("blur(1px)");
      expect(palette.background).toMatch(new RegExp(`^rgba\\(0, 0, 0, ${alpha}\\d*\\)$`));
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("palette")).toHaveCount(0);

      await page.keyboard.press("Meta+Slash");
      await expect(page.getByTestId("help-overlay")).toBeVisible();
      expect(await backdrop(page)).toEqual(palette);
    });
  });
}
