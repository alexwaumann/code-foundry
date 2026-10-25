import { expect, test, type Page } from "@playwright/test";
import { freshCopyByDefault, invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

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

/** The composer for a project from cmd+N, by its cmd+number. */
async function composeIn(page: Page, n: number): Promise<void> {
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
  await page.keyboard.press(`Meta+${String(n)}`);
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

/** The heading's set picker (a multi-select popover). */
async function openSetPicker(page: Page) {
  await page.getByTestId("composer-project-trigger").click();
  const list = page.getByTestId("composer-project-list");
  await expect(list).toBeVisible();
  return list;
}

/** The selected thread row's id. */
async function selectedThreadId(page: Page): Promise<string> {
  const created = page.locator('[data-row-kind="thread"][aria-selected="true"]');
  await expect(created).toBeVisible();
  return ((await created.getAttribute("data-row-key")) ?? "").slice(2);
}

test.beforeEach(async () => {
  await resetMock();
});

test("the set picker multi-selects: chips by id, the primary picker, sent as projects with the primary", async ({ page }) => {
  await openApp(page);
  await composeIn(page, 1);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in code-foundry?");
  // A lone project: no chips, only Add project; no primary picker.
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-add-project")).toHaveText("Add project");
  await expect(page.getByTestId("composer-primary")).toHaveCount(0);

  // Toggle two more projects in the heading's picker; it stays open, the set is checked.
  const list = await openSetPicker(page);
  await list.locator('[data-project="repo-sk"]').click();
  await list.locator('[data-project="repo-gp"]').click();
  await expect(list.locator('[data-project][data-current="true"]')).toHaveCount(3);
  // And one out again.
  await list.locator('[data-project="repo-sk"]').click();
  await expect(list.locator('[data-project][data-current="true"]')).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);

  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in 2 projects?");
  // Sorted by project id; the default primary is the first picked (code-foundry).
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(0)).toHaveAttribute("data-project", "repo-cf");
  await expect(chips(page).nth(1)).toHaveAttribute("data-project", "repo-gp");
  await expect(chips(page).nth(0)).toHaveAttribute("data-primary", "true");
  // In place (threads.default_worktree's default): each project's own checkout's branch.
  await expect(chips(page).nth(0).getByTestId("composer-member-branch")).toHaveText("main");
  await expect(page.getByTestId("composer-worktree")).toHaveText("In place");
  await expect(page.getByTestId("composer-base")).toHaveCount(0);

  const primary = page.getByTestId("composer-primary");
  await expect(primary).toHaveText("code-foundry");
  await primary.click();
  await expect(page.getByTestId("composer-primary-list").getByRole("option")).toHaveText([/^code-foundry/, /^ghostty-playground/]);
  await page.getByTestId("composer-primary-list").getByRole("option").filter({ hasText: "ghostty-playground" }).click();
  await expect(primary).toHaveText("ghostty-playground");
  await expect(chips(page).nth(1)).toHaveAttribute("data-primary", "true");

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
  // Line 2: "2 projects @ <the primary checkout's branch>" (no workspace badge).
  await expect(row(page, `s:${id}`).getByTestId("row-project")).toHaveText("2 projects");
  await expect(row(page, `s:${id}`).getByTestId("row-branch")).toHaveText("main");
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
  await expect(list.locator('[data-workspace="w-000000000001"]')).toHaveAttribute("data-current", "true");
  await page.keyboard.press("Escape");

  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in shop?");
  await expect(page.getByTestId("composer-workspace")).toContainText("shop");
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(0)).toHaveAttribute("data-project", "repo-cf");
  await expect(chips(page).nth(1)).toHaveAttribute("data-project", "repo-dot");
  await expect(chips(page).nth(0).getByTestId("composer-member-branch")).toHaveText("cf/…");
  await expect(page.getByTestId("composer-worktree")).toHaveText("Fresh copies");
  // The workspace's default primary.
  const primary = page.getByTestId("composer-primary");
  await expect(primary).toHaveText("dotfiles");
  await primary.click();
  const options = page.getByTestId("composer-primary-list").getByRole("option");
  await expect(options).toHaveText([/^Workspace\s*shop's own folder/, /^code-foundry/, /^dotfiles/]);
  await options.first().click();
  await expect(primary).toHaveText("Workspace");
  // The workspace's folder is no project: no base to pick.
  await expect(page.getByTestId("composer-base")).toHaveCount(0);

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

test("collision hints under the chips before send, and the daemon's after", async ({ page }) => {
  // sketches and the writing folder have no thread of their own in the mock's world.
  await mockPost("set-thread?projects=repo-sk,repo-wr&name=Busy%20one");
  await openApp(page);
  await page.keyboard.press("Meta+n");
  await page.getByTestId("palette").locator('[data-project="repo-sk"]').click();
  await expect(page.getByTestId("composer-input")).toBeFocused();
  // In place, sketches' own checkout is also Busy one's.
  await expect(page.getByTestId("composer-hint")).toHaveText(["sketches @ main is also open in Busy one"]);
  // A fresh copy shares nothing.
  await page.getByTestId("composer-worktree").click();
  await page.getByTestId("composer-worktree-list").getByRole("option").filter({ hasText: "A fresh copy of the project" }).click();
  await expect(page.getByTestId("composer-hints")).toHaveCount(0);
  // With the writing folder, fresh copies still share the folder: it cannot be isolated.
  await page.getByTestId("composer-add-project").click();
  await page.getByTestId("composer-add-project-list").getByRole("option").filter({ hasText: "writing" }).click();
  await expect(page.getByTestId("composer-worktree")).toHaveText("Fresh copies");
  await expect(page.getByTestId("composer-hint")).toHaveText(["writing is a folder, not a repo: thread Busy one also works there"]);
  // In place: both, and never a blocker.
  await page.getByTestId("composer-worktree").click();
  await page.getByTestId("composer-worktree-list").getByRole("option").filter({ hasText: "Each project's own folder" }).click();
  await expect(page.getByTestId("composer-hint")).toHaveText(["sketches @ main is also open in Busy one", "writing is also open in Busy one"]);
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Pair on the parser");
  await page.keyboard.press("Enter");
  await selectedThreadId(page);
  // After the Create: the daemon's hints as toasts (its label has the thread id).
  await expect(page.getByText(/^sketches @ main is also open in Busy one \(s-set-/)).toBeVisible();
});
test("Save as workspace: offered for an unsaved set of two or more, names it and sets the reference", async ({ page }) => {
  const t = (await mockPost("set-thread?projects=repo-cf,repo-gp&project=repo-gp&name=Pair")) as ThreadSummary;
  await openApp(page);
  await row(page, `s:${t.id}`).click();
  await expect(row(page, `s:${t.id}`).getByTestId("row-project")).toHaveText("2 projects");
  await page.getByTestId("pane-thread-menu").click();
  await expect(page.getByTestId("pane-thread-menu-items").getByRole("menuitem")).toHaveText(["New thread on this branch", "Save as workspace…"]);
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
  await expect(row(page, `s:${t.id}`).getByTestId("row-project")).toHaveText("parser pair");
  // Saved: the set matches a workspace now, so the item is gone.
  await page.getByTestId("pane-thread-menu").click();
  await expect(page.getByTestId("pane-thread-menu-items").getByRole("menuitem")).toHaveText(["New thread on this branch"]);
});

test("Save as workspace refuses a taken name in place", async ({ page }) => {
  await mockPost("workspace?name=taken&projects=repo-dot");
  const t = (await mockPost("set-thread?projects=repo-cf,repo-gp&name=Pair")) as ThreadSummary;
  await openApp(page);
  await row(page, `s:${t.id}`).click();
  await page.getByTestId("pane-thread-menu").click();
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
  await expect(row(page, `s:${t.id}`).getByTestId("row-project")).toHaveText("shop");
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
  await expect(chips(page).getByTestId("composer-member-branch")).toHaveText(["feat/parser", "feat/parser"]);
  await expect(page.getByTestId("composer-member-remove")).toHaveCount(0);
  await expect(page.getByTestId("composer-add-project")).toHaveCount(0);
  await expect(page.getByTestId("composer-like-mode")).toHaveText("On feat/parser");
  await expect(page.getByTestId("composer-worktree")).toHaveCount(0);
  await expect(page.getByTestId("composer-base")).toHaveCount(0);
  // The same checkouts as the thread it copies: said, not blocked.
  await expect(page.getByTestId("composer-hint").first()).toContainText("is also open in Parser");
  // The primary is the thread's, changeable.
  const primary = page.getByTestId("composer-primary");
  await expect(primary).toHaveText("code-foundry");
  await primary.click();
  await expect(page.getByTestId("composer-primary-list").getByRole("option")).toHaveText([/^Workspace/, /^code-foundry/, /^ghostty-playground/]);
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
  await expect(row(page, `s:${id}`).getByTestId("row-project")).toHaveText("shop");
  await expect(row(page, `s:${id}`).getByTestId("row-branch")).toHaveText("feat/parser");
});

test("New thread on this branch from the header menu and the palette; Escape goes back to the thread", async ({ page }) => {
  const t = (await mockPost("set-thread?projects=repo-cf&name=Solo")) as ThreadSummary;
  await openApp(page);
  await row(page, `s:${t.id}`).click();
  await page.getByTestId("pane-thread-menu").click();
  // A single project: nothing to save.
  await expect(page.getByTestId("pane-thread-menu-items").getByRole("menuitem")).toHaveText(["New thread on this branch"]);
  await page.getByTestId("menu-new-like").click();
  await expect(page.getByTestId("composer")).toHaveAttribute("data-like", t.id);
  // In place on main: the heading names the thread; one chip; no primary picker.
  await expect(page.getByTestId("composer-heading")).toHaveText("What's next beside Solo?");
  await expect(chips(page)).toHaveCount(1);
  await expect(page.getByTestId("composer-like-mode")).toHaveText("In place");
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
