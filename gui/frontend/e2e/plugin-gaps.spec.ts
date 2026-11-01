import { expect, test } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The plugin GUI gaps (docs/notes/plugins-11-gui-gaps.md): a flagged row opens the
 * plugin's surface, the flags on the thread info card, secrets in Settings → Plugins, a
 * dismissable install failure, and the daemon's real plugin folders.
 */

const flag = (id: string, plugin: string, name: string, level: string, reason: string) =>
  mockPost(`thread/flag?id=${id}&plugin=${plugin}&name=${encodeURIComponent(name)}&level=${level}&reason=${encodeURIComponent(reason)}`);

test.beforeEach(async () => {
  await resetMock();
});

test("a row that shows a plugin's flag opens the thread and the plugin's surface for it", async ({ page }) => {
  await openApp(page);
  await flag("s-3", "hello", "Hello", "attention", "deploy needs approval");
  const s3 = row(page, "s:s-3");
  await expect(s3.getByTestId("row-status")).toHaveText("Hello");
  await expect(s3.getByTestId("row-detail")).toHaveText("deploy needs approval");
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

// Settings → Plugins' secrets list, a failed install's line and the daemon's plugin folders:
// unit-tested in src/components/plugin/settings/{PluginsPage,BrowseSection}.test.tsx and
// src/stores/pluginRegistry.test.ts.
