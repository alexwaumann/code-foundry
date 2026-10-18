import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * Settings → Plugins → Browse (docs/notes/plugins-7-registry.md) against the mock's default
 * registry (mock/pluginRegistry.ts): gh-actions 0.1.0 not installed, test-watcher 0.1.0
 * listed while 0.0.9 is installed and running.
 */

async function openPlugins(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-3").click();
  await page.keyboard.press("Meta+,");
  await page.getByTestId("settings-nav-plugins").click();
}

const entry = (page: Page, name: string) => page.locator(`[data-testid="registry-entry"][data-plugin="${name}"]`);
const installed = (page: Page, name: string) => page.locator(`[data-testid="plugin-row-settings"][data-plugin="${name}"]`);

test.beforeEach(async () => {
  await resetMock();
});

test("Browse lists the registry's plugins with what they ask for, the registry below, and the registries setting", async ({ page }) => {
  await openPlugins(page);
  await expect(page.getByTestId("registry-entry")).toHaveCount(2);
  const gh = entry(page, "gh-actions");
  await expect(gh).toContainText("GitHub Actions");
  await expect(gh).toContainText("0.1.0");
  await expect(gh.getByTestId("registry-permissions")).toHaveText(
    "May run Code Foundry commands: pr.checks, thread.send, view.open.url; read events: gh, threads; raise threads to needs-attention or error.",
  );
  await expect(gh).toContainText("alexwaumann/code-foundry-plugin-gh-actions · from alexwaumann/code-foundry-plugins");
  await expect(gh.getByTestId("registry-install")).toBeVisible();
  const tw = entry(page, "test-watcher");
  await expect(tw.getByTestId("plugin-pill")).toHaveText("Update from 0.0.9");
  await expect(tw.getByTestId("registry-update")).toHaveText("Update to 0.1.0");
  await expect(page.getByTestId("registry-status")).toContainText("alexwaumann/code-foundry-plugins");
  await expect(page.getByTestId("registry-status")).toContainText("2 plugins");
  await expect(page.locator('[data-testid="settings-section"][data-section="registries"]')).toContainText("Plugin registries");

  // A registry that fails says so in words.
  await mockPost(`plugin/registry?error=${encodeURIComponent("not found: no index.json in o/r (or no access with your gh login)")}`);
  await page.getByTestId("registry-refresh").click();
  await expect(page.locator('[data-testid="registry-status"][data-error="true"]')).toContainText("Not found, or your gh login cannot read it.");
});

test("Install shows the download's progress, then asks for consent; enabling runs it", async ({ page }) => {
  await openPlugins(page);
  const gh = entry(page, "gh-actions");
  await gh.getByTestId("registry-install").click();
  const progress = gh.getByTestId("registry-progress");
  await expect(progress).toHaveAttribute("data-phase", "downloading");
  await expect(progress).toContainText("Downloading… 2.5 MB");
  await expect(progress).toHaveAttribute("data-phase", "verifying");
  const consent = page.getByTestId("consent-dialog");
  await expect(consent.getByTestId("consent-title")).toHaveText("Enable GitHub Actions 0.1.0?");
  await expect(progress).toHaveCount(0);
  await consent.getByTestId("consent-enable").click();
  await expect(installed(page, "gh-actions").getByTestId("plugin-pill")).toHaveText("Running");
  await expect(gh.getByTestId("plugin-pill")).toHaveText("Installed");
  await expect(gh.getByTestId("registry-install")).toHaveCount(0);
  const calls = await invocations();
  expect(calls.filter((c) => c.name === "plugin.install").map((c) => c.args)).toEqual([{ ref: "gh-actions" }]);
});

test("Update from the Installed row installs the listed version and keeps it running", async ({ page }) => {
  await openPlugins(page);
  const tw = installed(page, "test-watcher");
  await expect(tw.getByTestId("plugin-update-available")).toHaveText("0.1.0 is available.");
  await expect(tw).toContainText("from alexwaumann/code-foundry-plugins");
  await tw.getByTestId("plugin-update").click();
  await expect(tw).toContainText("0.1.0");
  await expect(tw.getByTestId("plugin-update")).toHaveCount(0);
  await expect(tw.getByTestId("plugin-pill")).toHaveText("Running");
  await expect(entry(page, "test-watcher").getByTestId("plugin-pill")).toHaveText("Installed");
});

test("Uninstall confirms once in its own dialog, with purge as a choice", async ({ page }) => {
  await openPlugins(page);
  await installed(page, "test-watcher").getByTestId("plugin-uninstall").click();
  const dialog = page.getByTestId("uninstall-dialog");
  await expect(dialog).toContainText("Uninstall Test Watcher?");
  await expect(dialog).toContainText("Its data, secrets and the consent you gave stay for a reinstall.");
  await dialog.getByTestId("uninstall-purge").click();
  await dialog.getByTestId("uninstall-confirm").click();
  await expect(installed(page, "test-watcher")).toHaveCount(0);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(entry(page, "test-watcher").getByTestId("registry-install")).toBeVisible();
  const calls = await invocations();
  expect(calls.filter((c) => c.name === "plugin.uninstall").map((c) => [c.args, c.confirmed])).toEqual([
    [{ name: "test-watcher", purge: "true" }, false],
    [{ name: "test-watcher", purge: "true" }, true],
  ]);
});
