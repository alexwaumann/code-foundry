import { expect, test, type Page } from "@playwright/test";
import { openAddProjectDialog, openApp, resetMock } from "./fixtures";

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

// The tabs, the tab each entry opens on with its input focused, the Projects page's Add project, the
// picker's pinned Add a project… row (last, not preselected, outside the list) and that nothing is
// invoked: src/components/addproject/AddProjectDialog.test.tsx, src/components/projects/ProjectsIndex.test.tsx,
// src/components/compose/ProjectPicker.test.tsx. Left: cmd+k and the picker handing off to the dialog.
test("the palette and New thread's picker open the dialog, its input focused", async ({ page }) => {
  await openApp(page);

  // The palette has one "Add Project" (project.add), and no separate folder prompt.
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await page.keyboard.type("add project");
  await expect(palette.locator('[data-command="project.add"]')).toContainText("Add Project");
  await expect(palette.getByText("Add Project (local folder)")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openFromPalette(page, "project.add");
  await expect(dialog(page)).toHaveAttribute("data-tab", "local");
  await expect(page.getByTestId("add-project-local-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  // project.clone in the palette opens it on GitHub instead of prompting for a project.
  await openFromPalette(page, "project.clone");
  await expect(dialog(page)).toHaveAttribute("data-tab", "github");
  await expect(page.getByTestId("add-project-github-input")).toBeFocused();
  await page.keyboard.press("Escape");

  // The sidebar has no Add project button; New thread's project picker's "Add a project…" closes it and opens the dialog.
  await expect(page.getByTestId("sidebar-add-project")).toHaveCount(0);
  await page.getByTestId("sidebar-new-thread").click();
  const picker = page.getByTestId("palette");
  await expect(picker).toHaveAttribute("data-mode", "projects");
  await picker.getByTestId("picker-add-project").click();
  await expect(picker).toHaveCount(0);
  await expect(dialog(page)).toHaveAttribute("data-tab", "local");
  await expect(page.getByTestId("add-project-local-input")).toBeFocused();
});

// A click opening a folder (an added one too), the message, no row highlighted at first, and Enter on a
// highlighted folder adding it: AddProjectDialog.test.tsx. Left: the chevron's opacity (computed CSS).
test("Local folder: the chevron shows on the highlighted row only", async ({ page }) => {
  await openApp(page);
  await openAddProjectDialog(page);
  await expect(page.getByTestId("path-entry").nth(1)).toBeVisible();
  await page.mouse.move(0, 0);
  await page.keyboard.press("ArrowDown");
  const first = page.getByTestId("path-entry").first();
  await expect(first).toHaveAttribute("data-selected", "true");
  await expect(first.getByTestId("path-entry-open")).toHaveCSS("opacity", "1");
  await expect(page.getByTestId("path-entry").nth(1).getByTestId("path-entry-open")).toHaveCSS("opacity", "0");
});
