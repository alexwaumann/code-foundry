/**
 * Live e2e: the side panel's workspace surface against a REAL daemon and real Claude
 * Code (docs/notes/workspaces-5-panel.md). Opt-in (LIVE_DAEMON=1), run with
 * playwright.live.config.ts, which starts nothing: bring up an isolated daemon
 * (CODE_FOUNDRY_HOME) and the Vite dev server pointed at it (recipe in
 * docs/notes/phase2-integration.md), with:
 *
 *   - a workspace LIVE_WORKSPACE over two projects whose first member is 1 commit ahead
 *     of its upstream and whose second member has an untracked file;
 *   - a third registered project LIVE_ADD_REPO, not a member (added, then removed).
 *
 * It starts one haiku thread ("say hi and stop") in the first member, opens the surface
 * from the thread's workspace badge, checks the members' state and the current member,
 * opens the first member as a tab, and adds and removes LIVE_ADD_REPO through the
 * surface (the removal through the daemon's confirm). The thread is closed at the end.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const HOME = process.env.CODE_FOUNDRY_HOME ?? "";
const WORKSPACE = process.env.LIVE_WORKSPACE ?? "demo";
const ADD_REPO = process.env.LIVE_ADD_REPO ?? "lib";
const BIN = process.env.LIVE_BIN ?? path.join(path.resolve(process.cwd(), "../.."), "bin/code-foundry");
const SHOTS = process.env.LIVE_SHOTS ?? "";

function cli(...args: string[]): string {
  return execFileSync(BIN, args, { env: { ...process.env, CODE_FOUNDRY_HOME: HOME }, encoding: "utf8", timeout: 60_000 });
}

interface Members {
  workspace: { id: string; name: string; branch: string };
  members: { repoId: string; repoName: string; worktreePath: string }[];
}

function members(): Members {
  return JSON.parse(cli("workspace", "members", WORKSPACE, "--json")) as Members;
}

function sessionStatus(id: string): string | undefined {
  return ((JSON.parse(cli("session", "list", "--json")) as { sessions?: { id: string; status?: string }[] }).sessions ?? []).find((s) => s.id === id)?.status;
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.skip(!LIVE || !HOME, "LIVE_DAEMON=1 and CODE_FOUNDRY_HOME are required");

test("workspace surface with a real thread: members' state, member tab, add and remove", async ({ page }) => {
  const ws = members();
  const [first, second] = ws.members;
  if (!first || !second) throw new Error(`workspace ${WORKSPACE} needs two members`);
  const thread = (
    JSON.parse(
      cli("session", "new", "--workspace", ws.workspace.id, "--repo", first.repoId, "--model", "haiku", "--effort", "medium", "--permission", "auto", "--prompt", "say hi and stop", "--json"),
    ) as { id: string }
  ).id;
  const surface = page.getByTestId("workspace-surface");
  const member = (repoId: string) => surface.locator(`[data-nav-key="m:${ws.workspace.id}::${repoId}"]`);
  try {
    await page.goto("/");
    const row = page.getByTestId("thread-list").locator(`[data-row-key="s:${thread}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sessionStatus(thread), { timeout: 120_000 }).toMatch(/IDLE|NEEDS_ATTENTION/);

    await test.step("the badge opens the surface: members, their state, the current member", async () => {
      await row.getByTestId("row-workspace").click();
      await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel-key", `session:${thread}`);
      await expect(page.getByTestId("workspace-surface-name")).toHaveText(ws.workspace.name);
      await expect(page.getByTestId("workspace-surface-branch")).toHaveText(ws.workspace.branch);
      await expect(surface.getByTestId("member-name")).toHaveText([first.repoName, second.repoName]);
      await expect(member(first.repoId).getByTestId("worktree-ahead")).toHaveText("1");
      await expect(member(first.repoId).getByTestId("worktree-dirty")).toHaveCount(0);
      await expect(member(first.repoId).getByTestId("member-at")).toHaveText("here");
      await expect(member(second.repoId).getByTestId("worktree-dirty")).toBeVisible();
      await expect(member(second.repoId).getByTestId("worktree-ahead")).toHaveCount(0);
      await expect(member(second.repoId).getByTestId("member-at")).toHaveCount(0);
      await page.waitForTimeout(300);
      await shot(page, "live-wspanel-surface");
    });

    await test.step("a member tab shows that worktree", async () => {
      const m = member(first.repoId);
      await m.hover();
      await m.getByTestId("member-open").click();
      const wt = page.getByTestId("worktree-surface");
      await expect(wt).toHaveAttribute("data-path", first.worktreePath);
      await expect(wt.getByTestId("worktree-surface-title")).toHaveText(`${first.repoName}@${ws.workspace.branch}`);
      await expect(wt.getByTestId("sync-line")).toContainText("↑1");
      await expect(wt.getByTestId("section-log")).toContainText("ahead commit");
      await page.waitForTimeout(300);
      await shot(page, "live-wspanel-member-tab");
      await page.getByTestId("panel-tabs").getByRole("tab", { name: ws.workspace.name }).click();
    });

    await test.step("add and remove a member round-trip", async () => {
      await surface.getByTestId("workspace-add-member").click();
      await page.getByTestId("workspace-add-member-list").getByRole("option", { name: ADD_REPO }).click();
      await expect(surface.getByTestId("member-name")).toHaveText([first.repoName, second.repoName, ADD_REPO], { timeout: 60_000 });
      expect(members().members.map((m) => m.repoName)).toEqual([first.repoName, second.repoName, ADD_REPO]);
      await shot(page, "live-wspanel-added");

      const added = surface.locator('[data-testid="workspace-member"]').filter({ hasText: ADD_REPO });
      await added.hover();
      await added.getByTestId("member-remove").click();
      const dialog = page.getByTestId("confirm-dialog");
      await expect(dialog).toContainText(`Remove project ${ADD_REPO} from its workspace?`);
      await dialog.getByTestId("confirm-ok").click();
      await expect(surface.getByTestId("member-name")).toHaveText([first.repoName, second.repoName], { timeout: 60_000 });
      expect(members().members.map((m) => m.repoName)).toEqual([first.repoName, second.repoName]);
    });
  } finally {
    try {
      cli("session", "close", "--id", thread);
    } catch {
      // already closed
    }
  }
});
