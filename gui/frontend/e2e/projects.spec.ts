import { expect, test, type Locator, type Page } from "@playwright/test";
import { CF, invocations, mockPost, openApp, openProjects, resetMock } from "./fixtures";

/**
 * The Projects page's project kinds, collapsible projects and workspaces, and the header
 * filter (docs/notes/projects-polish-1.md); always-visible actions, overflow menus, thread
 * counts, freshness and refresh, and the Publish / Initialize git gates
 * (docs/notes/projects-polish-2.md); the "in main" tag, the broom and Clean up merged
 * worktrees (docs/notes/projects-polish-3.md). The mock's projects: code-foundry and
 * ghostty-playground (GitHub), dotfiles (a remote that is not GitHub), sketches (git, no
 * remote) and writing (no git).
 */

test.beforeEach(async () => {
  await resetMock();
});

const project = (page: Page, repoId: string) => page.locator(`[data-testid="project"][data-repo="${repoId}"]`);
const navKeys = (page: Page) => page.getByTestId("projects-list").locator("[data-nav-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav-key")));

test("each project's header says what kind it is", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  const want: [string, string, string | null][] = [
    ["repo-cf", "github", "alexwaumann/code-foundry"],
    ["repo-gp", "github", "alexwaumann/ghostty-playground"],
    ["repo-dot", "git", "origin · not GitHub"],
    ["repo-sk", "git", "local only · no remote"],
    ["repo-wr", "nogit", null],
  ];
  for (const [id, kind, meta] of want) {
    const p = project(page, id);
    await expect(p).toHaveAttribute("data-kind", kind);
    await expect(p).toHaveAttribute("data-git", String(kind !== "nogit"));
    await expect(p.getByTestId("project-kind-icon")).toHaveAttribute("title", /\.$/);
    if (meta === null) {
      await expect(p.getByTestId("project-meta")).toHaveCount(0);
      await expect(p.locator(`[data-nav-key="p:${id}"]`).getByTestId("no-git-badge")).toBeVisible();
    } else {
      await expect(p.getByTestId("project-meta")).toHaveText(meta);
    }
  }
  await expect(project(page, "repo-sk").getByTestId("project-kind-icon")).toHaveAttribute("title", /no remote/);
});

test("collapse a project and a workspace by mouse and keyboard; it persists across a reload", async ({ page }) => {
  const ws = (await mockPost("workspace?name=login&repos=repo-cf,repo-gp")) as { id: string };
  await openApp(page);
  await openProjects(page);
  const cf = project(page, "repo-cf");
  const toggle = cf.getByTestId("project-collapse");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(cf.getByTestId("project-worktree")).toHaveCount(3);

  // The chevron collapses: no rows, the header counts them (the workspace added a fourth).
  await toggle.click();
  await expect(cf).toHaveAttribute("data-collapsed", "true");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(cf.getByTestId("project-worktree")).toHaveCount(0);
  await expect(cf.getByTestId("project-collapsed-summary")).toHaveText("4 worktrees · 1 in a workspace");
  // Its rows left the keyboard list; the list kept the focus.
  expect(await navKeys(page)).not.toContain("pw:repo-cf::/Users/dev/src/code-foundry");
  await expect(page.getByTestId("projects-list")).toBeFocused();

  // The workspace collapses by keyboard: ← on its header row, → expands, ← again.
  const w = page.locator(`[data-testid="workspace"][data-workspace="${ws.id}"]`);
  await w.locator(`[data-nav-key="ws:${ws.id}"]`).click();
  await page.keyboard.press("ArrowLeft");
  await expect(w).toHaveAttribute("data-collapsed", "true");
  await expect(w.getByTestId("workspace-collapsed-summary")).toHaveText("2 members");
  await expect(w.getByTestId("workspace-collapse")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(w).toHaveAttribute("data-collapsed", "false");
  await page.keyboard.press("ArrowLeft");
  await expect(w).toHaveAttribute("data-collapsed", "true");

  // Both stay collapsed after a reload (the UI store's persisted sets).
  await page.reload();
  await expect(page.getByTestId("thread-list").locator("[data-row-key]").first()).toBeVisible();
  await openProjects(page);
  await expect(cf).toHaveAttribute("data-collapsed", "true");
  await expect(cf.getByTestId("project-worktree")).toHaveCount(0);
  await expect(w).toHaveAttribute("data-collapsed", "true");
  await expect(project(page, "repo-gp")).toHaveAttribute("data-collapsed", "false");

  // Expanding again brings the rows back.
  await cf.getByTestId("project-collapse").click();
  await expect(cf.getByTestId("project-worktree")).toHaveCount(3);
});

test("the filter: / focuses it, it hides what does not match, shows collapsed matches expanded, Escape clears it", async ({ page }) => {
  await mockPost("workspace?name=login&repos=repo-cf,repo-gp");
  await openApp(page);
  await openProjects(page);
  const cf = project(page, "repo-cf");
  await cf.getByTestId("project-collapse").click();
  await expect(cf).toHaveAttribute("data-collapsed", "true");

  const filter = page.getByTestId("projects-filter");
  await page.getByTestId("projects-list").focus();
  await page.keyboard.press("/");
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue("");

  // A branch: only the project with it, only that row, expanded although saved collapsed.
  await page.keyboard.type("RESIZE");
  await expect(page.getByTestId("project")).toHaveCount(1);
  await expect(cf).toHaveAttribute("data-collapsed", "false");
  await expect(cf.getByTestId("project-collapse")).toBeDisabled();
  await expect(cf.getByTestId("worktree-branch")).toHaveText(["fix/resize"]);
  await expect(page.getByTestId("workspaces-no-matches")).toHaveText("No matches.");

  // A project name: all its rows.
  await filter.fill("ghostty");
  await expect(page.getByTestId("project-name")).toHaveText(["ghostty-playground"]);
  await expect(project(page, "repo-gp").getByTestId("project-worktree")).toHaveCount(1);

  // A tildified path, and the workspace by its branch.
  await filter.fill("~/documents");
  await expect(page.getByTestId("project-name")).toHaveText(["writing"]);
  await filter.fill("cf/login");
  await expect(page.getByTestId("projects-no-matches")).toHaveText("No matches.");
  await expect(page.getByTestId("workspace-name")).toHaveText(["login"]);

  // Escape clears it and gives the list the keyboard; the saved collapsed state is untouched.
  await page.keyboard.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(page.getByTestId("projects-list")).toBeFocused();
  await expect(page.getByTestId("project")).toHaveCount(5);
  await expect(cf).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId("projects-counts")).toHaveText("5 projects · 1 workspace");
});

const wtRow = (page: Page, repoId: string, path: string) => page.locator(`[data-nav-key="pw:${repoId}::${path}"]`);
const FEAT = `${CF}.worktrees/feat-sidebar`;
const FIX = `${CF}.worktrees/fix-resize`;
const opacity = (testId: string, within: Locator) => within.getByTestId(testId).evaluate((el) => getComputedStyle(el).opacity);
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

test("row actions show without hover, muted at rest, in a fixed-width column; rows show no path", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  await page.mouse.move(0, 0);
  const main = wtRow(page, "repo-cf", CF);
  const feat = wtRow(page, "repo-cf", FEAT);
  for (const id of ["worktree-new-thread", "worktree-new-terminal", "worktree-more"]) await expect(main.getByTestId(id)).toBeVisible();
  await expect.poll(() => opacity("worktree-actions", feat)).toBe("0.55");
  await expect.poll(() => opacity("project-actions", project(page, "repo-cf"))).toBe("0.7");
  // Hover brings a row's actions (and its card's header actions) to full opacity.
  await feat.hover();
  await expect.poll(() => opacity("worktree-actions", feat)).toBe("1");
  await expect.poll(() => opacity("project-actions", project(page, "repo-cf"))).toBe("1");
  // Every row's action column is as wide (the main row's too), so the state columns end at one x.
  const widths = await Promise.all([main, feat, wtRow(page, "repo-cf", FIX)].map(async (r) => (await r.getByTestId("worktree-actions").boundingBox())?.width));
  expect(new Set(widths).size).toBe(1);
  // Members too: always shown.
  await mockPost("workspace?name=login&repos=repo-cf,repo-gp");
  await expect(page.getByTestId("workspace-member").first()).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByTestId("member-actions").first().getByTestId("member-terminal")).toBeVisible();
  await expect.poll(() => page.getByTestId("member-actions").first().evaluate((el) => getComputedStyle(el).opacity)).toBe("0.55");

  // No path on git rows (the row's tooltip keeps it); the folder without git keeps it.
  await expect(project(page, "repo-cf").getByTestId("worktree-path")).toHaveCount(0);
  await expect(main).toHaveAttribute("title", CF);
  await expect(project(page, "repo-wr").getByTestId("worktree-path")).toHaveText("~/Documents/writing");
});

test("each worktree counts its live threads", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  // s-1 (busy) in the main worktree; s-5 (starting) and s-4 (disconnected) on feat/sidebar; s-3 (disconnected) on fix/resize.
  await expect(wtRow(page, "repo-cf", CF).getByTestId("worktree-threads")).toHaveText("1");
  await expect(wtRow(page, "repo-cf", CF).getByTestId("worktree-threads")).toHaveAttribute("title", "1 live thread");
  await expect(wtRow(page, "repo-cf", FEAT).getByTestId("worktree-threads")).toHaveText("1");
  await expect(wtRow(page, "repo-cf", FIX).getByTestId("worktree-threads")).toHaveCount(0);
  await mockPost("threads?repo=repo-cf&count=2&status=idle");
  await expect(wtRow(page, "repo-cf", CF).getByTestId("worktree-threads")).toHaveText("3");
  await expect(wtRow(page, "repo-cf", CF).getByTestId("worktree-threads")).toHaveAttribute("title", "3 live threads");
  // A workspace member with a live thread counts it too.
  await mockPost("workspace?name=login&repos=repo-cf,repo-gp");
  const gp = page.locator('[data-testid="workspace-member"][data-repo="repo-gp"]');
  await expect(gp).toBeVisible();
  await expect(gp.getByTestId("worktree-threads")).toHaveCount(0);
  await mockPost("workspace-thread?workspace=login&repo=repo-gp&name=driver&status=busy");
  await expect(gp.getByTestId("worktree-threads")).toHaveText("1");
});

test("overflow menus per row kind; the menu keeps the list's cursor and gives it the keyboard back", async ({ page }) => {
  await mockPost("workspace?name=login&repos=repo-cf,repo-gp");
  await openApp(page);
  await openProjects(page);

  const want: [string, string[]][] = [
    ["repo-cf", ["New worktree…", "Clean up merged worktrees 0", "Remove project"]],
    ["repo-dot", ["New worktree…", "Clean up merged worktrees 0", "Remove project"]],
    ["repo-sk", ["New worktree…", "Publish to GitHub…", "Remove project"]],
    ["repo-wr", ["Initialize git", "Remove project"]],
  ];
  for (const [id, items] of want) {
    await project(page, id).getByTestId("project-more").click();
    expect(await menuItems(page, "project-more")).toEqual(items);
    await closeMenu(page, "project-more");
  }

  await wtRow(page, "repo-cf", CF).getByTestId("worktree-more").click();
  expect(await menuItems(page, "worktree-more")).toEqual(["Show in side panel"]);
  await closeMenu(page, "worktree-more");
  await wtRow(page, "repo-cf", FIX).getByTestId("worktree-more").click();
  expect(await menuItems(page, "worktree-more")).toEqual(["Show in side panel", "Remove worktree…"]);
  await expect(page.getByTestId("worktree-remove")).toHaveAttribute("data-variant", "destructive");
  await closeMenu(page, "worktree-more");

  const ws = page.getByTestId("workspace").first();
  await ws.getByTestId("workspace-more").click();
  expect(await menuItems(page, "workspace-more")).toEqual(["Remove workspace"]);
  await closeMenu(page, "workspace-more");
  await ws.getByTestId("member-more").first().click();
  expect(await menuItems(page, "member-more")).toEqual(["Remove from workspace"]);
  await closeMenu(page, "member-more");

  // Arrow keys in a menu move in the menu, not the list's cursor; closing it gives the list the keyboard.
  const list = page.getByTestId("projects-list");
  await wtRow(page, "repo-cf", FIX).click();
  const cursor = await list.getAttribute("aria-activedescendant");
  await wtRow(page, "repo-cf", FIX).getByTestId("worktree-more").click();
  await expect(page.getByTestId("worktree-more-menu")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await closeMenu(page, "worktree-more");
  await expect(list).toHaveAttribute("aria-activedescendant", cursor ?? "");
  await expect(list).toBeFocused();

  // Show in side panel opens the worktree's tab; the list keeps the keyboard.
  await wtRow(page, "repo-cf", FIX).getByTestId("worktree-more").click();
  await page.getByTestId("worktree-show-panel").click();
  await expect(page.getByTestId("worktree-surface-title")).toHaveText("code-foundry@fix/resize");
  await expect(list).toBeFocused();
});

test("Publish to GitHub only on the remoteless project, Initialize git only on the one without git", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  for (const [id, publish, init] of [
    ["repo-cf", 0, 0],
    ["repo-gp", 0, 0],
    ["repo-dot", 0, 0],
    ["repo-sk", 1, 0],
    ["repo-wr", 0, 1],
  ] as const) {
    await expect(project(page, id).getByTestId("project-publish")).toHaveCount(publish);
    await expect(project(page, id).getByTestId("project-init-git")).toHaveCount(init);
  }
  // Publish opens the publish dialog for that project.
  await project(page, "repo-sk").getByTestId("project-publish").click();
  await expect(page.getByTestId("publish-dialog")).toHaveAttribute("data-repo", "repo-sk");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("publish-dialog")).toHaveCount(0);
  // The menu item too.
  await project(page, "repo-sk").getByTestId("project-more").click();
  await page.getByTestId("project-menu-publish").click();
  await expect(page.getByTestId("publish-dialog")).toHaveAttribute("data-repo", "repo-sk");
  // Closing the menu did not take the keyboard from the dialog.
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-testid=publish-dialog]") !== null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("publish-dialog")).toHaveCount(0);

  // Initialize git runs repo.git.init on that project; it then is a git project without a remote.
  await project(page, "repo-wr").getByTestId("project-init-git").click();
  const init = await lastInvocation("repo.git.init");
  expect(init?.args).toEqual({ repo: "repo-wr" });
  expect(init?.context).toMatchObject({ activeRepoId: "repo-wr", activeView: "projects" });
  await expect(project(page, "repo-wr")).toHaveAttribute("data-kind", "git");
  await expect(project(page, "repo-wr").getByTestId("project-init-git")).toHaveCount(0);
  await expect(project(page, "repo-wr").getByTestId("project-publish")).toHaveCount(1);
});

test("freshness shows on git projects; Refresh fetches (with a remote) then refreshes, spinning meanwhile", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  await expect(project(page, "repo-cf").getByTestId("project-freshness")).toHaveText(/^updated \d+s ago$/);
  await expect(project(page, "repo-sk").getByTestId("project-freshness")).toBeVisible();
  await expect(project(page, "repo-wr").getByTestId("project-freshness")).toHaveCount(0);
  await expect(project(page, "repo-wr").getByTestId("project-refresh")).toHaveCount(0);

  const refresh = project(page, "repo-cf").getByTestId("project-refresh");
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(refresh.locator("svg")).toHaveClass(/animate-spin/);
  await expect(refresh).toBeEnabled();
  const fetch = await lastInvocation("git.fetch");
  expect(fetch?.args).toEqual({ worktree: CF });
  expect(fetch?.context).toMatchObject({ activeRepoId: "repo-cf", activeWorktreePath: CF });
  expect((await lastInvocation("repo.refresh"))?.args).toEqual({ repo: "repo-cf" });
  const names = (await invocations()).map((i) => i.name).filter((n) => n === "git.fetch" || n === "repo.refresh");
  expect(names).toEqual(["git.fetch", "repo.refresh"]);
  await expect(page.getByText("fetched 2 updated refs")).toBeVisible();

  // Without a remote there is nothing to fetch: only repo.refresh.
  await project(page, "repo-sk").getByTestId("project-refresh").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "repo.refresh").length).toBe(2);
  expect((await invocations()).filter((i) => i.name === "git.fetch")).toHaveLength(1);

  // A failed fetch shows the gitops failure toast; the refresh still runs.
  await mockPost("gitops?fail=git.fetch");
  await project(page, "repo-dot").getByTestId("project-refresh").click();
  await expect(page.getByText(/Fetch .* failed/)).toBeVisible();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "repo.refresh").length).toBe(3);
});

test("New worktree… asks for the branch in the palette, in that project", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  await project(page, "repo-sk").getByTestId("project-more").click();
  await page.getByTestId("project-new-worktree").click();
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "args");
  // The closing menu leaves the keyboard with the palette.
  await expect(palette.locator("input")).toBeFocused();
  await page.keyboard.type("exp/x");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  const inv = await lastInvocation("repo.worktree.new");
  expect(inv?.args).toEqual({ branch: "exp/x" });
  expect(inv?.context).toMatchObject({ activeRepoId: "repo-sk", activeView: "projects" });
  await expect(project(page, "repo-sk").getByTestId("worktree-branch")).toHaveText(["main", "exp/x"]);
});

const MERGED = "/Users/dev/.code-foundry/worktrees/alexwaumann/code-foundry/cf-usage-polish";

test("a merged, clean worktree shows 'in main' and a broom that removes it after a confirm naming the branch", async ({ page }) => {
  expect(await mockPost("worktree/merged?repo=repo-cf&branch=cf/usage-polish")).toEqual({ path: MERGED });
  await openApp(page);
  await openProjects(page);
  const row = wtRow(page, "repo-cf", MERGED);
  // The tag and the broom are on the fixture only.
  await expect(row.getByTestId("worktree-cleanable")).toHaveText("in main");
  await expect(row.getByTestId("worktree-cleanable")).toHaveAttribute("title", "Clean: no changes, every commit is in origin/main, no live thread or terminal");
  await expect(page.getByTestId("worktree-cleanable")).toHaveCount(1);
  await expect(page.getByTestId("worktree-cleanup")).toHaveCount(1);
  await expect(row.getByTestId("worktree-cleanup")).toHaveAttribute("title", "Clean up: remove this worktree");
  // Every row of the project keeps a fourth slot so the state columns still end at one x;
  // a project with nothing to clean up keeps three.
  const widths = await Promise.all([CF, FEAT, FIX, MERGED].map(async (p) => (await wtRow(page, "repo-cf", p).getByTestId("worktree-actions").boundingBox())?.width));
  expect(new Set(widths).size).toBe(1);
  const gpWidth = (await wtRow(page, "repo-gp", "/Users/dev/src/ghostty-playground").getByTestId("worktree-actions").boundingBox())?.width;
  expect(gpWidth).toBeLessThan(widths[0] ?? 0);

  await row.getByTestId("worktree-cleanup").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Remove the worktree of cf/usage-polish");
  await expect(dialog).toContainText("the branch is kept");
  await dialog.getByTestId("confirm-ok").click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("Removed 1 worktree: cf/usage-polish")).toBeVisible();
  const inv = await lastInvocation("repo.worktree.cleanup");
  expect(inv?.args).toEqual({ repo: "repo-cf", path: MERGED });
  expect(inv?.context).toMatchObject({ activeRepoId: "repo-cf", activeWorktreePath: MERGED });
  await expect(page.getByTestId("worktree-cleanup")).toHaveCount(0);
});

test("the project menu counts merged worktrees, cleans them all up, and is disabled at zero", async ({ page }) => {
  await mockPost("worktree/merged?repo=repo-cf&branch=cf/usage-polish");
  await mockPost("worktree/merged?repo=repo-cf&branch=cf/old-docs");
  await openApp(page);
  await openProjects(page);
  await expect(page.getByTestId("worktree-cleanable")).toHaveCount(2);

  // Only git projects with a remote offer it; zero is disabled.
  await project(page, "repo-dot").getByTestId("project-more").click();
  await expect(page.getByTestId("project-cleanup-count")).toHaveText("0");
  await expect(page.getByTestId("project-cleanup")).toHaveAttribute("data-disabled", "");
  await closeMenu(page, "project-more");
  await project(page, "repo-sk").getByTestId("project-more").click();
  expect(await menuItems(page, "project-more")).toEqual(["New worktree…", "Publish to GitHub…", "Remove project"]);
  await closeMenu(page, "project-more");

  await project(page, "repo-cf").getByTestId("project-more").click();
  expect(await menuItems(page, "project-more")).toEqual(["New worktree…", "Clean up merged worktrees 2", "Remove project"]);
  await expect(page.getByTestId("project-cleanup")).not.toHaveAttribute("data-disabled");
  await page.getByTestId("project-cleanup").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Remove 2 worktrees whose work is in origin/main: cf/usage-polish, cf/old-docs?");
  await dialog.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("worktree-cleanable")).toHaveCount(0);
  await expect(page.getByText(/^Removed 2 worktrees: cf\/usage-polish, cf\/old-docs; kept 2 worktrees/)).toBeVisible();
  expect((await lastInvocation("repo.worktree.cleanup"))?.args).toEqual({ repo: "repo-cf" });
  await expect(project(page, "repo-cf").getByTestId("worktree-branch")).toHaveText(["main", "feat/sidebar", "fix/resize"]);

  await project(page, "repo-cf").getByTestId("project-more").click();
  await expect(page.getByTestId("project-cleanup-count")).toHaveText("0");
  await expect(page.getByTestId("project-cleanup")).toHaveAttribute("data-disabled", "");
});

test("a terminal open in a merged worktree keeps it: no tag, no broom, not counted", async ({ page }) => {
  await mockPost("worktree/merged?repo=repo-cf&branch=cf/usage-polish");
  await openApp(page);
  await openProjects(page);
  const row = wtRow(page, "repo-cf", MERGED);
  await expect(row.getByTestId("worktree-cleanable")).toBeVisible();
  await row.getByTestId("worktree-new-terminal").click();
  await expect(row.getByTestId("worktree-cleanable")).toHaveCount(0);
  await expect(row.getByTestId("worktree-cleanup")).toHaveCount(0);
  await project(page, "repo-cf").getByTestId("project-more").click();
  await expect(page.getByTestId("project-cleanup-count")).toHaveText("0");
});
