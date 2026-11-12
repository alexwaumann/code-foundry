/**
 * Live e2e: the Pull Requests page against a REAL daemon polling GitHub through the real
 * `gh` (docs/notes/phase3a-prs-overview.md). Opt-in; how to run it: docs/notes/live-e2e.md.
 * `gh` must be logged in; the page reads the viewer's pull requests across every repository
 * (read only). It never activates a row (Enter would open the system browser through
 * `open`). No Claude turns.
 *
 * LIVE_ALL=1: the account has open pull requests of its own, and the page must list one
 * (CODE_FOUNDRY_GH_SEARCH_AS on the daemon picks a busy account).
 */
import { expect, test } from "@playwright/test";
import { openApp, requireLive, shot } from "./live";

requireLive();

test("Pull Requests page with real GitHub data", async ({ page }) => {
  await openApp(page);
  // The registry command (view.pullrequests, cmd+shift+d) and the daemon's ShowView intent, end to end.
  await page.getByTestId("thread-list").focus();
  await page.keyboard.press("Meta+Shift+d");
  await expect(page.getByTestId("prs-page")).toBeVisible();
  await expect(page.getByTestId("prs-viewer")).toHaveText(/^@\S+/, { timeout: 30_000 });
  await expect(page.getByTestId("prs-updated")).toHaveText(/updated \d+[smh] ago/, { timeout: 150_000 });
  const current = page.getByTestId("activity-commits").locator('[data-testid="activity-marker"][data-partial]');
  await expect(current).toHaveAttribute("data-value", /^\d+$/, { timeout: 150_000 });
  if (process.env.LIVE_ALL === "1") {
    await expect(page.getByTestId("prs-authored").locator("[data-nav-key]").first()).toBeVisible({ timeout: 150_000 });
  }
  await shot(page, process.env.LIVE_ALL === "1" ? "live-prs-page-all" : "live-prs-page");
});
