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
 *   LIVE_DAEMON=1 LIVE_APP_URL=http://127.0.0.1:9257 LIVE_PROJECT=neovim \
 *   LIVE_WORKTREE=<this worktree> LIVE_SHOTS=<dir> bun run e2e:live e2e/live-prs.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const SHOTS = process.env.LIVE_SHOTS ?? "";
const PROJECT = process.env.LIVE_PROJECT ?? "";
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
  // LIVE_ALL=1: the account has open pull requests of its own (the page lists every
  // repository's; CODE_FOUNDRY_GH_SEARCH_AS picks a busy account).
  if (process.env.LIVE_ALL === "1") {
    await expect(page.getByTestId("prs-authored").locator("[data-nav-key]").first()).toBeVisible({ timeout: 150_000 });
  }
  await page.waitForTimeout(500);
  await shot(page, process.env.LIVE_ALL === "1" ? "live-prs-page-all" : "live-prs-page");
});

test("worktree overview of a GitHub-backed clone", async ({ page }) => {
  test.skip(!PROJECT, "set LIVE_PROJECT to a registered project's name");
  await page.goto("/");
  // Projects live on the Projects page (docs/notes/workspaces-4-sidebar.md).
  await page.getByTestId("nav-projects").click();
  const project = page.locator('[data-testid="project"]').filter({ has: page.getByTestId("project-name").getByText(PROJECT, { exact: true }) }).locator("[data-nav-key^='p:']");
  await project.dblclick();
  await expect(page.getByTestId("changes-surface")).toBeVisible();
  await expect(page.getByTestId("worktree-changes")).toContainText("Changes");
  await page.waitForTimeout(300);
  await shot(page, "live-overview-project");
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
  const list = page.getByTestId("changes-nav");
  await list.press("ArrowDown");
  await page.waitForTimeout(300);
  await shot(page, "live-overview-worktree");
});
