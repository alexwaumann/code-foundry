import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, mockUrl, openApp, openProjects, resetMock, row } from "./fixtures";

/** Where the mock (like the daemon) puts a repo's worktree for a cf/<name> branch. */
const WT = "/Users/dev/.code-foundry/worktrees/alexwaumann";
const CF_LOGIN = `${WT}/code-foundry/cf-login`;
const GP_LOGIN = `${WT}/ghostty-playground/cf-login`;
const WS = "w-000000000001";

interface SessionSummary {
  id: string;
  repoId: string;
  worktreePath: string;
  workspaceId: string;
  pendingWorktreePath: string;
  pinned: boolean;
}

async function session(id: string): Promise<SessionSummary | undefined> {
  const res = await fetch(`${mockUrl}/__mock/sessions`);
  return ((await res.json()) as SessionSummary[]).find((s) => s.id === id);
}

/** A workspace "login" over code-foundry and ghostty-playground with a thread "driver" in the ghostty-playground member. */
async function workspaceWithThread(): Promise<string> {
  await mockPost("workspace?name=login&repos=repo-cf,repo-gp");
  const s = (await mockPost("workspace-thread?workspace=login&repo=repo-gp&name=driver")) as { id: string };
  return s.id;
}

function list(page: Page) {
  return page.getByTestId("thread-list");
}

/** Row keys in display order, headers as "# Label". */
async function rowKeys(page: Page): Promise<string[]> {
  return list(page)
    .locator("[data-row-key]")
    .evaluateAll((els) => els.map((e) => (e.getAttribute("data-row-kind") === "header" ? `# ${e.textContent}` : (e.getAttribute("data-row-key") ?? ""))));
}

async function lastInvocation(name: string) {
  await expect.poll(async () => (await invocations()).filter((i) => i.name === name).length).toBeGreaterThan(0);
  return (await invocations()).filter((i) => i.name === name).at(-1);
}

test.beforeEach(async () => {
  await resetMock();
});

test("the sidebar is a flat thread list: sections on top, workspace badges, no repo or worktree rows", async ({ page }) => {
  const driver = await workspaceWithThread();
  await openApp(page);
  await expect(row(page, `s:${driver}`)).toBeVisible();
  await expect(page.getByTestId("sidebar-band")).toContainText("Code Foundry");
  // Needs attention (s-2) on top, then threads newest first, then terminals no thread owns.
  await expect.poll(() => rowKeys(page)).toEqual([
    "# Needs attention",
    "s:s-2",
    "# Threads",
    `s:${driver}`,
    "s:s-5",
    "s:s-1",
    "s:s-6",
    "s:s-4",
    "s:s-3",
    "# Terminals",
    "t:t-logs",
    "t:t-top",
    "t:t-tests",
    "t:t-tmp",
  ]);
  await expect(list(page).locator('[data-row-kind="repo"], [data-row-kind="worktree"], [data-row-kind="group"]')).toHaveCount(0);

  // A workspace thread: its cwd's project and branch, and the workspace badge.
  const d = row(page, `s:${driver}`);
  await expect(d.getByTestId("session-name")).toHaveText("driver");
  await expect(d.getByTestId("row-project")).toHaveText("ghostty-playground");
  await expect(d.getByTestId("row-branch")).toHaveText("cf/login");
  await expect(d.getByTestId("row-workspace")).toHaveText("login");
  // A project thread: no badge.
  const s1 = row(page, "s:s-1");
  await expect(s1.getByTestId("row-project")).toHaveText("code-foundry");
  await expect(s1.getByTestId("row-branch")).toHaveText("main");
  await expect(s1.getByTestId("row-workspace")).toHaveCount(0);
  // Terminals keep a terminal glyph and say where they run.
  await expect(row(page, "t:t-top").getByTestId("row-place")).toHaveText("code-foundry · feat/sidebar");
  await expect(row(page, "t:t-tmp").getByTestId("row-place")).toHaveText("/tmp");

  // Keyboard: ↓ skips headers; Enter selects.
  await list(page).focus();
  await page.keyboard.press("Home");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", "row-s:s-2");
  await page.keyboard.press("ArrowDown");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", `row-s:${driver}`);
  await page.keyboard.press("Enter");
  await expect(d).toHaveAttribute("aria-selected", "true");
  // cmd+1 is the first row (the attention thread), cmd+2 the next.
  await page.keyboard.press("Meta+2");
  await expect(d).toHaveAttribute("aria-selected", "true");
});

test("pin from the context menu moves a thread to Pinned; unpin moves it back", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click({ button: "right" });
  const menu = page.getByTestId("row-menu");
  await expect(menu).toBeVisible();
  await menu.getByTestId("menu-pin").click();
  await expect.poll(async () => (await session("s-3"))?.pinned).toBe(true);
  const pin = await lastInvocation("session.pin");
  expect(pin?.args).toEqual({ pinned: "true" });
  expect(pin?.context?.activeSessionId).toBe("s-3");
  await expect.poll(async () => (await rowKeys(page)).slice(0, 3)).toEqual(["# Pinned", "s:s-3", "# Needs attention"]);
  await expect(row(page, "s:s-3").getByTestId("row-pinned")).toBeVisible();

  await row(page, "s:s-3").click({ button: "right" });
  await expect(page.getByTestId("menu-pin")).toHaveText("Unpin");
  await page.getByTestId("menu-pin").click();
  await expect.poll(async () => (await rowKeys(page)).slice(0, 2)).toEqual(["# Needs attention", "s:s-2"]);
});

test("Run in… from the context menu moves a workspace thread; the row shows the queued move", async ({ page }) => {
  const driver = await workspaceWithThread();
  await openApp(page);
  const d = row(page, `s:${driver}`);
  await d.click({ button: "right" });
  await page.getByTestId("menu-run-in").click();
  const members = page.getByTestId("menu-run-in-members");
  await expect(members.locator("[data-member]")).toHaveCount(2);
  await expect(members.locator('[data-member="repo-gp"]')).toContainText("runs here");
  await expect(members.locator('[data-member="repo-gp"]')).toHaveAttribute("data-disabled", "");
  await members.locator('[data-member="repo-cf"]').click();

  const inv = await lastInvocation("session.run-in");
  expect(inv?.args).toEqual({ repo: "repo-cf" });
  expect(inv?.context).toMatchObject({ activeSessionId: driver, activeWorkspaceId: WS, activeView: "session" });
  // Queued until the thread is idle at its prompt (the mock: ~2s), then the row's worktree changes.
  await expect(d.getByTestId("row-moving")).toHaveText("moving to code-foundry…");
  await expect(d.getByTestId("row-moving")).toHaveCount(0, { timeout: 8000 });
  await expect(d.getByTestId("row-project")).toHaveText("code-foundry");
  await expect(d.getByTestId("row-branch")).toHaveText("cf/login");
  await expect(d.getByTestId("row-workspace")).toHaveText("login");
  expect(await session(driver)).toMatchObject({ repoId: "repo-cf", worktreePath: CF_LOGIN, pendingWorktreePath: "" });
});

test("Run in… is absent for a project thread and offered in the palette for a workspace thread", async ({ page }) => {
  const driver = await workspaceWithThread();
  await openApp(page);
  // Project thread: no menu entry, and the daemon lists the command as unavailable.
  await row(page, "s:s-1").click({ button: "right" });
  await expect(page.getByTestId("row-menu")).toBeVisible();
  await expect(page.getByTestId("menu-run-in")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await page.keyboard.type("Run Thread In");
  await expect(palette.locator('[data-command="session.run-in"]')).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Workspace thread: the palette offers it; picking it lists the other members.
  await row(page, `s:${driver}`).click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Run Thread In");
  await palette.locator('[data-command="session.run-in"]').click();
  const picker = page.getByTestId("runin-picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator('[data-member="repo-gp"]')).toContainText("runs here");
  await picker.locator('[data-member="repo-cf"]').click();
  await expect(picker).toHaveCount(0);
  const inv = await lastInvocation("session.run-in");
  expect(inv?.args).toEqual({ repo: "repo-cf" });
  expect(inv?.context).toMatchObject({ activeSessionId: driver, activeWorkspaceId: WS });
  await expect(row(page, `s:${driver}`).getByTestId("row-moving")).toBeVisible();
});

test("the Projects page lists projects with their own worktrees and workspaces with their members", async ({ page }) => {
  await workspaceWithThread();
  await openApp(page);
  // The chord (view.projects) opens it, like the nav entry.
  await page.keyboard.press("Meta+Shift+j");
  await expect(page.getByTestId("projects-page")).toBeVisible();
  await expect(page.getByTestId("nav-projects")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("projects-counts")).toHaveText("5 projects · 1 workspace");
  await expect(page.getByTestId("project-name")).toHaveText(["code-foundry", "dotfiles", "ghostty-playground", "sketches", "writing"]);

  // code-foundry's own worktrees; its cf/login worktree is listed under the workspace only.
  const cf = page.locator('[data-testid="project"][data-repo="repo-cf"]');
  await expect(cf.getByTestId("worktree-branch")).toHaveText(["main", "feat/sidebar", "fix/resize"]);
  await expect(cf.getByTestId("project-in-workspaces")).toHaveText("1 worktree is in workspaces (below)");
  const feat = cf.locator(`[data-path="${CF}.worktrees/feat-sidebar"]`);
  await expect(feat.getByTestId("worktree-dirty")).toBeVisible();
  await expect(feat.getByTestId("worktree-ahead")).toHaveText("2");
  await expect(feat.getByTestId("worktree-pr")).toContainText("#142");

  // The workspace: name, branch, members with their state.
  const ws = page.locator(`[data-testid="workspace"][data-workspace="${WS}"]`);
  await expect(ws.getByTestId("workspace-name")).toHaveText("login");
  await expect(ws.getByTestId("workspace-branch")).toHaveText("cf/login");
  await expect(ws.getByTestId("member-name")).toHaveText(["code-foundry", "ghostty-playground"]);
  await expect(ws.getByTestId("worktree-branch")).toHaveText(["cf/login", "cf/login"]);

  // Add a member (workspace.add-repo).
  await ws.getByTestId("workspace-add-member").click();
  await page.getByTestId("workspace-add-member-list").getByRole("option", { name: "dotfiles" }).click();
  const add = await lastInvocation("workspace.add-repo");
  expect(add?.args).toEqual({ repo: "dotfiles", workspace: WS });
  await expect(ws.getByTestId("member-name")).toHaveText(["code-foundry", "ghostty-playground", "dotfiles"]);

  // Remove one (workspace.remove-repo, confirmed).
  const member = ws.locator('[data-nav-key="m:w-000000000001::repo-cf"]');
  await member.hover();
  await member.getByTestId("member-remove").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Remove project code-foundry from its workspace?");
  await dialog.getByTestId("confirm-ok").click();
  await expect(ws.getByTestId("member-name")).toHaveText(["ghostty-playground", "dotfiles"]);
  const removed = (await invocations()).filter((i) => i.name === "workspace.remove-repo");
  expect(removed.map((i) => i.confirmed)).toEqual([false, true]);
  expect(removed.at(-1)?.args).toEqual({ repo: "code-foundry", workspace: WS });
  // The worktree is gone from disk (and so from the projects too).
  await expect(cf.getByTestId("project-in-workspaces")).toHaveCount(0);

  // A member with a live thread is refused, and stays.
  const gp = ws.locator('[data-nav-key="m:w-000000000001::repo-gp"]');
  await gp.hover();
  await gp.getByTestId("member-remove").click();
  await page.getByTestId("confirm-dialog").getByTestId("confirm-ok").click();
  await expect(page.getByText(/running in .*ghostty-playground\/cf-login; close it first/)).toBeVisible();
  await expect(ws.getByTestId("member-name")).toHaveText(["ghostty-playground", "dotfiles"]);

  // Enter on a worktree row shows it in the page's side panel (worktree-panel.spec.ts).
  await page.getByTestId("projects-list").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("worktree-surface").getByTestId("worktree-surface-title")).toHaveText("code-foundry@main");
  await expect(page.getByTestId("projects-page")).toBeVisible();
});

test("the Projects page removes a workspace and offers project actions", async ({ page }) => {
  await mockPost("workspace?name=spare&repos=repo-gp,repo-sk");
  await openApp(page);
  await openProjects(page);
  const ws = page.locator('[data-testid="workspace"]').filter({ hasText: "spare" });
  await ws.getByTestId("workspace-remove").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Remove workspace spare?");
  await dialog.getByTestId("confirm-ok").click();
  await expect(page.locator('[data-testid="workspace"]')).toHaveCount(0);
  expect((await lastInvocation("workspace.remove"))?.args).toEqual({ workspace: "spare" });

  // New thread from a project row opens its composer.
  const gp = page.locator('[data-testid="project"][data-repo="repo-gp"]');
  await gp.getByTestId("project-new-thread").click();
  await expect(page.getByTestId("composer-heading")).toContainText("ghostty-playground");

  // Remove a worktree (repo.worktree.remove with that worktree's context, confirmed).
  await openProjects(page);
  const fix = page.locator(`[data-nav-key="pw:repo-cf::${CF}.worktrees/fix-resize"]`);
  await fix.hover();
  await fix.getByTestId("worktree-remove").click();
  await page.getByTestId("confirm-dialog").getByTestId("confirm-ok").click();
  await expect(fix).toHaveCount(0);
  const rm = (await invocations()).filter((i) => i.name === "repo.worktree.remove").at(-1);
  expect(rm?.context).toMatchObject({ activeRepoId: "repo-cf", activeWorktreePath: `${CF}.worktrees/fix-resize`, activeView: "projects" });
  // The main worktree has no remove action.
  const main = page.locator(`[data-nav-key="pw:repo-cf::${CF}"]`);
  await main.hover();
  await expect(main.getByTestId("worktree-remove")).toHaveCount(0);
  await expect(main.getByTestId("worktree-new-terminal")).toBeVisible();
});

test("a workspace thread's member worktree never shows under its project in the sidebar", async ({ page }) => {
  await workspaceWithThread();
  await openApp(page);
  await expect(list(page).locator(`[data-row-key*="${GP_LOGIN}"]`)).toHaveCount(0);
  await expect(list(page).getByText("cf/login")).toHaveCount(1); // only the driver row's branch
});
