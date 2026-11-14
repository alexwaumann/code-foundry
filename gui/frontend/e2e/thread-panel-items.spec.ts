import { expect, test, type Page } from "@playwright/test";
import { CF, invokeAs, openApp, resetMock, row } from "./fixtures";
import { openRowThread } from "./shell-threads";

/**
 * view.open.file, view.open.diff and view.open.pr (and their old view.panel.* names) from inside
 * a thread (docs/notes/control-5-fixes.md, shell-22-retire-verbs.md): the model in s-1 opens a
 * file, a changed file's diff and a pull request as tabs linked to it while the user looks at
 * s-2. The window does not move; the tabs are there for s-1. SHOTS=<dir> saves screenshots.
 */

/** The tabs linked to a thread (files, diffs, pull requests), in strip order. */
const linkedTabs = (page: Page) => page.locator('[data-testid="shell-tab"]:is([data-kind="file"], [data-kind="diff"], [data-kind="pullrequest"])');

/** Runs a command as the CLI inside thread s-1 would (no active view). */
async function inS1(name: string, args: Record<string, string>): Promise<string> {
  const res = await invokeAs("s-1", name, args);
  expect(res.ok).toBe(true);
  return res.message;
}

const shots = process.env.SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${shots}/${name}-${scheme}-${test.info().project.name}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
}

test.beforeEach(async () => {
  await resetMock();
});

// What each item verb opens: internal/command commands_view_open_test.go (and the mock's
// panelItemVerbs.test.ts); the daemon placing them without moving the focus (a tab of a thread with
// no tab in the space goes to the focused pane, behind its active tab): internal/layout
// property_test.go (KeepFocus). Left here: the layout's commits reaching the window from the CLI
// while another thread is shown, and the tabs there for s-1, under the new names and the old.
test("a thread's model opens a file, a diff and a pull request in its own panel; the window stays on the user's thread", async ({ page }) => {
  await openApp(page);
  await openRowThread(page, "s-2");
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-2");

  expect(await inS1("view.open.file", { path: `${CF}/README.md`, line: "3" })).toBe("opened a file tab for thread s-1");
  expect(await inS1("view.panel.diff", { path: `${CF}/README.md` })).toBe("opened a diff tab for thread s-1");
  expect(await inS1("view.open.pr", { number: "145" })).toBe("opened a pullrequest tab for thread s-1");

  // The user's view did not move: s-1 has no tab in the space, so its three tabs wait in the
  // focused pane behind s-2's, each placed after the active tab. A Diff tab is named by its
  // comparison, and nothing is read until it shows.
  await expect(linkedTabs(page)).toHaveCount(3);
  await expect(page.locator('[data-testid="shell-tab"][data-kind="file"]')).toHaveText("README.md");
  await expect(page.locator('[data-testid="shell-tab"][data-kind="diff"]')).toHaveText("Diff");
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-2");
  await expect(page.locator('[data-testid="shell-tab"][data-kind="thread"]')).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("pr-surface")).toHaveCount(0);

  // s-1's pull request, from its tab.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-1");
  await page.locator('[data-testid="shell-tab"][data-kind="pullrequest"]').click();
  await expect(page.getByTestId("pr-title")).toHaveText("fix(terminal): resize race between attach and first output");
  await shot(page, "thread-panel-pr");

  // The file and diff tabs themselves: e2e/file-tabs.spec.ts and src/components/diff/DiffView.test.tsx.
  if (shots) {
    await linkedTabs(page).nth(0).click();
    await expect(page.getByTestId("file-tab")).toHaveAttribute("data-path", `${CF}/README.md`);
    await shot(page, "thread-panel-file");
    await linkedTabs(page).nth(1).click();
    await expect(page.getByTestId("diff-file").locator('[data-line-type="change-addition"]').first()).toBeVisible();
    await shot(page, "thread-panel-diff");
  }
});
