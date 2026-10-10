import { expect, test, type Page } from "@playwright/test";
import { emit, invocations, mockPost, openApp, openProjects, resetMock, row } from "./fixtures";

/** Where the mock (like the daemon) puts a repo's worktree for the cf/checkout branch. */
const WT = "/Users/dev/.code-foundry/worktrees";
const CF_MEMBER = `${WT}/alexwaumann/code-foundry/cf-checkout`;
const GP_MEMBER = `${WT}/alexwaumann/ghostty-playground/cf-checkout`;
const WS = "w-000000000001";

/**
 * The mixed workspace "checkout" (code-foundry: open PR #151 with failing CI;
 * ghostty-playground: 2 ahead; dotfiles: dirty), with a thread "driver" in its
 * ghostty-playground member unless `thread` is false.
 */
async function mixedWorkspace(thread = true): Promise<string> {
  await mockPost("workspace-mixed?name=checkout");
  if (!thread) return "";
  const s = (await mockPost("workspace-thread?workspace=checkout&repo=repo-gp&name=driver")) as { id: string };
  return s.id;
}

const panel = (page: Page) => page.getByTestId("side-panel");
const surface = (page: Page) => page.getByTestId("workspace-surface");
const member = (page: Page, repoId: string) => surface(page).locator(`[data-nav-key="m:${WS}::${repoId}"]`);

async function setPanelWidth(page: Page, width: number): Promise<void> {
  await page.evaluate(`import("/src/stores/panel.ts").then((m) => m.setPanelWidth("current", ${String(width)}))`);
  await expect.poll(async () => (await panel(page).boundingBox())?.width).toBe(width);
}

/** How far the element overflows horizontally (0 or less: it fits). */
function overflowX(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((el) => el.scrollWidth - el.clientWidth);
}

/** SHOTS=<dir> saves screenshots (mock daemon) for the notes, as in pr-panel.spec.ts. */
const shots = process.env.SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: `${shots}/${name}-${test.info().project.name}.png` });
}

async function lastInvocation(name: string) {
  await expect.poll(async () => (await invocations()).filter((i) => i.name === name).length).toBeGreaterThan(0);
  return (await invocations()).filter((i) => i.name === name).at(-1);
}

async function expectWorkspaceTab(page: Page, threadId: string): Promise<void> {
  await expect(panel(page)).toHaveAttribute("data-panel-key", `session:${threadId}`);
  await expect(page.getByTestId("panel-tabs").getByRole("tab", { selected: true })).toHaveText("checkout");
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "workspace");
}

test.beforeEach(async () => {
  await resetMock();
});

test("the workspace badge opens the surface: name, branch, members with their state, the thread's member marked", async ({ page }) => {
  const driver = await mixedWorkspace();
  await openApp(page);
  await row(page, `s:${driver}`).getByTestId("row-workspace").click();
  await expectWorkspaceTab(page, driver);
  // The click also selected the thread.
  await expect(row(page, `s:${driver}`)).toHaveAttribute("aria-selected", "true");

  await expect(page.getByTestId("workspace-surface-name")).toHaveText("checkout");
  await expect(page.getByTestId("workspace-surface-branch")).toHaveText("cf/checkout");
  await expect(page.getByTestId("workspace-surface-count")).toHaveText("3 members");
  await expect(surface(page).getByTestId("member-name")).toHaveText(["code-foundry", "ghostty-playground", "dotfiles"]);
  await expect(surface(page).getByTestId("worktree-branch")).toHaveText(["cf/checkout", "cf/checkout", "cf/checkout"]);

  // code-foundry: an open pull request whose checks fail; nothing else.
  const cf = member(page, "repo-cf");
  await expect(cf.getByTestId("worktree-pr")).toContainText("#151");
  await expect(cf.getByTestId("worktree-pr").locator('[data-checks="failure"]')).toBeVisible();
  await expect(cf.getByTestId("worktree-dirty")).toHaveCount(0);
  await expect(cf.getByTestId("worktree-ahead")).toHaveCount(0);
  // ghostty-playground: 2 ahead, and the thread runs here.
  const gp = member(page, "repo-gp");
  await expect(gp.getByTestId("worktree-ahead")).toHaveText("2");
  await expect(gp.getByTestId("member-at")).toHaveText("here");
  await expect(gp.getByTestId("workspace-member")).toHaveAttribute("data-current", "true");
  await expect(gp.getByTestId("worktree-pr")).toHaveCount(0);
  // dotfiles: uncommitted changes (2 modified, 1 untracked).
  const dot = member(page, "repo-dot");
  await expect(dot.getByTestId("worktree-dirty")).toHaveText("3");
  await expect(surface(page).getByTestId("member-at")).toHaveCount(1);
  await shot(page, "ws5-surface-420");
});

test("the palette, the thread header and the CLI open it on a workspace thread; a project thread has none", async ({ page }) => {
  const driver = await mixedWorkspace();
  await openApp(page);
  const palette = page.getByTestId("palette");

  // Project thread: no palette entry, no header button, not in the empty panel.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("pane-actions")).toBeVisible();
  await expect(page.getByTestId("pane-workspace")).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Workspace");
  await expect(palette.locator('[data-command="view.panel.workspace"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Shift+e");
  await expect(page.getByTestId("panel-empty")).toBeVisible();
  await expect(page.getByTestId("panel-empty").locator('[data-surface="pullrequest"]')).toBeVisible();
  await expect(page.getByTestId("panel-empty").locator('[data-surface="workspace"]')).toHaveCount(0);
  // W does nothing there.
  await page.keyboard.press("w");
  await expect(page.getByTestId("panel-empty")).toBeVisible();

  // Workspace thread: the palette.
  await row(page, `s:${driver}`).click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Workspace");
  await palette.locator('[data-command="view.panel.workspace"]').click();
  await expect(palette).toHaveCount(0);
  await expectWorkspaceTab(page, driver);
  // Focus came back to the panel, so cmd+w closes the tab (and hides the emptied panel).
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-region="panel"]') !== null)).toBe(true);
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);

  // The header button (the same command).
  await page.getByTestId("pane-workspace").click();
  await expectWorkspaceTab(page, driver);
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);

  // W in the empty panel.
  await page.keyboard.press("Meta+Shift+e");
  await expect(page.getByTestId("panel-empty").locator('[data-surface="workspace"]')).toHaveAttribute("data-availability", "enabled");
  await page.keyboard.press("w");
  await expectWorkspaceTab(page, driver);
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);

  // The CLI's ShowView (code-foundry view panel workspace) acts on the window's selection.
  expect(await emit({ showView: { name: "panel.workspace" } })).toBeGreaterThan(0);
  await expectWorkspaceTab(page, driver);
});

test("a member opens as a worktree tab showing that worktree's overview", async ({ page }) => {
  const driver = await mixedWorkspace();
  await openApp(page);
  await row(page, `s:${driver}`).getByTestId("row-workspace").click();
  await expectWorkspaceTab(page, driver);

  const cf = member(page, "repo-cf");
  await cf.hover();
  await cf.getByTestId("member-open").click();
  const tabs = page.getByTestId("panel-tabs").getByRole("tab");
  await expect(tabs).toHaveText(["checkout", "code-foundry"]);
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "worktree");
  const wt = page.getByTestId("worktree-surface");
  await expect(wt).toHaveAttribute("data-path", CF_MEMBER);
  await expect(wt.getByTestId("worktree-surface-title")).toHaveText("code-foundry@cf/checkout");
  await expect(wt.getByTestId("sync-line")).toContainText("Upstream origin/cf/checkout");
  await expect(wt.getByTestId("section-github")).toContainText("#151");
  await expect(wt.getByTestId("section-files")).toBeVisible();
  // The content pane still shows the thread.
  await expect(page.getByTestId("terminal-header")).toContainText("driver");

  // Enter on a member row opens its tab too; back on the workspace tab the list is there.
  await tabs.filter({ hasText: "checkout" }).click();
  await page.getByTestId("workspace-surface-list").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(tabs).toHaveText(["checkout", "code-foundry", "ghostty-playground"]);
  await expect(page.getByTestId("worktree-surface")).toHaveAttribute("data-path", GP_MEMBER);
  await expect(page.getByTestId("worktree-surface").getByTestId("sync-line")).toContainText("↑2");
});

test("remove member confirms and the mock applies it; add member and Run in go through their commands", async ({ page }) => {
  const driver = await mixedWorkspace();
  await openApp(page);
  await row(page, `s:${driver}`).getByTestId("row-workspace").click();
  await expectWorkspaceTab(page, driver);

  // Remove code-foundry (workspace.remove-repo, confirmed by the daemon's prompt).
  const cf = member(page, "repo-cf");
  await cf.hover();
  await cf.getByTestId("member-remove").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Remove project code-foundry from its workspace?");
  await dialog.getByTestId("confirm-ok").click();
  await expect(surface(page).getByTestId("member-name")).toHaveText(["ghostty-playground", "dotfiles"]);
  await expect(page.getByTestId("workspace-surface-count")).toHaveText("2 members");
  const removed = (await invocations()).filter((i) => i.name === "workspace.remove-repo");
  expect(removed.map((i) => i.confirmed)).toEqual([false, true]);
  expect(removed.at(-1)?.args).toEqual({ repo: "code-foundry", workspace: WS });

  // The member the thread runs in is refused (the daemon names the thread), and stays.
  const gp = member(page, "repo-gp");
  await gp.hover();
  await gp.getByTestId("member-remove").click();
  await page.getByTestId("confirm-dialog").getByTestId("confirm-ok").click();
  await expect(page.getByText(/running in .*ghostty-playground\/cf-checkout; close it first/)).toBeVisible();
  await expect(surface(page).getByTestId("member-name")).toHaveText(["ghostty-playground", "dotfiles"]);

  // Add sketches (workspace.add-repo).
  await surface(page).getByTestId("workspace-add-member").click();
  await page.getByTestId("workspace-add-member-list").getByRole("option", { name: "sketches" }).click();
  const add = await lastInvocation("workspace.add-repo");
  expect(add?.args).toEqual({ repo: "sketches", workspace: WS });
  await expect(surface(page).getByTestId("member-name")).toHaveText(["ghostty-playground", "dotfiles", "sketches"]);

  // Run in dotfiles (session.run-in with the thread's context): queued until the thread is idle.
  const dot = member(page, "repo-dot");
  await dot.hover();
  await expect(gp.getByTestId("member-run-in")).toHaveCount(0);
  await dot.getByTestId("member-run-in").click();
  const runIn = await lastInvocation("session.run-in");
  expect(runIn?.args).toEqual({ repo: "repo-dot" });
  expect(runIn?.context).toMatchObject({ activeSessionId: driver, activeWorkspaceId: WS });
  // The mock moves an idle thread ~2s later; the marker follows.
  await expect(dot.getByTestId("member-at")).toHaveText("here", { timeout: 8000 });
  await expect(gp.getByTestId("member-at")).toHaveCount(0);
});

test("at 280px nothing overflows: the workspace surface and a member tab", async ({ page }) => {
  const driver = await mixedWorkspace();
  await openApp(page);
  await row(page, `s:${driver}`).getByTestId("row-workspace").click();
  await expectWorkspaceTab(page, driver);
  await setPanelWidth(page, 280);

  expect(await overflowX(page, "panel-body")).toBeLessThanOrEqual(0);
  expect(await overflowX(page, "workspace-surface-header")).toBeLessThanOrEqual(0);
  // Every member row keeps its state and its actions inside the row.
  for (const repoId of ["repo-cf", "repo-gp", "repo-dot"]) {
    const m = member(page, repoId);
    await m.hover();
    const rowBox = await m.boundingBox();
    const actions = await m.getByTestId("member-remove").boundingBox();
    expect(rowBox && actions && actions.x + actions.width <= rowBox.x + rowBox.width + 1).toBe(true);
    expect(await m.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  }
  await expect(member(page, "repo-cf").getByTestId("worktree-pr")).toBeVisible();
  await expect(member(page, "repo-gp").getByTestId("worktree-ahead")).toBeVisible();
  await expect(member(page, "repo-dot").getByTestId("worktree-dirty")).toBeVisible();
  await shot(page, "ws5-surface-280");

  // The member tab (the worktree overview) narrows too.
  const cf = member(page, "repo-cf");
  await cf.hover();
  await cf.getByTestId("member-open").click();
  await expect(page.getByTestId("worktree-surface")).toBeVisible();
  await expect(page.getByTestId("worktree-surface").getByTestId("section-github")).toContainText("#151");
  expect(await overflowX(page, "panel-body")).toBeLessThanOrEqual(0);
  await shot(page, "ws5-member-tab-280");
});

test("a Projects page workspace row opens the surface in a live thread's panel, and only with one", async ({ page }) => {
  await mixedWorkspace(false);
  await openApp(page);
  await openProjects(page);
  const ws = page.locator(`[data-testid="workspace"][data-workspace="${WS}"]`);
  await expect(ws.getByTestId("workspace-name")).toHaveText("checkout");
  await expect(ws.getByTestId("workspace-show-panel")).toHaveCount(0);
  // Step 4's actions are unchanged.
  await expect(ws.getByTestId("workspace-new-thread")).toHaveCount(1);

  const s = (await mockPost("workspace-thread?workspace=checkout&repo=repo-gp&name=driver")) as { id: string };
  await expect(ws.getByTestId("workspace-show-panel")).toHaveCount(1);
  await ws.getByTestId("workspace-show-panel").click();
  await expect(page.getByTestId("projects-page")).toHaveCount(0);
  await expect(row(page, `s:${s.id}`)).toHaveAttribute("aria-selected", "true");
  await expectWorkspaceTab(page, s.id);
});
