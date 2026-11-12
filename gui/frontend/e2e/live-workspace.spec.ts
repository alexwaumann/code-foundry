/**
 * Live e2e: a workspace thread started from the composer against a REAL daemon and real
 * Claude Code (docs/notes/workspaces-3-composer.md). Opt-in; how to run it:
 * docs/notes/live-e2e.md. Needs a workspace (LIVE_WORKSPACE, default demo) of at least two
 * registered projects.
 *
 * It picks the workspace in the new-thread picker, makes its second project the one the
 * thread runs in ("Run in"), spends one short turn ("say hi and stop") and archives the thread.
 */
import { expect, test } from "@playwright/test";
import { archiveThreads, composeIn, liveWorkspace, openApp, pickCheapModel, requireLive, selectedThreadId, shot, threadInfo } from "./live";

requireLive();

test("composer: pick a workspace, run in its second project, start a thread", async ({ page }) => {
  const { workspace, members } = liveWorkspace(process.env.LIVE_WORKSPACE ?? "demo");
  const second = members[1];
  if (!second) throw new Error(`workspace ${workspace.name} needs two projects`);

  await openApp(page);
  await composeIn(page, { workspace: workspace.id });
  await expect(page.getByTestId("composer-heading")).toHaveText(`What should we build in ${workspace.name}?`);
  await page.getByTestId("composer-primary").click();
  await page.getByTestId("composer-primary-list").getByRole("option", { name: second.name }).click();
  await expect(page.getByTestId("composer-primary")).toContainText(second.name);
  await pickCheapModel(page);
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("say hi and stop");
  await shot(page, "live-workspace-composer");
  await page.keyboard.press("Enter");

  const id = await selectedThreadId(page, 30_000);
  try {
    await expect.poll(() => threadInfo(id)?.worktreePath, { timeout: 60_000 }).toBe(second.path);
    expect(threadInfo(id)).toMatchObject({ workspaceId: workspace.id, projectId: second.id, worktreePath: second.path });
    await expect.poll(() => threadInfo(id)?.status, { timeout: 120_000 }).toMatch(/IDLE|NEEDS_ATTENTION/);
    await shot(page, "live-workspace-thread");
  } finally {
    archiveThreads(id);
  }
});
