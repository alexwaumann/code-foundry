/**
 * Live e2e: the flat thread sidebar, the Projects page and "Run in…" against a REAL
 * daemon and real Claude Code (docs/notes/workspaces-4-sidebar.md). Opt-in
 * (LIVE_DAEMON=1), run with playwright.live.config.ts, which starts nothing: bring up an
 * isolated daemon (CODE_FOUNDRY_HOME) with two registered repos and one workspace over
 * both (LIVE_WORKSPACE, its name), and the Vite dev server pointed at it (recipe in
 * docs/notes/phase2-integration.md).
 *
 * It starts two haiku threads ("say hi and stop"): one in the workspace's first member,
 * one in the second project's main worktree; moves the workspace thread to the second
 * member with Run in…, and closes both at the end.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const HOME = process.env.CODE_FOUNDRY_HOME ?? "";
const WORKSPACE = process.env.LIVE_WORKSPACE ?? "demo";
const BIN = process.env.LIVE_BIN ?? path.join(path.resolve(process.cwd(), "../.."), "bin/code-foundry");
const SHOTS = process.env.LIVE_SHOTS ?? "";

function cli(...args: string[]): string {
  return execFileSync(BIN, args, { env: { ...process.env, CODE_FOUNDRY_HOME: HOME }, encoding: "utf8", timeout: 60_000 });
}

interface LiveSession {
  id: string;
  repoId?: string;
  worktreePath?: string;
  workspaceId?: string;
  pendingWorktreePath?: string;
  state?: string;
  status?: string;
}

function sessionInfo(id: string): LiveSession | undefined {
  return ((JSON.parse(cli("session", "list", "--json")) as { sessions?: LiveSession[] }).sessions ?? []).find((s) => s.id === id);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.skip(!LIVE || !HOME, "LIVE_DAEMON=1 and CODE_FOUNDRY_HOME are required");

test("flat sidebar, Projects page and Run in… with real threads", async ({ page }) => {
  const ws = JSON.parse(cli("workspace", "members", WORKSPACE, "--json")) as {
    workspace: { id: string; name: string };
    members: { repoId: string; repoName: string; worktreePath: string }[];
  };
  const [first, second] = ws.members;
  if (!first || !second) throw new Error(`workspace ${WORKSPACE} needs two members`);
  const start = (...args: string[]) =>
    (JSON.parse(cli("session", "new", ...args, "--model", "haiku", "--effort", "medium", "--permission", "auto", "--prompt", "say hi and stop", "--json")) as LiveSession).id;
  const wsThread = start("--workspace", ws.workspace.id, "--repo", first.repoId);
  const projThread = start("--repo", second.repoId);
  try {
    await page.goto("/");
    const list = page.getByTestId("thread-list");
    const wsRow = list.locator(`[data-row-key="s:${wsThread}"]`);
    const projRow = list.locator(`[data-row-key="s:${projThread}"]`);

    await test.step("flat list: both threads, the badge on the workspace thread, no worktree rows", async () => {
      await expect(wsRow).toBeVisible({ timeout: 20_000 });
      await expect(projRow).toBeVisible();
      await expect(wsRow.getByTestId("row-workspace")).toHaveText(ws.workspace.name);
      await expect(wsRow.getByTestId("row-project")).toHaveText(first.repoName);
      await expect(projRow.getByTestId("row-workspace")).toHaveCount(0);
      await expect(projRow.getByTestId("row-project")).toHaveText(second.repoName);
      await expect(list.locator('[data-row-kind="repo"], [data-row-kind="worktree"]')).toHaveCount(0);
      // Both turns end (the unwatched ones then wait under Needs attention, "finished").
      await expect.poll(() => sessionInfo(wsThread)?.status, { timeout: 120_000 }).toMatch(/IDLE|NEEDS_ATTENTION/);
      await expect.poll(() => sessionInfo(projThread)?.status, { timeout: 120_000 }).toMatch(/IDLE|NEEDS_ATTENTION/);
      await page.waitForTimeout(500);
      await shot(page, "live-sidebar-list");
    });

    await test.step("Projects page: both projects, the workspace and its members", async () => {
      await page.getByTestId("nav-projects").click();
      await expect(page.getByTestId("project-name")).toHaveText([first.repoName, second.repoName].sort((a, b) => a.localeCompare(b)));
      const block = page.locator(`[data-testid="workspace"][data-workspace="${ws.workspace.id}"]`);
      await expect(block.getByTestId("workspace-name")).toHaveText(ws.workspace.name);
      await expect(block.getByTestId("member-name")).toHaveText([first.repoName, second.repoName]);
      await page.waitForTimeout(300);
      await shot(page, "live-projects-page");
    });

    await test.step("Run in… is absent on the project thread", async () => {
      await projRow.click({ button: "right" });
      await expect(page.getByTestId("row-menu")).toBeVisible();
      await expect(page.getByTestId("menu-run-in")).toHaveCount(0);
      await page.keyboard.press("Escape");
    });

    await test.step("Run in… moves the workspace thread: pending, then the new member", async () => {
      await wsRow.click({ button: "right" });
      await page.getByTestId("menu-run-in").click();
      await page.getByTestId("menu-run-in-members").locator(`[data-member="${second.repoId}"]`).click();
      await expect(wsRow.getByTestId("row-moving")).toHaveText(`moving to ${second.repoName}…`, { timeout: 5000 });
      await shot(page, "live-sidebar-moving");
      await expect(wsRow.getByTestId("row-moving")).toHaveCount(0, { timeout: 60_000 });
      await expect(wsRow.getByTestId("row-project")).toHaveText(second.repoName);
      expect(sessionInfo(wsThread)).toMatchObject({ repoId: second.repoId, worktreePath: second.worktreePath, workspaceId: ws.workspace.id });
      await page.waitForTimeout(300);
      await shot(page, "live-sidebar-moved");
    });
  } finally {
    for (const id of [wsThread, projThread]) {
      try {
        cli("session", "close", "--id", id);
      } catch {
        // already closed
      }
    }
  }
});
