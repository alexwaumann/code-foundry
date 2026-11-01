import { expect, test } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { invocations, mockUrl, openApp, openProjectPage, openProjects, resetMock } from "./fixtures";

/**
 * Renaming a project from its page (docs/notes/projects-table-3-rename.md): the header's ⋯ Rename opens the name
 * editor in place; the daemon's name rules are checked as the user types. The mock's projects: code-foundry
 * (repo-cf), ghostty-playground (repo-gp), dotfiles (repo-dot), sketches (repo-sk) and writing (repo-wr).
 */

test.beforeEach(async () => {
  await resetMock();
});

const renames = async () => (await invocations()).filter((i) => i.name === "project.rename");

test("rename from the project page's menu: refused names stay in the field, Escape keeps, Enter renames everywhere", async ({ page }) => {
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  const input = page.getByTestId("project-name-input");
  const error = page.getByTestId("project-name-error");

  await page.getByTestId("project-more").click();
  await page.getByTestId("project-menu-rename").click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("code-foundry");
  await input.fill("DOTFILES");
  await expect(error).toHaveText("A project named “dotfiles” exists.");
  await page.keyboard.press("Enter");
  await expect(input).toBeVisible();
  await input.fill("web/site");
  await expect(error).toHaveText("No / or , in a project name.");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("page-name")).toHaveText("code-foundry");
  expect(await renames()).toHaveLength(0);

  await page.getByTestId("project-more").click();
  await page.getByTestId("project-menu-rename").click();
  await input.fill("foundry");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("page-name")).toHaveText("foundry");
  await expect(page.getByTestId("projects-list")).toBeFocused();
  const done = await renames();
  expect(done).toHaveLength(1);
  expect(done[0]?.args).toEqual({ project: "repo-cf", name: "foundry" });
  expect(done[0]?.context).toMatchObject({ activeProjectId: "repo-cf" });

  // The index has the new name too.
  await openProjects(page);
  await expect(page.locator('[data-nav-key="p:repo-cf"]')).toContainText("foundry");
});

test("a rename from elsewhere (the CLI) shows on the open page", async ({ page }) => {
  await openApp(page);
  await openProjectPage(page, "repo-gp");
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name: "project.rename", args: { project: "ghostty-playground", name: "playground" } }),
  });
  expect(res.ok).toBe(true);
  await expect(page.getByTestId("page-name")).toHaveText("playground");
});
