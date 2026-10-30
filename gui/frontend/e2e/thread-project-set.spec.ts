import { expect, test, type Page } from "@playwright/test";
import { composeProject, expectTooltip, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * A thread's project set on the fly (docs/notes/thread-project-set.md), from the thread
 * info card: Add project (the composer's multi-select list, thread.project.add per pick),
 * the Run in menu's × (thread.project.remove, asking first for a dirty checkout), the
 * thread leaving its named workspace (the crumb's "<cwd> +N", Save as workspace), and a
 * member whose worktree moved greyed with the daemon's refusal; the composer's Work in
 * greys such a branch the same way.
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

test("Add project: one add per pick, the thread leaves its workspace, then Save as workspace attaches it to the new one", async ({ page }) => {
  await mockPost("workspace?name=login&projects=repo-cf,repo-gp");
  const id = await openMulti(page, "repo-cf,repo-gp", "repo-gp", "login");
  await expect(crumb(page)).toHaveAttribute("data-icon", "layers");
  await expect(page.getByTestId("thread-crumb-place")).toHaveText("login");

  await card(page).getByTestId("ti-project").click();
  // A named workspace: nothing to save.
  await expect(menu(page).getByTestId("ti-save-workspace")).toHaveCount(0);
  await menu(page).getByTestId("ti-add-project").click();
  const list = page.getByTestId("ti-add-project-picker-list");
  await expect(list).toBeVisible();
  // The thread's projects are checked; a pick adds one and the list stays open for the next.
  await expect(list.locator('[data-checked="true"]')).toHaveCount(2);
  await list.getByRole("option", { name: /dotfiles/ }).click();
  await expect.poll(() => calls("thread.project.add")).toEqual([[{ project: "repo-dot" }, id]]);
  await expect(list.getByRole("option", { name: /dotfiles/ })).toHaveAttribute("data-checked", "true");
  await list.getByRole("option", { name: /sketches/ }).click();
  await expect.poll(async () => (await calls("thread.project.add")).length).toBe(2);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);

  // Out of the workspace: the crumb is the unnamed form, the card's workspace row is gone.
  await expect(crumb(page)).toHaveAttribute("data-icon", "folders");
  await expect(page.getByTestId("thread-crumb-place")).toHaveText("ghostty-playground +3");
  await expect(card(page).getByTestId("ti-workspace")).toHaveCount(0);
  await expect(page.getByText(/Added project dotfiles to this thread .*The thread no longer follows workspace login/)).toBeVisible();

  // Save as workspace is offered now; the thread then references the new workspace.
  await card(page).getByTestId("ti-project").click();
  await menu(page).getByTestId("ti-save-workspace").click();
  await page.getByTestId("save-workspace-name").fill("quad");
  await page.getByTestId("save-workspace-submit").click();
  await expect(page.getByTestId("save-workspace-dialog")).toHaveCount(0);
  await expect(crumb(page)).toHaveAttribute("data-icon", "layers");
  await expect(page.getByTestId("thread-crumb-place")).toHaveText("quad");
  await expect(card(page).getByTestId("ti-workspace")).toContainText("quad");
});

test("Remove from this thread: a × on every member but the cwd's; a dirty checkout asks first", async ({ page }) => {
  const id = await openMulti(page, "repo-cf,repo-gp,repo-sk", "repo-gp");
  await card(page).getByTestId("ti-project").click();
  await expect(menu(page).getByTestId("ti-runin-item")).toHaveCount(3);
  await expect(runIn(page, "repo-gp").getByTestId("ti-runin-remove")).toHaveCount(0);
  await runIn(page, "repo-sk").hover();
  await runIn(page, "repo-sk").getByTestId("ti-runin-remove").click();
  await expect.poll(() => calls("thread.project.remove")).toEqual([[{ project: "repo-sk" }, id]]);
  await expect(page.getByText(/Removed project sketches from this thread\. Its checkout .* stays on disk\./)).toBeVisible();

  // A member with uncommitted changes: the daemon's confirmation names the work, then it goes.
  await mockPost(`worktree/dirty?path=${encodeURIComponent(worktreeOf("alexwaumann/code-foundry", "feat/x"))}&modified=2`);
  await card(page).getByTestId("ti-project").click();
  await expect(menu(page).getByTestId("ti-runin-item")).toHaveCount(2);
  await runIn(page, "repo-cf").hover();
  await runIn(page, "repo-cf").getByTestId("ti-runin-remove").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("has uncommitted work");
  await expect(dialog).toContainText("this thread no longer sees it");
  await page.getByTestId("confirm-ok").click();
  await expect(dialog).toHaveCount(0);
  // One project left: the menu has no Run in.
  await card(page).getByTestId("ti-project").click();
  await expect(menu(page).getByTestId("ti-runin-item")).toHaveCount(0);
});

test("a member whose worktree moved is greyed in Run in with the daemon's refusal, and still runs there", async ({ page }) => {
  const gp = worktreeOf("alexwaumann/ghostty-playground", "feat/x");
  const id = await openMulti(page, "repo-cf,repo-gp", "repo-cf");
  await mockPost(`worktree/checkout?path=${encodeURIComponent(gp)}&branch=other`);
  await card(page).getByTestId("ti-project").click();
  const item = runIn(page, "repo-gp");
  await expect(item).toHaveAttribute("data-refused", "");
  await expect(item).toContainText("ghostty-playground @ other");
  await expect(runIn(page, "repo-cf")).not.toHaveAttribute("data-refused", "");
  await expectTooltip(page, item, `ghostty-playground's worktree for feat/x at ${gp} has other checked out now; switch it back to feat/x, or pick another branch`);
  await item.click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.run-in").map((i) => [i.args.project, i.context?.activeThreadId])).toEqual([["repo-gp", id]]);
});

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
