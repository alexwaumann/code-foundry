import { expect, test, type Page } from "@playwright/test";
import { CF, DEFAULT_ORDER, holdSessions, invocations, mockPost, mockUrl, openApp, openProjects, resetMock, row } from "./fixtures";

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

test("the window starts on the dashboard; the toolbar's Dashboard button returns to it and shows it is current", async ({ page }) => {
  await openApp(page);
  const dashboard = page.getByTestId("sidebar-dashboard");
  await expect(page.getByTestId("start-page")).toBeVisible();
  await expect(dashboard).toHaveAttribute("aria-current", "page");
  await expect(dashboard).toHaveClass(/bg-sidebar-accent/);

  await page.getByTestId("nav-projects").click();
  await expect(page.getByTestId("projects-page")).toBeVisible();
  await expect(dashboard).not.toHaveAttribute("aria-current", "page");

  // view.dashboard through the daemon (ShowView), like the Pull Requests and Projects chords.
  await dashboard.click();
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("view.dashboard");
  await expect(page.getByTestId("start-page")).toBeVisible();
  await expect(dashboard).toHaveAttribute("aria-current", "page");

  // A selected thread is not restored: a reload starts on the dashboard again.
  await row(page, "s:s-2").click();
  await expect(dashboard).not.toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(page.getByTestId("start-page")).toBeVisible();
  await expect(dashboard).toHaveAttribute("aria-current", "page");
});

test("Notifications: the count over the bell jumps to the waiting thread; with none it is a no-op", async ({ page }) => {
  await openApp(page);
  const bell = page.getByTestId("sidebar-notifications");
  // The mock's s-2 waits on the user.
  await expect(bell.getByTestId("attention-badge")).toHaveText("1");
  await expect(bell).toHaveAttribute("title", "1 thread needs attention");
  await bell.click();
  await expect(row(page, "s:s-2")).toHaveAttribute("aria-selected", "true");

  await mockPost("session/status?id=s-2&status=idle");
  await expect(bell).toHaveAttribute("title", "No threads need attention");
  await expect(bell).toHaveAttribute("aria-disabled", "true");
  await expect(bell.getByTestId("attention-badge")).toHaveCount(0);
  // aria-disabled, not disabled, so the tooltip still shows; a forced click does nothing.
  await page.getByTestId("nav-projects").click();
  await bell.click({ force: true });
  await expect(page.getByTestId("projects-page")).toBeVisible();
});

test("the sidebar is a flat thread list: waiting threads on top, working ones under Working, workspace badges, no repo or worktree rows", async ({ page }) => {
  const driver = await workspaceWithThread();
  await openApp(page);
  await expect(row(page, `s:${driver}`)).toBeVisible();
  await expect(page.getByTestId("sidebar-band")).toContainText("Code Foundry");
  // The waiting thread (s-2) on top, then idle threads newest first (no header), then the
  // working ones under Working. No terminal rows: shells live in bottom panels.
  await expect.poll(() => rowKeys(page)).toEqual(["s:s-2", `s:${driver}`, "s:s-6", "s:s-4", "s:s-3", "# Working 2", "s:s-5", "s:s-1"]);
  await expect(list(page).locator('[data-row-kind]:not([data-row-kind="session"]):not([data-row-kind="header"])')).toHaveCount(0);
  await expect(list(page)).toHaveAttribute("aria-label", "Threads");

  // A workspace thread: its cwd's project and branch, and the workspace badge.
  const d = row(page, `s:${driver}`);
  await expect(d.getByTestId("session-name")).toHaveText("driver");
  await expect(d.getByTestId("row-project")).toHaveText("ghostty-playground");
  await expect(d.getByTestId("row-branch")).toHaveText("cf/login");
  await expect(d.getByTestId("row-workspace")).toHaveText("login");
  // No model on the row any more.
  await expect(d).not.toContainText("haiku");
  // A project thread: no badge.
  const s1 = row(page, "s:s-1");
  await expect(s1.getByTestId("row-project")).toHaveText("code-foundry");
  await expect(s1.getByTestId("row-branch")).toHaveText("main");
  await expect(s1.getByTestId("row-workspace")).toHaveCount(0);

  // Keyboard: ↓ moves; Enter selects.
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

test("pin from the context menu moves a thread to the top; unpin moves it back", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click({ button: "right" });
  const menu = page.getByTestId("row-menu");
  await expect(menu).toBeVisible();
  await menu.getByTestId("menu-pin").click();
  await expect.poll(async () => (await session("s-3"))?.pinned).toBe(true);
  const pin = await lastInvocation("session.pin");
  expect(pin?.args).toEqual({ pinned: "true" });
  expect(pin?.context?.activeSessionId).toBe("s-3");
  await expect.poll(async () => (await rowKeys(page)).slice(0, 2)).toEqual(["s:s-3", "s:s-2"]);
  await expect(row(page, "s:s-3")).toHaveAttribute("data-section", "pinned");
  await expect(row(page, "s:s-3").getByTestId("row-pinned")).toBeVisible();

  await row(page, "s:s-3").click({ button: "right" });
  await expect(page.getByTestId("menu-pin")).toHaveText("Unpin");
  await page.getByTestId("menu-pin").click();
  // Back among the idle threads, by creation time: s-2 (waiting), s-6, s-4, s-3.
  await expect.poll(async () => (await rowKeys(page)).slice(0, 4)).toEqual(["s:s-2", "s:s-6", "s:s-4", "s:s-3"]);
  await expect(row(page, "s:s-3")).toHaveAttribute("data-section", "idle");
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
  // By keyboard: the add-repo toast sits over the menu's bottom-right corner.
  await member.getByTestId("member-more").click();
  await page.getByTestId("member-remove").focus();
  await page.keyboard.press("Enter");
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
  await gp.getByTestId("member-more").click();
  await page.getByTestId("member-remove").focus();
  await page.keyboard.press("Enter");
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
  await ws.getByTestId("workspace-more").click();
  await page.getByTestId("workspace-remove").click();
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
  await fix.getByTestId("worktree-more").click();
  await page.getByTestId("worktree-remove").click();
  await page.getByTestId("confirm-dialog").getByTestId("confirm-ok").click();
  await expect(fix).toHaveCount(0);
  const rm = (await invocations()).filter((i) => i.name === "repo.worktree.remove").at(-1);
  expect(rm?.context).toMatchObject({ activeRepoId: "repo-cf", activeWorktreePath: `${CF}.worktrees/fix-resize`, activeView: "projects" });
  // The main worktree has no remove action.
  const main = page.locator(`[data-nav-key="pw:repo-cf::${CF}"]`);
  await expect(main.getByTestId("worktree-new-terminal")).toBeVisible();
  await main.getByTestId("worktree-more").click();
  await expect(page.getByTestId("worktree-more-menu")).toBeVisible();
  await expect(page.getByTestId("worktree-remove")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("a workspace thread's member worktree never shows under its project in the sidebar", async ({ page }) => {
  await workspaceWithThread();
  await openApp(page);
  await expect(list(page).locator(`[data-row-key*="${GP_LOGIN}"]`)).toHaveCount(0);
  await expect(list(page).getByText("cf/login")).toHaveCount(1); // only the driver row's branch
});

test("status kinds: each thread's second line says its status in words and colour; waiting threads first, prompts above errors above finished, working last", async ({ page }) => {
  await mockPost("status-kinds");
  await openApp(page);
  // Prompts newest first (s-2 is the default world's permission prompt), then the interrupted
  // thread, then the finished turn, then idle and offline threads newest first, then the
  // working ones (starting s-5, busy s-k-busy and s-1) under the Working header.
  await expect
    .poll(() => rowKeys(page))
    .toEqual([
      "s:s-k-plan",
      "s:s-k-approval",
      "s:s-k-question",
      "s:s-k-error",
      "s:s-2",
      "s:s-k-asked-before-restart",
      "s:s-k-interrupted",
      "s:s-k-finished",
      "s:s-k-idle",
      "s:s-6",
      "s:s-4",
      "s:s-3",
      "# Working 3",
      "s:s-5",
      "s:s-k-busy",
      "s:s-1",
    ]);
  const sections = await list(page)
    .locator('[data-row-kind="session"]')
    .evaluateAll((els) => els.map((e) => `${e.getAttribute("data-row-key") ?? ""} ${e.getAttribute("data-section") ?? ""}`));
  expect(sections).toEqual([
    "s:s-k-plan attention",
    "s:s-k-approval attention",
    "s:s-k-question attention",
    "s:s-k-error attention",
    "s:s-2 attention",
    "s:s-k-asked-before-restart attention",
    "s:s-k-interrupted attention",
    "s:s-k-finished done",
    "s:s-k-idle idle",
    "s:s-6 idle",
    "s:s-4 idle",
    "s:s-3 idle",
    "s:s-5 working",
    "s:s-k-busy working",
    "s:s-1 working",
  ]);

  const want: [string, string, string, RegExp][] = [
    ["s-k-approval", "input", "Needs input · Bash", /text-amber/],
    ["s-k-question", "question", "Asked a question", /text-amber/],
    ["s-k-plan", "plan", "Plan ready for review", /text-amber/],
    ["s-k-finished", "finished", "Finished 12 min ago", /text-emerald/],
    ["s-k-error", "error", "Error · model_not_found", /text-red/],
    ["s-k-busy", "working", "Working", /text-sky/],
    ["s-k-interrupted", "interrupted", "Interrupted while working · 35 min ago", /text-red/],
    ["s-k-asked-before-restart", "question", "Asked a question", /text-amber/],
  ];
  for (const [id, kind, text, tone] of want) {
    const r = row(page, `s:${id}`);
    await expect(r.getByTestId("row-place"), id).toHaveAttribute("data-status-line", kind);
    await expect(r.getByTestId("row-status"), id).toHaveText(text);
    await expect(r.getByTestId("row-status"), id).toHaveClass(tone);
  }
  // Working and idle rows say where they run; prompts and finished turns do not.
  await expect(row(page, "s:s-k-busy").getByTestId("row-place")).toHaveText("Working · code-foundry · main");
  const idle = row(page, "s:s-k-idle");
  await expect(idle.getByTestId("row-place")).toHaveAttribute("data-status-line", "place");
  await expect(idle.getByTestId("row-status")).toHaveCount(0);
  await expect(idle.getByTestId("row-place")).toHaveText("code-foundry · main");
  await expect(row(page, "s:s-k-question").getByTestId("row-project")).toHaveCount(0);
  // Offline rows are dimmed, the rest are not; the name is never coloured by status.
  for (const id of ["s-k-interrupted", "s-k-asked-before-restart"]) await expect(row(page, `s:${id}`).getByTestId("session-body"), id).toHaveAttribute("data-offline", "true");
  for (const id of ["s-k-approval", "s-k-finished", "s-k-busy", "s-k-idle"]) await expect(row(page, `s:${id}`).getByTestId("session-body"), id).not.toHaveAttribute("data-offline");
  await expect(row(page, "s:s-k-approval").getByTestId("session-name")).not.toHaveClass(/amber/);
  // No status icon in thread rows.
  await expect(list(page).locator('[data-row-kind="session"] [role="img"]')).toHaveCount(0);

  // cmd+1 is the top row; cmd+shift+a visits the waiting threads in this order.
  await list(page).focus();
  await page.keyboard.press("Meta+1");
  await expect(row(page, "s:s-k-plan")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+Shift+a");
  await expect(row(page, "s:s-k-approval")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("attention-badge")).toHaveText("7");
});

test("Working section: a header with the count collapses and expands its rows, persists across a reload, and cmd+N skips hidden rows", async ({ page }) => {
  await openApp(page);
  await expect.poll(() => rowKeys(page)).toEqual(DEFAULT_ORDER.map((k) => (k === "h:working" ? "# Working 2" : k)));
  const header = page.getByTestId("working-header");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("working-label")).toHaveText("Working");
  await expect(page.getByTestId("working-count")).toHaveText("2");
  await expect(header).toHaveAccessibleName("Working 2");
  // Not an option of the listbox: the row is presentation.
  await expect(row(page, "h:working")).toHaveAttribute("role", "presentation");
  // Same left edge as the rows (the 8px gutter rule): the header button starts where s-3 starts.
  const hb = await header.boundingBox();
  const rb = await row(page, "s:s-3").boundingBox();
  expect(hb?.x).toBe(rb?.x);
  expect(hb?.width).toBe(rb?.width);

  // s-1 is selected and shown; collapsing hides its row but not the thread in the main pane.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-session-id", "s-1");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "s:s-1")).toHaveCount(0);
  await expect(row(page, "s:s-5")).toHaveCount(0);
  await expect(page.getByTestId("working-count")).toHaveText("2");
  await expect.poll(() => rowKeys(page)).toEqual(["s:s-2", "s:s-6", "s:s-4", "s:s-3", "# Working 2"]);
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-session-id", "s-1");

  // cmd+N counts only the rows shown: cmd+4 is s-3, the last one, and cmd+5 does nothing.
  await page.keyboard.press("Meta+4");
  await expect(row(page, "s:s-3")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+5");
  await expect(row(page, "s:s-3")).toHaveAttribute("aria-selected", "true");
  // Arrows and End skip the hidden rows too: s-3 is the last row ↓ and End reach.
  await row(page, "s:s-3").click();
  await list(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", "row-s:s-3");
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", "row-s:s-3");

  // The collapsed state survives a reload.
  await page.reload();
  await expect(page.getByTestId("working-header")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "s:s-2")).toBeVisible();
  await expect(row(page, "s:s-1")).toHaveCount(0);
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem("code-foundry.ui") ?? "{}") as { state?: { workingCollapsed?: boolean } }).state?.workingCollapsed)).toBe(true);

  // Expanding brings the rows back, and cmd+5 is the starting thread again.
  await page.getByTestId("working-header").click();
  await expect(page.getByTestId("working-header")).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => rowKeys(page)).toEqual(DEFAULT_ORDER.map((k) => (k === "h:working" ? "# Working 2" : k)));
  await page.keyboard.press("Meta+5");
  await expect(row(page, "s:s-5")).toHaveAttribute("aria-selected", "true");

  // From the keyboard: the header is a button (Space toggles it).
  await page.getByTestId("working-header").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("working-header")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("working-header")).toHaveAttribute("aria-expanded", "true");
});

test("Working section: the header counts threads as they start and stop working, and goes away with the last one", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("working-count")).toHaveText("2");
  // s-6 is idle (closing); a busy thread joins Working, at its place by creation time.
  const [job = ""] = (await mockPost("threads?repo=repo-cf&count=1&status=busy&prefix=Job")) as string[];
  await holdSessions(job);
  await expect(page.getByTestId("working-count")).toHaveText("3");
  await expect.poll(async () => (await rowKeys(page)).slice(4, 8)).toEqual(["# Working 3", `s:${job}`, "s:s-5", "s:s-1"]);
  // A pinned working thread stays at the top, not under Working.
  await row(page, `s:${job}`).click({ button: "right" });
  await page.getByTestId("menu-pin").click();
  await expect.poll(async () => (await rowKeys(page))[0]).toBe(`s:${job}`);
  await expect(row(page, `s:${job}`)).toHaveAttribute("data-section", "pinned");
  await expect(page.getByTestId("working-count")).toHaveText("2");
  // s-1 goes idle and s-5 closes: no working threads left, no header.
  await mockPost("session/status?id=s-1&status=idle");
  await expect(page.getByTestId("working-count")).toHaveText("1");
  await expect(row(page, "s:s-1")).toHaveAttribute("data-section", "idle");
  await mockPost("session/disconnect?id=s-5&reason=closed&code=0&status=idle");
  await expect(page.getByTestId("working-header")).toHaveCount(0);
  expect((await rowKeys(page)).filter((k) => k.startsWith("#"))).toEqual([]);
});

test("hovering a thread row shows its tooltip: name, project, branch with a worktree chip, model and effort", async ({ page }) => {
  await mockPost("threads?repo=repo-wr&count=1&status=idle&prefix=Notes");
  await openApp(page);
  // The open one: the previous tooltip may still be fading out.
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');

  // s-3 runs in a linked worktree of code-foundry.
  await row(page, "s:s-3").hover();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveAttribute("data-session-id", "s-3");
  await expect(tip.getByTestId("tip-name")).toHaveText("Fix resize race");
  await expect(tip.getByTestId("tip-project")).toHaveText("code-foundry");
  await expect(tip.getByTestId("tip-branch")).toHaveText("fix/resizeworktree");
  await expect(tip.getByTestId("tip-branch-chip")).toHaveText("worktree");
  await expect(tip.getByTestId("tip-model")).toHaveText("Opus (medium)");
  await expect(tip.getByTestId("tip-project-chip")).toHaveCount(0);
  // To the right of the sidebar, 220px wide.
  const sidebar = await page.getByTestId("sidebar").boundingBox();
  const box = await tip.boundingBox();
  expect(box && sidebar && box.x >= sidebar.x + sidebar.width - 1).toBe(true);
  expect(Math.round(box?.width ?? 0)).toBe(220);

  // Moving to the next row: s-2 in ghostty-playground's main checkout, no effort.
  await row(page, "s:s-2").hover();
  await expect(tip).toHaveAttribute("data-session-id", "s-2");
  await expect(tip.getByTestId("tip-branch")).toHaveText("main");
  await expect(tip.getByTestId("tip-branch-chip")).toHaveCount(0);
  await expect(tip.getByTestId("tip-model")).toHaveText("Sonnet");

  // A project without git: a plain folder, the no git chip, no branch row.
  const notes = list(page).locator('[data-row-kind="session"]').filter({ hasText: "Notes 1" });
  await notes.hover();
  await expect(tip.getByTestId("tip-name")).toHaveText("Notes 1");
  await expect(tip.getByTestId("tip-project")).toHaveText("writingno git");
  await expect(tip.getByTestId("tip-project-chip")).toHaveText("no git");
  await expect(tip.getByTestId("tip-branch")).toHaveCount(0);
  await expect(tip.getByTestId("tip-model")).toHaveText("Haiku");

  // A click closes it and selects the row; the keyboard never opens one.
  await notes.click();
  await expect(tip).toHaveCount(0);
  await page.mouse.move(900, 600);
  await list(page).focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(700);
  await expect(tip).toHaveCount(0);

  // A right-click closes it and opens the row menu; other rows stay quiet while the menu is open.
  await row(page, "s:s-1").hover();
  await expect(tip).toHaveAttribute("data-session-id", "s-1");
  await row(page, "s:s-1").click({ button: "right" });
  await expect(page.getByTestId("row-menu")).toBeVisible();
  await expect(tip).toHaveCount(0);
  await row(page, "s:s-4").hover({ force: true });
  await page.waitForTimeout(700);
  await expect(tip).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("row-menu")).toHaveCount(0);
});

test("the tooltip shows the full status, wrapped, under the name for threads that need input or failed; not for finished, working or idle", async ({ page }) => {
  await mockPost("status-kinds");
  const long = "Do you want to create hello.txt in the scratch repository and then run the whole test suite?";
  await mockPost(`session/status?id=s-k-approval&status=attention&reason=${encodeURIComponent(`permission: ${long}`)}`);
  await openApp(page);
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');

  // The permission prompt: line 2 cuts it off, the tooltip has all of it, wrapped, in amber.
  const approval = row(page, "s:s-k-approval");
  await expect(approval.getByTestId("row-status")).toHaveText(`Needs input · ${long}`);
  await approval.hover();
  await expect(tip).toHaveAttribute("data-session-id", "s-k-approval");
  const status = tip.getByTestId("tip-status");
  await expect(status).toHaveText(`Needs input · ${long}`);
  await expect(status).toHaveAttribute("data-tone", "amber");
  await expect(status).toHaveClass(/text-amber/);
  const line2 = await approval.getByTestId("row-place").locator("span.truncate").evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(line2).toBe(true);
  // Wrapped over several lines inside the 220px tooltip, between the name and the project.
  expect(Math.round((await tip.boundingBox())?.width ?? 0)).toBe(220);
  const [name, st, project] = [await tip.getByTestId("tip-name").boundingBox(), await status.boundingBox(), await tip.getByTestId("tip-project").boundingBox()];
  expect(st && st.height >= 40).toBe(true);
  expect(name && st && project && name.y < st.y && st.y + st.height <= project.y).toBe(true);

  // The other prompts, the Claude error and the interrupted thread: same words and colour as line 2.
  const shown: [string, string, "amber" | "red"][] = [
    ["s-k-question", "Asked a question", "amber"],
    ["s-k-plan", "Plan ready for review", "amber"],
    ["s-k-error", "Error · model_not_found", "red"],
    ["s-k-interrupted", "Interrupted while working · 35 min ago", "red"],
  ];
  for (const [id, text, tone] of shown) {
    await row(page, `s:${id}`).hover();
    await expect(tip, id).toHaveAttribute("data-session-id", id);
    await expect(tip.getByTestId("tip-status"), id).toHaveText(text);
    await expect(tip.getByTestId("tip-status"), id).toHaveAttribute("data-tone", tone);
    await expect(tip.getByTestId("tip-status"), id).toHaveClass(tone === "amber" ? /text-amber/ : /text-red/);
  }

  // Finished, working and idle threads: no status row; the rest of the tooltip is unchanged.
  for (const id of ["s-k-finished", "s-k-busy", "s-k-idle"]) {
    await row(page, `s:${id}`).hover();
    await expect(tip, id).toHaveAttribute("data-session-id", id);
    await expect(tip.getByTestId("tip-project"), id).toBeVisible();
    await expect(tip.getByTestId("tip-status"), id).toHaveCount(0);
  }
});

test("the toolbar: Dashboard and Notifications on the left, Add project then New thread on the right", async ({ page }) => {
  await openApp(page);
  const bar = await page.getByTestId("sidebar-toolbar").boundingBox();
  const at = async (id: string) => (await page.getByTestId(id).boundingBox()) ?? { x: 0, width: 0 };
  const [dash, bell, add, add2] = [await at("sidebar-dashboard"), await at("sidebar-notifications"), await at("sidebar-add-project"), await at("sidebar-new-session")];
  expect(dash.x).toBeLessThan(bell.x);
  expect(bell.x + bell.width).toBeLessThan((bar?.x ?? 0) + (bar?.width ?? 0) / 2);
  expect(add.x).toBeGreaterThan((bar?.x ?? 0) + (bar?.width ?? 0) / 2);
  expect(add.x).toBeLessThan(add2.x);
  // New thread is rightmost, flush with the toolbar's right edge (#40: no inset; the
  // content pane's 8px margin is the gap beyond it).
  expect(Math.round((bar?.x ?? 0) + (bar?.width ?? 0) - (add2.x + add2.width))).toBe(0);
});
