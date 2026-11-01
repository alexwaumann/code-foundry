import { expect, test, type Page } from "@playwright/test";
import { openApp, openProjectPage, resetMock, row } from "./fixtures";

// Add-project PR 4: project.create and project.github.publish reached from the palette
// (the New tab and the Publish to GitHub dialog themselves are unit-tested).
// docs/notes/add-project-4-create.md.

test.beforeEach(async () => {
  await resetMock();
});

const dialog = (page: Page) => page.getByTestId("add-project-dialog");

// The New tab (name rules, create, publish, owners and visibilities, a refused publish, cancel deleting) and the Publish dialog from the index row: unit-tested in src/components/addproject/AddProjectDialog.test.tsx.

test("project.github.publish in the palette opens the publish dialog; project.create opens New", async ({ page }) => {
  await openApp(page);
  // The composer for sketches (its project page's New thread) gives the palette the
  // project's context; the Projects page itself has none.
  await openProjectPage(page, "repo-sk");
  await page.getByTestId("project-new-thread").click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await palette.locator('[data-command="project.github.publish"]').click();
  await expect(page.getByTestId("publish-dialog")).toHaveAttribute("data-project", "repo-sk");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("publish-dialog")).toHaveCount(0);

  // A project with origin does not offer it.
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+k");
  await expect(palette.locator('[data-command="project.github.publish"]')).toHaveCount(0);
  await palette.locator('[data-command="project.create"]').click();
  await expect(dialog(page)).toHaveAttribute("data-tab", "new");
});
