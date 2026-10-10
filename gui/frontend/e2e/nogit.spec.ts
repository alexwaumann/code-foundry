import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, openProjects, resetMock, selectProject } from "./fixtures";

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

/** cmd+n, then cmd+<n> in the project picker. */
async function compose(page: Page, n: number): Promise<void> {
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
  await page.keyboard.press(`Meta+${String(n)}`);
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

test("a project without git: No git on the Projects page, its overview, then Initialize Git", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  const project = page.locator('[data-testid="project"][data-repo="repo-wr"]');
  await expect(project).toHaveAttribute("data-git", "false");
  // The badge stands where the branch would; no branch, status or pull request.
  await expect(project.getByTestId("no-git-badge")).toBeVisible();
  await expect(project.getByTestId("worktree-branch")).toHaveCount(0);
  await expect(project.getByTestId("worktree-dirty")).toHaveCount(0);

  await selectProject(page, "repo-wr");
  const overview = page.getByTestId("overview-page");
  await expect(overview).toHaveAttribute("data-git", "false");
  await expect(page.getByTestId("overview-title")).toHaveText(/^writing\s*No git$/);
  await expect(page.getByTestId("section-nogit")).toContainText("Not a git repository");
  // Nothing git-shaped renders: sync line, GitHub, files, log.
  for (const id of ["sync-line", "section-github", "section-files", "section-log"]) await expect(page.getByTestId(id)).toHaveCount(0);
  // Its threads and terminals are still listed (WorktreeItems).
  await expect(page.getByTestId("empty-new-session")).toBeVisible();

  // The palette offers Initialize Git and nothing that needs git.
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await expect(palette.locator('[data-command="repo.git.init"]')).toBeVisible();
  for (const name of ["worktree.create", "git.fetch", "git.pull", "git.push", "pr.create"]) await expect(palette.locator(`[data-command="${name}"]`)).toHaveCount(0);
  await page.keyboard.press("Escape");

  const init = page.getByTestId("init-git");
  await expect(init).toBeEnabled();
  await expect(init).toHaveText("Initialize Git");
  await init.click();
  await expect.poll(async () => (await lastInvocation("repo.git.init"))?.context?.activeRepoId).toBe("repo-wr");
  // A git repository on main now: the normal overview takes over.
  await expect(overview).toHaveAttribute("data-git", "true");
  await expect(page.getByTestId("overview-title")).toHaveText("writing@main");
  await expect(page.getByTestId("sync-line")).toBeVisible();
  await expect(page.getByTestId("section-files")).toBeVisible();
  await expect(page.getByTestId("section-nogit")).toHaveCount(0);
  // Still without a remote: Publish to GitHub.
  await expect(page.getByTestId("publish-github")).toBeVisible();
  await page.keyboard.press("Meta+k");
  await expect(palette.locator('[data-command="repo.git.init"]')).toHaveCount(0);
  await page.keyboard.press("Escape");

  await openProjects(page);
  await expect(project).toHaveAttribute("data-git", "true");
  await expect(project.getByTestId("no-git-badge")).toHaveCount(0);
  await expect(project.getByTestId("worktree-branch")).toHaveText("main");
});

test("the composer in a project without git offers only its current checkout; the thread's row says No git", async ({ page }) => {
  await openApp(page);
  // Projects by name: code-foundry, dotfiles, ghostty-playground, sketches, writing.
  await compose(page, 5);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in writing?");
  await expect(page.getByTestId("composer-worktree")).toHaveText("Current checkout");
  // Its member chip names the project with the No git badge, never a branch (no "cf/…").
  const chip = page.getByTestId("composer-member");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute("data-primary", "true");
  await expect(chip.getByTestId("no-git-badge")).toBeVisible();
  await expect(chip.getByTestId("composer-member-branch")).toHaveCount(0);
  await expect(chip).not.toContainText("cf/");
  await expect(chip.getByRole("button").first()).toHaveAccessibleName("writing, not a git repository, primary: the thread runs here");
  // And the badge beside the worktree picker, where a branch would be.
  await expect(page.getByTestId("composer-card").getByTestId("no-git-badge")).toBeVisible();
  // No base ref, no branch, no Also in (a workspace needs git).
  for (const id of ["composer-base", "composer-checkout-branch", "composer-also-in"]) await expect(page.getByTestId(id)).toHaveCount(0);
  await page.getByTestId("composer-worktree").click();
  await expect(page.getByTestId("composer-worktree-list").getByRole("option")).toHaveText([/^Current checkout\s*~\/Documents\/writing · not a git repository/]);
  await page.keyboard.press("Escape");

  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Outline chapter two");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.new");
  const args = (await invocations()).at(-1)?.args;
  expect(args).toMatchObject({ repo: "repo-wr", worktree: WR });
  expect(args).not.toHaveProperty("new-worktree");

  const row = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(row).toBeVisible();
  await expect(row.getByTestId("row-project")).toHaveText("writing");
  await expect(row.getByTestId("no-git-badge")).toBeVisible();
  await expect(row.getByTestId("row-branch")).toHaveCount(0);
});

test("a git repository without a remote: Publish to GitHub is there, disabled, coming soon", async ({ page }) => {
  await openApp(page);
  await selectProject(page, "repo-sk");
  await expect(page.getByTestId("overview-title")).toHaveText("sketches@main");
  await expect(page.getByTestId("no-remote")).toContainText("No remote");
  await expect(page.getByTestId("publish-github")).toBeDisabled();
  await expect(page.getByTestId("publish-github")).toHaveText("Publish to GitHub");
  await expect(page.getByTestId("publish-github-wrapper")).toHaveAttribute("title", "Coming soon");
  // Worktrees and files work as for any git repository.
  await expect(page.getByTestId("sync-line")).toBeVisible();
  await expect(page.getByTestId("section-files")).toBeVisible();

  // A remote that is not GitHub, and a GitHub repository: no Publish button.
  for (const id of ["repo-dot", "repo-cf"]) {
    await selectProject(page, id);
    await expect(page.getByTestId("overview-page")).toHaveAttribute("data-git", "true");
    await expect(page.getByTestId("publish-github")).toHaveCount(0);
  }
});

test("workspace member pickers leave out projects without git, not repositories without a remote", async ({ page }) => {
  await mockPost("workspace?name=login&repos=repo-cf");
  await openApp(page);
  // The composer's Also in (a new workspace).
  await compose(page, 1);
  await page.getByTestId("composer-also-in").click();
  await expect(page.getByTestId("composer-also-in-list").getByRole("option")).toHaveText([/^dotfiles/, /^ghostty-playground/, /^sketches/]);
  await page.keyboard.press("Escape");

  // An existing workspace's Add project.
  await openProjects(page);
  const ws = page.locator('[data-testid="workspace"]');
  await ws.getByTestId("workspace-add-member").click();
  await expect(page.getByTestId("workspace-add-member-list").getByRole("option")).toHaveText(["dotfiles", "ghostty-playground", "sketches"]);
});
