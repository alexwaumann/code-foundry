/**
 * Live e2e: the Add Project dialog's New tab and the publish picker against a REAL daemon
 * and GitHub (docs/notes/add-project-4-create.md). Opt-in; how to run it:
 * docs/notes/live-e2e.md. The scratch home must be under ~ (new projects land in
 * <home>/projects, and projects must be under home); `gh` must be logged in (it lists the
 * owners). No Claude turns.
 *
 * It creates a project with the dialog, checks the picker lists the viewer first with
 * Public and Private (Public selected), opens the project page's publish dialog, and never
 * publishes (nothing is created on GitHub). Then it unregisters and deletes the project.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { expectProjectRevealed, openAddProjectDialog } from "./fixtures";
import { cli, HOME, openApp, projectAt, requireLive, shot } from "./live";

requireLive();

test("create a project with the New tab; the publish picker lists the viewer", async ({ page }) => {
  const name = `cf-live-create-${String(Date.now() % 100000)}`;
  const dest = path.join(HOME, "projects", name);
  await openApp(page);
  await openAddProjectDialog(page);
  await page.getByTestId("add-project-tab-new").click();
  await page.getByTestId("add-project-new-name").fill(name);
  await expect(page.getByTestId("add-project-new-dest")).toHaveText(new RegExp(`/projects/${name}$`));

  await page.getByTestId("add-project-new-publish").check();
  const owner = page.getByTestId("publish-owner");
  await expect(owner).not.toHaveAttribute("data-owner", "", { timeout: 30_000 });
  await expect(page.getByTestId("publish-visibility").getByRole("radio")).toHaveText(["Public", "Private"]);
  await expect(page.getByTestId("publish-visibility")).toHaveAttribute("data-value", "public");
  await owner.click();
  await expect(page.getByTestId("publish-owner-option").first()).toBeVisible();
  await shot(page, "create-owners");
  await page.keyboard.press("Escape");
  await page.getByTestId("add-project-new-publish").uncheck();
  // Never publish: Create must not reach GitHub.
  await expect(page.getByTestId("add-project-new-publish")).not.toBeChecked();

  try {
    await page.getByTestId("add-project-create").click();
    await expect(page.getByTestId("add-project-dialog")).toHaveCount(0);
    await expectProjectRevealed(page, name);
    expect(projectAt(dest)).not.toBe("");

    await page.getByTestId("project-publish").click();
    await expect(page.getByTestId("publish-dialog")).toBeVisible();
    await expect(page.getByTestId("publish-name")).toHaveValue(name);
    await expect(page.getByTestId("publish-visibility")).toHaveAttribute("data-value", "public");
    await shot(page, "create-publish-dialog");
    await page.keyboard.press("Escape");
  } finally {
    const id = projectAt(dest);
    if (id) cli("project", "unregister", "--project", id, "--yes");
    rmSync(dest, { recursive: true, force: true });
  }
});
