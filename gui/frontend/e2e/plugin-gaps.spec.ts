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

// The info card's project row carrying a flag in its colour (and its hover card), and the title menu's Clear flags: src/components/threadinfo/PlaceGroup.test.tsx ("a plugin's flag marks the row…") and src/components/thread/ThreadMenuItems.test.tsx (thread.flag.clear); a flag's row status is SidebarRow.test.tsx's.

// Settings → Plugins' secrets list, a failed install's line and the daemon's plugin folders:
// unit-tested in src/components/plugin/settings/{PluginsPage,BrowseSection}.test.tsx and
// src/stores/pluginRegistry.test.ts.
