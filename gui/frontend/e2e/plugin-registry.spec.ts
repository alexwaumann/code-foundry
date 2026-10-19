import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row } from "./fixtures";

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

const entry = (page: Page, name: string) => page.locator(`[data-testid="registry-entry"][data-plugin="${name}"]`);
const installed = (page: Page, name: string) => page.locator(`[data-testid="plugin-row-settings"][data-plugin="${name}"]`);

test.beforeEach(async () => {
  await resetMock();
});

test("Refresh re-reads the registries, and one that fails says so in words", async ({ page }) => {
  await openPlugins(page);
  await expect(page.getByTestId("registry-status")).toContainText("2 plugins");
  await mockPost(`plugin/registry?error=${encodeURIComponent("not found: no index.json in o/r (or no access with your gh login)")}`);
  await page.getByTestId("registry-refresh").click();
  await expect(page.locator('[data-testid="registry-status"][data-error="true"]')).toContainText("Not found, or your gh login cannot read it.");
});

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

test("with a second registry, Browse offers updates only from the install source and says where another source's install came from", async ({ page }) => {
  // The fixture registry, then a loopback one listing acme-data 1.3.0 (1.2.0 is installed
  // from Acme's own registry) and a test-watcher 0.2.0 the fixture shadows.
  const fixture = "https://github.com/alexwaumann/code-foundry-plugins";
  const loopback = "http://127.0.0.1:8765/index.json";
  await mockPost(`settings/external?plugins.registries=${encodeURIComponent(`${fixture},${loopback}`)}`);
  await openPlugins(page);
  await expect(page.getByTestId("registry-entry")).toHaveCount(3);

  // Another source's install: no Update on its Installed row, though newer, and where it came
  // from (Browse's pills for each relation are BrowseSection.test.tsx).
  await expect(entry(page, "acme-data")).toHaveAttribute("data-relation", "other-source");
  await expect(installed(page, "acme-data").getByTestId("plugin-update")).toHaveCount(0);
  await expect(installed(page, "acme-data").getByTestId("plugin-installed-from")).toHaveText("from plugins.acme.dev/index.json");

  // Its own registry's entry is still the update, in Browse and on the Installed row.
  const tw = entry(page, "test-watcher");
  await expect(tw).toHaveAttribute("data-relation", "update");
  await expect(installed(page, "test-watcher").getByTestId("plugin-update-available")).toHaveText("0.1.0 is available.");
  await expect(page.locator('[data-testid="registry-status"]').filter({ hasText: "127.0.0.1:8765/index.json" })).toContainText(
    `test-watcher: already listed by ${fixture}, which comes first`,
  );

  // The loopback registry first: its test-watcher wins the name, and is not an update of
  // the one installed from the fixture registry (nor is the fixture's, no longer listed).
  await mockPost(`settings/external?plugins.registries=${encodeURIComponent(`${loopback},${fixture}`)}`);
  await expect(tw.getByTestId("plugin-pill")).toHaveText("Installed from alexwaumann/code-foundry-plugins");
  await expect(tw).toContainText("0.2.0");
  await expect(tw.getByTestId("registry-update")).toHaveCount(0);
  await expect(installed(page, "test-watcher").getByTestId("plugin-update")).toHaveCount(0);
  const calls = await invocations();
  expect(calls.filter((c) => c.name === "plugin.update" || c.name === "plugin.install")).toEqual([]);
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
  // A plugin with threads of its own says how many go with it.
  await installed(page, "hello").getByTestId("plugin-uninstall").click();
  const dialog = page.getByTestId("uninstall-dialog");
  await expect(dialog).toContainText("It removes its 1 thread.");
  await dialog.getByTestId("uninstall-cancel").click();
  await installed(page, "test-watcher").getByTestId("plugin-uninstall").click();
  await expect(dialog).toContainText("Uninstall Test Watcher?");
  await expect(dialog).not.toContainText("thread");
  await expect(dialog).toContainText("Its data (~/.code-foundry/plugin-data/test-watcher), secrets and the consent you gave stay for a reinstall.");
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
