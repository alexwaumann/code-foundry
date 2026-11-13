import { expect, test, type Page } from "@playwright/test";
import { CF, mockPost, openProjectPage, resetMock } from "./fixtures";
import { layoutState, openShellApp, paneNode, paneOf, rowNode } from "./shell";
import { openLayout, openProjectsTab, PROJECTS_TAB, sizePane } from "./shell-pages";

/**
 * The Projects view (docs/notes/projects-redesign-1-index.md): the index (rows by last
 * activity, status sentences, pills, setup links, filter, keyboard), a project's page
 * (header, picker, checkouts table, kind variants, details, narrow layout), the workspace
 * page's header, navigation (the space's one Projects tab keeping its page), and a project's Worktrees without threads with the remove
 * confirm (docs/notes/projects-redesign-2-leftovers.md, project-page-3-leftovers.md). The mock's projects: code-foundry (repo-cf) and
 * ghostty-playground (repo-gp) on GitHub, dotfiles (repo-dot, a remote that is not
 * GitHub), sketches (repo-sk, git without a remote) and writing (repo-wr, no git).
 */

test.beforeEach(async () => {
  await resetMock();
});

const row = (page: Page, projectId: string) => page.locator(`[data-nav-key="p:${projectId}"]`);
const checkout = (page: Page, path: string) => page.locator(`[data-testid="project-worktree"][data-path="${path}"]`);
const checkoutRow = (page: Page, projectId: string, path: string) => page.locator(`[data-nav-key="pw:${projectId}::${path}"]`);
const FEAT = `${CF}.worktrees/feat-sidebar`;
// POST /__mock/leftovers: three leftovers (SPIKE, COPY, exp/shaders; and MERGED with clean=1).
const SPIKE = "/Users/dev/.code-foundry/worktrees/alexwaumann/code-foundry/cf-perf-spike";
const COPY = "/Users/dev/.code-foundry/worktrees/alexwaumann/code-foundry/cf-old-copy";
const leftover = (page: Page, path: string) => page.locator(`[data-testid="leftover-row"][data-path="${path}"]`);

/** A checkout's Diff tab, unlinked (as a checkout menu's Show changes opens it from a project's page). */
const diffTab = (path: string): Record<string, unknown> => ({ id: "t-diff", kind: "diff", params: { project: "repo-cf", worktree: path }, title: "Diff · code-foundry" });

/** code-foundry's page in the Projects tab (pane p-1) with a checkout's Diff tab in a pane to its right (p-2). */
async function pageBesideDiff(page: Page, path: string): Promise<void> {
  await openLayout(page, rowNode([paneNode("p-1", [{ ...PROJECTS_TAB, params: { project: "repo-cf" } }]), paneNode("p-2", [diffTab(path)])], [0.55, 0.45]), "p-1");
  await expect(page.locator('[data-testid="projects-page"][data-page="project"][data-project="repo-cf"]')).toBeVisible();
  await expect(page.getByTestId("diff-surface")).toHaveAttribute("data-path", path);
}

// The index's rows (order, kinds, status sentences, pills, setup links, ages, no hover actions), the
// setup links and the kind after Initialize git: unit-tested in src/components/projects/ProjectsIndex.test.tsx.
// The index's Default branch, the filter, the page picker and the crumb: unit-tested in src/components/projects/ProjectsIndex.test.tsx.

test("narrowing drops Activity, then Updated, then Default branch; Needs a look stays", async ({ page }) => {
  await mockPost("workspace?name=login&projects=repo-cf,repo-gp");
  await openProjectsTab(page);
  const scroll = page.getByTestId("projects-scroll");
  // Sizes the window so the content (the scroll box) is `width` wide.
  const contentWidth = async (width: number) => {
    const now = await scroll.evaluate((el) => el.clientWidth);
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    await page.setViewportSize({ width: vp.width + width - now, height: vp.height });
    await expect.poll(() => scroll.evaluate((el) => el.clientWidth)).toBe(width);
  };
  const heads = (table: string) => page.getByTestId(table).getByTestId("index-columns").locator("span");
  const steps: [number, string[], string[]][] = [
    [900, ["Project", "Activity", "Default branch", "Needs a look", "Updated"], ["Workspace", "Activity", "Projects", "Contents", "Updated"]],
    [800, ["Project", "Default branch", "Needs a look", "Updated"], ["Workspace", "Projects", "Contents", "Updated"]],
    [650, ["Project", "Default branch", "Needs a look"], ["Workspace", "Projects", "Contents"]],
    [560, ["Project", "Needs a look"], ["Workspace", "Projects"]],
  ];
  for (const [width, projects, workspaces] of steps) {
    await contentWidth(width);
    await expect(heads("projects-table")).toHaveText(projects);
    await expect(heads("workspaces-table")).toHaveText(workspaces);
  }
  // The cells follow their headers, and what needs a look still shows.
  await expect(row(page, "repo-cf").getByTestId("project-status")).toHaveCount(0);
  await expect(row(page, "repo-cf").getByTestId("index-age")).toHaveCount(0);
  await expect(row(page, "repo-cf").getByTestId("index-default-branch")).toHaveCount(0);
  await expect(row(page, "repo-cf").getByTestId("index-prs")).toHaveText("2 PRs");
  await expect(row(page, "repo-sk").getByTestId("index-publish")).toBeVisible();
});

// The index's ↑/↓/Home/End/Enter, and on a project's page End then Shift+F10 opening that row's menu:
// ProjectsIndex.test.tsx and ProjectPage.test.tsx. Left: the real focus, the keymap leaving Shift+F10
// to the list, the menu taking the keyboard and Escape giving it back.
test("keyboard: a project page's list has the keyboard; Shift+F10 opens the cursor row's menu, Escape returns", async ({ page }) => {
  await openProjectsTab(page);
  await openProjectPage(page, "repo-cf");
  await expect(page.getByTestId("projects-list")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+F10");
  const menu = page.getByTestId("checkout-menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(menu.locator('[role="menuitem"][data-highlighted]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("projects-list")).toBeFocused();
});

// Which items a checkout's menu has, what each runs, Open thread and the apps submenu: menus.test.ts,
// ProjectPage.test.tsx and CheckoutsTable.test.tsx. Left: the split item's two hover blocks (pseudo-elements).
test("a checkout menu's Open in Finder hovers as two blocks: text bright with › dim, › bright with its submenu open", async ({ page }) => {
  await openProjectsTab(page);
  await openProjectPage(page, "repo-cf");
  await checkoutRow(page, "repo-cf", FEAT).click({ button: "right" });
  const split = page.getByTestId("checkout-menu-open-in");
  const more = page.getByTestId("checkout-menu-open-in-more");
  const bg = (pseudo: "::before" | "::after", el = split) => el.evaluate((e, p) => getComputedStyle(e, p).backgroundColor, pseudo);
  // Geometry: the › block is the item's last 32px at its full height; the left block ends 34px short.
  const box = await split.boundingBox();
  const geo = await more.evaluate((e) => {
    const a = getComputedStyle(e, "::after");
    const item = e.closest('[role="menuitem"]') as HTMLElement;
    return { w: a.width, h: a.height, itemH: `${String(item.offsetHeight)}px`, right: getComputedStyle(item, "::before").right };
  });
  expect(geo).toEqual({ w: "32px", h: geo.itemH, itemH: geo.itemH, right: "34px" });
  expect(box?.height).toBeGreaterThan(0);
  const none = await bg("::before");
  await split.hover({ position: { x: 20, y: 8 } });
  await expect(page.getByTestId("checkout-menu-open-in-menu")).toHaveCount(0);
  const bright = await bg("::before");
  const half = await bg("::after", more);
  expect(new Set([none, bright, half]).size).toBe(3);
  await more.hover();
  await expect(page.getByTestId("checkout-menu-open-in-menu")).toBeVisible();
  await expect.poll(() => bg("::after", more)).toBe(bright);
  await expect.poll(() => bg("::before")).toBe(half);
  // Back on its text: the submenu closes; a click there reveals and closes the menu.
  await split.hover({ position: { x: 20, y: 8 } });
  await expect(page.getByTestId("checkout-menu-open-in-menu")).toHaveCount(0);
  await split.click({ position: { x: 20, y: 8 } });
  await expect(page.getByTestId("checkout-menu")).toHaveCount(0);
});

// A project's page (title block, checkouts table, the row and title block menus, Details with Copy and
// Open in) and the kind variants (with Initialize git): ProjectPage.test.tsx; the table's columns and menu parts: CheckoutsTable.test.tsx.
// A row's Diff tab drawn in the page's own panel is "each page has its own side panel" below.

// Refresh (fetch then refresh, spinning) and a failed refresh in the title block: unit-tested in src/components/projects/ProjectPage.test.tsx ("Refresh fetches…", "a failed refresh turns…").

// whenTruncated's slack under a page zoom (a value that fits reading a pixel over its box) and which
// values open on a real cut: src/components/ui/tooltip.test.tsx.

// A checkout menu's Show changes opening the Diff tab in the page's pane: the shell gap in
// e2e/workspace-page.spec.ts ("View opens … a File tab"). Here the Diff tab is seeded beside the page.
test("narrow: with the Diff tab open, Sync and the slug drop and Open in Finder shows its icon only", async ({ page }) => {
  await pageBesideDiff(page, FEAT);
  await expect(page.getByTestId("checkouts-col-sync")).toHaveCount(0);
  await expect(page.getByTestId("worktree-sync")).toHaveCount(0);
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-compact", "true");
  await expect(page.getByTestId("project-meta")).toHaveCount(0);
  await expect(page.getByTestId("title-default-branch")).toBeVisible();
  await expect(page.getByTestId("details-reveal")).toHaveText("");
  await expect(page.getByTestId("checkouts-col-pr")).toHaveCount(1);
  // The table drops by its own width (lib/projects.ts checkoutColumns).
  const w = await page.getByTestId("checkouts-table").evaluate((e) => e.getBoundingClientRect().width);
  expect(await page.getByTestId("checkouts-col-threads").count()).toBe(w >= 720 ? 1 : 0);
  // Closing the Diff tab (its pane goes with it) gives the room back.
  await paneOf(page, "p-2").getByTestId("shell-tab-close").click();
  await expect(paneOf(page, "p-2")).toHaveCount(0);
  await expect(page.getByTestId("projects-page")).not.toHaveAttribute("data-compact");
  await expect(page.getByTestId("checkouts-col-sync")).toHaveCount(1);
  await expect(page.getByTestId("project-meta")).toHaveText("alexwaumann/code-foundry");
  await expect(page.getByTestId("details-reveal")).toHaveText("Open in Finder");
});

// Details' Open in Finder: the split hover (docs/notes/thread-info-split-hover.md) on two real
// buttons. Which items its ⋯ lists and what they run: ProjectPage.test.tsx.
test("Details' Open in Finder: two blocks with a 2px seam, the one under the pointer bright, the other half; menu open: only the ⋯", async ({ page }) => {
  await openProjectsTab(page);
  await openProjectPage(page, "repo-cf");
  const main = page.getByTestId("details-reveal");
  const more = page.getByTestId("details-open-in-more");
  const tint = await page.evaluate(() => {
    const probe = (value: string) => {
      const d = document.createElement("div");
      d.style.backgroundColor = value;
      document.body.append(d);
      const c = getComputedStyle(d).backgroundColor;
      d.remove();
      return c;
    };
    return { none: probe("transparent"), full: probe("var(--cf-control-hover)"), half: probe("color-mix(in oklab, var(--cf-control-hover) 50%, transparent)") };
  });
  expect(new Set(Object.values(tint)).size).toBe(3);
  const lit = () => Promise.all([main.evaluate((el) => getComputedStyle(el).backgroundColor), more.evaluate((el) => getComputedStyle(el).backgroundColor)]);
  const [a, b] = await Promise.all([main.boundingBox(), more.boundingBox()]);
  expect(Math.round((b?.x ?? 0) - ((a?.x ?? 0) + (a?.width ?? 0)))).toBe(2);
  expect(await lit()).toEqual([tint.none, tint.none]);
  await main.hover();
  await expect.poll(lit).toEqual([tint.full, tint.half]);
  await more.hover();
  await expect.poll(lit).toEqual([tint.half, tint.full]);
  await more.click();
  await expect(page.getByTestId("details-open-in-menu")).toBeVisible();
  await expect.poll(lit).toEqual([tint.none, tint.full]);
  await main.hover({ force: true });
  await expect.poll(lit).toEqual([tint.none, tint.full]);
});

// The classic window's side panel per page, its sidebar row (back to the last page, then to the index)
// and the selection history walking the pages are gone: the Projects page is one tab per space, the
// + menu's Projects runs view.projects without a page (the index, as the daemon's), and cmd+[ walks
// what was focused. Left: the tab keeps the page it shows, and stays the space's one.
test("the Projects tab keeps its page across a reload; the + menu focuses the space's one tab", async ({ page }) => {
  await openProjectsTab(page);
  await openProjectPage(page, "repo-dot");
  // The page is the tab's (its params, in the daemon's layout): a reload shows it again.
  await openShellApp(page);
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-project", "repo-dot");
  const projectsTabs = async () => {
    const root = (await layoutState()).spaces[0]?.root;
    return root?.t === "pane" ? root.tabs.filter((t) => t.kind === "projects").length : -1;
  };
  // A thread takes the pane; the + menu's Projects focuses the same tab, on the index.
  await page.locator('[data-row-key="s:s-1"]').click();
  await expect(page.locator('[data-testid="thread-pane"][data-thread-id="s-1"]')).toBeVisible();
  await expect(page.getByTestId("projects-page")).toHaveCount(0);
  await paneOf(page, "p-1").getByTestId("pane-plus").click();
  await page.getByTestId("pane-plus-menu").locator('[data-item="projects"]').click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
  expect(await projectsTabs()).toBe(1);
});

test("a page's scroll position is remembered while the window lives", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 420 });
  await openProjectsTab(page);
  await openProjectPage(page, "repo-cf");
  const scroll = page.getByTestId("projects-scroll");
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const top = await scroll.evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(0);
  await page.getByTestId("projects-crumb").click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
  await row(page, "repo-cf").getByTestId("project-name").click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-project", "repo-cf");
  await expect.poll(() => page.getByTestId("projects-scroll").evaluate((el) => el.scrollTop)).toBe(top);
  // Another project's page starts at the top.
  await page.getByTestId("page-picker").click();
  await page.getByTestId("page-picker-menu").locator('[data-project="repo-gp"]').click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-project", "repo-gp");
  expect(await page.getByTestId("projects-scroll").evaluate((el) => el.scrollTop)).toBe(0);
});

// Worktrees to tidy (the index pill, the menu's count, a terminal holding one): src/components/projects/ProjectsIndex.test.tsx and ProjectPage.test.tsx ("the project menu counts the cleanable ones; a terminal open in one holds it").

// Clean up merged worktrees and Remove the N that are clean (confirm, cleanup, the pill going): unit-tested in src/components/projects/ProjectPage.test.tsx.

// The rows, why each stayed, their icons and menu, the counts, New thread and Resume, and the whole
// Remove confirm (what goes, the uncommitted files, Show diff, Cancel, force, the rows leaving):
// ProjectPage.test.tsx and menus.test.ts. Left: the narrow content Show diff makes (real width: the
// reason truncates, no column drops, the icons stay in the row) and Resume from the menu over the stream.
test("Worktrees without threads: at the width Show diff leaves, the reason truncates and the icons stay; Resume from the menu unarchives and the worktree moves to the table", async ({ page }) => {
  await mockPost("leftovers?project=repo-cf");
  await openProjectsTab(page);
  await openProjectPage(page, "repo-cf");
  const reason = leftover(page, COPY).getByTestId("leftover-reason");
  await expect.poll(() => reason.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  // One Branch column for the header and every row (a subgrid), as wide as the longest branch:
  // no branch is cut and every Why it stayed starts at the same x.
  const branches = page.getByTestId("leftover-branch");
  expect(await branches.evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).length)).toBe(0);
  const reasonsX = await page.getByTestId("leftover-reason").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().x)));
  const headX = await page.getByTestId("leftover-head").locator("span").nth(1).evaluate((el) => Math.round(el.getBoundingClientRect().x));
  expect(new Set([...reasonsX, headX]).size).toBe(1);
  // Show diff's Diff tab opening in the page's pane: the shell gap in e2e/workspace-page.spec.ts. Here it
  // is seeded beside the page, sized so that the page's content is about 480px wide.
  await pageBesideDiff(page, COPY);
  await sizePane(page, "p-1", 520);
  await expect.poll(() => reason.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // Why it stayed keeps its 10rem (160px) before the branch gives way.
  expect(await reason.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(159.5);
  await expect(page.getByTestId("leftover-head")).toHaveText(/Branch\s*Why it stayed/);
  // The icons stay inside the row, at its right end.
  const box = await leftover(page, COPY).boundingBox();
  const remove = await leftover(page, COPY).getByTestId("leftover-remove").boundingBox();
  expect(box && remove && remove.x + remove.width <= box.x + box.width).toBe(true);
  await expect(leftover(page, COPY).getByTestId("leftover-show-diff")).toBeVisible();

  await leftover(page, SPIKE).click({ button: "right" });
  await page.getByTestId("leftover-menu").getByTestId("leftover-menu-resume").click();
  // The thread opens as a tab in the focused pane.
  await expect(paneOf(page, "p-1").locator('[data-testid="shell-tab"][data-kind="thread"][data-active]')).toHaveText("Profile the renderer");
  await expect(paneOf(page, "p-1").getByTestId("thread-pane")).toBeVisible();
  await openProjectPage(page, "repo-cf");
  await expect(leftover(page, SPIKE)).toHaveCount(0);
  await expect(checkout(page, SPIKE)).toHaveCount(1);
});
