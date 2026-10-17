/**
 * Live e2e for Phase 3a: the Pull Requests page and the worktree overview against a REAL
 * daemon polling GitHub through the real `gh`. Opt-in (LIVE_DAEMON=1), run with
 * playwright.live.config.ts. It starts nothing and never activates a row (Enter would
 * open the system browser through `open`).
 *
 * Recipe (docs/notes/phase3a-prs-overview.md): an isolated daemon (CODE_FOUNDRY_HOME)
 * with this repository and a GitHub-backed clone registered, the Vite dev server pointed
 * at it, then:
 *
 *   LIVE_DAEMON=1 LIVE_APP_URL=http://127.0.0.1:9257 LIVE_REPO=neovim \
 *   LIVE_WORKTREE=<this worktree> LIVE_SHOTS=<dir> pnpm run e2e:live e2e/live-prs.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const SHOTS = process.env.LIVE_SHOTS ?? "";
const REPO = process.env.LIVE_REPO ?? "";
const WORKTREE = process.env.LIVE_WORKTREE ?? "";

test.skip(!LIVE, "set LIVE_DAEMON=1 (see the file header)");

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test("Pull Requests page with real GitHub data", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("thread-list")).toBeVisible({ timeout: 20_000 });
  // The registry command and the daemon's ShowView intent, end to end.
  await page.getByTestId("thread-list").focus();
  await page.keyboard.press("Meta+Shift+d");
  await expect(page.getByTestId("prs-page")).toBeVisible();
  await expect(page.getByTestId("prs-viewer")).toHaveText(/^@\S+/, { timeout: 30_000 });
  await expect(page.getByTestId("prs-updated")).toHaveText(/updated \d+[smh] ago/, { timeout: 150_000 });
  const current = page.getByTestId("activity-commits").locator('[data-testid="activity-marker"][data-partial]');
  await expect(current).toHaveAttribute("data-value", /^\d+$/, { timeout: 150_000 });
  const commits = Number(await current.getAttribute("data-value"));
  expect(commits).toBeGreaterThanOrEqual(0);
  // LIVE_ALL=1: show every repository (with CODE_FOUNDRY_GH_SEARCH_AS the searches run
  // for an account whose PRs live in repos that are not registered here).
  if (process.env.LIVE_ALL === "1") {
    await page.getByTestId("prs-list").press("a");
    await expect(page.getByTestId("prs-scope")).toHaveText("all repositories");
    await expect(page.getByTestId("prs-authored").locator("[data-nav-key]").first()).toBeVisible({ timeout: 150_000 });
  }
  await page.waitForTimeout(500);
  await shot(page, process.env.LIVE_ALL === "1" ? "live-prs-page-all" : "live-prs-page");
});

test("worktree overview of a GitHub-backed clone", async ({ page }) => {
  test.skip(!REPO, "set LIVE_REPO to a registered repo's name");
  await page.goto("/");
  // Projects live on the Projects page (docs/notes/workspaces-4-sidebar.md).
  await page.getByTestId("nav-projects").click();
  const project = page.locator('[data-testid="project"]').filter({ has: page.getByTestId("project-name").getByText(REPO, { exact: true }) }).locator("[data-nav-key^='p:']");
  await project.dblclick();
  await expect(page.getByTestId("worktree-surface")).toBeVisible();
  await expect(page.getByTestId("worktree-facts")).toBeVisible();
  await expect(page.getByTestId("worktree-changes")).toContainText("Changes");
  await page.waitForTimeout(300);
  await shot(page, "live-overview-repo");
});

test("worktree overview of this worktree (files and log vs origin/main)", async ({ page }) => {
  test.skip(!WORKTREE, "set LIVE_WORKTREE to a registered worktree path");
  await page.goto("/");
  await page.getByTestId("nav-projects").click({ timeout: 20_000 });
  const wt = page.locator(`[data-nav-key$="::${WORKTREE}"]`).first();
  await wt.scrollIntoViewIfNeeded();
  await wt.dblclick();
  await expect(page.getByTestId("changes-list")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("worktree-changes")).toContainText("vs main");
  await page.getByTestId("worktree-commits").locator('[data-nav-key="commits"]').click();
  await expect(page.getByTestId("commits-list").locator("[data-nav-key]").first()).toBeVisible();
  const list = page.getByTestId("overview-list");
  await list.press("ArrowDown");
  await page.waitForTimeout(300);
  await shot(page, "live-overview-worktree");
});
