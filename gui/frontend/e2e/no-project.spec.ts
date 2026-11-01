import { expect, test } from "@playwright/test";
import { openApp, resetMock } from "./fixtures";

// Project-less threads, the GUI (docs/notes/no-project-2-gui.md): cmd+N's "No project"
// row, its composer, and the thread it starts, against the mock's thread.new --no-project
// (a thread in /Users/dev).

test.beforeEach(async () => {
  await resetMock();
});

// The picker's No project row (first, ~ and cmd+1, highlighted, searchable, Add a project pinned below):
// src/components/compose/ProjectPicker.test.tsx; the composer without worktree, base or member chips:
// src/components/compose/Composer.test.tsx; thread.new's args (no-project alone): src/lib/compose.test.ts;
// the crumb's house and No project: src/components/thread/ThreadParts.test.tsx; the row's No project and
// no branch: src/components/sidebar/SidebarRow.test.tsx and src/lib/threadRow.test.ts; no project surfaces
// in the side panel: src/surfaces/noProject.test.ts; the shell's tab titled No project:
// src/stores/bottomPanel.test.ts; its context (the thread's, no project or worktree):
// src/stores/bottomActions.test.ts. What is left is the chords and the real editor and send.
test("No project: cmd+N, cmd+1 and a real send start a thread placed nowhere; cmd+T's shell; cmd+N and Enter again", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+n");
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  await page.keyboard.type("no proj");
  await page.keyboard.press("Meta+1");
  await expect(palette).toHaveCount(0);

  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build with No project?");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  // "@" does not search home; nothing opens.
  await page.keyboard.type("@src");
  await page.waitForTimeout(300);
  await expect(page.getByTestId("completion-card")).toHaveCount(0);
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("Reply with just OK");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-crumb-place")).toHaveText("No project");

  // A shell of the thread starts in home and is titled No project.
  await page.keyboard.press("Meta+t");
  await expect(page.locator("[data-tab-id]")).toHaveText("No project");

  // cmd+N from the thread still opens the picker (home is never sent as a worktree), and
  // Enter right away starts another no-project thread.
  await page.keyboard.press("Meta+n");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  await expect(page.getByTestId("picker-no-project")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build with No project?");
});
