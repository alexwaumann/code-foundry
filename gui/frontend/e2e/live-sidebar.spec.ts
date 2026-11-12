/**
 * Live e2e: the thread sidebar's rows, a workspace's page and "Run in" against a REAL daemon
 * and real Claude Code (docs/notes/workspaces-4-sidebar.md). Opt-in; how to run it:
 * docs/notes/live-e2e.md. Needs a workspace (LIVE_WORKSPACE, default demo) of at least two
 * registered projects.
 *
 * It starts two threads from the CLI ("say hi and stop", one short turn each): one of the
 * workspace in its first project, one in the second project alone; checks their rows, the
 * workspace's page, that Run in is offered only to the workspace thread, moves that thread to
 * the second project with it, and archives both at the end.
 */
import { expect, test } from "@playwright/test";
import { openWorkspacePage } from "./fixtures";
import { archiveThreads, cliJson, liveWorkspace, MODEL, openApp, requireLive, shot, threadInfo, type LiveThread } from "./live";

requireLive();

test("sidebar rows, the workspace page and Run in with real threads", async ({ page }) => {
  const { workspace, members } = liveWorkspace(process.env.LIVE_WORKSPACE ?? "demo");
  const [first, second] = members;
  if (!first || !second) throw new Error(`workspace ${workspace.name} needs two projects`);
  const start = (...args: string[]) =>
    (cliJson("thread", "new", ...args, "--model", MODEL, "--effort", "medium", "--permission", "auto", "--focus=false", "--prompt", "say hi and stop") as LiveThread).id;
  const wsThread = start("--workspace", workspace.id, "--project", first.id);
  const projThread = start("--project", second.id);
  try {
    await openApp(page);
    const list = page.getByTestId("thread-list");
    const wsRow = list.locator(`[data-row-key="s:${wsThread}"]`);
    const projRow = list.locator(`[data-row-key="s:${projThread}"]`);

    await test.step("rows: the workspace thread has the Layers glyph and its project", async () => {
      await expect(wsRow).toBeVisible({ timeout: 20_000 });
      await expect(projRow).toBeVisible();
      await expect(wsRow.getByTestId("row-workspace")).toHaveCount(1);
      await expect(projRow.getByTestId("row-workspace")).toHaveCount(0);
      await expect(wsRow.getByTestId("row-project")).toHaveText(first.name);
      await expect(projRow.getByTestId("row-project")).toHaveText(second.name);
      // Both turns end (unwatched, they then need attention, "finished").
      await expect.poll(() => threadInfo(wsThread)?.status, { timeout: 120_000 }).toMatch(/IDLE|NEEDS_ATTENTION/);
      await expect.poll(() => threadInfo(projThread)?.status, { timeout: 120_000 }).toMatch(/IDLE|NEEDS_ATTENTION/);
      await shot(page, "live-sidebar-list");
    });

    await test.step("the workspace's page lists its projects", async () => {
      await openWorkspacePage(page, workspace.id);
      await expect(page.getByTestId("page-name")).toHaveText(workspace.name);
      const names = page.getByTestId("projects-page").getByTestId("member-name");
      for (const p of [first, second]) await expect(names.filter({ hasText: new RegExp(`^${p.name}$`) })).toHaveCount(1);
      await shot(page, "live-workspace-page");
    });

    await test.step("Run in is absent on the project thread", async () => {
      await projRow.click({ button: "right" });
      await expect(page.getByTestId("row-menu")).toBeVisible();
      await expect(page.getByTestId("menu-run-in")).toHaveCount(0);
      await page.keyboard.press("Escape");
    });

    await test.step("Run in moves the workspace thread to the second project", async () => {
      await wsRow.click({ button: "right" });
      await page.getByTestId("menu-run-in").click();
      await page.getByTestId("menu-run-in-members").locator(`[data-member="${second.id}"]`).click();
      await shot(page, "live-sidebar-moving");
      await expect.poll(() => threadInfo(wsThread)?.worktreePath, { timeout: 60_000 }).toBe(second.path);
      expect(threadInfo(wsThread)).toMatchObject({ projectId: second.id, worktreePath: second.path, workspaceId: workspace.id });
      await expect(wsRow.getByTestId("row-project")).toHaveText(second.name);
      await shot(page, "live-sidebar-moved");
    });
  } finally {
    archiveThreads(wsThread, projThread);
  }
});
