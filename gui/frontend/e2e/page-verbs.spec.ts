import { expect, test } from "@playwright/test";
import { emit, openApp, projectAt, resetMock, row, threadPrompt } from "./fixtures";

// The intents behind the page verbs (docs/notes/page-verbs.md): composer.stage
// (UiIntent.StageComposer), view.settings --page (ShowView "settings.<page>") and
// project.add without a folder (ShowView "project.add"), as the daemon sends them.

test.beforeEach(async () => {
  await resetMock();
});

test("composer.stage fills the shown thread's composer without sending, then adds on a new line", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-6").click();
  const prompt = threadPrompt(page);
  await expect(prompt).toBeVisible();
  expect(await emit({ stageComposer: { threadId: "s-6", text: "Add my first project" } })).toBe(1);
  await expect(prompt).toHaveText("Add my first project");
  await expect(prompt).toBeFocused();
  await emit({ stageComposer: { threadId: "s-6", text: "and open it" } });
  await expect(prompt).toHaveText(/Add my first project\s*and open it/);
  // Another thread's text leaves this one alone, and the window stays where it is.
  await emit({ stageComposer: { threadId: "s-3", text: "elsewhere" } });
  await expect(page.getByTestId("thread-header")).toBeVisible();
  await expect(prompt).not.toContainText("elsewhere");
});

test("view.settings --page opens Settings on that page", async ({ page }) => {
  await openApp(page);
  await emit({ showView: { name: "settings.memory" } });
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(page.getByTestId("settings-nav-memory")).toHaveAttribute("aria-current", "page");
  // An open sheet moves to the page asked for.
  await emit({ showView: { name: "settings.appearance" } });
  await expect(page.getByTestId("settings-nav-appearance")).toHaveAttribute("aria-current", "page");
});

test("project.add without a folder opens the Add Project dialog", async ({ page }) => {
  await openApp(page);
  await emit({ showView: { name: "project.add" } });
  const dialog = page.getByTestId("add-project-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-tab", "local");
});

test("a project added in the dialog project.add opened leaves the window on its thread", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-6").click();
  await expect(page.getByTestId("thread-header")).toBeVisible();
  await emit({ showView: { name: "project.add" } });
  const dialog = page.getByTestId("add-project-dialog");
  const input = page.getByTestId("add-project-local-input");
  await expect(input).toBeFocused();
  await input.fill("src/new-app");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => projectAt("/Users/dev/src/new-app")).toMatchObject({ name: "new-app" });
  // No Projects page, no worktree: the thread stays selected and shown.
  await expect(row(page, "s:s-6")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("thread-header")).toBeVisible();
  await expect(page.getByTestId("projects-page")).toHaveCount(0);
  await expect(page.getByTestId("worktree-surface")).toHaveCount(0);
});
