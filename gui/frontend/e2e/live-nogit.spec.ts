/**
 * Live e2e: a project without git against a REAL daemon (docs/notes/add-project-2-nogit.md).
 * Opt-in (LIVE_DAEMON=1), run with playwright.live.config.ts, which starts nothing: bring
 * up an isolated daemon (CODE_FOUNDRY_HOME) and the Vite dev server pointed at it (recipe
 * in docs/notes/phase2-integration.md), and name an existing plain folder under $HOME
 * that is not inside a git repository (LIVE_NOGIT_DIR).
 *
 * It registers the folder with the CLI, checks the Projects page, the overview and a
 * terminal's sidebar row, runs `repo git init` with the CLI, and checks that the project
 * turned into a git repository on its default branch. No Claude turns. The folder is
 * left as a git repository with one empty commit; the terminal is killed.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const HOME = process.env.CODE_FOUNDRY_HOME ?? "";
const DIR = process.env.LIVE_NOGIT_DIR ?? "";
const BIN = process.env.LIVE_BIN ?? path.join(path.resolve(process.cwd(), "../.."), "bin/code-foundry");
const SHOTS = process.env.LIVE_SHOTS ?? "";

function cli(...args: string[]): string {
  return execFileSync(BIN, args, { env: { ...process.env, CODE_FOUNDRY_HOME: HOME }, encoding: "utf8", timeout: 60_000 });
}

test.skip(!LIVE || !HOME || !DIR, "LIVE_DAEMON=1, CODE_FOUNDRY_HOME and LIVE_NOGIT_DIR are required");

test("register a plain folder, see No git everywhere, then repo git init turns it into a git project", async ({ page }) => {
  const repo = JSON.parse(cli("repo", "register", "--path", DIR, "--json")) as { id: string; name: string; git?: boolean };
  expect(repo.git ?? false).toBe(false);
  const term = JSON.parse(cli("terminal", "new", "--cwd", DIR, "--json")) as { id: string };

  try {
    await page.goto("/");
    // The terminal's sidebar row: "<project> · No git" where a branch would be.
    const row = page.locator(`[data-row-key="t:${term.id}"]`);
    await expect(row.getByTestId("row-place")).toHaveText(`${repo.name} · No git`);

    await page.getByTestId("nav-projects").click();
    const project = page.locator(`[data-testid="project"][data-repo="${repo.id}"]`);
    await expect(project).toHaveAttribute("data-git", "false");
    await expect(project.getByTestId("no-git-badge")).toBeVisible();
    await expect(project.getByTestId("worktree-branch")).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "nogit-projects.png") });

    await page.locator(`[data-nav-key="p:${repo.id}"]`).dblclick();
    await expect(page.getByTestId("overview-page")).toHaveAttribute("data-git", "false");
    await expect(page.getByTestId("section-nogit")).toContainText("Not a git repository");
    await expect(page.getByTestId("init-git")).toBeEnabled();
    await expect(page.getByTestId("section-files")).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "nogit-overview.png") });

    const after = JSON.parse(cli("repo", "git", "init", "--repo", repo.id, "--json")) as { git?: boolean; defaultBranch?: string };
    expect(after.git).toBe(true);
    const branch = after.defaultBranch ?? "";
    expect(branch).not.toBe("");

    // The open overview follows the repo event: the normal git overview, no remote.
    await expect(page.getByTestId("overview-page")).toHaveAttribute("data-git", "true");
    await expect(page.getByTestId("overview-title")).toHaveText(`${repo.name}@${branch}`);
    await expect(page.getByTestId("sync-line")).toBeVisible();
    await expect(page.getByTestId("publish-github")).toBeDisabled();
    await expect(row.getByTestId("row-place")).toHaveText(`${repo.name} · ${branch}`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "nogit-after-init.png") });
  } finally {
    cli("terminal", "kill", "--id", term.id, "--yes");
  }
});
