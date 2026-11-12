/**
 * Live e2e: a project without git against a REAL daemon (docs/notes/add-project-2-nogit.md).
 * Opt-in; how to run it: docs/notes/live-e2e.md. Needs LIVE_NOGIT_DIR: an existing plain
 * folder under ~ that is not inside a git repository. No Claude turns.
 *
 * It registers the folder with the CLI, checks the Projects index row and the project page
 * read as a folder without git, opens a terminal there from the page, runs `project git
 * init` with the CLI, and checks the open page follows: checkouts, and Publish (no remote).
 * At the end it closes the terminal, unregisters the project and removes the .git it made,
 * so the folder can be used again.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectPage, openProjects } from "./fixtures";
import { cli, cliJson, openApp, requireLive, shot, type LiveProject } from "./live";

const DIR = process.env.LIVE_NOGIT_DIR ?? "";

requireLive("LIVE_NOGIT_DIR");

test("register a plain folder, see it without git, then project git init turns it into a git project", async ({ page }) => {
  const project = cliJson("project", "add", "--path", DIR) as LiveProject;
  expect(project.git ?? false).toBe(false);
  let terminal = "";
  try {
    await openApp(page);
    await openProjects(page);
    await expect(page.locator(`[data-testid="index-project"][data-project="${project.id}"]`)).toHaveAttribute("data-kind", "nogit");
    await shot(page, "nogit-projects");

    await openProjectPage(page, project.id);
    const projectPage = page.locator(`[data-testid="projects-page"][data-project="${project.id}"]`);
    await expect(projectPage).toHaveAttribute("data-kind", "nogit");
    await expect(page.getByTestId("project-init-git")).toBeVisible();
    await expect(page.getByTestId("project-checkouts")).toHaveCount(0);

    // A terminal in the folder, from the page: its bottom panel, the shell in the folder.
    await page.getByTestId("project-threads-terminal").click();
    const host = page.getByTestId("bottom-terminal-host");
    await expect(host).toHaveAttribute("data-attach-phase", "live");
    terminal = (await host.getAttribute("data-terminal-id")) ?? "";
    const terminals = (cliJson("terminal", "list") as { terminals?: { id: string; cwd?: string }[] }).terminals ?? [];
    expect(terminals.find((t) => t.id === terminal)?.cwd).toBe(DIR);
    await shot(page, "nogit-project");

    const after = cliJson("project", "git", "init", "--project", project.id) as { git?: boolean; defaultBranch?: string };
    expect(after.git).toBe(true);
    expect(after.defaultBranch ?? "").not.toBe("");

    // The open page follows the project event: a git repository without a remote.
    await expect(projectPage).not.toHaveAttribute("data-kind", "nogit");
    await expect(page.getByTestId("project-init-git")).toHaveCount(0);
    await expect(page.getByTestId("project-checkouts")).toBeVisible();
    await expect(page.getByTestId("project-publish")).toBeVisible();
    await shot(page, "nogit-after-init");
  } finally {
    if (terminal) cli("terminal", "close", "--id", terminal);
    cli("project", "unregister", "--project", project.id, "--yes");
    rmSync(path.join(DIR, ".git"), { recursive: true, force: true });
  }
});
