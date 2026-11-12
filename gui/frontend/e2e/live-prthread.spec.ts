/**
 * Live e2e: the PR panel's "Explain this PR" against a REAL daemon and real Claude Code
 * (docs/notes/side-panel.md, chunk 4). The daemon reads the pull request through `gh`, picks a
 * checkout of a registered clone of its repository and starts a thread with the explain
 * prompt. Opt-in; how to run it: docs/notes/live-e2e.md. Needs `gh` logged in, a clone of
 * LIVE_PR_SLUG registered as LIVE_PROJECT (a public repository that is not yours, e.g.
 * octocat/Hello-World cloned under ~/cf-live-scratch), and LIVE_PR, one of its pull requests.
 * threads.default_model picks the thread's model (set it to Haiku 5.5). Nothing is written to
 * GitHub; the thread (one short turn) is archived at the end.
 */
import { expect, test } from "@playwright/test";
import { openProjectPage } from "./fixtures";
import { archiveThreads, liveProject, openApp, requireLive, selectedThreadId, shot } from "./live";

const SLUG = process.env.LIVE_PR_SLUG ?? "";
const NUMBER = Number(process.env.LIVE_PR ?? "0");

requireLive("LIVE_PROJECT", "LIVE_PR_SLUG", "LIVE_PR");

test("Explain this PR starts a real thread with the explain prompt", async ({ page }) => {
  const project = liveProject();
  await page.setViewportSize({ width: 1400, height: 900 });
  await openApp(page);
  await openProjectPage(page, project.id);
  // Through the app's own store module, as a pull request row would: the page's side panel.
  await page.evaluate(`__cfModule("/src/stores/prPanel.ts").then((m) => m.openPullRequestInPanel({ slug: "${SLUG}", number: ${String(NUMBER)} }))`);
  await expect(page.getByTestId("pr-title")).toBeVisible({ timeout: 60_000 });

  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-explain").click();
  const id = await selectedThreadId(page);
  console.log(`thread ${id}`);
  try {
    // The prompt goes out as the thread's first message once Claude is up.
    await expect(page.getByTestId("thread-pane").getByTestId("thread-user").first()).toContainText(/Explain this pull request|Walk through this pull request/i, { timeout: 120_000 });
    await shot(page, "live-explain");

    // The page the thread was started from keeps the pull request in its panel.
    await openProjectPage(page, project.id);
    await expect(page.getByTestId("panel-tabs").getByRole("tab")).toHaveText([`#${String(NUMBER)}`]);
  } finally {
    archiveThreads(id);
  }
});
