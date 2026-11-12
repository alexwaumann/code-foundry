/**
 * Live e2e: the Add Project dialog's GitHub tab against a REAL daemon and GitHub
 * (docs/notes/add-project-3-dialog.md). Opt-in; how to run it: docs/notes/live-e2e.md.
 * The scratch home must be under ~ (clones land in <home>/projects), `gh` must be logged in,
 * and LIVE_CLONE_REPO names a small public repository to clone read-only (owner/name, e.g.
 * octocat/Hello-World) that is not cloned there yet. No Claude turns.
 *
 * It searches for the repository, looks it up by URL, clones it with the dialog (gh's
 * progress streams in), checks the new project opens, then unregisters it and deletes
 * the clone.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { expectProjectRevealed, openAddProjectDialog } from "./fixtures";
import { cli, HOME, openApp, projectAt, requireLive, shot } from "./live";

const REPO = process.env.LIVE_CLONE_REPO ?? "";

requireLive("LIVE_CLONE_REPO");

test("search, look up and clone a GitHub repository with the dialog", async ({ page }) => {
  const [owner = "", name = ""] = REPO.split("/");
  const dest = path.join(HOME, "projects", owner, name);
  await openApp(page);
  await openAddProjectDialog(page);
  await page.getByTestId("add-project-tab-github").click();
  const input = page.getByTestId("add-project-github-input");

  await input.fill(`${name} user:${owner}`);
  await input.press("Enter");
  await expect(page.getByTestId("add-project-github-result").and(page.locator(`[data-slug="${REPO}" i]`))).toBeVisible();
  await shot(page, "addproject-search");

  await input.fill(`https://github.com/${REPO}.git`);
  await input.press("Enter");
  const card = page.getByTestId("add-project-github-selected");
  await expect(card).toHaveAttribute("data-slug", new RegExp(`^${REPO}$`, "i"));
  await expect(card.getByTestId("add-project-clone-dest")).toHaveText(new RegExp(`/projects/${owner}/${name}$`, "i"));

  try {
    await card.getByTestId("add-project-clone").click();
    await expect(card.getByTestId("add-project-clone-line").first()).toContainText("Cloning into");
    await shot(page, "addproject-cloning");
    await expect(page.getByTestId("add-project-dialog")).toHaveCount(0, { timeout: 120_000 });
    await expectProjectRevealed(page, name);
    await shot(page, "addproject-cloned");
    expect(projectAt(dest)).not.toBe("");
  } finally {
    const id = projectAt(dest);
    if (id) cli("project", "unregister", "--project", id, "--yes");
    rmSync(dest, { recursive: true, force: true });
  }
});
