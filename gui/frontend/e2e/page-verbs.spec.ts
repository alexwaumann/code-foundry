import { expect, test } from "@playwright/test";
import { emit, openApp, resetMock, row, threadPrompt } from "./fixtures";

// The intents behind the page verbs (docs/notes/page-verbs.md): composer.stage
// (UiIntent.StageComposer), view.settings --page (ShowView "settings.<page>") and
// project.add without a folder (ShowView "project.add"), as the daemon sends them.

test.beforeEach(async () => {
  await resetMock();
});

// composer.stage's text on a new line after what is there, another thread's left alone, the window
// staying put: src/stores/intents.test.ts ("the stageComposer intent"). Here only the real editor.
test("composer.stage fills the shown thread's prompt, which takes the keyboard", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-6").click();
  const prompt = threadPrompt(page);
  await expect(prompt).toBeVisible();
  expect(await emit({ stageComposer: { threadId: "s-6", text: "Add my first project" } })).toBe(1);
  await expect(prompt).toHaveText("Add my first project");
  await expect(prompt).toBeFocused();
});

// view.settings --page opening Settings on that page, and moving an open one: src/stores/views.test.ts ("settings.<page>" opens settings on that page…); the nav's current page follows settingsPage in src/components/settings/SettingsPage.test.tsx.

// project.add without a folder opening the Add Project dialog on Local folder: src/stores/views.test.ts ("project.add" opens the Add Project dialog…) and src/components/addproject/AddProjectDialog.test.tsx.

// A project added in the dialog project.add opened leaves the window where it is:
// src/stores/addProject.test.ts ("opened to stay"); the path focused on open and Enter adding:
// src/components/addproject/AddProjectDialog.test.tsx.
