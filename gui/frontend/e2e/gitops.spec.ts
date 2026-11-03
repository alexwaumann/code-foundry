import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, openApp, resetMock, row } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

/** The thread on code-foundry's main worktree: worktree commands take their worktree from the selection. */
async function selectMainWorktree(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-1").click();
}

// The progress toast, its result in place and no duplicate command toast: src/components/gitops/GitOpToast.test.tsx
// ("shows a progress toast with the worktree, then its result in place") and src/stores/commands.test.ts.
// git.fetch, git.pull and git.push have no default chord (they run from the palette and the
// CLI); the worktree chord that is left stands in for them.
test("cmd+shift+o runs worktree.open.editor in the selected thread's worktree", async ({ page }) => {
  await selectMainWorktree(page);
  await page.keyboard.press("Meta+Shift+o"); // worktree.open.editor
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "worktree.open.editor").map((i) => i.context?.activeWorktreePath)).toEqual([CF]);
});

// A failure's output toggle and close button, CLI-started ops and a created PR's Open: unit-tested
// in src/components/gitops/GitOpToast.test.tsx (the duplicate command toast in src/stores/commands.test.ts).

// A second op on the same worktree waiting, then running: src/components/gitops/GitOpToast.test.tsx ("a second op waiting on the worktree says so, then runs"); the queueing itself is the daemon's.
