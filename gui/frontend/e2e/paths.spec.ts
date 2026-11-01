import { expect, test, type Page } from "@playwright/test";
import { invocations, openAddProjectDialog, openApp, projectAt, resetMock } from "./fixtures";

// Folder completion against FilesystemService.ListDirectories over the mock's fake home
// (mock/filesystem.ts), driven through the Add Project dialog's Local folder tab. The
// palette's path prompts use the same completion (usePathCompletion, pathCompletion.tsx).

test.beforeEach(async () => {
  await resetMock();
});

async function openAddProject(page: Page) {
  await openApp(page);
  await openAddProjectDialog(page);
  const dialog = page.getByTestId("add-project-dialog");
  await expect(dialog).toHaveAttribute("data-tab", "local");
  await expect(page.getByTestId("add-project-local-input")).toBeFocused();
  // The "~/" is permanent: the input holds what follows it, data-path the full path.
  await expect(page.getByTestId("add-project-local-prefix")).toHaveText("~/");
  await expect(page.getByTestId("add-project-local-input")).toHaveAttribute("data-path", "~/");
  return dialog;
}

function entry(page: Page, name: string) {
  return page.getByTestId("path-entry").and(page.locator(`[data-entry-name="${name}"]`));
}

// Local folder completion: what a listing holds (home without dot-directories, the case-insensitive common prefix, one match with a slash, a "." segment) is the daemon's, internal/fsx/list_test.go; Tab applying it and Enter adding: src/components/addproject/AddProjectDialog.test.tsx; a pasted ~ not doubled: src/palette/paths.test.ts; the git and already-added marks: src/components/palette/pathCompletion.test.tsx.

test("a highlighted folder: / descends, Tab descends, Enter submits it", async ({ page }) => {
  const dialog = await openAddProject(page);
  const input = page.getByTestId("add-project-local-input");
  await input.fill("Documents/");
  await expect(entry(page, "Projects")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(entry(page, "Projects")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("/");
  await expect(input).toHaveValue("Documents/Projects/");
  await expect(entry(page, "side-project")).toHaveAttribute("data-git", "true");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("Documents/Projects/side-project/");

  await input.fill("Documents/Projects/");
  await expect(entry(page, "side-project")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await projectAt("/Users/dev/Documents/Projects/side-project"))?.name).toBe("side-project");
});

// Absolute paths mapping under home is paths.test.ts's (homeRelative).
// Long listings bounded to the first 200: the daemon's (internal/fsx/list_test.go "bounded"); the "Folders (first 200)" heading: src/components/palette/pathCompletion.test.tsx.

test("the palette's path prompt still uses a clicked folder, with no chevron", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await palette.locator('[data-command="dev.path"]').click();
  await expect(palette).toHaveAttribute("data-mode", "args");
  await page.keyboard.type("~/");
  await expect(entry(page, "src")).toBeVisible();
  await expect(palette.getByText("Use ~/")).toBeVisible();
  await expect(palette.getByTestId("path-entry-open")).toHaveCount(0);
  await entry(page, "src").click();
  await expect(palette).toHaveCount(0);
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("dev.path");
  expect((await invocations()).at(-1)?.args).toEqual({ path: "~/src" });
});
