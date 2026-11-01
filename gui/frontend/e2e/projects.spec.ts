import { expect, test, type Page } from "@playwright/test";
import { CF, mockPost, openApp, openProjectPage, openProjects, resetMock } from "./fixtures";

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
const checkout = (page: Page, path: string) => page.locator(`[data-testid="project-worktree"][data-path="${path}"]`);
const checkoutRow = (page: Page, projectId: string, path: string) => page.locator(`[data-nav-key="pw:${projectId}::${path}"]`);
const FEAT = `${CF}.worktrees/feat-sidebar`;
const FIX = `${CF}.worktrees/fix-resize`;
// POST /__mock/leftovers: three leftovers (SPIKE, COPY, exp/shaders; and MERGED with clean=1).
const SPIKE = "/Users/dev/.code-foundry/worktrees/alexwaumann/code-foundry/cf-perf-spike";
const COPY = "/Users/dev/.code-foundry/worktrees/alexwaumann/code-foundry/cf-old-copy";
const leftover = (page: Page, path: string) => page.locator(`[data-testid="leftover-row"][data-path="${path}"]`);

const panelKey = (page: Page) => page.getByTestId("side-panel").getAttribute("data-panel-key");

// The index's rows (order, kinds, status sentences, pills, setup links, ages, no hover actions), the
// setup links and the kind after Initialize git: unit-tested in src/components/projects/ProjectsIndex.test.tsx.
// The index's Default branch, the filter, the page picker and the crumb: unit-tested in src/components/projects/ProjectsIndex.test.tsx.

test("narrowing drops Activity, then Updated, then Default branch; Needs a look stays", async ({ page }) => {
  await mockPost("workspace?name=login&projects=repo-cf,repo-gp");
  await openApp(page);
  await openProjects(page);
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

// The index's ↑/↓/Home/End/Enter, and End then Enter on a project's page opening that checkout's Changes tab:
// ProjectsIndex.test.tsx and ProjectPage.test.tsx. Left: the real focus and the tab drawn in the page's panel.
test("keyboard: a project page's list has the keyboard; End then Enter shows a checkout's Changes tab", async ({ page }) => {
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  await expect(page.getByTestId("projects-list")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("changes-surface")).toBeVisible();
});

// A project's page (header, checkouts table, a row opening its Changes tab in the page's panel, the row
// and header menus, Details) and the kind variants (with Initialize git): ProjectPage.test.tsx. A row's
// tab drawn in the page's own panel is "each page has its own side panel" below; hover actions, "narrow".

// Refresh (fetch then refresh, spinning) and a failed refresh in the header and Details: unit-tested in src/components/projects/ProjectPage.test.tsx ("Refresh fetches…", "a failed refresh shows…").

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
  await row(page, "repo-cf").getByTestId("project-name").click();
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

// The rows, why each stayed, their actions, the counts, New thread and Resume, and the whole Remove…
// confirm (what goes, the uncommitted files, Show diff, Cancel, force, the rows leaving):
// ProjectPage.test.tsx. Left: the narrow page Show diff makes (real width) and Resume over the stream.
test("Worktrees without threads: Show diff narrows the page (Remove icon-only); Resume unarchives and the worktree moves to the table", async ({ page }) => {
  await mockPost("leftovers?project=repo-cf");
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  await leftover(page, COPY).getByTestId("leftover-show-diff").click();
  await expect(page.getByTestId("changes-surface")).toHaveAttribute("data-path", COPY);
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-narrow", "true");
  await expect(leftover(page, COPY).getByTestId("leftover-remove")).toHaveText("");
  await expect(leftover(page, COPY).getByTestId("leftover-remove")).toHaveAttribute("aria-label", "Remove worktree…");

  await leftover(page, SPIKE).getByTestId("leftover-resume").click();
  await expect(page.getByTestId("thread-header").getByTestId("thread-title")).toHaveText("Profile the renderer");
  await openProjectPage(page, "repo-cf");
  await expect(leftover(page, SPIKE)).toHaveCount(0);
  await expect(checkout(page, SPIKE)).toHaveCount(1);
});
