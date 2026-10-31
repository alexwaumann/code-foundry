import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { appPath, CF, invocations, mockPost, mockUrl, openApp, openProjectPage, openProjects, openWorkspacePage, resetMock } from "./fixtures";

/**
 * The Projects view (docs/notes/projects-redesign-1-index.md): the index (rows by last
 * activity, status sentences, pills, setup links, filter, keyboard), a project's page
 * (header, picker, checkouts table, kind variants, details, narrow layout), the workspace
 * page's header, navigation (a selection and a side panel per page, the sidebar row
 * reopening the last page), and a project's Worktrees without threads with the remove
 * confirm (docs/notes/projects-redesign-2-leftovers.md). The mock's projects: code-foundry (repo-cf) and
 * ghostty-playground (repo-gp) on GitHub, dotfiles (repo-dot, a remote that is not
 * GitHub), sketches (repo-sk, git without a remote) and writing (repo-wr, no git).
 */

test.beforeEach(async () => {
  await resetMock();
});

const row = (page: Page, projectId: string) => page.locator(`[data-nav-key="p:${projectId}"]`);
const wsRow = (page: Page, workspaceId: string) => page.locator(`[data-nav-key="ws:${workspaceId}"]`);
const checkout = (page: Page, path: string) => page.locator(`[data-testid="project-worktree"][data-path="${path}"]`);
const checkoutRow = (page: Page, projectId: string, path: string) => page.locator(`[data-nav-key="pw:${projectId}::${path}"]`);
const indexIds = (page: Page) => page.locator('[data-testid="index-project"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-project")));
const FEAT = `${CF}.worktrees/feat-sidebar`;
const FIX = `${CF}.worktrees/fix-resize`;
const MERGED = "/Users/dev/.code-foundry/worktrees/alexwaumann/code-foundry/cf-usage-polish";
// POST /__mock/leftovers: three leftovers (and MERGED with clean=1).
const SPIKE = "/Users/dev/.code-foundry/worktrees/alexwaumann/code-foundry/cf-perf-spike";
const COPY = "/Users/dev/.code-foundry/worktrees/alexwaumann/code-foundry/cf-old-copy";
const SHADERS = `${CF}-shaders`;
const leftover = (page: Page, path: string) => page.locator(`[data-testid="leftover-row"][data-path="${path}"]`);

async function lastInvocation(name: string) {
  await expect.poll(async () => (await invocations()).filter((i) => i.name === name).length).toBeGreaterThan(0);
  return (await invocations()).filter((i) => i.name === name).at(-1);
}
/** Escape closes the open menu (and waits out its closing animation). */
async function closeMenu(page: Page, testId: string): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(`${testId}-menu`)).toHaveCount(0);
}
async function menuItems(page: Page, testId: string): Promise<string[]> {
  const menu = page.getByTestId(`${testId}-menu`);
  await expect(menu).toBeVisible();
  // A count badge reads "Clean up merged worktrees 1".
  return (await menu.getByRole("menuitem").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
}
const panelKey = (page: Page) => page.getByTestId("side-panel").getAttribute("data-panel-key");

test("the index: a row per project by last activity, its kind, caption, status sentence, pills and setup links", async ({ page }) => {
  // sketches gets the newest thread; writing has none, so it goes last.
  await mockPost("threads?project=repo-sk&count=1&status=busy");
  await openApp(page);
  await openProjects(page);
  await expect(page.getByTestId("index-project")).toHaveCount(5);
  const ids = await indexIds(page);
  expect(ids[0]).toBe("repo-sk");
  expect(ids.at(-1)).toBe("repo-wr");
  // ghostty-playground's latest thread is older than code-foundry's and dotfiles'.
  expect(ids.indexOf("repo-gp")).toBeGreaterThan(ids.indexOf("repo-cf"));
  expect(ids.indexOf("repo-gp")).toBeGreaterThan(ids.indexOf("repo-dot"));

  const kinds: [string, string, string, string][] = [
    ["repo-cf", "github", "alexwaumann/code-foundry", "2 threads working · 3 checkouts"],
    ["repo-dot", "git", "origin · not GitHub", "idle · main only"],
    ["repo-sk", "git", "local only", "1 thread working · main only"],
    ["repo-wr", "nogit", "~/Documents/writing · no git", "idle"],
  ];
  for (const [id, kind, caption, status] of kinds) {
    await expect(row(page, id).getByTestId("index-project")).toHaveAttribute("data-kind", kind);
    await expect(row(page, id).getByTestId("project-caption")).toHaveText(caption);
    await expect(row(page, id).getByTestId("project-status")).toHaveText(status);
  }
  // Green dot only while a thread works.
  await expect(row(page, "repo-cf").locator("[data-live]")).toHaveCount(1);
  await expect(row(page, "repo-dot").locator("[data-live]")).toHaveCount(0);
  // Pills only for what needs a look: code-foundry's open pull requests (a draft counts).
  await expect(row(page, "repo-cf").getByTestId("index-prs")).toHaveText("2 PRs");
  await expect(page.getByTestId("index-prs")).toHaveCount(1);
  await expect(page.getByTestId("index-tidy")).toHaveCount(0);
  // Setup links: Publish on the repository without a remote, Initialize git on the folder.
  await expect(page.getByTestId("index-publish")).toHaveCount(1);
  await expect(row(page, "repo-sk").getByTestId("index-publish")).toHaveText("Publish to GitHub…");
  await expect(row(page, "repo-wr").getByTestId("index-init-git")).toHaveText("Initialize git");
  // Ages: a thread's, none for a project without threads.
  await expect(row(page, "repo-sk").getByTestId("index-age")).toHaveText("now");
  await expect(row(page, "repo-wr").getByTestId("index-age")).toHaveText("");

  // Hover actions are hidden at rest and show on hover.
  await page.mouse.move(0, 0);
  const actions = row(page, "repo-gp").getByTestId("index-row-actions");
  await expect(actions).toHaveCSS("opacity", "0");
  await row(page, "repo-gp").hover();
  await expect(actions).toHaveCSS("opacity", "1");
  // No New worktree anywhere: worktrees are made by threads and agents.
  await row(page, "repo-gp").getByTestId("project-more").click();
  expect(await menuItems(page, "project-more")).toEqual(["New action…", "Clean up merged worktrees 0", "Remove project"]);
  await closeMenu(page, "project-more");
  await row(page, "repo-wr").hover();
  await row(page, "repo-wr").getByTestId("project-more").click();
  expect(await menuItems(page, "project-more")).toEqual(["New action…", "Initialize git", "Remove project"]);
  await closeMenu(page, "project-more");

  // The setup links act without opening the page.
  await row(page, "repo-sk").getByTestId("index-publish").click();
  await expect(page.getByTestId("publish-dialog")).toHaveAttribute("data-project", "repo-sk");
  await page.keyboard.press("Escape");
  await row(page, "repo-wr").getByTestId("index-init-git").click();
  expect((await lastInvocation("project.git.init"))?.args).toEqual({ project: "repo-wr" });
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
  await expect(row(page, "repo-wr").getByTestId("index-project")).toHaveAttribute("data-kind", "git");

  // A click opens the project's page.
  await row(page, "repo-gp").click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-project", "repo-gp");
});

test("the index's Workspaces rows: members, status, contents; a click opens the workspace's page", async ({ page }) => {
  const ws = (await mockPost("workspace?name=platform&projects=repo-cf,repo-gp&skills=a,b")) as { id: string };
  await mockPost(`workspace-thread?workspace=${ws.id}&project=repo-gp&name=driver&status=busy&branch=cf/platform`);
  await openApp(page);
  await openProjects(page);
  const r = wsRow(page, ws.id);
  await expect(r.getByTestId("workspace-name")).toHaveText("platform");
  await expect(r.getByTestId("workspace-caption")).toHaveText("code-foundry + ghostty-playground");
  await expect(r.getByTestId("workspace-status")).toHaveText(/^1 thread working/);
  await expect(r.getByTestId("workspace-contents")).toHaveText("no instructions · 2 skills");
  await r.click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "workspace");
  await expect(page.getByTestId("page-name")).toHaveText("platform");
  await expect(page.getByTestId("workspace-meta")).toHaveText("workspace · 2 projects");
  // Its body (e2e/workspace-page.spec.ts covers it).
  await expect(page.locator(`[data-testid="workspace"][data-workspace="${ws.id}"]`)).toBeVisible();
  await page.getByTestId("workspace-page-reveal").click();
  expect((await lastInvocation("workspace.reveal"))?.args).toEqual({ workspace: ws.id });
  await page.getByTestId("workspace-page-more").click();
  expect(await menuItems(page, "workspace-page-more")).toEqual(["Rename…", "Remove workspace…"]);
  await page.getByTestId("workspace-page-rename").click();
  await expect(page.getByTestId("workspace-name-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByTestId("workspace-page-new-thread").click();
  await expect(page.getByTestId("composer")).toBeVisible();
});

test("the filter: / focuses it, it matches names, slugs, branches and paths, says when nothing matches, Escape clears it", async ({ page }) => {
  await mockPost("workspace?name=login&projects=repo-cf,repo-gp");
  await openApp(page);
  await openProjects(page);
  const filter = page.getByTestId("projects-filter");
  await page.getByTestId("projects-list").focus();
  await page.keyboard.press("/");
  await expect(filter).toBeFocused();

  // A branch: the project with it, as a whole row.
  await page.keyboard.type("RESIZE");
  await expect(page.getByTestId("index-project")).toHaveCount(1);
  await expect(page.getByTestId("project-name")).toHaveText(["code-foundry"]);
  await expect(page.getByTestId("workspaces-section")).toHaveCount(0);
  // A slug, a tildified path, a workspace by its name (or a member's).
  await filter.fill("alexwaumann/ghostty");
  await expect(page.getByTestId("project-name")).toHaveText(["ghostty-playground"]);
  await filter.fill("~/documents");
  await expect(page.getByTestId("project-name")).toHaveText(["writing"]);
  await filter.fill("logi");
  await expect(page.getByTestId("index-project")).toHaveCount(0);
  await expect(page.getByTestId("index-workspace")).toHaveCount(1);
  await filter.fill("zig");
  await expect(page.getByTestId("projects-no-matches")).toHaveText("Nothing matches “zig”. The filter looks at names, GitHub slugs, branches and paths.");

  // Escape clears it and gives the list the keyboard.
  await page.keyboard.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(page.getByTestId("projects-list")).toBeFocused();
  await expect(page.getByTestId("index-project")).toHaveCount(5);
});

test("keyboard: ↑/↓ move the cursor over projects then workspaces, Enter opens the page", async ({ page }) => {
  const ws = (await mockPost("workspace?name=login&projects=repo-cf")) as { id: string };
  await openApp(page);
  await openProjects(page);
  const list = page.getByTestId("projects-list");
  await expect(list).toBeFocused();
  const ids = await indexIds(page);
  await page.keyboard.press("ArrowDown");
  await expect(row(page, ids[0] ?? "")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(row(page, ids[1] ?? "")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(wsRow(page, ws.id)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-project", ids[1] ?? "");
  // The project page's list has the keyboard: ↓ then Enter opens a checkout's Changes tab.
  await openProjectPage(page, "repo-cf");
  await expect(page.getByTestId("projects-list")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("changes-surface")).toBeVisible();
});

test("an empty install: No projects yet with the three ways to add one", async ({ page }) => {
  await mockPost("empty");
  await page.goto(appPath);
  await openProjects(page);
  const empty = page.getByTestId("projects-empty");
  await expect(empty).toContainText("No projects yet");
  await expect(empty).toContainText("or code-foundry project add ~/src/app");
  await empty.getByTestId("projects-empty-github").click();
  await expect(page.getByTestId("add-project-dialog")).toBeVisible();
  await expect(page.getByTestId("add-project-dialog").getByRole("tab", { selected: true })).toContainText("GitHub");
  await page.keyboard.press("Escape");
  await empty.getByTestId("projects-empty-local").click();
  await expect(page.getByTestId("add-project-dialog").getByRole("tab", { selected: true })).toContainText("Local");
});

test("a project's page: header, the checkouts table by activity, a row opens its Changes tab, the row menu", async ({ page }) => {
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  await expect(page.getByTestId("page-name")).toHaveText("code-foundry");
  await expect(page.getByTestId("project-meta")).toHaveText("alexwaumann/code-foundry");
  for (const id of ["project-refresh", "project-terminal", "project-new-thread", "project-more"]) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId("project-terminal")).toHaveText("Terminal");
  await expect(page.getByTestId("checkouts-title")).toContainText("main plus 2 worktrees · 2 threads working");
  await expect(page.getByTestId("checkouts-head")).toHaveText(/Branch\s*Threads\s*Changes\s*Sync\s*Pull request/);

  // Working first (main: s-1, feat/sidebar: s-5 starting), then the rest.
  const branches = page.getByTestId("worktree-branch");
  await expect(branches).toHaveCount(3);
  await expect(branches.last()).toHaveText("fix/resize");
  await expect(checkout(page, CF).getByTestId("worktree-main-tag")).toHaveText("main");
  // main: s-1 working, s-8 snoozed (idle); s-7 archived is left out.
  await expect(checkout(page, CF).getByTestId("worktree-threads")).toHaveText("1 working · 1 idle");
  await expect(checkout(page, FIX).getByTestId("worktree-threads")).toHaveText("1 idle");
  await expect(checkout(page, FIX).getByTestId("worktree-sync")).toHaveText("1 behind");
  await expect(checkout(page, CF).getByTestId("worktree-sync")).toHaveText("up to date");
  await expect(checkout(page, CF).getByTestId("worktree-changes-cell")).toHaveText("clean");
  // Pull requests as tinted pills; none on main.
  await expect(checkout(page, FEAT).getByTestId("worktree-pr")).toContainText("#142");
  await expect(checkout(page, FEAT).getByTestId("worktree-pr")).toHaveAttribute("data-state", "open");
  await expect(checkout(page, CF).getByTestId("worktree-pr")).toHaveCount(0);

  // A click opens the checkout's Changes tab in this page's own panel.
  await checkoutRow(page, "repo-cf", FIX).click();
  await expect(page.getByTestId("changes-surface")).toHaveAttribute("data-path", FIX);
  expect(await panelKey(page)).toBe("view:projects:project:repo-cf");

  // The row menu: main has no Remove; the others do.
  await checkoutRow(page, "repo-cf", CF).hover();
  await checkoutRow(page, "repo-cf", CF).getByTestId("worktree-more").click();
  expect(await menuItems(page, "worktree-more")).toEqual(["New thread here", "New terminal here", "Show changes", "Open in Finder", "Copy path"]);
  await closeMenu(page, "worktree-more");
  await checkoutRow(page, "repo-cf", FEAT).hover();
  await checkoutRow(page, "repo-cf", FEAT).getByTestId("worktree-more").click();
  expect(await menuItems(page, "worktree-more")).toEqual(["New thread here", "New terminal here", "Show changes", "Open pull request #142", "Open in Finder", "Copy path", "Remove worktree…"]);
  await page.getByTestId("worktree-reveal").click();
  const reveal = await lastInvocation("worktree.reveal");
  expect(reveal?.args).toEqual({ worktree: FEAT });
  await checkoutRow(page, "repo-cf", FIX).hover();
  await checkoutRow(page, "repo-cf", FIX).getByTestId("worktree-more").click();
  await page.getByTestId("worktree-remove").click();
  await expect(page.getByTestId("remove-worktree-title")).toHaveText("Remove the worktree on fix/resize?");
  await page.getByTestId("remove-worktree-ok").click();
  expect((await lastInvocation("project.worktree.remove"))?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: FIX });

  // The header's menu: no New worktree.
  await page.getByTestId("project-more").click();
  expect(await menuItems(page, "project-more")).toEqual(["New action…", "Clean up merged worktrees 0", "Remove project"]);
  await closeMenu(page, "project-more");

  // Details.
  await expect(page.getByTestId("details-path")).toContainText("~/src/code-foundry");
  await expect(page.getByTestId("details-default-branch")).toContainText("main");
  await expect(page.getByTestId("details-refreshed")).toHaveText(/^refreshed (just now|\d+m ago)$/);
  await expect(page.getByTestId("details-remote")).toContainText("origin · github.com/alexwaumann/code-foundry");
  await expect(page.getByTestId("details-worktrees")).toContainText("~/src/code-foundry.worktrees · 1"); // fix/resize was removed above
  await expect(page.getByText("Show in sidebar")).toHaveCount(0);
  // Worktrees without threads sits between Checkouts and Details; threads hold both worktrees here.
  const sections = await page.getByTestId("projects-list").evaluate((el) => [...el.children].map((c) => c.getAttribute("data-testid")));
  expect(sections).toEqual(["project-checkouts", "leftover-worktrees", "project-details"]);
  await expect(page.getByTestId("leftover-empty")).toBeVisible();
});

test("the picker: projects by activity, then workspaces, then Add project…; picking switches the page", async ({ page }) => {
  const ws = (await mockPost("workspace?name=platform&projects=repo-cf,repo-gp")) as { id: string };
  await openApp(page);
  await openProjects(page);
  const order = await indexIds(page);
  await row(page, "repo-cf").click();
  await page.getByTestId("page-picker").click();
  const menu = page.getByTestId("page-picker-menu");
  await expect(menu).toBeVisible();
  expect(await menu.getByTestId("page-picker-project").evaluateAll((els) => els.map((e) => e.getAttribute("data-project")))).toEqual(order);
  await expect(menu.locator('[data-current="true"]')).toHaveAttribute("data-project", "repo-cf");
  await expect(menu.getByTestId("page-picker-workspace")).toHaveText(/platform/);
  await expect(menu.getByTestId("page-picker-add-project")).toHaveText("Add project…");
  await menu.locator('[data-project="repo-dot"]').click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-project", "repo-dot");
  await expect(page.getByTestId("projects-list")).toBeFocused();
  await page.getByTestId("page-picker").click();
  await page.getByTestId("page-picker-workspace").click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-workspace", ws.id);
  // The crumb goes back to the index.
  await page.getByTestId("projects-crumb").click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
});

test("kind variants: no remote (note, no Sync or PR), another remote (no PR), no git (note, Threads, no table)", async ({ page }) => {
  await openApp(page);
  await openProjectPage(page, "repo-sk");
  await expect(page.getByTestId("project-meta")).toHaveText("local only · no remote");
  await expect(page.getByTestId("project-note")).toContainText("This repository has no remote. Threads can commit, but nothing can be pushed and there are no pull requests.");
  await expect(page.getByTestId("checkouts-col-sync")).toHaveCount(0);
  await expect(page.getByTestId("checkouts-col-pr")).toHaveCount(0);
  await expect(page.getByTestId("checkouts-title")).toContainText("main only");
  await expect(page.getByTestId("details-remote")).toHaveCount(0);
  await page.getByTestId("project-publish").click();
  await expect(page.getByTestId("publish-dialog")).toHaveAttribute("data-project", "repo-sk");
  await page.keyboard.press("Escape");
  await page.getByTestId("project-more").click();
  expect(await menuItems(page, "project-more")).toEqual(["New action…", "Publish to GitHub…", "Remove project"]);
  await closeMenu(page, "project-more");

  await openProjectPage(page, "repo-dot");
  await expect(page.getByTestId("project-meta")).toHaveText("origin · not GitHub");
  await expect(page.getByTestId("project-note")).toHaveCount(0);
  await expect(page.getByTestId("checkouts-col-sync")).toHaveCount(1);
  await expect(page.getByTestId("checkouts-col-pr")).toHaveCount(0);
  await expect(page.getByTestId("details-remote")).toContainText("origin · pull requests need GitHub");

  await openProjectPage(page, "repo-wr");
  await expect(page.getByTestId("project-meta")).toHaveText("~/Documents/writing");
  await expect(page.getByTestId("project-note")).toContainText("A plain folder, not a git repository.");
  await expect(page.getByTestId("checkouts-table")).toHaveCount(0);
  await expect(page.getByTestId("project-refresh")).toHaveCount(0);
  await expect(page.getByTestId("project-threads")).toContainText("No thread is working here. New thread or Terminal.");
  await expect(page.getByTestId("details-default-branch")).toHaveCount(0);
  await expect(page.getByTestId("details-actions")).toContainText(/none\s*·\s*Add an action/);
  await page.getByTestId("project-init-git").click();
  const init = await lastInvocation("project.git.init");
  expect(init?.args).toEqual({ project: "repo-wr" });
  expect(init?.context).toMatchObject({ activeProjectId: "repo-wr", activeView: "projects" });
  // A git repository without a remote now: its checkouts and the Publish note.
  await expect(page.getByTestId("checkouts-table")).toBeVisible();
  await expect(page.getByTestId("project-note")).toContainText("no remote");
});

test("Refresh fetches (with a remote) then refreshes, spinning meanwhile; a failed refresh shows in the header and Details", async ({ page }) => {
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  const refresh = page.getByTestId("project-refresh");
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(refresh.locator("svg")).toHaveClass(/animate-spin/);
  await expect(refresh).toBeEnabled();
  const fetch = await lastInvocation("git.fetch");
  expect(fetch?.args).toEqual({ worktree: CF });
  const names = (await invocations()).map((i) => i.name).filter((n) => n === "git.fetch" || n === "project.refresh");
  expect(names).toEqual(["git.fetch", "project.refresh"]);
  // Without a remote: only project.refresh.
  await openProjectPage(page, "repo-sk");
  await page.getByTestId("project-refresh").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "project.refresh").length).toBe(2);
  expect((await invocations()).filter((i) => i.name === "git.fetch")).toHaveLength(1);

  await openProjectPage(page, "repo-cf");
  await expect(page.getByTestId("project-refresh-failed")).toHaveCount(0);
  await mockPost(`worktree/refresh-error?path=${encodeURIComponent(CF)}&error=${encodeURIComponent("could not reach origin")}&ago=870000`);
  await expect(page.getByTestId("project-refresh-failed")).toHaveText(/^Refresh failed · could not reach origin· 1[45]m ago$/);
  await expect(page.getByTestId("details-refreshed")).toHaveText(/^refresh failed 1[45]m ago$/);
  await expect(page.getByTestId("details-refreshed")).toHaveAttribute("data-failed", "true");
  // Everything else keeps the last known state.
  await expect(page.getByTestId("worktree-branch")).toHaveCount(3);
  await mockPost(`worktree/refresh-error?path=${encodeURIComponent(CF)}`);
  await expect(page.getByTestId("project-refresh-failed")).toHaveCount(0);
});

test("narrow: with the Changes tab open, Sync and the slug drop and Terminal shows its icon only", async ({ page }) => {
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  await expect(page.getByTestId("projects-page")).not.toHaveAttribute("data-narrow");
  await checkoutRow(page, "repo-cf", FEAT).click();
  await expect(page.getByTestId("changes-surface")).toBeVisible();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-narrow", "true");
  await expect(page.getByTestId("checkouts-col-sync")).toHaveCount(0);
  await expect(page.getByTestId("worktree-sync")).toHaveCount(0);
  await expect(page.getByTestId("project-meta")).toHaveCount(0);
  await expect(page.getByTestId("project-terminal")).toHaveText("");
  await expect(page.getByTestId("checkouts-col-pr")).toHaveCount(1);
  // Row actions still reach: on hover, over the row's end.
  await checkoutRow(page, "repo-cf", FIX).hover();
  await expect(checkoutRow(page, "repo-cf", FIX).getByTestId("worktree-new-terminal")).toBeVisible();
  // Closing the panel gives the room back.
  await page.getByTestId("side-panel").getByTestId("panel-toggle").click();
  await expect(page.getByTestId("projects-page")).not.toHaveAttribute("data-narrow");
  await expect(page.getByTestId("checkouts-col-sync")).toHaveCount(1);
  await expect(page.getByTestId("project-terminal")).toHaveText("Terminal");
});

test("each page has its own side panel; the sidebar row reopens the last page and goes to the index from one", async ({ page }) => {
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  await checkoutRow(page, "repo-cf", FIX).click();
  await expect(page.getByTestId("side-panel").getByRole("tab", { selected: true })).toHaveText("Changes · code-foundry · fix/resize");

  // ghostty-playground's page has its own panel: closed, nothing of code-foundry's.
  await openProjectPage(page, "repo-gp");
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
  // The index has its own too.
  await page.getByTestId("projects-crumb").click();
  await expect(page.getByTestId("side-panel")).toHaveCount(0);

  // Back on code-foundry's page: its tab is still there.
  await row(page, "repo-cf").click();
  await expect(page.getByTestId("side-panel").getByRole("tab", { selected: true })).toHaveText("Changes · code-foundry · fix/resize");
  expect(await panelKey(page)).toBe("view:projects:project:repo-cf");

  // Elsewhere, then the sidebar row: the last Projects page; again: the index.
  await page.getByTestId("nav-pullrequests").click();
  await page.getByTestId("nav-projects").click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-project", "repo-cf");
  await page.getByTestId("nav-projects").click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
  // Remembered across a reload (the UI store keeps it).
  await row(page, "repo-dot").click();
  await page.reload();
  await expect(page.getByTestId("thread-list").locator("[data-row-key]").first()).toBeVisible();
  await page.getByTestId("nav-projects").click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-project", "repo-dot");

  // History walks the pages.
  await page.getByTestId("projects-crumb").click();
  await page.keyboard.press("Meta+BracketLeft");
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-project", "repo-dot");
  await page.keyboard.press("Meta+BracketRight");
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
});

test("a page's scroll position is remembered while the window lives", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 420 });
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  const scroll = page.getByTestId("projects-scroll");
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const top = await scroll.evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(0);
  await page.getByTestId("projects-crumb").click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
  await row(page, "repo-cf").click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-project", "repo-cf");
  await expect.poll(() => page.getByTestId("projects-scroll").evaluate((el) => el.scrollTop)).toBe(top);
  // Another project's page starts at the top.
  await page.getByTestId("page-picker").click();
  await page.getByTestId("page-picker-menu").locator('[data-project="repo-gp"]').click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-project", "repo-gp");
  expect(await page.getByTestId("projects-scroll").evaluate((el) => el.scrollTop)).toBe(0);
});

test("worktrees to tidy: the index pill and the project menu count the cleanable ones; a terminal holds one", async ({ page }) => {
  await mockPost("worktree/merged?project=repo-cf&branch=cf/usage-polish");
  await openApp(page);
  await openProjects(page);
  await expect(row(page, "repo-cf").getByTestId("index-tidy")).toHaveText("1 worktree to tidy");
  await row(page, "repo-cf").click();
  await page.getByTestId("project-more").click();
  await expect(page.getByTestId("project-cleanup-count")).toHaveText("1");
  await closeMenu(page, "project-more");

  // A terminal open in it holds it (started as the CLI would: without threads the worktree
  // is in its own block, not the table, and its clean row offers no terminal).
  await expect(leftover(page, MERGED)).toHaveCount(1);
  await expect(checkout(page, MERGED)).toHaveCount(0);
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name: "terminal.new", args: {}, context: { activeProjectId: "repo-cf", activeWorktreePath: MERGED } }),
  });
  expect(res.ok).toBe(true);
  await expect(leftover(page, MERGED).getByTestId("leftover-reason")).toContainText("a terminal is open in it");
  await page.getByTestId("project-more").click();
  await expect(page.getByTestId("project-cleanup-count")).toHaveText("0");
  await closeMenu(page, "project-more");
  await openProjects(page);
  await expect(page.getByTestId("index-tidy")).toHaveCount(0);
});

test("Clean up merged worktrees removes them after a confirm and the index's pill goes", async ({ page }) => {
  await mockPost("worktree/merged?project=repo-cf&branch=cf/usage-polish");
  await mockPost("worktree/merged?project=repo-cf&branch=cf/old-docs");
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  await page.getByTestId("project-more").click();
  expect(await menuItems(page, "project-more")).toEqual(["New action…", "Clean up merged worktrees 2", "Remove project"]);
  await page.getByTestId("project-cleanup").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Fetch, then remove 2 worktrees");
  await dialog.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("worktree-branch")).toHaveCount(3);
  expect((await lastInvocation("project.worktree.cleanup"))?.args).toEqual({ project: "repo-cf" });
  await openProjects(page);
  await expect(page.getByTestId("index-tidy")).toHaveCount(0);
});

test("the workspace page reached by its row, and the workspace header's actions", async ({ page }) => {
  const ws = (await mockPost("workspace?name=login&projects=repo-cf,repo-gp")) as { id: string };
  await openApp(page);
  await openWorkspacePage(page, ws.id);
  expect(await page.getByTestId("projects-page").getAttribute("data-workspace")).toBe(ws.id);
  await page.getByTestId("projects-crumb").click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
});

test("Worktrees without threads: a row per leftover with why it stayed; Show diff, Resume, New thread; the three cleanable counts agree", async ({ page }) => {
  await mockPost("leftovers?project=repo-cf&clean=1");
  await openApp(page);
  await openProjects(page);
  await expect(row(page, "repo-cf").getByTestId("index-tidy")).toHaveText("1 worktree to tidy");
  await row(page, "repo-cf").click();
  await page.getByTestId("project-more").click();
  await expect(page.getByTestId("project-cleanup-count")).toHaveText("1");
  await closeMenu(page, "project-more");

  await expect(page.getByTestId("leftover-title")).toHaveText(/Worktrees without threads\s*· 4 kept/);
  await expect(page.getByTestId("leftover-remove-clean")).toHaveText("Remove the 1 that is clean");
  // Threads hold feat/sidebar and fix/resize: not leftovers.
  await expect(page.getByTestId("leftover-row")).toHaveCount(4);
  await expect(leftover(page, FEAT)).toHaveCount(0);
  // A worktree shows once: the table keeps main and the two held ones, the caption counts all seven.
  await expect(page.getByTestId("checkouts-title")).toContainText("main plus 6 worktrees · 2 threads working");
  await expect(page.getByTestId("project-worktree")).toHaveCount(3);
  for (const path of [CF, FEAT, FIX]) await expect(checkout(page, path)).toHaveCount(1);
  for (const path of [SPIKE, COPY, SHADERS, MERGED]) await expect(checkout(page, path)).toHaveCount(0);
  const rows: [string, string, string, boolean][] = [
    [SPIKE, "cf/perf-spike", "3 commits not on main · last thread archived 12d ago", true],
    [COPY, "cf/old-copy", "4 uncommitted files · merged otherwise · last thread archived 3w ago", true],
    [SHADERS, "exp/shaders", "made outside Code Foundry · clean · merged", false],
    [MERGED, "cf/usage-polish", "clean · merged", false],
  ];
  for (const [path, branch, reason, work] of rows) {
    const r = leftover(page, path);
    await expect(r.getByTestId("leftover-branch")).toHaveText(branch);
    await expect(r.getByTestId("leftover-reason")).toHaveText(reason);
    // Holding work: Show diff and Resume; clean: New thread. Remove… on every row.
    await expect(r.getByTestId("leftover-show-diff")).toHaveCount(work ? 1 : 0);
    await expect(r.getByTestId("leftover-resume")).toHaveCount(work ? 1 : 0);
    await expect(r.getByTestId("leftover-new-thread")).toHaveCount(work ? 0 : 1);
    await expect(r.getByTestId("leftover-remove")).toHaveText("Remove…");
    if (work) await expect(r).toHaveAttribute("data-work", "true");
    else await expect(r).not.toHaveAttribute("data-work");
  }
  await expect(page.getByTestId("leftover-footer")).toHaveText(
    "Worktrees made for a thread go on their own once its last thread is archived and the work is on main. These stayed because they still hold something.",
  );
  // Details counts the worktrees Code Foundry made.
  await expect(page.getByTestId("details-worktrees")).toContainText("6, 3 made by Code Foundry");

  // Show diff: the worktree's Changes tab in this page's panel; narrow, Remove shows its icon only.
  await leftover(page, COPY).getByTestId("leftover-show-diff").click();
  await expect(page.getByTestId("changes-surface")).toHaveAttribute("data-path", COPY);
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-narrow", "true");
  await expect(leftover(page, COPY).getByTestId("leftover-remove")).toHaveText("");
  await expect(leftover(page, COPY).getByTestId("leftover-remove")).toHaveAttribute("aria-label", "Remove worktree…");
  await page.getByTestId("side-panel").getByTestId("panel-toggle").click();

  // New thread on a clean one: the composer in that checkout.
  await leftover(page, MERGED).getByTestId("leftover-new-thread").click();
  await expect(page.getByTestId("composer-heading")).toContainText("code-foundry");
  await expect(page.getByTestId("composer-worktree")).toContainText("cf/usage-polish");

  // Resume with an archived thread there: it is unarchived and shown, so the worktree is no leftover.
  await openProjectPage(page, "repo-cf");
  await leftover(page, SPIKE).getByTestId("leftover-resume").click();
  const archive = await lastInvocation("thread.archive");
  expect(archive?.args).toMatchObject({ archived: "false" });
  expect(archive?.context).toMatchObject({ activeThreadId: "s-lo-spike" });
  await expect(page.getByTestId("thread-header").getByTestId("thread-title")).toHaveText("Profile the renderer");
  await openProjectPage(page, "repo-cf");
  await expect(leftover(page, SPIKE)).toHaveCount(0);
  await expect(page.getByTestId("leftover-title")).toContainText("3 kept");
  // ... and moves to the table.
  await expect(checkout(page, SPIKE)).toHaveCount(1);
  await expect(page.getByTestId("project-worktree")).toHaveCount(4);

  // Resume with no archived thread there: the composer in that checkout.
  await mockPost(`worktree/dirty?path=${encodeURIComponent(SHADERS)}&modified=2`);
  await expect(leftover(page, SHADERS).getByTestId("leftover-reason")).toHaveText("made outside Code Foundry · 2 uncommitted files · merged otherwise");
  await leftover(page, SHADERS).getByTestId("leftover-resume").click();
  await expect(page.getByTestId("composer-worktree")).toContainText("exp/shaders");
});

test("Remove…: the confirm names what goes and what stays; with uncommitted files it warns and lists them, and one yes removes", async ({ page }) => {
  await mockPost("leftovers?project=repo-cf");
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  await expect(page.getByTestId("leftover-remove-clean")).toHaveCount(0);

  // Dirty: the warning, the first three files and how many more; Show diff closes it and opens the Changes tab.
  await leftover(page, COPY).getByTestId("leftover-remove").click();
  const dialog = page.getByTestId("remove-worktree-dialog");
  await expect(page.getByTestId("remove-worktree-title")).toHaveText("Remove the worktree on cf/old-copy?");
  await expect(page.getByTestId("remove-worktree-body")).toHaveText("~/.code-foundry/worktrees/alexwaumann/code-foundry/cf-old-copy goes. The branch cf/old-copy stays.");
  await expect(page.getByTestId("remove-worktree-loss-count")).toHaveText("4 uncommitted files are lost.");
  await expect(page.getByTestId("remove-worktree-loss-files")).toHaveText("gui/frontend/src/lib/tree.ts, docs/notes/sidebar.md, scratch.txt and 1 more · Show diff");
  await page.getByTestId("remove-worktree-show-diff").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("changes-surface")).toHaveAttribute("data-path", COPY);
  await expect(leftover(page, COPY)).toHaveCount(1);

  // Cancel keeps it.
  await leftover(page, SPIKE).getByTestId("leftover-remove").click();
  await expect(page.getByTestId("remove-worktree-loss")).toHaveCount(0);
  await page.getByTestId("remove-worktree-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(leftover(page, SPIKE)).toHaveCount(1);

  // One yes removes the dirty one: the daemon's second question (force) is answered by it.
  await leftover(page, COPY).getByTestId("leftover-remove").click();
  await page.getByTestId("remove-worktree-ok").click();
  await expect(leftover(page, COPY)).toHaveCount(0);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  const removes = (await invocations()).filter((i) => i.name === "project.worktree.remove");
  expect(removes.at(-1)?.args).toEqual({ path: COPY, force: "true" });
  expect(removes.at(-1)?.confirmed).toBe(true);

  // Clean: no warning, no force.
  await leftover(page, SHADERS).getByTestId("leftover-remove").click();
  await expect(page.getByTestId("remove-worktree-title")).toHaveText("Remove the worktree on exp/shaders?");
  await expect(page.getByTestId("remove-worktree-loss")).toHaveCount(0);
  await page.getByTestId("remove-worktree-ok").click();
  await expect(leftover(page, SHADERS)).toHaveCount(0);
  expect((await lastInvocation("project.worktree.remove"))?.args).toEqual({ path: SHADERS });
  await expect(page.getByTestId("leftover-title")).toContainText("1 kept");
});

test("Remove the N that are clean runs the cleanup after its confirm; with nothing kept the section says so", async ({ page }) => {
  await mockPost("leftovers?project=repo-cf&clean=1");
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  await page.getByTestId("leftover-remove-clean").click();
  await page.getByTestId("confirm-dialog").getByTestId("confirm-ok").click();
  await expect(leftover(page, MERGED)).toHaveCount(0);
  expect((await lastInvocation("project.worktree.cleanup"))?.args).toEqual({ project: "repo-cf" });
  await expect(page.getByTestId("leftover-remove-clean")).toHaveCount(0);
  // Only the cleanable one goes: the others still hold something (or were made outside the app).
  await expect(page.getByTestId("leftover-row")).toHaveCount(3);
  await openProjects(page);
  await expect(page.getByTestId("index-tidy")).toHaveCount(0);

  // ghostty-playground: nothing kept.
  await openProjectPage(page, "repo-gp");
  await expect(page.getByTestId("leftover-title")).toHaveText("Worktrees without threads");
  await expect(page.getByTestId("leftover-empty")).toHaveText("Nothing kept. Worktrees made for a thread go on their own once its last thread is archived and the work is on main.");
  await expect(page.getByTestId("leftover-footer")).toHaveCount(0);
  await expect(page.getByTestId("leftover-remove-clean")).toHaveCount(0);
});
