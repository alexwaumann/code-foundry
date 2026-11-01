import { expect, test, type Page } from "@playwright/test";
import { composeProject, expectTooltip, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * A thread's project set on the fly (docs/notes/thread-project-set.md), from the thread
 * info card: Add project (the composer's list of the projects not in the set: one pick,
 * thread.project.add, and it closes), the Run in menu's × (thread.project.remove, asking
 * first for a dirty checkout, never Run in), the thread leaving its named workspace (the
 * crumb's "<cwd> +N", Save as workspace, or Use workspace when a saved one has the set),
 * and a member whose worktree moved greyed with the daemon's refusal; the composer's Work
 * in greys such a branch the same way.
 */

const HOME = "/Users/dev";
/** Where the mock (the daemon's DefaultWorktreePath) puts a project's worktree for a branch. */
const worktreeOf = (slug: string, branch: string) => `${HOME}/.code-foundry/worktrees/${slug}/${branch.replaceAll("/", "-")}`;

const card = (page: Page) => page.getByTestId("thread-info-card");
const crumb = (page: Page) => page.getByTestId("thread-header").getByTestId("thread-crumb");
const menu = (page: Page) => page.getByTestId("ti-project-menu");
const runIn = (page: Page, project: string) => menu(page).locator(`[data-testid="ti-runin-item"][data-project="${project}"]`);

/** A worktree-mode thread on feat/x over `projects` (worktrees made), in workspace login when given; the card open. */
async function openMulti(page: Page, projects: string, primary: string, workspace = ""): Promise<string> {
  const { id } = (await mockPost(`multi-thread?projects=${projects}&project=${primary}&branch=feat/x&name=multi${workspace ? `&workspace=${workspace}` : ""}`)) as { id: string };
  await openApp(page);
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", id);
  await page.getByTestId("thread-info-toggle").click();
  await expect(card(page)).toBeVisible();
  return id;
}

async function calls(name: string) {
  return (await invocations()).filter((i) => i.name === name).map((i) => [i.args, i.context?.activeThreadId]);
}

test.beforeEach(async () => {
  await resetMock();
});

// Add project (one pick, the list closing, "+N", "Every project is in this thread."), leaving the
// workspace (the crumb), Save as workspace and Use workspace, Run in's × and its confirm, and a
// moved member greyed with its tooltip: src/components/threadinfo/ProjectSet.test.tsx. The daemon's
// rules behind them (leaving the workspace, the dirty-checkout question, the refusal) are Go's.

test("the composer's Work in greys a branch whose worktree moved, with the refusal as its tooltip", async ({ page }) => {
  const path = worktreeOf("alexwaumann/code-foundry", "release/v0.3");
  await mockPost("multi-thread?projects=repo-cf&project=repo-cf&branch=release/v0.3&name=release");
  await mockPost(`worktree/checkout?path=${encodeURIComponent(path)}&branch=hotfix`);
  await openApp(page);
  await composeProject(page);
  const before = (await page.getByTestId("composer-worktree").getAttribute("aria-label")) ?? "";
  await page.getByTestId("composer-worktree").click();
  const list = page.getByTestId("composer-worktree-list");
  const refused = list.getByRole("option", { name: "release/v0.3" });
  await expect(refused).toHaveAttribute("data-unavailable", "");
  await expect(list.getByRole("option", { name: "feat/sidebar" })).not.toHaveAttribute("data-unavailable", "");
  await expectTooltip(page, refused.locator("[data-tip]"), `code-foundry's worktree for release/v0.3 at ${path} has hotfix checked out now; switch it back to release/v0.3, or pick another branch`);
  // A pick of it does nothing: the list stays open on the same choice.
  await refused.click();
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer-worktree")).toHaveAttribute("aria-label", before);
});
