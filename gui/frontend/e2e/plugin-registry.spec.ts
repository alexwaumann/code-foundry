import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * Settings → Plugins → Browse (docs/notes/plugins-7-registry.md) against the mock's fixture
 * registry (mock/pluginRegistry.ts), which the mock's settings configure explicitly
 * (plugins.registries is empty by default): gh-actions 0.1.0 not installed, test-watcher
 * 0.1.0 listed while 0.0.9 is installed and running.
 */

async function openPlugins(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-3").click();
  await page.keyboard.press("Meta+,");
  await page.getByTestId("settings-nav-plugins").click();
}

test.beforeEach(async () => {
  await resetMock();
});

// Refresh and a failed registry's words, a second registry's relations and skipped names,
// install progress and consent, Update and Uninstall: unit-tested in
// src/components/plugin/settings/{BrowseSection,PluginsPage}.test.tsx,
// src/components/plugin/ConsentDialog.test.tsx and src/stores/pluginRegistry.test.ts.

test("with no registry configured (the default) Browse says so and points at the setting; adding one lists its plugins", async ({ page }) => {
  // The setting back to its default: no registry.
  await mockPost("settings/external?plugins.registries=");
  await openPlugins(page);
  await expect(page.getByTestId("registry-none")).toHaveText("No registry configured. Add one in Registries");
  await expect(page.getByTestId("registry-entry")).toHaveCount(0);
  await expect(page.getByTestId("registry-status")).toHaveCount(0);
  await expect(page.getByTestId("registry-empty")).toHaveCount(0);

  // Its link leads to the field below; adding the registry there re-reads Browse.
  const field = page.locator('[data-setting="plugins.registries"]').getByRole("textbox");
  await page.getByTestId("registry-none-link").click();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");
  await field.fill("https://github.com/alexwaumann/code-foundry-plugins");
  await field.press("Enter");
  await expect(page.getByTestId("registry-entry")).toHaveCount(2);
  await expect(page.getByTestId("registry-none")).toHaveCount(0);
  await expect(page.getByTestId("registry-status")).toContainText("alexwaumann/code-foundry-plugins");

  // A registry that lists nothing says that.
  await mockPost(`settings/external?plugins.registries=${encodeURIComponent("https://example.com/plugins/index.json")}`);
  await expect(page.getByTestId("registry-empty")).toHaveText("No plugins listed yet.");
});
