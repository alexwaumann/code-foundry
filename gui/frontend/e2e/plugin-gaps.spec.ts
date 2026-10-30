import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The plugin GUI gaps (docs/notes/plugins-11-gui-gaps.md): a flagged row opens the
 * plugin's surface, the flags on the thread info card, secrets in Settings → Plugins, a
 * dismissable install failure, and the daemon's real plugin folders.
 */

const flag = (id: string, plugin: string, name: string, level: string, reason: string) =>
  mockPost(`thread/flag?id=${id}&plugin=${plugin}&name=${encodeURIComponent(name)}&level=${level}&reason=${encodeURIComponent(reason)}`);

async function openPlugins(page: Page): Promise<void> {
  await page.keyboard.press("Meta+,");
  await page.getByTestId("settings-nav-plugins").click();
}

const installed = (page: Page, name: string) => page.locator(`[data-testid="plugin-row-settings"][data-plugin="${name}"]`);
const entry = (page: Page, name: string) => page.locator(`[data-testid="registry-entry"][data-plugin="${name}"]`);

test.beforeEach(async () => {
  await resetMock();
});

test("a row whose line 2 shows a plugin's flag opens the thread and the plugin's surface for it", async ({ page }) => {
  await openApp(page);
  await flag("s-3", "hello", "Hello", "attention", "deploy needs approval");
  const s3 = row(page, "s:s-3");
  await expect(s3.getByTestId("row-status")).toHaveText("Hello: deploy needs approval");
  await s3.click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-3");
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "plugin.hello.demo");
  await expect(page.getByTestId("plugin-surface")).toHaveAttribute("data-phase", "live");
});

test("the thread info card's project row carries the flags in their colour, in its hover card; the title menu clears them", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click();
  await page.getByTestId("thread-info-toggle").click();
  const project = page.getByTestId("thread-info-card").getByTestId("ti-project");
  await expect(project.getByTestId("ti-project-mark")).toHaveCount(0);
  await flag("s-3", "hello", "Hello", "error", "build failed");
  // The header has no flag chip (docs/notes/thread-header-crumb.md).
  await expect(page.getByTestId("thread-flag")).toHaveCount(0);
  await expect(project.getByTestId("ti-project-mark")).toHaveClass(/text-cf-error-text/);
  await project.hover();
  const flagged = page.getByTestId("ti-project-notes").getByTestId("ti-project-flag");
  await expect(flagged).toHaveText("Hello: build failed");
  await expect(flagged).toHaveAttribute("data-level", "error");
  await expect(flagged).toHaveClass(/text-cf-error-text/);

  // The title menu clears it: the mark, the row's status and the attention go.
  await page.mouse.move(0, 0);
  await page.getByTestId("thread-header").getByTestId("thread-title").click();
  await page.getByTestId("thread-title-menu").getByTestId("menu-clear-flags").click();
  await expect(project.getByTestId("ti-project-mark")).toHaveCount(0);
  await expect(row(page, "s:s-3").getByTestId("row-status")).toHaveCount(0);
  const calls = await invocations();
  expect(calls.filter((c) => c.name === "thread.flag.clear").map((c) => c.args)).toEqual([{ id: "s-3" }]);
});

test("Settings → Plugins lists a plugin's secrets by name and deletes one after the confirm", async ({ page }) => {
  await openApp(page);
  await openPlugins(page);
  // A plugin that asks for no secrets has no toggle.
  await expect(installed(page, "crasher").getByTestId("plugin-secrets-toggle")).toHaveCount(0);
  const acme = installed(page, "acme-data");
  await acme.getByTestId("plugin-secrets-toggle").click();
  await expect(acme.getByTestId("plugin-secrets-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(acme.getByTestId("plugin-secret")).toHaveCount(2);
  const token = acme.locator('[data-testid="plugin-secret"][data-key="token"]');
  await expect(token).toContainText("set 3 d ago");
  await token.getByTestId("plugin-secret-delete").click();
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toContainText("Delete secret token of plugin acme-data from the Keychain?");
  await page.getByTestId("confirm-ok").click();
  await expect(acme.getByTestId("plugin-secret")).toHaveCount(1);
  await expect(token).toHaveCount(0);

  const hello = installed(page, "hello");
  await hello.getByTestId("plugin-secrets-toggle").click();
  await expect(hello.getByTestId("plugin-secret")).toContainText("word");
  await hello.getByTestId("plugin-secret-delete").click();
  await page.getByTestId("confirm-ok").click();
  await expect(hello.getByTestId("plugin-secrets-none")).toHaveText("No secrets in the Keychain.");
});

test("a failed install says the daemon's words under its row until dismissed or tried again", async ({ page }) => {
  await openApp(page);
  await mockPost(`plugin/registry?installError=${encodeURIComponent("gh-actions: no build for darwin/arm64 in release v0.1.0")}`);
  await openPlugins(page);
  const gh = entry(page, "gh-actions");
  await gh.getByTestId("registry-install").click();
  const progress = gh.getByTestId("registry-progress");
  await expect(progress).toHaveAttribute("data-phase", "failed");
  await expect(progress).toContainText("gh-actions: no build for darwin/arm64 in release v0.1.0");
  await progress.getByTestId("registry-progress-dismiss").click();
  await expect(progress).toHaveCount(0);

  // Again: it fails again; then with the failure gone, the next try clears it.
  await gh.getByTestId("registry-install").click();
  await expect(progress).toHaveAttribute("data-phase", "failed");
  await mockPost("plugin/registry?installError=");
  await gh.getByTestId("registry-install").click();
  await expect(progress).not.toHaveAttribute("data-phase", "failed");
  await expect(page.getByTestId("consent-dialog")).toBeVisible();
});

test("Settings → Plugins and the uninstall dialog name the daemon's plugin folders", async ({ page }) => {
  await mockPost(`plugin/dirs?home=${encodeURIComponent("/Users/dev/.cf-integ")}`);
  await openApp(page);
  await openPlugins(page);
  await expect(page.locator('[data-testid="settings-section"][data-section="installed"]')).toContainText("Plugins in ~/.cf-integ/plugins.");
  await installed(page, "test-watcher").getByTestId("plugin-uninstall").click();
  const dialog = page.getByTestId("uninstall-dialog");
  await expect(dialog).toContainText("It stops and its package goes from ~/.cf-integ/plugins.");
  await expect(dialog).toContainText("Its data (~/.cf-integ/plugin-data/test-watcher), secrets and the consent you gave stay for a reinstall.");
  await expect(dialog).not.toContainText(".code-foundry");
});
