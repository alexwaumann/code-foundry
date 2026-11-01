/**
 * Live e2e for the PR surface's thread actions: Explain this PR against a REAL daemon,
 * which reads the pull request through `gh`, picks a worktree of a registered clone and
 * starts Claude Code with the explain prompt. Opt-in (LIVE_DAEMON=1), run with
 * playwright.live.config.ts. It starts nothing itself; the thread it starts is left
 * running for the caller to stop (`code-foundry thread archive --id <id> --yes`).
 *
 * Recipe (docs/notes/side-panel.md, chunk 4): an isolated daemon (CODE_FOUNDRY_HOME) with
 * a clone of LIVE_PR_SLUG registered and threads.default_model=haiku, the Vite dev server
 * pointed at it, then:
 *
 *   LIVE_DAEMON=1 LIVE_APP_URL=http://127.0.0.1:9372 LIVE_PROJECT=code-foundry \
 *   LIVE_PR_SLUG=alexwaumann/code-foundry LIVE_PR=1 LIVE_SHOTS=<dir> \
 *   bun run e2e:live e2e/live-prthread.spec.ts
 */
import { expect, test } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const SHOTS = process.env.LIVE_SHOTS ?? "";
const PROJECT = process.env.LIVE_PROJECT ?? "";
const SLUG = process.env.LIVE_PR_SLUG ?? "alexwaumann/code-foundry";
const NUMBER = Number(process.env.LIVE_PR ?? "1");

test.skip(!LIVE || !PROJECT, "set LIVE_DAEMON=1 and LIVE_PROJECT (see the file header)");

test("Explain this PR starts a real thread with the explain prompt", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  // Projects live on the Projects page (docs/notes/workspaces-4-sidebar.md).
  const openProject = async () => {
    await page.getByTestId("nav-projects").click({ timeout: 20_000 });
    await page.locator('[data-testid="project"]').filter({ has: page.getByTestId("project-name").getByText(PROJECT, { exact: true }) }).locator("[data-nav-key^='p:']").dblclick();
  };
  await openProject();
  await expect(page.getByTestId("changes-surface")).toBeVisible();
  // Through the app's own store module, as a pull request row would.
  await page.evaluate(`import("/src/stores/prPanel.ts").then((m) => m.openPullRequestInPanel({ slug: "${SLUG}", number: ${String(NUMBER)} }))`);
  await expect(page.getByTestId("pr-title")).toBeVisible({ timeout: 60_000 });

  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-explain").click();
  const selected = page.locator('[data-row-kind="thread"][aria-selected="true"]');
  await expect(selected).toHaveAttribute("data-row-key", /^s:s-/, { timeout: 60_000 });
  const key = (await selected.getAttribute("data-row-key")) ?? "";
  console.log(`thread ${key.slice(2)}`);
  // The prompt goes out as the thread's first message once Claude is up.
  await expect(page.getByTestId("thread-pane").getByTestId("thread-user").first()).toContainText(/Explain this pull request|Walk through this pull request/i, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chunk4-live-explain.png` });

  // The originating selection's panel keeps the pull request.
  await openProject();
  await expect(page.getByTestId("panel-tabs").getByRole("tab")).toHaveText([`#${String(NUMBER)}`]);
});
