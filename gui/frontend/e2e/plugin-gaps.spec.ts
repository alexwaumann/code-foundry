import { expect, test } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

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
  // The flagged thread is under Needs you (its ask's kind is the plugin's flag); the card's Go to
  // thread opens the thread and the plugin's surface as a linked tab placed by the rules. Which
  // control does what: src/components/needs/NeedsCard.test.tsx and src/stores/flagSurface.test.ts.
  // Kept here: the surface going live through the plugin host's stream in a pane of the shell.
  const s3 = row(page, "s:s-3");
  await expect(s3).toHaveAttribute("data-section", "needs");
  await expect(s3.getByTestId("row-ask")).toHaveText("Hello");
  await s3.getByTestId("thread-name").hover();
  const card = page.getByTestId("needs-card");
  await expect(card).toBeVisible();
  await card.getByTestId("needs-card-go").click();
  const threadPane = page.locator('[data-testid="shell-pane"]').filter({ has: page.locator('[data-testid="thread-pane"][data-thread-id="s-3"]') });
  await expect(threadPane).toHaveCount(1);
  const surface = page.getByTestId("plugin-surface");
  await expect(surface).toHaveAttribute("data-phase", "live");
  // Room beside the thread: a pane of its own to its right (shell-model.md, Placement 5).
  const surfacePane = page.locator('[data-testid="shell-pane"]').filter({ has: surface });
  await expect(surfacePane).toHaveCount(1);
  const [t, p] = [await threadPane.boundingBox(), await surfacePane.boundingBox()];
  expect(t && p && p.x >= t.x + t.width).toBe(true);
});

// The info card's project row carrying a flag in its colour (and its hover card), and the title menu's Clear flags: src/components/threadinfo/PlaceGroup.test.tsx ("a plugin's flag marks the row…") and src/components/thread/ThreadMenuItems.test.tsx (thread.flag.clear); a flag's row status is SidebarRow.test.tsx's.

// Settings → Plugins' secrets list, a failed install's line and the daemon's plugin folders:
// unit-tested in src/components/plugin/settings/PluginsPage.test.tsx and
// src/stores/pluginRegistry.test.ts.
