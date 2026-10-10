import { expect, test, type Page } from "@playwright/test";
import { CF, emit, mockPost, openApp, openProjects, resetMock, row } from "./fixtures";

/**
 * The Worktree surface as a side panel tab (docs/notes/worktree-panel-tab.md): the
 * Projects page's rows open it in the page's own panel; a thread opens its own worktree
 * with T, view.panel.worktree, or the empty panel's list.
 */

const panel = (page: Page) => page.getByTestId("side-panel");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const surface = (page: Page) => page.getByTestId("worktree-surface");
const FEAT = `${CF}.worktrees/feat-sidebar`;

const inPanel = (page: Page) => page.evaluate(() => document.activeElement?.closest('[data-region="panel"]') !== null);

test.beforeEach(async () => {
  await resetMock();
});

test("double-click on a worktree row and on a project row opens their tabs in the Projects page's panel; the page keeps focus", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  await expect(panel(page)).toHaveCount(0);

  await page.locator(`[data-nav-key="pw:repo-cf::${FEAT}"]`).dblclick();
  await expect(panel(page)).toHaveAttribute("data-panel-key", "view:projects");
  await expect(tabs(page)).toHaveText(["code-foundry · feat/sidebar"]);
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "worktree");
  await expect(surface(page)).toHaveAttribute("data-path", FEAT);
  await expect(surface(page).getByTestId("worktree-surface-title")).toHaveText("code-foundry@feat/sidebar");
  await expect(surface(page).getByTestId("section-files")).toBeVisible();
  // The page is still the content and keeps the keyboard.
  await expect(page.getByTestId("projects-page")).toBeVisible();
  expect(await inPanel(page)).toBe(false);

  // A project row: its main worktree, titled with the project alone.
  await page.locator('[data-nav-key="p:repo-cf"]').dblclick();
  await expect(tabs(page)).toHaveText(["code-foundry · feat/sidebar", "code-foundry"]);
  await expect(surface(page)).toHaveAttribute("data-path", CF);
  await expect(surface(page).getByTestId("worktree-surface-title")).toHaveText("code-foundry@main");

  // The same worktree again activates its tab rather than adding one.
  await page.locator(`[data-nav-key="pw:repo-cf::${FEAT}"]`).dblclick();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).and(page.locator('[aria-selected="true"]'))).toHaveText("code-foundry · feat/sidebar");
});

test("Enter on a workspace member row opens its tab; the Open buttons still go to the overview page", async ({ page }) => {
  await mockPost("workspace?name=login&repos=repo-cf,repo-gp");
  await openApp(page);
  await openProjects(page);
  const member = page.locator('[data-nav-key="m:w-000000000001::repo-gp"]');
  await member.click();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toHaveAttribute("data-panel-key", "view:projects");
  await expect(tabs(page)).toHaveText(["ghostty-playground · cf/login"]);
  await expect(surface(page).getByTestId("worktree-surface-title")).toHaveText("ghostty-playground@cf/login");

  await member.hover();
  await member.getByTestId("member-open-overview").click();
  await expect(page.getByTestId("projects-page")).toHaveCount(0);
  await expect(page.getByTestId("overview-title")).toHaveText("ghostty-playground@cf/login");

  await openProjects(page);
  const project = page.locator('[data-nav-key="p:repo-cf"]');
  await project.hover();
  await project.getByTestId("project-open").click();
  await expect(page.getByTestId("overview-title")).toHaveText("code-foundry@main");
});

test("a thread's panel lists Worktree with T; T, the list entry and the palette command open the thread's own worktree", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toHaveAttribute("data-panel-key", "session:s-1");
  const entry = page.getByTestId("panel-empty").locator('[data-surface="worktree"]');
  await expect(entry).toHaveAttribute("data-availability", "enabled");
  await expect(entry).toContainText("Worktree");
  await expect(entry.locator("kbd")).toHaveText("T");

  await page.keyboard.press("t");
  await expect(tabs(page)).toHaveText(["code-foundry"]);
  await expect(surface(page)).toHaveAttribute("data-path", CF);
  await expect(surface(page).getByTestId("worktree-surface-title")).toHaveText("code-foundry@main");
  // The content pane still shows the thread.
  await expect(page.getByTestId("terminal-header")).toContainText("Refactor sidebar tree");

  // The palette lists the command for a thread; its presenter runs locally (no round
  // trip, like view.panel.workspace): the tab comes back and the panel takes focus.
  await page.keyboard.press("Meta+w");
  await expect(tabs(page)).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Worktree");
  const palette = page.getByTestId("palette");
  await palette.locator('[data-command="view.panel.worktree"]').click();
  await expect(palette).toHaveCount(0);
  await expect(tabs(page)).toHaveText(["code-foundry"]);
  await expect.poll(() => inPanel(page)).toBe(true);
});

test("the CLI's ShowView reaches the window; a terminal outside any worktree has no Worktree entry", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  expect(await emit({ showView: { name: "panel.worktree" } })).toBe(1);
  await expect(panel(page)).toHaveAttribute("data-panel-key", "session:s-2");
  await expect(tabs(page)).toHaveText(["ghostty-playground"]);
  await expect(surface(page).getByTestId("worktree-surface-title")).toHaveText("ghostty-playground@main");

  await row(page, "t:t-tmp").click();
  await page.keyboard.press("Meta+Shift+e");
  await expect(panel(page)).toHaveAttribute("data-panel-key", "terminal:t-tmp");
  await expect(page.getByTestId("panel-empty").locator('[data-surface="worktree"]')).toHaveCount(0);
  // The ShowView is ignored here: nothing to open.
  await emit({ showView: { name: "panel.worktree" } });
  await expect(tabs(page)).toHaveCount(0);
});
