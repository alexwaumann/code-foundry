import { expect, test } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { mockUrl, openApp, openProjectPage, resetMock } from "./fixtures";

/**
 * Renaming a project (docs/notes/projects-table-3-rename.md): a rename made elsewhere (the CLI) reaching the open
 * page over the daemon's stream. The mock's projects: code-foundry (repo-cf), ghostty-playground (repo-gp),
 * dotfiles (repo-dot), sketches (repo-sk) and writing (repo-wr).
 */

test.beforeEach(async () => {
  await resetMock();
});

// Renaming from the page's menu (refusals, Escape, Enter, the index): unit-tested in src/components/projects/ProjectPage.test.tsx.

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
