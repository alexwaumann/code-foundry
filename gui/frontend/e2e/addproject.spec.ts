import { expect, test, type Page } from "@playwright/test";
import { invocations, listProjects, openAddProjectDialog, openApp, openProjects, projectAt, resetMock } from "./fixtures";

// The Add Project dialog (project.add): its entry points (the palette, New thread's project
// picker, the Projects page) and the Local folder tab's mouse and hover behaviour. The tabs'
// logic is unit-tested in src/components/addproject/AddProjectDialog.test.tsx; completion
// itself is e2e/paths.spec.ts.

test.beforeEach(async () => {
  await resetMock();
});

const dialog = (page: Page) => page.getByTestId("add-project-dialog");

async function openFromPalette(page: Page, command: string): Promise<void> {
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await palette.locator(`[data-command="${command}"]`).click();
  await expect(palette).toHaveCount(0);
}

test("every entry point opens the dialog", async ({ page }) => {
  await openApp(page);

  // The palette has one "Add Project" (project.add), and no separate folder prompt.
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await page.keyboard.type("add project");
  await expect(palette.locator('[data-command="project.add"]')).toContainText("Add Project");
  await expect(palette.getByText("Add Project (local folder)")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openFromPalette(page, "project.add");
  await expect(dialog(page)).toBeVisible();
  // Tabs are New, Local folder, GitHub; it opens on Local folder (New is e2e/create.spec.ts).
  await expect(page.getByTestId("add-project-tabs").getByRole("tab")).toHaveText(["New", "Local folder", "GitHub"]);
  await expect(dialog(page)).toHaveAttribute("data-tab", "local");
  await expect(page.getByTestId("add-project-local-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  // project.clone in the palette opens it on GitHub instead of prompting for a project.
  await openFromPalette(page, "project.clone");
  await expect(dialog(page)).toHaveAttribute("data-tab", "github");
  await expect(page.getByTestId("add-project-github-input")).toBeFocused();
  await page.keyboard.press("Escape");

  // The sidebar has no Add project button; New thread's project picker has "Add a
  // project…" pinned below its list, which closes the picker and opens the dialog.
  await expect(page.getByTestId("sidebar-add-project")).toHaveCount(0);
  await page.getByTestId("sidebar-new-thread").click();
  const picker = page.getByTestId("palette");
  await expect(picker).toHaveAttribute("data-mode", "projects");
  const add = picker.locator("[cmdk-item]").last();
  await expect(add).toHaveAttribute("data-testid", "picker-add-project");
  await expect(picker.getByTestId("picker-rows").getByTestId("picker-add-project")).toHaveCount(0);
  await expect(add).toHaveText("Add a project…a folder on this Mac, or from GitHub");
  await expect(add).not.toHaveAttribute("data-selected", "true");
  await add.click();
  await expect(picker).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute("data-tab", "local");
  await page.keyboard.press("Escape");

  // The Projects page's Add project button.
  await openProjects(page);
  await page.getByTestId("projects-register").click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  // None of them invoked anything: the dialog is the GUI presentation of project.add.
  expect((await invocations()).filter((i) => i.name.startsWith("project."))).toEqual([]);
});

test("Local folder: a click opens a folder; only Enter and the button add", async ({ page }) => {
  await openApp(page);
  const before = (await listProjects()).length;
  await openAddProjectDialog(page);
  const input = page.getByTestId("add-project-local-input");
  const message = page.getByTestId("add-project-local-message");
  const entry = (name: string) => page.getByTestId("path-entry").and(page.locator(`[data-entry-name="${name}"]`));
  await expect(entry("src")).toBeVisible();
  await expect(message).toHaveText("Click or Tab opens a folder · Enter adds");

  // No "Add ~/..." row, and no folder highlighted until the keyboard or the mouse moves there.
  await expect(dialog(page).getByText(/^Add ~\//)).toHaveCount(0);
  await expect(page.getByTestId("add-project-local-typed")).toBeHidden();
  await expect(page.locator('[data-testid="path-entry"][data-selected="true"]')).toHaveCount(0);

  // A click opens the folder (clearing an error), and adds nothing.
  await page.keyboard.press("Enter");
  await expect(message).toContainText("Type a folder path");
  await entry("src").click();
  await expect(input).toHaveValue("src/");
  await expect(input).toHaveAttribute("data-path", "~/src/");
  await expect(input).toBeFocused();
  await expect(message).toHaveText("Click or Tab opens a folder · Enter adds");
  await expect(entry("new-app")).toBeVisible();

  // An already added folder opens the same way.
  await expect(entry("code-foundry")).toContainText("already added");
  await entry("code-foundry").click();
  await expect(input).toHaveAttribute("data-path", "~/src/code-foundry/");
  await expect(entry("docs")).toBeVisible();
  await expect(dialog(page)).toBeVisible();
  expect((await listProjects()).length).toBe(before);

  // The chevron shows on the highlighted (or hovered) row only.
  await page.mouse.move(0, 0);
  await page.keyboard.press("ArrowDown");
  const first = page.getByTestId("path-entry").first();
  await expect(first).toHaveAttribute("data-selected", "true");
  await expect(first.getByTestId("path-entry-open")).toHaveCSS("opacity", "1");
  await expect(page.getByTestId("path-entry").nth(1).getByTestId("path-entry-open")).toHaveCSS("opacity", "0");

  // Enter on a highlighted folder adds that folder.
  await input.fill("src/");
  await expect(entry("Website")).toBeVisible();
  await page.keyboard.press("End");
  await expect(entry("Website")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  expect(await projectAt("/Users/dev/src/Website")).toMatchObject({ name: "Website", git: true });
});
