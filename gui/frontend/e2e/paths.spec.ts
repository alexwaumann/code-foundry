import { expect, test, type Page } from "@playwright/test";
import { invocations, openApp, resetMock } from "./fixtures";

// Path prompts (repo.register's "path") complete against FilesystemService.ListDirectories
// over the mock's fake home (mock/filesystem.ts).

test.beforeEach(async () => {
  await resetMock();
});

async function openAddProject(page: Page) {
  await openApp(page);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("add project local folder");
  await page.keyboard.press("Enter");
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "args");
  return palette;
}

function entry(page: Page, name: string) {
  return page.getByTestId("path-entry").and(page.locator(`[data-entry-name="${name}"]`));
}

test("Add Project completes paths with Tab and submits with Enter", async ({ page }) => {
  const palette = await openAddProject(page);
  const input = palette.locator("input");

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
  await expect(palette).toHaveCount(0);
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("repo.register");
  expect((await invocations()).at(-1)?.args).toEqual({ path: "~/src/new-app" });
});

test("a highlighted folder: / descends, Tab descends, Enter submits it", async ({ page }) => {
  const palette = await openAddProject(page);
  const input = palette.locator("input");
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
  await expect(palette).toHaveCount(0);
  await expect.poll(async () => (await invocations()).at(-1)?.args).toEqual({ path: "~/Documents/Projects/side-project" });
});

test("outside home is refused and long listings are bounded", async ({ page }) => {
  const palette = await openAddProject(page);
  const input = palette.locator("input");
  await input.fill("/etc/");
  await expect(page.getByTestId("path-message")).toContainText("/etc/ is outside your home directory");
  await expect(page.getByTestId("path-entry")).toHaveCount(0);

  await input.fill("~/many/");
  await expect(page.getByTestId("path-entry")).toHaveCount(200);
  await expect(palette.getByText("Folders (first 200)")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("~/many/d");
});
