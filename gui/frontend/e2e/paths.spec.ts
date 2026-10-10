import { expect, test, type Page } from "@playwright/test";
import { openApp, repoAt, resetMock } from "./fixtures";

// Folder completion against FilesystemService.ListDirectories over the mock's fake home
// (mock/filesystem.ts), driven through the Add Project dialog's Local folder tab. The
// palette's path prompts use the same completion (usePathCompletion, pathCompletion.tsx).

test.beforeEach(async () => {
  await resetMock();
});

async function openAddProject(page: Page) {
  await openApp(page);
  await page.getByTestId("sidebar-add-project").click();
  const dialog = page.getByTestId("add-project-dialog");
  await expect(dialog).toHaveAttribute("data-tab", "local");
  await expect(page.getByTestId("add-project-local-input")).toBeFocused();
  return dialog;
}

function entry(page: Page, name: string) {
  return page.getByTestId("path-entry").and(page.locator(`[data-entry-name="${name}"]`));
}

test("Local folder completes paths with Tab and submits with Enter", async ({ page }) => {
  const dialog = await openAddProject(page);
  const input = page.getByTestId("add-project-local-input");

  // Empty input lists home, without dot-directories.
  await expect(entry(page, "src")).toBeVisible();
  await expect(entry(page, "dotfiles")).toHaveAttribute("data-git", "true");
  await expect(entry(page, "dotfiles")).toContainText("already added");
  await expect(entry(page, ".config")).toHaveCount(0);
  // No Wails host in the browser: no folder picker button.
  await expect(page.getByTestId("pick-directory")).toHaveCount(0);

  // A single match completes with a slash and lists the directory.
  await page.keyboard.type("~/S");
  await expect(page.getByTestId("path-entry")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("~/src/");
  await expect(input).toBeFocused();
  await expect(entry(page, "new-app")).toBeVisible();
  await expect(entry(page, "code-foundry")).toHaveAttribute("data-registered", "true");
  await expect(entry(page, "new-app")).toHaveAttribute("data-git", "true");
  await expect(entry(page, "new-app")).not.toContainText("already added");
  await expect(entry(page, "Notebook")).not.toHaveAttribute("data-git", "true");

  // Several matches complete to their common prefix (case-insensitively).
  await page.keyboard.type("CO");
  await expect(page.getByTestId("path-entry")).toHaveCount(2);
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("~/src/code-foundry");

  // Dot-directories show for a "." segment.
  await input.fill("~/.");
  await expect(entry(page, ".config")).toBeVisible();
  await expect(entry(page, "src")).toHaveCount(0);

  // Enter submits what is typed (trailing slash dropped).
  await input.fill("~/src/ne");
  await expect(page.getByTestId("path-entry")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("~/src/new-app/");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(await repoAt("/Users/dev/src/new-app")).toMatchObject({ name: "new-app", git: true });
});

test("a highlighted folder: / descends, Tab descends, Enter submits it", async ({ page }) => {
  const dialog = await openAddProject(page);
  const input = page.getByTestId("add-project-local-input");
  await input.fill("~/Documents/");
  await expect(entry(page, "Projects")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(entry(page, "Projects")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("/");
  await expect(input).toHaveValue("~/Documents/Projects/");
  await expect(entry(page, "side-project")).toHaveAttribute("data-git", "true");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("~/Documents/Projects/side-project/");

  await input.fill("~/Documents/Projects/");
  await expect(entry(page, "side-project")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await repoAt("/Users/dev/Documents/Projects/side-project"))?.name).toBe("side-project");
});

test("outside home is refused and long listings are bounded", async ({ page }) => {
  const dialog = await openAddProject(page);
  const input = page.getByTestId("add-project-local-input");
  await input.fill("/etc/");
  await expect(page.getByTestId("path-message")).toContainText("/etc/ is outside your home directory");
  await expect(page.getByTestId("path-entry")).toHaveCount(0);

  await input.fill("~/many/");
  await expect(page.getByTestId("path-entry")).toHaveCount(200);
  await expect(dialog.getByText("Folders (first 200)")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("~/many/d");
});
