/**
 * Live e2e: the flat thread sidebar, the Projects page and "Run in…" against a REAL
 * daemon and real Claude Code (docs/notes/workspaces-4-sidebar.md). Opt-in
 * (LIVE_DAEMON=1), run with playwright.live.config.ts, which starts nothing: bring up an
 * isolated daemon (CODE_FOUNDRY_HOME) with two registered projects and one workspace over
 * both (LIVE_WORKSPACE, its name), and the Vite dev server pointed at it (recipe in
 * docs/notes/phase2-integration.md).
 *
^ * It starts two Haiku 5.5 threads ("say hi and stop"): one in the workspace's first member,
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

interface LiveThread {
  id: string;
  projectId?: string;
  worktreePath?: string;
  workspaceId?: string;
  pendingWorktreePath?: string;
  state?: string;
  status?: string;
}

function threadInfo(id: string): LiveThread | undefined {
  return ((JSON.parse(cli("thread", "list", "--json")) as { threads?: LiveThread[] }).threads ?? []).find((s) => s.id === id);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.skip(!LIVE || !HOME, "LIVE_DAEMON=1 and CODE_FOUNDRY_HOME are required");

/** The workspace by name, with its first two members' names and own checkouts (workspaces v2: members are project ids). */
function liveWorkspace(name: string) {
  const w = ((JSON.parse(cli("workspace", "list", "--json")) as { workspaces?: { id: string; name: string; members?: string[] }[] }).workspaces ?? []).find((x) => x.name === name);
  if (!w) throw new Error(`no workspace ${name}`);
  const projects = (JSON.parse(cli("project", "list", "--json")) as { projects?: { id: string; name: string; path: string }[] }).projects ?? [];
  const members = (w.members ?? []).flatMap((id) => {
    const p = projects.find((x) => x.id === id);
    return p ? [{ projectId: id, projectName: p.name, worktreePath: p.path }] : [];
  });
  return { workspace: { id: w.id, name: w.name }, members };
}

test("flat sidebar, Projects page and Run in… with real threads", async ({ page }) => {
  const ws = liveWorkspace(WORKSPACE);
  const [first, second] = ws.members;
  if (!first || !second) throw new Error(`workspace ${WORKSPACE} needs two members`);
  const start = (...args: string[]) =>
    (JSON.parse(cli("thread", "new", ...args, "--model", "claude-haiku-5-5[1m]", "--effort", "medium", "--permission", "auto", "--prompt", "say hi and stop", "--json")) as LiveThread).id;
  const wsThread = start("--workspace", ws.workspace.id, "--project", first.projectId);
  const projThread = start("--project", second.projectId);
  try {
    await page.goto("/");
    const list = page.getByTestId("thread-list");
    const wsRow = list.locator(`[data-row-key="s:${wsThread}"]`);
    const projRow = list.locator(`[data-row-key="s:${projThread}"]`);

    await test.step("flat list: both threads, the workspace thread's line 1 has the Layers glyph and its project, no worktree rows", async () => {
      await expect(wsRow).toBeVisible({ timeout: 20_000 });
      await expect(projRow).toBeVisible();
      // A thread of the workspace's members: the Layers glyph and the project it runs in (the workspace's name is on the card).
      await expect(wsRow.getByTestId("row-workspace")).toHaveCount(1);
      await expect(projRow.getByTestId("row-workspace")).toHaveCount(0);
      await expect(wsRow.getByTestId("row-project")).toHaveText(first.projectName);
      await expect(projRow.getByTestId("row-project")).toHaveText(second.projectName);
      await expect(list.locator('[data-row-kind="project"], [data-row-kind="worktree"]')).toHaveCount(0);
      // Both turns end (the unwatched ones then wait under Needs attention, "finished").
      await expect.poll(() => threadInfo(wsThread)?.status, { timeout: 120_000 }).toMatch(/IDLE|NEEDS_ATTENTION/);
      await expect.poll(() => threadInfo(projThread)?.status, { timeout: 120_000 }).toMatch(/IDLE|NEEDS_ATTENTION/);
      await page.waitForTimeout(500);
      await shot(page, "live-sidebar-list");
    });

    await test.step("Projects page: both projects, the workspace and its members", async () => {
      await page.getByTestId("nav-projects").click();
      // Both projects are listed (the home may register more).
      for (const p of [first, second]) await expect(page.getByTestId("project-name").filter({ hasText: new RegExp(`^${p.projectName}$`) })).toHaveCount(1);
      await page.locator(`[data-nav-key="ws:${ws.workspace.id}"]`).click();
      const block = page.locator(`[data-testid="workspace"][data-workspace="${ws.workspace.id}"]`);
      await expect(page.getByTestId("page-name")).toHaveText(ws.workspace.name);
      await expect(block.getByTestId("member-name")).toHaveText([first.projectName, second.projectName].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
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
      await page.getByTestId("menu-run-in-members").locator(`[data-member="${second.projectId}"]`).click();
      await expect(wsRow.getByTestId("row-moving")).toHaveText(`moving to ${second.projectName}…`, { timeout: 5000 });
      await shot(page, "live-sidebar-moving");
      await expect(wsRow.getByTestId("row-moving")).toHaveCount(0, { timeout: 60_000 });
      // Line 3 may be the status's detail now; the place is the daemon's.
      expect(threadInfo(wsThread)).toMatchObject({ projectId: second.projectId, worktreePath: second.worktreePath, workspaceId: ws.workspace.id });
      await page.waitForTimeout(300);
      await shot(page, "live-sidebar-moved");
    });
  } finally {
    for (const id of [wsThread, projThread]) {
      try {
        cli("thread", "archive", "--id", id, "--yes");
      } catch {
        // already gone
      }
    }
  }
});
