import { expect, test } from "@playwright/test";
import { openApp, resetMock } from "./fixtures";

/**
 * Settings' pages and sections (docs/notes/settings-pages-sections.md): screenshots only. The
 * page order, the sections and their fields are unit-tested (internal/store/settings/schema_test.go,
 * src/components/settings/model.test.ts). SHOTS=<dir> saves the sheet on each page in both schemes.
 */

test.beforeEach(async () => {
  await resetMock();
});

const PAGES = ["general", "appearance", "layout", "dictation", "ember", "advanced"];

test("SHOTS: the settings pages", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
  const shots = process.env.SHOTS ?? "";
  await page.setViewportSize({ width: 1376, height: 1376 });
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  const sheet = page.getByTestId("settings-sheet");
  await expect(sheet).toHaveCSS("opacity", "1");
  for (const id of PAGES) {
    const nav = page.getByTestId(`settings-nav-${id}`);
    if ((await nav.count()) === 0) continue;
    await nav.click();
    await expect(page.locator("[data-setting]").first()).toBeVisible();
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(200);
      await sheet.screenshot({ path: `${shots}/${id}-${scheme}.png` });
    }
  }
});
