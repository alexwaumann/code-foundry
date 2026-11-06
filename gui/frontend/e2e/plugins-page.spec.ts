import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock } from "./fixtures";

/**
 * Settings → Plugins (docs/notes/plugins-page-redesign.md) against the mock's plugins and
 * fixture registry. Only what needs a browser: groups, rows, the switch, menus, search and
 * Update all are unit-tested in src/components/plugin/settings/PluginsPage.test.tsx.
 */

test.beforeEach(async () => {
  await resetMock();
});

async function openPlugins(page: Page) {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("settings-nav-plugins").click();
  await expect(page.getByTestId("plugin-row-settings").first()).toBeVisible();
}

test("no registry: the line's link opens Registries with the caret in the setting, and Escape keeps Settings open", async ({ page }) => {
  await mockPost("settings/external?plugins.registries=");
  await openPlugins(page);
  await page.getByTestId("plugin-browse-all").click();
  await page.getByTestId("registry-none-link").click();
  const dialog = page.getByTestId("plugin-registries");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-setting="plugins.registries"] input, [data-setting="plugins.registries"] textarea').first()).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("settings-page")).toBeVisible();
});

/** SHOTS=<dir>: the PR's screenshots, WebKit, 1280x800, dark and light: default, search, Browse all, a row's menu. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2 });
    test("default, search, Browse all, a row's menu", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      await openPlugins(page);
      const shot = (name: string) => page.screenshot({ path: `${shots ?? ""}/plugins-${name}-${scheme}.png` });
      const row = (name: string) => page.getByTestId("plugin-row-settings").and(page.locator(`[data-plugin="${name}"]`));
      await row("crasher").getByTestId("catalog-chevron").click();
      await shot("default");
      await page.getByTestId("plugin-search").fill("linear");
      await expect(page.getByTestId("registry-entry").first()).toBeVisible();
      await shot("search");
      await page.getByTestId("plugin-search").fill("");
      await page.getByTestId("plugin-browse-all").click();
      await expect(page.getByTestId("registry-entry").first()).toBeVisible();
      await shot("browse");
      await page.getByTestId("plugin-browse-all").click();
      await row("hello").getByTestId("plugin-row-menu").click();
      await expect(page.getByTestId("plugin-menu-uninstall")).toBeVisible();
      await page.waitForTimeout(350);
      await shot("menu");
    });
  });
}
