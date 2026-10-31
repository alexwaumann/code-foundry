import { expect, test, type Page } from "@playwright/test";
import { composeProject, invocations, openApp, openProjectPage, openProjects, resetMock, selectProject } from "./fixtures";

/**
 * Add-project PR 2: a project without git (the mock's "writing", a plain folder) and a
 * git repository without a remote ("sketches"). docs/notes/add-project-2-nogit.md.
 */

const WR = "/Users/dev/Documents/writing";

test.beforeEach(async () => {
  await resetMock();
});

async function lastInvocation(name: string) {
  return (await invocations()).filter((i) => i.name === name).at(-1);
}

/** cmd+n, then the nth project row of the picker. */
async function compose(page: Page, n: number): Promise<void> {
  await composeProject(page, n);
}

test("a project without git: its page says so, its Changes tab, then Initialize git", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  // The index row: its folder and "no git", no checkouts to count.
  const indexRow = page.locator('[data-nav-key="p:repo-wr"]');
  await expect(indexRow.getByTestId("index-project")).toHaveAttribute("data-kind", "nogit");
  await expect(indexRow.getByTestId("project-caption")).toHaveText("~/Documents/writing · no git");
  // Its page: the note, no branch, status or pull request.
  await openProjectPage(page, "repo-wr");
  const pageEl = page.getByTestId("projects-page");
  await expect(pageEl).toHaveAttribute("data-kind", "nogit");
  await expect(page.getByTestId("project-note")).toContainText("not a git repository");
  await expect(page.getByTestId("worktree-branch")).toHaveCount(0);

  // Its Changes tab in the page's side panel says there is nothing git-shaped to list.
  await selectProject(page, "repo-wr");
  const changes = page.getByTestId("changes-surface");
  await expect(changes.getByTestId("changes-nogit")).toContainText("Not a git repository");
  for (const id of ["worktree-changes", "worktree-commits"]) await expect(page.getByTestId(id)).toHaveCount(0);

  // The project's menu runs project.git.init on it.
  await page.getByTestId("project-more").click();
  await page.getByTestId("project-menu-init-git").click();
  await expect.poll(async () => (await lastInvocation("project.git.init"))?.context?.activeProjectId).toBe("repo-wr");
  // A git repository on main now: the lists take over, and the page shows its checkout.
  await expect(changes.getByTestId("changes-nogit")).toHaveCount(0);
  await expect(page.getByTestId("worktree-changes")).toBeVisible();
  await expect(pageEl).toHaveAttribute("data-kind", "git");
  await expect(page.getByTestId("worktree-branch")).toHaveText("main");
  await openProjects(page);
  await expect(indexRow.getByTestId("project-caption")).toHaveText("local only");
});

test("the composer in a project without git offers only its current checkout; the thread's row says No git", async ({ page }) => {
  await openApp(page);
  // Projects by name: code-foundry, dotfiles, ghostty-playground, sketches, writing.
  await compose(page, 5);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in writing?");
  await expect(page.getByTestId("composer-worktree")).toHaveText("Project folder");
  // A lone project: no chip, only Add project (a plain folder can be part of a set).
  await expect(page.getByTestId("composer-member")).toHaveCount(0);
  await expect(page.getByTestId("composer-add-project")).toBeVisible();
  // The No git badge beside the worktree picker, where a branch would be.
  await expect(page.getByTestId("composer-card").getByTestId("no-git-badge")).toBeVisible();
  // No base ref, no branch.
  for (const id of ["composer-base", "composer-checkout-branch"]) await expect(page.getByTestId(id)).toHaveCount(0);
  await page.getByTestId("composer-worktree").click();
  await expect(page.getByTestId("composer-worktree-list").getByRole("option")).toHaveText([/^Project folder\s*Edits land in the project's checkout directly/]);
  await page.keyboard.press("Escape");

  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Outline chapter two");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("thread.new");
  const args = (await invocations()).at(-1)?.args;
  expect(args).toMatchObject({ project: "repo-wr", worktree: WR });
  expect(args).not.toHaveProperty("new-worktree");

  const row = page.locator('[data-row-kind="thread"][aria-selected="true"]');
  await expect(row).toBeVisible();
  await expect(row.getByTestId("row-project")).toHaveText("writing");
  await expect(row.getByTestId("no-git-badge")).toBeVisible();
  await expect(row.getByTestId("row-branch")).toHaveCount(0);
  // The header's crumb: the project's folder and name (no branch: the card has the rest).
  const crumb = page.getByTestId("thread-crumb");
  await expect(crumb).toHaveAttribute("data-icon", "folder");
  await expect(crumb.getByTestId("thread-crumb-place")).toHaveText("writing");
});
