import { expect, test, type Page } from "@playwright/test";
import { composeProject, invocations, openApp, openProjects, resetMock, selectProject } from "./fixtures";

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

test("a project without git: No git on the Projects page, its overview, then Initialize Git", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  const project = page.locator('[data-testid="project"][data-project="repo-wr"]');
  await expect(project).toHaveAttribute("data-git", "false");
  await expect(project).toHaveAttribute("data-kind", "nogit");
  // The header says it after the name; on the row the badge stands where the branch
  // would. No branch, status or pull request.
  await expect(project.locator('[data-nav-key="p:repo-wr"]').getByTestId("no-git-badge")).toBeVisible();
  await expect(project.getByTestId("project-worktree").getByTestId("no-git-badge")).toBeVisible();
  await expect(project.getByTestId("worktree-branch")).toHaveCount(0);
  await expect(project.getByTestId("worktree-dirty")).toHaveCount(0);

  // Its tab in the page's side panel.
  await selectProject(page, "repo-wr");
  const overview = page.getByTestId("worktree-surface");
  await expect(overview).toHaveAttribute("data-git", "false");
  await expect(page.getByTestId("worktree-surface-title")).toHaveText(/^writing\s*No git$/);
  await expect(page.getByTestId("section-nogit")).toContainText("Not a git repository");
  // Nothing git-shaped renders: facts, pull request, changes, commits.
  for (const id of ["worktree-facts", "overview-pr", "worktree-changes", "worktree-commits"]) await expect(page.getByTestId(id)).toHaveCount(0);

  // Initialize Git runs project.git.init on the project (the page itself has no project context).
  const init = page.getByTestId("init-git");
  await expect(init).toBeEnabled();
  await expect(init).toHaveText("Initialize Git");
  await init.click();
  await expect.poll(async () => (await lastInvocation("project.git.init"))?.context?.activeProjectId).toBe("repo-wr");
  // A git repository on main now: the normal overview takes over.
  await expect(overview).toHaveAttribute("data-git", "true");
  await expect(page.getByTestId("worktree-surface-title")).toHaveText("writing@main");
  await expect(page.getByTestId("worktree-facts")).toBeVisible();
  await expect(page.getByTestId("worktree-changes")).toBeVisible();
  await expect(page.getByTestId("section-nogit")).toHaveCount(0);
  // Still without a remote: Publish to GitHub.
  await expect(page.getByTestId("publish-github")).toBeVisible();

  await openProjects(page);
  await expect(project).toHaveAttribute("data-git", "true");
  await expect(project).toHaveAttribute("data-kind", "git");
  await expect(project.getByTestId("project-meta")).toHaveText("local only · no remote");
  await expect(project.getByTestId("no-git-badge")).toHaveCount(0);
  await expect(project.getByTestId("worktree-branch")).toHaveText("main");
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
  await expect(page.getByTestId("composer-worktree-list").getByRole("option")).toHaveText([/^Project folder\s*Edits land in ~\/Documents\/writing directly/]);
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
  // The header: the folder, the project and No git; no "@", branch or worktree chip.
  const where = page.getByTestId("thread-location");
  await expect(where).toHaveText("writingNo git");
  await expect(where.getByTestId("no-git-badge")).toBeVisible();
  await expect(where.getByTestId("thread-branch")).toHaveCount(0);
  await expect(where.getByTestId("thread-worktree-chip")).toHaveCount(0);
});
