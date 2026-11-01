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

test("Add project: one pick adds and closes the list, the thread leaves its workspace, then Save as workspace attaches it to the new one", async ({ page }) => {
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
  // Only the projects not in the set are listed; a pick adds one and the list closes.
  await expect(list.getByRole("option")).toHaveCount(3);
  await expect(list.getByRole("option", { name: /code-foundry|ghostty/ })).toHaveCount(0);
  await list.getByRole("option", { name: /dotfiles/ }).click();
  await expect(list).toHaveCount(0);
  await expect.poll(() => calls("thread.project.add")).toEqual([[{ project: "repo-dot" }, id]]);
  await expect(card(page).getByTestId("ti-project")).toContainText("+2");
  // The next add is another pick; dotfiles is no longer offered.
  await card(page).getByTestId("ti-project").click();
  await menu(page).getByTestId("ti-add-project").click();
  await expect(list.getByRole("option")).toHaveCount(2);
  await list.getByRole("option", { name: /sketches/ }).click();
  await expect(list).toHaveCount(0);
  await expect.poll(async () => (await calls("thread.project.add")).length).toBe(2);
  // The last one in: the list then says every project is in the thread.
  await card(page).getByTestId("ti-project").click();
  await menu(page).getByTestId("ti-add-project").click();
  await list.getByRole("option").first().click();
  await expect.poll(async () => (await calls("thread.project.add")).length).toBe(3);
  await card(page).getByTestId("ti-project").click();
  await menu(page).getByTestId("ti-add-project").click();
  await expect(list).toContainText("Every project is in this thread.");
  await expect(list.getByRole("option")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);

  // Out of the workspace: the crumb is the unnamed form, the card's workspace row is gone.
  await expect(crumb(page)).toHaveAttribute("data-icon", "folders");
  await expect(page.getByTestId("thread-crumb-place")).toHaveText("ghostty-playground +4");
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

test("Use workspace: a set that equals a saved workspace is offered that workspace, not a save", async ({ page }) => {
  await mockPost("workspace?name=login&projects=repo-cf,repo-gp");
  const id = await openMulti(page, "repo-cf,repo-gp,repo-sk", "repo-gp");
  await expect(crumb(page)).toHaveAttribute("data-icon", "folders");
  await card(page).getByTestId("ti-project").click();
  // Three projects match no workspace: Save as workspace.
  await expect(menu(page).getByTestId("ti-save-workspace")).toBeVisible();
  await expect(menu(page).getByTestId("ti-use-workspace")).toHaveCount(0);
  await runIn(page, "repo-sk").hover();
  await runIn(page, "repo-sk").getByTestId("ti-runin-remove").click();
  await expect.poll(() => calls("thread.project.remove")).toEqual([[{ project: "repo-sk" }, id]]);
  // Down to login's two: Use workspace login takes the save's place, and attaches the thread.
  await card(page).getByTestId("ti-project").click();
  await expect(menu(page).getByTestId("ti-save-workspace")).toHaveCount(0);
  const use = menu(page).getByTestId("ti-use-workspace");
  await expect(use).toHaveText("Use workspace login");
  await use.click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.workspace").map((i) => [i.args.workspace?.startsWith("w-"), i.context?.activeThreadId])).toEqual([[true, id]]);
  await expect(crumb(page)).toHaveAttribute("data-icon", "layers");
  await expect(card(page).getByTestId("ti-workspace")).toContainText("login");
});

test("Remove from this thread: a × on every member but the cwd's; a dirty checkout asks first", async ({ page }) => {
  const id = await openMulti(page, "repo-cf,repo-gp,repo-sk", "repo-gp");
  await card(page).getByTestId("ti-project").click();
  await expect(menu(page).getByTestId("ti-runin-item")).toHaveCount(3);
  await expect(runIn(page, "repo-gp").getByTestId("ti-runin-remove")).toHaveCount(0);
  await runIn(page, "repo-sk").hover();
  // The × (shown on the row's hover) says what it does.
  await runIn(page, "repo-sk").getByTestId("ti-runin-remove").hover();
  await expect(page.getByRole("tooltip")).toHaveText("Remove project");
  await runIn(page, "repo-sk").getByTestId("ti-runin-remove").click();
  await expect.poll(() => calls("thread.project.remove")).toEqual([[{ project: "repo-sk" }, id]]);
  await expect(page.getByText(/Removed project sketches from this thread\. Its checkout .* stays on disk\./)).toBeVisible();
  // The × is only a removal: the thread did not run in sketches (the item's own select).
  expect((await invocations()).filter((i) => i.name === "thread.run-in")).toEqual([]);

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
  // The thread's own checkout: the move in plain words, not the daemon's refusal naming this thread.
  await expectTooltip(page, item, "This checkout moved from feat/x to other; a new thread on feat/x would be refused here.");
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
