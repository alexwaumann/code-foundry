import { expect, test, type Page } from "@playwright/test";
import { composeProject, freshCopyByDefault, invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * Workspaces v2 in the GUI (docs/notes/workspaces-v2-3-composer.md): the composer's
 * project set (multi-select, chips by id, the primary picker), collision hints, Save as
 * workspace, sidebar line 2 of a multi-project thread, New thread on this branch.
 */

interface ThreadSummary {
  id: string;
  name: string;
  projectId: string;
  projectIds: string[];
  worktreePath: string;
  workspaceId: string;
  branch: string;
  createdWorktree: boolean;
}

async function threads(): Promise<ThreadSummary[]> {
  const res = await fetch(`${mockUrl}/__mock/threads`);
  return (await res.json()) as ThreadSummary[];
}

async function lastInvoked(name: string): Promise<Record<string, string>> {
  await expect.poll(async () => (await invocations()).filter((i) => i.name === name).length).toBeGreaterThan(0);
  return (await invocations()).filter((i) => i.name === name).at(-1)?.args ?? {};
}

function chips(page: Page) {
  return page.getByTestId("composer-member");
}

/** The composer for a project from cmd+N, the nth project row. */
async function composeIn(page: Page, n: number): Promise<void> {
  await composeProject(page, n);
}

/** The heading's picker (one pick: a workspace or a project). */
async function openSetPicker(page: Page) {
  await page.getByTestId("composer-project-trigger").click();
  const list = page.getByTestId("composer-project-list");
  await expect(list).toBeVisible();
  return list;
}

/** The chip row's "Add project" (a multi-select that stays open). */
async function openAddProject(page: Page) {
  await page.getByTestId("composer-add-project").click();
  const list = page.getByTestId("composer-add-project-list");
  await expect(list).toBeVisible();
  return list;
}

const option = (list: ReturnType<Page["getByTestId"]>, name: string) => list.getByRole("option").filter({ hasText: name });

/** The selected thread row's id. */
async function selectedThreadId(page: Page): Promise<string> {
  const created = page.locator('[data-row-kind="thread"][aria-selected="true"]');
  await expect(created).toBeVisible();
  return ((await created.getAttribute("data-row-key")) ?? "").slice(2);
}

test.beforeEach(async () => {
  await resetMock();
});

test("Add project multi-selects: chips by id, the primary picker, sent as projects with the primary", async ({ page }) => {
  await openApp(page);
  await composeIn(page, 1);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in code-foundry?");
  // A lone project: no chips, only Add project; no primary picker, no Clear.
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-add-project")).toHaveText("Add project");
  await expect(page.getByTestId("composer-primary")).toHaveCount(0);
  await expect(page.getByTestId("composer-clear")).toHaveCount(0);

  // Toggle two more projects in Add project; it stays open, the set is checked, by name.
  const list = await openAddProject(page);
  await expect(list.getByRole("option")).toHaveText([/^code-foundry/, /^dotfiles/, /^ghostty-playground/, /^sketches/, /^writing/]);
  await expect(list.locator("[data-checked]")).toHaveText([/^code-foundry/]);
  await option(list, "sketches").click();
  await option(list, "ghostty-playground").click();
  await expect(list.locator("[data-checked]")).toHaveCount(3);
  // And one out again.
  await option(list, "sketches").click();
  await expect(list.locator("[data-checked]")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();

  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in 2 projects?");
  // Add project first, then the chips, then Clear.
  await expect(page.getByTestId("composer-members").locator("> li").first().getByTestId("composer-add-project")).toBeVisible();
  await expect(page.getByTestId("composer-clear")).toHaveText("Clear");
  // Sorted by project id; the default primary is the first picked (code-foundry).
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(0)).toHaveAttribute("data-project", "repo-cf");
  await expect(chips(page).nth(1)).toHaveAttribute("data-project", "repo-gp");
  // Name only: the primary and the branch are the pickers' to show.
  await expect(chips(page).nth(0)).toHaveText("code-foundry");
  await expect(chips(page).nth(0)).not.toHaveAttribute("data-primary");
  // In place (threads.default_worktree's default).
  await expect(page.getByTestId("composer-worktree")).toHaveText("Project folders");
  await expect(page.getByTestId("composer-base")).toHaveCount(0);

  const primary = page.getByTestId("composer-primary");
  await expect(primary).toHaveText("code-foundry");
  await expect(primary).toHaveAccessibleName("Run in: code-foundry");
  // Work in on the left, Run in on the right of the same row.
  const [work, run] = await Promise.all([page.getByTestId("composer-worktree").boundingBox(), primary.boundingBox()]);
  const card = await page.getByTestId("composer-card").boundingBox();
  expect(work && run && card && Math.abs(work.y - run.y) < 2 && run.x + run.width > card.x + card.width - 16 && work.x < card.x + card.width / 2).toBe(true);
  await primary.click();
  await expect(page.getByTestId("composer-primary-list").getByRole("option")).toHaveText([/^code-foundry/, /^ghostty-playground/]);
  await page.getByTestId("composer-primary-list").getByRole("option").filter({ hasText: "ghostty-playground" }).click();
  await expect(primary).toHaveText("ghostty-playground");
  // A pill's pick hands focus to the prompt.
  await expect(page.getByTestId("composer-input")).toBeFocused();

  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Share the login types");
  await page.keyboard.press("Enter");
  expect(await lastInvoked("thread.new")).toEqual({
    project: "repo-gp",
    projects: "repo-cf,repo-gp",
    "new-worktree": "false",
    model: "claude-sonnet-5[1m]",
    effort: "medium",
    permission: "auto",
    prompt: "Share the login types",
  });
  const id = await selectedThreadId(page);
  expect((await threads()).find((t) => t.id === id)).toMatchObject({ projectId: "repo-gp", projectIds: ["repo-cf", "repo-gp"], workspaceId: "", createdWorktree: false });
  // Line 2: the run-in project @ its checkout's branch, never the set's "2 projects" (no workspace badge).
  await expect(row(page, `s:${id}`).getByTestId("row-project")).toHaveText("ghostty-playground");
  await expect(row(page, `s:${id}`).getByTestId("row-branch")).toHaveText("main");
});

/** The composer for code-foundry with ghostty-playground added: a set of two git projects. */
async function composeTwo(page: Page): Promise<void> {
  await composeIn(page, 1);
  const list = await openAddProject(page);
  await option(list, "ghostty-playground").click();
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in 2 projects?");
}

test("Work in: an existing branch for a set, from every project's branches; thread.new gets it, no base", async ({ page }) => {
  await freshCopyByDefault();
  await openApp(page);
  await composeTwo(page);
  const worktree = page.getByTestId("composer-worktree");
  await expect(worktree).toHaveText("Fresh copies");
  await worktree.click();
  const list = page.getByTestId("composer-worktree-list");
  const options = list.getByRole("option");
  // The two choices, then both projects' branches merged by name, newest first, without
  // the default branch (main, both projects'): Project folders works on it.
  await expect(options).toHaveText([/^Fresh copies\s*Edits land/, /^Project folders\s*Edits land/, "feat/sidebar", "fix/resize", "release/v0.3"]);
  await expect(options.filter({ hasText: /^main$/ })).toHaveCount(0);
  // The search filters the branches only; the choices stay.
  await expect(list.getByPlaceholder("Find existing branch")).toBeFocused();
  await page.keyboard.type("resize");
  await expect(options).toHaveText([/^Fresh copies/, /^Project folders/, "fix/resize"]);
  // Enter picks the first match, not a choice above the search.
  await page.keyboard.press("Enter");
  await expect(worktree).toHaveText("fix/resize");
  await expect(page.getByTestId("composer-base")).toHaveCount(0);

  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Fix the resize glitch");
  await page.keyboard.press("Enter");
  expect(await lastInvoked("thread.new")).toEqual({
    project: "repo-cf",
    projects: "repo-cf,repo-gp",
    "new-worktree": "true",
    branch: "fix/resize",
    model: "claude-sonnet-5[1m]",
    effort: "medium",
    permission: "auto",
    prompt: "Fix the resize glitch",
  });
  const id = await selectedThreadId(page);
  expect((await threads()).find((t) => t.id === id)).toMatchObject({ branch: "fix/resize", createdWorktree: true });
});

test("Branch from: Default branches first, the branches every project has, the rule as a footer; every project gets the pick", async ({ page }) => {
  await freshCopyByDefault();
  await openApp(page);
  await composeTwo(page);
  const base = page.getByTestId("composer-base");
  await expect(base).toHaveText("From defaults");
  await base.click();
  const list = page.getByTestId("composer-base-list");
  const options = list.getByRole("option");
  // fix/resize is code-foundry's only; main is both projects' default branch (the first row).
  await expect(options).toHaveText(["Default branches", "feat/sidebar", "release/v0.3"]);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(list.locator('[data-slot="picker-footer"]')).toHaveText("Each project takes origin's copy of the branch, or its own when that is ahead.");
  // The filter box filters the whole list.
  await expect(list.getByPlaceholder("Filter branches…")).toBeFocused();
  await page.keyboard.type("release");
  await expect(options).toHaveText(["release/v0.3"]);
  await page.keyboard.press("Enter");
  await expect(base).toHaveText("From release/v0.3");

  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Backport the fix");
  await page.keyboard.press("Enter");
  expect(await lastInvoked("thread.new")).toEqual({
    project: "repo-cf",
    projects: "repo-cf:release/v0.3,repo-gp:release/v0.3",
    "new-worktree": "true",
    model: "claude-sonnet-5[1m]",
    effort: "medium",
    permission: "auto",
    prompt: "Backport the fix",
  });
});

test("Branch from: no footer while projects.base_from_origin is off", async ({ page }) => {
  await freshCopyByDefault();
  await mockPost("settings/external?projects.base_from_origin=false");
  await openApp(page);
  await composeTwo(page);
  await page.getByTestId("composer-base").click();
  const list = page.getByTestId("composer-base-list");
  await expect(list.getByRole("option")).toHaveText(["Default branches", "feat/sidebar", "release/v0.3"]);
  await expect(list.locator('[data-slot="picker-footer"]')).toHaveCount(0);
});

test("a workspace row selects its members and the reference; Workspace as the primary; fresh copies", async ({ page }) => {
  await freshCopyByDefault();
  await mockPost("workspace?name=shop&projects=repo-cf,repo-dot&primary=repo-dot");
  await openApp(page);
  await composeIn(page, 2);
  const list = await openSetPicker(page);
  await expect(list.locator("[cmdk-group-heading]")).toHaveText(["Workspaces", "Projects"]);
  await expect(list.locator('[data-workspace="w-000000000001"]').getByTestId("workspace-detail")).toHaveText("code-foundry, dotfiles");
  await list.locator('[data-workspace="w-000000000001"]').click();
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in shop?");
  await page.getByTestId("composer-project-trigger").click();
  await expect(list.locator('[data-workspace="w-000000000001"]')).toHaveAttribute("data-current", "true");
  await expect(list.locator("[data-current]")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await expect(page.getByTestId("composer-workspace")).toContainText("shop");
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(0)).toHaveAttribute("data-project", "repo-cf");
  await expect(chips(page).nth(1)).toHaveAttribute("data-project", "repo-dot");
  await expect(chips(page).nth(0)).toHaveText("code-foundry");
  await expect(page.getByTestId("composer-worktree")).toHaveText("Fresh copies");
  // The workspace's default primary.
  const primary = page.getByTestId("composer-primary");
  await expect(primary).toHaveText("dotfiles");
  await primary.click();
  const options = page.getByTestId("composer-primary-list").getByRole("option");
  await expect(options).toHaveText([/^Workspace folder\s*shop's folder/, /^code-foundry/, /^dotfiles/]);
  await options.first().click();
  await expect(primary).toHaveText("Workspace folder");
  // A base applies to every git project, whichever runs the thread: Branch from stays.
  await expect(page.getByTestId("composer-base")).toHaveText("From defaults");

  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Ship the shop banner");
  await page.keyboard.press("Enter");
  expect(await lastInvoked("thread.new")).toEqual({
    project: "workspace",
    projects: "repo-cf,repo-dot",
    workspace: "w-000000000001",
    "new-worktree": "true",
    model: "claude-sonnet-5[1m]",
    effort: "medium",
    permission: "auto",
    prompt: "Ship the shop banner",
  });
  const id = await selectedThreadId(page);
  expect((await threads()).find((t) => t.id === id)).toMatchObject({ projectId: "", workspaceId: "w-000000000001", branch: "cf/ship-the-shop-banner", createdWorktree: true });
  await expect(row(page, `s:${id}`).getByTestId("row-project")).toHaveText("shop");
  await expect(row(page, `s:${id}`).getByTestId("row-branch")).toHaveText("cf/ship-the-shop-banner");
  await expect(row(page, `s:${id}`).getByTestId("row-workspace")).toHaveCount(0);
});

test("the workspace chip's × takes its members with it; Clear empties the set; every × goes to the prompt", async ({ page }) => {
  await mockPost("workspace?name=shop&projects=repo-cf,repo-dot");
  await openApp(page);
  await composeIn(page, 3);
  // ghostty-playground, then the workspace: its two members are the set, the reference is set.
  const heading = await openSetPicker(page);
  await heading.locator('[data-workspace="w-000000000001"]').click();
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in shop?");
  await expect(chips(page)).toHaveCount(2);
  // × on the workspace: shop and its members go; no tooltip on a chip's ×.
  const remove = page.getByTestId("composer-workspace-remove");
  await expect(remove).toHaveAccessibleName("Remove workspace shop");
  await remove.hover();
  await page.waitForTimeout(700);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await remove.click();
  await expect(page.getByTestId("composer-workspace")).toHaveCount(0);
  await expect(page.getByTestId("composer-heading")).toHaveText("Pick a project");
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();

  // Clear: a set of two to nothing, the empty state.
  const again = await openAddProject(page);
  await option(again, "sketches").click();
  await option(again, "ghostty-playground").click();
  await page.keyboard.press("Escape");
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).getByTestId("composer-member-remove")).toHaveCount(2);
  await page.getByTestId("composer-clear").click();
  await expect(page.getByTestId("composer-heading")).toHaveText("Pick a project");
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-clear")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  // Add project is still there to start again.
  const back = await openAddProject(page);
  await option(back, "dotfiles").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in dotfiles?");
});

test("the collision banner before send, and the daemon's hints after", async ({ page }) => {
  // sketches and the writing folder have no thread of their own in the mock's world.
  await mockPost("set-thread?projects=repo-sk,repo-wr&name=Busy%20one");
  await openApp(page);
  await page.keyboard.press("Meta+n");
  await page.getByTestId("palette").locator('[data-project="repo-sk"]').click();
  await expect(page.getByTestId("composer-input")).toBeFocused();
  // In place, sketches' own checkout is also Busy one's (a running thread).
  const banner = page.getByTestId("composer-collision");
  await expect(banner.getByTestId("composer-collision-text")).toHaveText(
    "This project is already being edited on main by another running thread. Multiple agents changing the same file at the same time can overwrite each other's work.",
  );
  await expect(page.getByTestId("composer-worktree-warning")).toBeVisible();
  // "Use a new branch": a fresh copy shares nothing.
  await banner.getByTestId("composer-collision-new-branch").click();
  await expect(page.getByTestId("composer-worktree")).toHaveText("Fresh copy");
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("composer-worktree-warning")).toHaveCount(0);
  // With the writing folder, fresh copies still share the folder: it cannot be isolated. Already on a new branch: no button.
  await page.getByTestId("composer-add-project").click();
  await page.getByTestId("composer-add-project-list").getByRole("option").filter({ hasText: "writing" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer-worktree")).toHaveText("Fresh copies");
  await expect(banner.getByTestId("composer-collision-text")).toContainText("1 of 2 projects is already being edited by another running thread.");
  await expect(banner.getByTestId("composer-collision-new-branch")).toHaveCount(0);
  // In place: both, one banner, never a blocker.
  await page.getByTestId("composer-worktree").click();
  await page.getByTestId("composer-worktree-list").getByRole("option").filter({ hasText: "Project folders" }).click();
  await expect(banner).toHaveCount(1);
  await expect(banner.getByTestId("composer-collision-text")).toContainText("2 of 2 projects are already being edited by another running thread.");
  await expect(banner.getByTestId("composer-collision-new-branch")).toBeVisible();
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Pair on the parser");
  await page.keyboard.press("Enter");
  await selectedThreadId(page);
  // After the Create: the daemon's hints repeat the lines shown above, so no toast says them again (composer-fixes.spec.ts).
  await expect(page.getByTestId("composer")).toHaveCount(0);
});
test("Save as workspace: offered for an unsaved set of two or more, names it and sets the reference", async ({ page }) => {
  const t = (await mockPost("set-thread?projects=repo-cf,repo-gp&project=repo-gp&name=Pair")) as ThreadSummary;
  await openApp(page);
  await row(page, `s:${t.id}`).click();
  await expect(row(page, `s:${t.id}`).getByTestId("row-project")).toHaveText("ghostty-playground");
  await page.getByTestId("thread-title").click();
  await expect(page.getByTestId("thread-title-menu").locator('[data-testid="menu-new-like"], [data-testid="menu-save-workspace"]')).toHaveText(["New thread on this branch", "Save as workspace"]);
  await page.getByTestId("menu-save-workspace").click();
  const dialog = page.getByTestId("save-workspace-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("save-workspace-projects")).toHaveText("code-foundry, ghostty-playground");
  await expect(dialog.getByTestId("save-workspace-name")).toBeFocused();
  await page.keyboard.type("parser pair");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(await lastInvoked("workspace.new")).toEqual({ name: "parser pair", projects: "repo-cf,repo-gp", primary: "repo-gp" });
  expect(await lastInvoked("thread.workspace")).toEqual({ workspace: "w-000000000001" });
  await expect.poll(async () => (await threads()).find((x) => x.id === t.id)?.workspaceId).toBe("w-000000000001");
  // Line 2 keeps the run-in project; the workspace's name shows on the card.
  await expect(row(page, `s:${t.id}`).getByTestId("row-project")).toHaveText("ghostty-playground");
  // Saved: the set matches a workspace now, so the item is gone.
  await page.getByTestId("thread-title").click();
  await expect(page.getByTestId("thread-title-menu").locator('[data-testid="menu-new-like"], [data-testid="menu-save-workspace"]')).toHaveText(["New thread on this branch"]);
});

test("Save as workspace refuses a taken name in place", async ({ page }) => {
  await mockPost("workspace?name=taken&projects=repo-dot");
  const t = (await mockPost("set-thread?projects=repo-cf,repo-gp&name=Pair")) as ThreadSummary;
  await openApp(page);
  await row(page, `s:${t.id}`).click();
  await page.getByTestId("thread-title").click();
  await page.getByTestId("menu-save-workspace").click();
  await expect(page.getByTestId("save-workspace-name")).toBeFocused();
  await page.keyboard.type("Taken");
  await page.getByTestId("save-workspace-submit").click();
  await expect(page.getByTestId("save-workspace-error")).toContainText(`a workspace named "taken" exists`);
  await expect(page.getByTestId("save-workspace-dialog")).toBeVisible();
});

test("New thread on this branch: the row menu opens the composer prefilled; only the prompt and primary change", async ({ page }) => {
  await mockPost("workspace?name=shop&projects=repo-cf,repo-gp");
  const t = (await mockPost("set-thread?projects=repo-cf,repo-gp&workspace=shop&branch=feat/parser&name=Parser")) as ThreadSummary;
  await openApp(page);
  await expect(row(page, `s:${t.id}`).getByTestId("row-project")).toHaveText("code-foundry");
  await expect(row(page, `s:${t.id}`).getByTestId("row-branch")).toHaveText("feat/parser");
  await row(page, `s:${t.id}`).click({ button: "right" });
  await page.getByTestId("row-menu").getByTestId("menu-new-like").click();

  await expect(page.getByTestId("composer")).toHaveAttribute("data-like", t.id);
  await expect(page.getByTestId("composer-heading")).toHaveText("What's next on feat/parser?");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  // What the daemon copies, read-only: the workspace, the set by id on the thread's branch, the mode.
  await expect(page.getByTestId("composer-workspace")).toContainText("shop");
  await expect(page.getByTestId("composer-workspace-remove")).toHaveCount(0);
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).getByTestId("composer-member-branch")).toHaveCount(0);
  await expect(page.getByTestId("composer-member-remove")).toHaveCount(0);
  await expect(page.getByTestId("composer-add-project")).toHaveCount(0);
  await expect(page.getByTestId("composer-like-mode")).toHaveText("On feat/parser");
  await expect(page.getByTestId("composer-worktree")).toHaveCount(0);
  await expect(page.getByTestId("composer-base")).toHaveCount(0);
  // The same checkouts as the thread it copies: said, not blocked.
  await expect(page.getByTestId("composer-collision")).toContainText("already being edited on feat/parser by another running thread.");
  // Its mode is its thread's: nothing to switch.
  await expect(page.getByTestId("composer-collision-new-branch")).toHaveCount(0);
  await expect(page.getByTestId("composer-like-mode")).toHaveAttribute("data-warning", "");
  // The primary is the thread's, changeable.
  const primary = page.getByTestId("composer-primary");
  await expect(primary).toHaveText("code-foundry");
  await primary.click();
  await expect(page.getByTestId("composer-primary-list").getByRole("option")).toHaveText([/^Workspace folder/, /^code-foundry/, /^ghostty-playground/]);
  await page.getByTestId("composer-primary-list").getByRole("option").filter({ hasText: "ghostty-playground" }).click();

  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Add the error cases");
  await page.keyboard.press("Enter");
  expect(await lastInvoked("thread.new-like")).toEqual({
    id: t.id,
    project: "repo-gp",
    model: "claude-sonnet-5[1m]",
    effort: "medium",
    permission: "auto",
    prompt: "Add the error cases",
  });
  const id = await selectedThreadId(page);
  expect(id).not.toBe(t.id);
  expect((await threads()).find((x) => x.id === id)).toMatchObject({ projectId: "repo-gp", projectIds: ["repo-cf", "repo-gp"], workspaceId: "w-000000000001", branch: "feat/parser", createdWorktree: true });
  await expect(row(page, `s:${id}`).getByTestId("row-project")).toHaveText("ghostty-playground");
  await expect(row(page, `s:${id}`).getByTestId("row-branch")).toHaveText("feat/parser");
});

test("New thread on this branch from the title menu and the palette; Escape goes back to the thread", async ({ page }) => {
  const t = (await mockPost("set-thread?projects=repo-cf&name=Solo")) as ThreadSummary;
  await openApp(page);
  await row(page, `s:${t.id}`).click();
  await page.getByTestId("thread-title").click();
  // A single project: nothing to save.
  await expect(page.getByTestId("thread-title-menu").locator('[data-testid="menu-new-like"], [data-testid="menu-save-workspace"]')).toHaveText(["New thread on this branch"]);
  await page.getByTestId("menu-new-like").click();
  await expect(page.getByTestId("composer")).toHaveAttribute("data-like", t.id);
  // In place on main: the heading names the project; one chip; no primary picker.
  await expect(page.getByTestId("composer-heading")).toHaveText("What's next in code-foundry?");
  await expect(chips(page)).toHaveCount(1);
  await expect(page.getByTestId("composer-like-mode")).toHaveText("Project folder");
  await expect(page.getByTestId("composer-primary")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(row(page, `s:${t.id}`)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Meta+k");
  await page.keyboard.type("New thread on this branch");
  await page.getByTestId("palette").getByRole("option", { name: /New thread on this branch/ }).first().click();
  await expect(page.getByTestId("composer")).toHaveAttribute("data-like", t.id);
  await expect(page.getByTestId("composer-input")).toBeFocused();
});

test("a workspace removed while its composer is open says so", async ({ page }) => {
  await mockPost("workspace?name=login&projects=repo-cf,repo-gp");
  await openApp(page);
  await page.keyboard.press("Meta+n");
  await page.getByTestId("palette").locator('[data-workspace="w-000000000001"]').click();
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in login?");
  await mockPost("reset");
  await expect(page.getByTestId("composer")).toHaveText("This workspace no longer exists.");
});

/** SHOTS=<dir>: the PR's screenshots, WebKit, 1440x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await freshCopyByDefault();
    await mockPost("workspace?name=shop&projects=repo-cf,repo-dot");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await composeIn(page, 1);
    const heading = await openSetPicker(page);
    await heading.locator('[data-workspace="w-000000000001"]').click();
    const add = await openAddProject(page);
    await option(add, "ghostty-playground").click();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/add-project-${scheme}.png` });
    await page.keyboard.press("Escape");
    await expect(add).toHaveCount(0);
    await page.getByTestId("composer-input").click();
    await page.keyboard.type("Ship the shop banner");
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/set-${scheme}.png` });
  });
}
