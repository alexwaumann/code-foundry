import { expect, test, type Page } from "@playwright/test";
import { composeProject, openApp, resetMock } from "./fixtures";

/**
 * Workspaces v2, fuzz round D fixes for the composer and sidebar
 * (docs/notes/workspaces-v2-fix-4-composer.md): an emptied workspace set, a like with the
 * workspace folder, folder-only sets in place, cmd+N on a project resets an empty draft,
 * Save as workspace in a workspace folder, the like headings and labels, a like draft whose
 * thread is removed, the menus' and palette's rules, deduped hints, the header chip.
 */

async function composeIn(page: Page, n: number): Promise<void> {
  await composeProject(page, n);
}

test.beforeEach(async () => {
  await resetMock();
});

// 1, 1b, 4: a picked workspace's set (a project out or in leaves it, the empty state, cmd+N on an empty draft):
// unit-tested in src/components/compose/ComposerSets.test.tsx (the store rules in src/stores/compose.test.ts).
// 2, 7, 8, 14, 15, 9: New thread on this branch (headings, the read-only pill, Workspace folder, thread.new-like's
// args, a removed thread's draft): ComposerSets.test.tsx; the new row's workspace name and its tooltip:
// src/components/sidebar/SidebarRow.test.tsx. The created thread's places are the daemon's
// (internal/command/commands_thread_workspace_test.go).
// 3: a set without a git project: ComposerSets.test.tsx.
// 5, 10: the menus' Save as workspace, New thread on this branch and Run in: src/components/thread/ThreadMenuItems.test.tsx;
// the palette's: src/components/palette/CommandPalette.test.tsx. 11, 13: deduped hints and the name-only chip:
// ComposerSets.test.tsx.

// 12: the thread header's crumb naming the thread's workspace: src/components/thread/ThreadParts.test.tsx ("the thread header's crumb", "a named workspace"); pane-workspace no longer exists.

test("16: cmd+N from a new-thread composer's prompt opens the project picker", async ({ page }) => {
  await openApp(page);
  await composeIn(page, 1);
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
});
