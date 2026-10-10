/**
 * Live e2e for the PR surface's session actions: Explain this PR against a REAL daemon,
 * which reads the pull request through `gh`, picks a worktree of a registered clone and
 * starts Claude Code with the explain prompt. Opt-in (LIVE_DAEMON=1), run with
 * playwright.live.config.ts. It starts nothing itself; the session it starts is left
 * running for the caller to close (`code-foundry session close --id <id>`).
 *
 * Recipe (docs/notes/side-panel.md, chunk 4): an isolated daemon (CODE_FOUNDRY_HOME) with
 * a clone of LIVE_PR_SLUG registered and sessions.default_model=haiku, the Vite dev server
 * pointed at it, then:
 *
 *   LIVE_DAEMON=1 LIVE_APP_URL=http://127.0.0.1:9372 LIVE_REPO=code-foundry \
 *   LIVE_PR_SLUG=alexwaumann/code-foundry LIVE_PR=1 LIVE_SHOTS=<dir> \
 *   pnpm run e2e:live e2e/live-prsession.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const SHOTS = process.env.LIVE_SHOTS ?? "";
const REPO = process.env.LIVE_REPO ?? "";
const SLUG = process.env.LIVE_PR_SLUG ?? "alexwaumann/code-foundry";
const NUMBER = Number(process.env.LIVE_PR ?? "1");

test.skip(!LIVE || !REPO, "set LIVE_DAEMON=1 and LIVE_REPO (see the file header)");

function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { __cfTerminal?: { renderer: { getText(): string } } };
    return w.__cfTerminal?.renderer.getText() ?? "";
  });
}

test("Explain this PR starts a real Claude session with the explain prompt", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  // Projects live on the Projects page (docs/notes/workspaces-4-sidebar.md).
  const openRepo = async () => {
    await page.getByTestId("nav-projects").click({ timeout: 20_000 });
    await page.locator('[data-testid="project"]').filter({ has: page.getByTestId("project-name").getByText(REPO, { exact: true }) }).locator("[data-nav-key^='p:']").dblclick();
  };
  await openRepo();
  await expect(page.getByTestId("overview-page")).toBeVisible();
  // Through the app's own store module, as a pull request row would.
  await page.evaluate(`import("/src/stores/prPanel.ts").then((m) => m.openPullRequestInPanel({ slug: "${SLUG}", number: ${String(NUMBER)} }))`);
  await expect(page.getByTestId("pr-title")).toBeVisible({ timeout: 60_000 });

  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-explain").click();
  const selected = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(selected).toHaveAttribute("data-row-key", /^s:s-/, { timeout: 60_000 });
  const key = (await selected.getAttribute("data-row-key")) ?? "";
  console.log(`session ${key.slice(2)}`);
  // The session runner types the prompt into Claude Code once it is ready.
  await expect.poll(() => terminalText(page), { timeout: 120_000 }).toMatch(/Explain this pull request|pasted|Walk through this pull request/i);
  await page.waitForTimeout(1500);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chunk4-live-explain.png` });

  // The originating selection's panel keeps the pull request.
  await openRepo();
  await expect(page.getByTestId("panel-tabs").getByRole("tab")).toHaveText([`#${String(NUMBER)}`]);
});
