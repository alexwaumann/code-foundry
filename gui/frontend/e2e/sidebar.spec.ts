import { expect, test, type Page } from "@playwright/test";
import { CF, composeProject, DEFAULT_ORDER, emit, expectAttention, holdThreads, invocations, mockPost, mockUrl, openApp, openProjectPage, openProjects, openWorkspacePage, resetMock, row } from "./fixtures";

/** Where the mock (like the daemon) puts a project's worktree for a cf/<name> branch. */
const WT = "/Users/dev/.code-foundry/worktrees/alexwaumann";
const CF_LOGIN = `${WT}/code-foundry/cf-login`;
const WS = "w-000000000001";

interface ThreadSummary {
  id: string;
  projectId: string;
  worktreePath: string;
  workspaceId: string;
  pendingWorktreePath: string;
  pinned: boolean;
}

async function thread(id: string): Promise<ThreadSummary | undefined> {
  const res = await fetch(`${mockUrl}/__mock/threads`);
  return ((await res.json()) as ThreadSummary[]).find((s) => s.id === id);
}

/** A workspace "login" over code-foundry and ghostty-playground with a thread "driver" in the ghostty-playground member. */
async function workspaceWithThread(): Promise<string> {
  await mockPost("workspace?name=login&projects=repo-cf,repo-gp");
  const s = (await mockPost("workspace-thread?workspace=login&project=repo-gp&name=driver")) as { id: string };
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

test("the window starts on the No project composer; the menu pane marks the current page: New thread on the composer, Projects, Pull Requests", async ({ page }) => {
  await openApp(page);
  const composer = page.getByTestId("composer");
  await expect(composer).toBeVisible();
  await expect(page.getByTestId("composer-project-name")).toHaveText("No project");
  // Home is the composer itself: the project picker stays closed.
  await expect(page.getByTestId("palette")).toHaveCount(0);
  const menu = page.getByTestId("sidebar-menu");
  const current = menu.locator('[aria-current="page"]');
  await expect(page.getByTestId("sidebar-toolbar")).toHaveCount(0);
  const newThread = page.getByTestId("sidebar-new-thread");
  await expect(newThread).toHaveAttribute("aria-current", "page");
  await expect(newThread).toHaveClass(/bg-cf-sidebar-row-selected/);
  await expect(current).toHaveCount(1);

  for (const id of ["nav-projects", "nav-pullrequests"]) {
    await page.getByTestId(id).click();
    await expect(page.getByTestId(id)).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId(id)).toHaveClass(/bg-cf-sidebar-row-selected/);
    await expect(current).toHaveCount(1);
  }
  // A project's composer: New thread is the current row.
  await composeProject(page);
  await expect(newThread).toHaveAttribute("aria-current", "page");
  await expect(current).toHaveCount(1);

  // The removed dashboard is an unknown page name now: ignored.
  expect(await emit({ showView: { name: "dashboard" } })).toBeGreaterThan(0);
  await expect(composer).toBeVisible();
  await expect(page.getByTestId("composer-project-name")).not.toHaveText("No project");

  // A selected thread is not restored: a reload starts on the No project composer again.
  await row(page, "s:s-2").click();
  await expect(composer).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("composer-project-name")).toHaveText("No project");
  await expect(page.getByTestId("palette")).toHaveCount(0);
});

test("the sidebar is a flat thread list: waiting threads on top, working ones under Working, a workspace thread's run-in project on line 1, no project or worktree rows", async ({ page }) => {
  const driver = await workspaceWithThread();
  await openApp(page);
  await expect(row(page, `s:${driver}`)).toBeVisible();
  await expect(page.getByTestId("sidebar-band")).toContainText("Code Foundry");
  // The waiting thread (s-2) on top, then idle threads newest first (no header), then the
  // working ones under Working. No terminal rows: shells live in bottom panels.
  await expect.poll(() => rowKeys(page)).toEqual(["s:s-2", `s:${driver}`, "s:s-6", "s:s-4", "s:s-3", "# Working 2", "s:s-5", "s:s-1", "# Snoozed 2", "# Archived 1"]);
  await expect(list(page).locator('[data-row-kind]:not([data-row-kind="thread"]):not([data-row-kind="header"])')).toHaveCount(0);
  await expect(list(page)).toHaveAttribute("aria-label", "Threads");

  // A thread of a workspace's projects: the Layers glyph and the project it runs in (the workspace's name only on the card), the branch on line 3.
  const d = row(page, `s:${driver}`);
  await expect(d.getByTestId("thread-name")).toHaveText("driver");
  await expect(d.getByTestId("row-project")).toHaveText("ghostty-playground");
  await expect(d.getByTestId("row-branch")).toHaveText("cf/login");
  await expect(d.getByTestId("row-workspace")).toHaveCount(1);
  // No model on the row any more.
  await expect(d).not.toContainText("Haiku");
  // A single-project thread: its project.
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
  // End reaches the last row; ↑ skips the Working header.
  await list(page).focus();
  await page.keyboard.press("End");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", "row-s:s-1");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(list(page)).toHaveAttribute("aria-activedescendant", "row-s:s-3");
});

test("pin from the context menu moves a thread to the top; unpin moves it back", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click({ button: "right" });
  const menu = page.getByTestId("row-menu");
  await expect(menu).toBeVisible();
  await menu.getByTestId("menu-pin").click();
  await expect.poll(async () => (await thread("s-3"))?.pinned).toBe(true);
  const pin = await lastInvocation("thread.pin");
  expect(pin?.args).toEqual({ pinned: "true" });
  expect(pin?.context?.activeThreadId).toBe("s-3");
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
  // The workspace's folder, then the thread's projects by id.
  await expect(members.locator("[data-member]")).toHaveCount(3);
  await expect(members.locator('[data-member="workspace"]')).toContainText("Workspace");
  await expect(members.locator('[data-member="repo-gp"]')).toContainText("runs here");
  await expect(members.locator('[data-member="repo-gp"]')).toHaveAttribute("data-disabled", "");
  await members.locator('[data-member="repo-cf"]').click();

  const inv = await lastInvocation("thread.run-in");
  expect(inv?.args).toEqual({ project: "repo-cf" });
  expect(inv?.context).toMatchObject({ activeThreadId: driver, activeWorkspaceId: WS, activeView: "thread" });
  // Queued until the thread is idle at its prompt (the mock: ~2s), then the row's worktree changes.
  await expect(d.getByTestId("row-moving")).toHaveText("moving to code-foundry…");
  await expect(d.getByTestId("row-moving")).toHaveCount(0, { timeout: 8000 });
  // Line 1 names the project it runs in now.
  await expect(d.getByTestId("row-project")).toHaveText("code-foundry");
  await expect(d.getByTestId("row-branch")).toHaveText("cf/login");
  expect(await thread(driver)).toMatchObject({ projectId: "repo-cf", worktreePath: CF_LOGIN, pendingWorktreePath: "" });
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
  await expect(palette.locator('[data-command="thread.run-in"]')).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Workspace thread: the palette offers it; picking it lists the other members.
  await row(page, `s:${driver}`).click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Run Thread In");
  await palette.locator('[data-command="thread.run-in"]').click();
  const picker = page.getByTestId("runin-picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator('[data-member="repo-gp"]')).toContainText("runs here");
  await picker.locator('[data-member="repo-cf"]').click();
  await expect(picker).toHaveCount(0);
  const inv = await lastInvocation("thread.run-in");
  expect(inv?.args).toEqual({ project: "repo-cf" });
  expect(inv?.context).toMatchObject({ activeThreadId: driver, activeWorkspaceId: WS });
  await expect(row(page, `s:${driver}`).getByTestId("row-moving")).toBeVisible();
});

test("the Projects view removes a workspace and offers project actions", async ({ page }) => {
  const spare = (await mockPost("workspace?name=spare&projects=repo-gp,repo-sk")) as { id: string };
  await openApp(page);
  await openWorkspacePage(page, spare.id);
  await page.getByTestId("workspace-page-more").click();
  await page.getByTestId("workspace-page-remove").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Remove workspace spare?");
  await dialog.getByTestId("confirm-ok").click();
  await expect(page.locator('[data-testid="workspace"]')).toHaveCount(0);
  expect((await lastInvocation("workspace.remove"))?.args).toEqual({ workspace: "spare" });

  // New thread from a project row opens its composer.
  await openProjects(page);
  const gp = page.locator('[data-nav-key="p:repo-gp"]');
  await gp.hover();
  await gp.getByTestId("project-new-thread").click();
  await expect(page.getByTestId("composer-heading")).toContainText("ghostty-playground");

  // Remove a worktree (project.worktree.remove with that worktree's context, confirmed).
  await openProjectPage(page, "repo-cf");
  const fix = page.locator(`[data-nav-key="pw:repo-cf::${CF}.worktrees/fix-resize"]`);
  await fix.hover();
  await fix.getByTestId("worktree-more").click();
  await page.getByTestId("worktree-remove").click();
  await page.getByTestId("remove-worktree-dialog").getByTestId("remove-worktree-ok").click();
  await expect(fix).toHaveCount(0);
  const rm = (await invocations()).filter((i) => i.name === "project.worktree.remove").at(-1);
  expect(rm?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: `${CF}.worktrees/fix-resize`, activeView: "projects" });
  // The main worktree has no remove action.
  const main = page.locator(`[data-nav-key="pw:repo-cf::${CF}"]`);
  await main.hover();
  await expect(main.getByTestId("worktree-new-terminal")).toBeVisible();
  await main.getByTestId("worktree-more").click();
  await expect(page.getByTestId("worktree-more-menu")).toBeVisible();
  await expect(page.getByTestId("worktree-remove")).toHaveCount(0);
  await page.keyboard.press("Escape");
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
      "# Snoozed 2",
      "# Archived 1",
    ]);
  const sections = await list(page)
    .locator('[data-row-kind="thread"]')
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

  // Line 1: the status's icon and word in its tone (a time after it for working only); line 3: its detail, else the branch.
  const want: [string, string, RegExp, RegExp, string | null][] = [
    ["s-k-approval", "input", /^Permission$/, /text-cf-warning-text/, "Bash"],
    ["s-k-question", "question", /^Question$/, /text-cf-warning-text/, "Which color do you prefer?"],
    ["s-k-plan", "plan", /^Plan$/, /text-cf-warning-text/, "ready for review"],
    ["s-k-finished", "finished", /^Done$/, /text-cf-success-text/, null],
    ["s-k-error", "error", /^Error$/, /text-cf-error-text/, "model_not_found"],
    ["s-k-busy", "working", /^Working \d+s$|^Working \d+m$/, /text-cf-info-text/, "Bash make check"],
    ["s-k-interrupted", "interrupted", /^Interrupted$/, /text-cf-error-text/, "resend to continue"],
    ["s-k-asked-before-restart", "question", /^Question$/, /text-cf-warning-text/, "Which density should the sidebar use?"],
  ];
  for (const [id, kind, text, tone, detail] of want) {
    const r = row(page, `s:${id}`);
    await expect(r.getByTestId("thread-body"), id).toHaveAttribute("data-status-line", kind);
    await expect(r.getByTestId("row-status"), id).toHaveText(text);
    await expect(r.getByTestId("row-status"), id).toHaveClass(tone);
    await expect(r.getByTestId("row-status-icon"), id).toBeVisible();
    if (detail === null) await expect(r.getByTestId("row-branch"), id).toHaveText("main");
    else await expect(r.getByTestId("row-detail"), id).toHaveText(detail);
  }
  // Every row names its project on line 1.
  await expect(row(page, "s:s-k-question").getByTestId("row-project")).toHaveText("code-foundry");
  // Idle: no icon or word, the time since the last activity, muted; the branch on line 3.
  const idle = row(page, "s:s-k-idle");
  await expect(idle.getByTestId("thread-body")).toHaveAttribute("data-status-line", "place");
  await expect(idle.getByTestId("row-status")).toHaveCount(0);
  await expect(idle.getByTestId("row-time")).toHaveText(/^\d+(s|m|h( \d+m)?|d)$/);
  await expect(idle.getByTestId("row-time")).toHaveClass(/text-cf-sidebar-muted-foreground/);
  await expect(idle.getByTestId("row-branch")).toHaveText("main");
  // Attention, error and done rows show no time.
  for (const id of ["s-k-approval", "s-k-finished", "s-k-interrupted"]) await expect(row(page, `s:${id}`).getByTestId("row-time"), id).toHaveCount(0);
  // Three lines in the 60px box.
  expect(Math.round((await idle.boundingBox())?.height ?? 0)).toBe(60);
  await expect(row(page, "s:s-k-approval").getByTestId("thread-name")).not.toHaveClass(/text-cf-warning-text/);
  // No row is dimmed (whether Claude runs never shows); the name is never coloured by status.
  for (const id of ["s-k-interrupted", "s-k-asked-before-restart", "s-k-approval", "s-k-finished", "s-k-busy", "s-k-idle"]) await expect(row(page, `s:${id}`).getByTestId("thread-body"), id).toHaveCSS("opacity", "1");

  // cmd+1 is the top row; cmd+shift+a visits the waiting threads in this order.
  await list(page).focus();
  await page.keyboard.press("Meta+1");
  await expect(row(page, "s:s-k-plan")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+Shift+a");
  await expect(row(page, "s:s-k-approval")).toHaveAttribute("aria-selected", "true");
  await expectAttention(page, 7);
});

test("Working section: a header with the count collapses and expands its rows, persists across a reload, and cmd+N skips hidden rows", async ({ page }) => {
  await openApp(page);
  await expect.poll(() => rowKeys(page)).toEqual(DEFAULT_ORDER.map((k) => (k === "h:working" ? "# Working 2" : k === "h:snoozed" ? "# Snoozed 2" : k === "h:archived" ? "# Archived 1" : k)));
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
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-1");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "s:s-1")).toHaveCount(0);
  await expect(row(page, "s:s-5")).toHaveCount(0);
  await expect(page.getByTestId("working-count")).toHaveText("2");
  await expect.poll(() => rowKeys(page)).toEqual(["s:s-2", "s:s-6", "s:s-4", "s:s-3", "# Working 2", "# Snoozed 2", "# Archived 1"]);
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-1");

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
  await expect.poll(() => rowKeys(page)).toEqual(DEFAULT_ORDER.map((k) => (k === "h:working" ? "# Working 2" : k === "h:snoozed" ? "# Snoozed 2" : k === "h:archived" ? "# Archived 1" : k)));
  await page.keyboard.press("Meta+5");
  await expect(row(page, "s:s-5")).toHaveAttribute("aria-selected", "true");

  // From the keyboard: the header is a button (Space toggles it).
  await page.getByTestId("working-header").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("working-header")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("working-header")).toHaveAttribute("aria-expanded", "true");
});

test("thread rows sit 4px apart at both densities, each row's box (and its selection) the row's own height", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("snoozed-header").click();
  await expect(page.getByTestId("sidebar-snoozed-rows").locator("[data-row-key]")).toHaveCount(2);
  const gaps = async (a: string, b: string) => {
    const [ra, rb] = [await row(page, a).boundingBox(), await row(page, b).boundingBox()];
    return { height: ra?.height, gap: Math.round(((rb?.y ?? 0) - ((ra?.y ?? 0) + (ra?.height ?? 0))) * 10) / 10 };
  };
  const snoozed = async () => {
    const keys = await page.getByTestId("sidebar-snoozed-rows").locator("[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key") ?? ""));
    expect(keys).toHaveLength(2);
    return gaps(keys[0] ?? "", keys[1] ?? "");
  };
  for (const [density, two, one] of [
    ["comfortable", 50, 32],
    ["compact", 46, 28],
  ] as const) {
    await mockPost(`settings/external?appearance.density=${density}`);
    await expect(page.locator("html")).toHaveAttribute("data-density", density);
    // Main list and the Working footer: two-line rows; Snoozed: one-line rows.
    await expect.poll(() => gaps("s:s-2", "s:s-6")).toEqual({ height: two, gap: 4 });
    expect(await gaps("s:s-5", "s:s-1")).toEqual({ height: two, gap: 4 });
    expect(await snoozed()).toEqual({ height: one, gap: 4 });
  }
  // The selection background is the row's own box: the gap under it stays the sidebar's.
  await row(page, "s:s-2").click();
  await expect(row(page, "s:s-2")).toHaveClass(/bg-cf-sidebar-row-selected/);
  const parent = await row(page, "s:s-2").evaluate((e) => (e.parentElement ? e.parentElement.getBoundingClientRect().height : 0));
  expect(parent).toBe(46);
  await mockPost("settings/external?appearance.density=");
});

test("the menu pane: under the band, gutter to edge, surface fill, divider border, pane radius, 4px inside; the threads 8px below", async ({ page }) => {
  await openApp(page);
  await expect(row(page, "s:s-2")).toBeVisible();
  await expect(page.getByTestId("sidebar-divider")).toHaveCount(0);
  const m = await page.evaluate(() => {
    const r = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
    const [menu, band, body, sidebar, newThread, projects] = [r("sidebar-menu"), r("sidebar-band"), r("sidebar-body"), r("sidebar"), r("sidebar-new-thread"), r("nav-projects")];
    const first = document.querySelector('[data-testid="sidebar-main"] [role="option"]')?.getBoundingClientRect();
    const el = document.querySelector('[data-testid="sidebar-menu"]');
    const resolve = (prop: "backgroundColor" | "borderTopColor", v: string) => {
      const probe = document.createElement("div");
      probe.style.border = "1px solid";
      probe.style[prop] = v;
      document.body.append(probe);
      const c = getComputedStyle(probe)[prop];
      probe.remove();
      return c;
    };
    const cs = el ? getComputedStyle(el) : null;
    return {
      top: (menu?.top ?? 0) - (band?.bottom ?? 0),
      left: (menu?.left ?? 0) - (body?.left ?? 0),
      right: menu?.right === sidebar?.right,
      radius: cs?.borderTopLeftRadius,
      border: cs?.borderTopWidth,
      fill: cs?.backgroundColor === resolve("backgroundColor", "var(--cf-surface)"),
      edge: cs?.borderTopColor === resolve("borderTopColor", "var(--cf-divider)"),
      inset: [(newThread?.top ?? 0) - (menu?.top ?? 0), (newThread?.left ?? 0) - (menu?.left ?? 0), (menu?.bottom ?? 0) - (projects?.bottom ?? 0)],
      rows: [newThread?.height, projects?.height],
      below: (first?.top ?? 0) - (menu?.bottom ?? 0),
    };
  });
  // 12px gutter (pl-shell) on the left; 1px border + 4px padding to the rows; 8px gap plus the
  // list's 4px paddingStart to the first thread row.
  expect(m).toEqual({ top: 0, left: 12, right: true, radius: "12px", border: "1px", fill: true, edge: true, inset: [5, 5, 5], rows: [28, 28], below: 12 });
});

test("Working section: the header counts threads as they start and stop working, and goes away with the last one", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("working-count")).toHaveText("2");
  // s-6 is idle (closing); a busy thread joins Working, at its place by creation time.
  const [job = ""] = (await mockPost("threads?project=repo-cf&count=1&status=busy&prefix=Job")) as string[];
  await holdThreads(job);
  await expect(page.getByTestId("working-count")).toHaveText("3");
  await expect.poll(async () => (await rowKeys(page)).slice(4, 8)).toEqual(["# Working 3", `s:${job}`, "s:s-5", "s:s-1"]);
  // A pinned working thread stays at the top, not under Working.
  await row(page, `s:${job}`).click({ button: "right" });
  await page.getByTestId("menu-pin").click();
  await expect.poll(async () => (await rowKeys(page))[0]).toBe(`s:${job}`);
  await expect(row(page, `s:${job}`)).toHaveAttribute("data-section", "pinned");
  await expect(page.getByTestId("working-count")).toHaveText("2");
  // s-1 goes idle and s-5 closes: no working threads left, no header.
  await mockPost("thread/status?id=s-1&status=idle");
  await expect(page.getByTestId("working-count")).toHaveText("1");
  await expect(row(page, "s:s-1")).toHaveAttribute("data-section", "idle");
  await mockPost("thread/stop?id=s-5&reason=closed&code=0&status=idle");
  await expect(page.getByTestId("working-header")).toHaveCount(0);
  expect((await rowKeys(page)).filter((k) => k.startsWith("#"))).toEqual(["# Snoozed 2", "# Archived 1"]);
});

test("hovering a thread row shows its tooltip: name, project with where it runs, branch, model and effort", async ({ page }) => {
  await mockPost("threads?project=repo-wr&count=1&status=idle&prefix=Notes");
  await openApp(page);
  // The open one: the previous tooltip may still be fading out.
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');

  // s-3 runs in a linked worktree of code-foundry that it did not make (a picked one): no chip.
  await row(page, "s:s-3").hover();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveAttribute("data-thread-id", "s-3");
  await expect(tip.getByTestId("tip-name")).toHaveText("Fix resize race");
  await expect(tip.getByTestId("tip-project")).toHaveText("code-foundry");
  await expect(tip.getByTestId("tip-branch")).toHaveText("fix/resize");
  await expect(tip.getByTestId("tip-branch-chip")).toHaveCount(0);
  await expect(tip.getByTestId("tip-model")).toHaveText("Opus 4.8 (medium)");
  await expect(tip.getByTestId("tip-project-chip")).toHaveCount(0);
  await expect(tip.getByTestId("tip-workspace")).toHaveCount(0);
  // To the right of the sidebar, 260px wide.
  const sidebar = await page.getByTestId("sidebar").boundingBox();
  const box = await tip.boundingBox();
  expect(box && sidebar && box.x >= sidebar.x + sidebar.width - 1).toBe(true);
  expect(Math.round(box?.width ?? 0)).toBe(260);

  // Moving to the next row: s-2 in ghostty-playground's main checkout, no effort: Project folder.
  await row(page, "s:s-2").hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-2");
  await expect(tip.getByTestId("tip-project-chip")).toHaveText("Project folder");
  await expect(tip.getByTestId("tip-branch")).toHaveText("main");
  await expect(tip.getByTestId("tip-model")).toHaveText("Sonnet 5");

  // A project without git: a plain folder, the no git chip, no branch row.
  const notes = list(page).locator('[data-row-kind="thread"]').filter({ hasText: "Notes 1" });
  await notes.hover();
  await expect(tip.getByTestId("tip-name")).toHaveText("Notes 1");
  await expect(tip.getByTestId("tip-project")).toHaveText("writingno git");
  await expect(tip.getByTestId("tip-project-chip")).toHaveText("no git");
  await expect(tip.getByTestId("tip-branch")).toHaveCount(0);
  await expect(tip.getByTestId("tip-model")).toHaveText("Haiku 4.5");

  // A click closes it and selects the row; the keyboard never opens one.
  await notes.click();
  await expect(tip).toHaveCount(0);
  await page.mouse.move(900, 600);
  await list(page).focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(700);
  await expect(tip).toHaveCount(0);

  // A right-click closes it and opens the row menu.
  await row(page, "s:s-1").hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-1");
  await row(page, "s:s-1").click({ button: "right" });
  await expect(page.getByTestId("row-menu")).toBeVisible();
  await expect(tip).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("row-menu")).toHaveCount(0);
});

test("a multi-project thread's card: workspace (or N projects), the run-in project with where it runs, branch, model; line 1 the run-in only", async ({ page }) => {
  await mockPost("workspace?name=login&projects=repo-cf,repo-gp");
  const ws = (await mockPost("workspace-thread?workspace=login&project=repo-gp&name=Login%20flow&status=idle")) as { id: string };
  const set = (await mockPost("multi-thread?projects=repo-cf,repo-gp&project=repo-gp&branch=feat/x&name=Unsaved%20set")) as { id: string };
  const folder = (await mockPost("workspace-thread?workspace=login&project=workspace&name=In%20the%20folder")) as { id: string };
  await openApp(page);
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');
  const card = async (id: string) => {
    await page.mouse.move(0, 0);
    await row(page, `s:${id}`).getByTestId("thread-name").hover();
    await expect(tip).toHaveAttribute("data-thread-id", id);
    return tip.locator("> div").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  };

  await expect(row(page, `s:${ws.id}`).getByTestId("row-project")).toHaveText("ghostty-playground");
  await expect(row(page, `s:${ws.id}`).getByTestId("row-branch")).toHaveText("cf/login");
  await expect(row(page, `s:${set.id}`).getByTestId("row-project")).toHaveText("ghostty-playground");
  await expect(row(page, `s:${set.id}`).getByTestId("row-branch")).toHaveText("feat/x");
  // A thread in its workspace's folder: no project, so the workspace's name.
  await expect(row(page, `s:${folder.id}`).getByTestId("row-project")).toHaveText("login");

  expect(await card(ws.id)).toEqual(["tip-name", "tip-workspace", "tip-project", "tip-branch", "tip-model"]);
  await expect(tip.getByTestId("tip-workspace")).toHaveText("login2 projects");
  await expect(tip.getByTestId("tip-workspace-meta")).toHaveText("2 projects");
  await expect(tip.getByTestId("tip-project")).toHaveText("ghostty-playgroundFresh copy");
  await expect(tip.getByTestId("tip-project-chip")).toHaveText("Fresh copy");
  await expect(tip.getByTestId("tip-branch")).toHaveText("cf/login");
  await expect(tip.getByTestId("tip-branch-chip")).toHaveCount(0);
  await expect(tip.getByTestId("tip-set")).toHaveCount(0);

  await card(set.id);
  await expect(tip.getByTestId("tip-workspace")).toHaveText("2 projects");
  await expect(tip.getByTestId("tip-workspace-meta")).toHaveCount(0);
  await expect(tip.getByTestId("tip-project-chip")).toHaveText("Fresh copy");
  await expect(tip.getByTestId("tip-branch")).toHaveText("feat/x");

  await card(folder.id);
  await expect(tip.getByTestId("tip-workspace")).toHaveText("login2 projects");
  await expect(tip.getByTestId("tip-project")).toHaveText("Workspace folder");
  await expect(tip.getByTestId("tip-project-chip")).toHaveCount(0);
  await page.mouse.move(0, 0);
});

test("the tooltip shows the full status, wrapped, under the name for threads that need input or failed, with how long; a finished turn says how long ago; not for working or idle", async ({ page }) => {
  await mockPost("status-kinds");
  const long = "Do you want to create hello.txt in the scratch repository and then run the whole test suite?";
  await mockPost(`thread/status?id=s-k-approval&status=attention&reason=${encodeURIComponent(`permission: ${long}`)}`);
  await openApp(page);
  const tip = page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');

  // The permission prompt: line 3 cuts it off, the tooltip has all of it, wrapped, in amber.
  const approval = row(page, "s:s-k-approval");
  await expect(approval.getByTestId("row-detail")).toHaveText(long);
  await approval.hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-k-approval");
  const status = tip.getByTestId("tip-status");
  await expect(status).toHaveText(new RegExp(`^Needs input · ${long.replace("?", "\\?")} · for \\d+s$`));
  await expect(status).toHaveAttribute("data-tone", "amber");
  await expect(status).toHaveClass(/text-cf-warning-text/);
  const line3 = await approval.getByTestId("row-detail").evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(line3).toBe(true);
  // Wrapped over several lines inside the 260px tooltip, between the name and the project.
  expect(Math.round((await tip.boundingBox())?.width ?? 0)).toBe(260);
  const [name, st, project] = [await tip.getByTestId("tip-name").boundingBox(), await status.boundingBox(), await tip.getByTestId("tip-project").boundingBox()];
  expect(st && st.height >= 40).toBe(true);
  expect(name && st && project && name.y < st.y && st.y + st.height <= project.y).toBe(true);

  // The other prompts, the Claude error and the interrupted thread, with how long they have been so.
  const shown: [string, string, "amber" | "red"][] = [
    ["s-k-question", "Asked a question · for 6m", "amber"],
    ["s-k-plan", "Plan ready for review · for 1m", "amber"],
    ["s-k-error", "Error · model_not_found · for 20m", "red"],
    ["s-k-interrupted", "Interrupted while working · for 35m", "red"],
  ];
  for (const [id, text, tone] of shown) {
    await row(page, `s:${id}`).hover();
    await expect(tip, id).toHaveAttribute("data-thread-id", id);
    await expect(tip.getByTestId("tip-status"), id).toHaveText(text);
    await expect(tip.getByTestId("tip-status"), id).toHaveAttribute("data-tone", tone);
    await expect(tip.getByTestId("tip-status"), id).toHaveClass(tone === "amber" ? /text-cf-warning-text/ : /text-cf-error-text/);
  }

  // A finished turn: how long ago, green.
  await row(page, "s:s-k-finished").hover();
  await expect(tip).toHaveAttribute("data-thread-id", "s-k-finished");
  await expect(tip.getByTestId("tip-status")).toHaveText("Finished 12m ago");
  await expect(tip.getByTestId("tip-status")).toHaveAttribute("data-tone", "emerald");

  // Working and idle threads: no status row; the rest of the tooltip is unchanged.
  for (const id of ["s-k-busy", "s-k-idle"]) {
    await row(page, `s:${id}`).hover();
    await expect(tip, id).toHaveAttribute("data-thread-id", id);
    await expect(tip.getByTestId("tip-project"), id).toBeVisible();
    await expect(tip.getByTestId("tip-status"), id).toHaveCount(0);
  }
});
