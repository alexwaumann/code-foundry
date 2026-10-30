import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row } from "./fixtures";

// A plugin's session environment changed since a running thread's Claude started
// (Thread.plugin_env_stale; docs/notes/plugins-env-restart.md): the thread info card's
// project row is marked and its hover card says what changed, and the title menu offers
// Restart Claude (thread.restart), which asks only when it would interrupt a turn
// (docs/notes/thread-header-crumb.md). The mock's POST /__mock/thread/envstale is the
// daemon's staleness check.

test.beforeEach(async () => {
  await resetMock();
});

const stale = (id: string, change: string) => mockPost(`thread/envstale?id=${id}&change=${encodeURIComponent(change)}`);
const titleMenu = async (page: Page) => {
  await page.getByTestId("thread-header").getByTestId("thread-title").click();
  return page.getByTestId("thread-title-menu");
};

test("an idle stale thread: the card's project row says so; Restart Claude restarts at once and the note goes", async ({ page }) => {
  await openApp(page);
  await mockPost("thread/status?id=s-1&status=idle");
  await row(page, "s:s-1").click();
  await page.getByTestId("thread-info-toggle").click();
  const project = page.getByTestId("thread-info-card").getByTestId("ti-project");
  await expect(project.getByTestId("ti-project-mark")).toHaveCount(0);
  let menu = await titleMenu(page);
  await expect(menu.getByTestId("menu-restart")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await stale("s-1", "Hello removed CF_HELLO");
  await expect(project.getByTestId("ti-project-mark")).toBeVisible();
  await project.hover();
  const notes = page.getByTestId("ti-project-notes");
  await expect(notes.getByTestId("ti-project-env-stale")).toHaveText(
    /^Plugin environment changed\s*Hello removed CF_HELLO\.\s*Claude is still running with the old environment\. Restart Claude restarts the Claude process with the new one; the conversation continues\.$/,
  );
  await page.mouse.move(0, 0);

  menu = await titleMenu(page);
  await menu.getByTestId("menu-restart").click();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(project.getByTestId("ti-project-mark")).toHaveCount(0);
  await expect(page.getByTestId("thread-pane").getByText("Restarted Claude")).toBeVisible();
  const calls = (await invocations()).filter((i) => i.name === "thread.restart");
  expect(calls.map((i) => [i.context?.activeThreadId, i.confirmed ?? false])).toEqual([["s-1", false]]);
});

test("restarting a working thread asks first: the conversation continues, the turn is interrupted", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await stale("s-1", "GitHub Actions added 2 variables");

  let menu = await titleMenu(page);
  await menu.getByTestId("menu-restart").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Restart Claude for Refactor sidebar tree? The conversation continues; the current turn is interrupted.");
  await expect(page.getByTestId("confirm-ok")).toHaveText("Restart Claude");
  await page.getByTestId("confirm-cancel").click();

  menu = await titleMenu(page);
  await menu.getByTestId("menu-restart").click();
  await page.getByTestId("confirm-ok").click();
  menu = await titleMenu(page);
  await expect(menu.getByTestId("menu-pin")).toBeVisible();
  await expect(menu.getByTestId("menu-restart")).toHaveCount(0);
  const confirmed = (await invocations()).filter((i) => i.name === "thread.restart");
  expect(confirmed.map((i) => i.confirmed ?? false)).toEqual([false, false, true]);
});
