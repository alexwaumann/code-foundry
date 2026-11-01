import { expect, test, type Page } from "@playwright/test";
import { openAddProjectDialog, openApp, projectAt, resetMock } from "./fixtures";

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

// A highlighted folder: / descends, Tab descends, Enter adds it: src/components/addproject/AddProjectDialog.test.tsx.

// Absolute paths mapping under home is paths.test.ts's (homeRelative).
// Long listings bounded to the first 200: the daemon's (internal/fsx/list_test.go "bounded"); the "Folders (first 200)" heading: src/components/palette/pathCompletion.test.tsx.

// The palette's path prompt (folders without a chevron, Use ~/, a clicked folder as the answer):
// src/components/palette/CommandPalette.projects.test.tsx.
