import { expect, test } from "@playwright/test";
import { freshCopyByDefault, invocations, openApp, resetMock, row } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

test("sidebar new-thread button opens the project picker, then the composer", async ({ page }) => {
  await freshCopyByDefault();
  await openApp(page);
  const button = page.getByTestId("sidebar-new-thread");
  // Nothing selected: the picker supplies the project, so the button is enabled anyway.
  await expect(button).toBeEnabled();
  // A thread in ghostty-playground (s-2) is selected.
  await row(page, "s:s-2").click();
  await button.click();

  // The selected thread's project is highlighted first; Enter picks it.
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  await expect(palette.locator('[data-project="repo-gp"]')).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in ghostty-playground?");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.keyboard.type("Port the renderer");
  await page.keyboard.press("Enter");

  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("thread.new");
  const last = (await invocations()).at(-1);
  expect(last?.args).toMatchObject({ project: "repo-gp", "new-worktree": "true", prompt: "Port the renderer" });
  expect(last?.context).toMatchObject({ activeProjectId: "repo-gp", activeWorktreePath: "", activeView: "compose" });
  const created = page.locator('[data-row-kind="thread"][aria-selected="true"]');
  await expect(created).toBeVisible();
  expect(await created.getAttribute("data-row-key")).toMatch(/^s:s-new-/);
  await expect(page.getByTestId("thread-pane")).toBeVisible();
});

test("status row buttons toggle settings, open help and the palette; so does the welcome panel's palette button", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("welcome-actions").getByRole("button", { name: "Command palette" }).click();
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);

  const status = page.getByTestId("sidebar-status");
  await expect(status.getByTestId("daemon-status")).toBeVisible();

  const settings = status.getByTestId("status-settings");
  await expect(settings).toHaveAttribute("aria-pressed", "false");
  await settings.click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(settings).toHaveAttribute("aria-pressed", "true");
  // A toggle, like usage: the button closes the page it opened.
  await settings.click();
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await expect(settings).toHaveAttribute("aria-pressed", "false");
  await settings.click();
  await expect(page.getByTestId("settings-page")).toBeVisible();

  await status.getByTestId("status-help").click();
  await expect(page.getByTestId("help-overlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help-overlay")).toHaveCount(0);

  await status.getByTestId("status-palette").click();
  await expect(page.getByTestId("palette")).toBeVisible();
  // Presented locally, like cmd+k: no round trip through the daemon.
  expect((await invocations()).some((i) => i.name === "ui.palette.open")).toBe(false);
});

test("thread pane header: the name renames, the location opens the worktree; no Close; fork is palette-only", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  const header = page.getByTestId("thread-header");
  await expect(header.getByTestId("thread-title")).toHaveText("Refactor sidebar tree");
  // 44px, like every pane header (window/PaneHeader; layout.spec.ts).
  expect((await header.boundingBox())?.height).toBe(44);
  // The thread's commands only: no Kill Terminal (a thread has no terminal).
  await expect(header.getByRole("button", { name: "Kill Terminal" })).toHaveCount(0);
  // No rename (the name is the button) or fork buttons.
  await expect(header.getByRole("button", { name: "Rename Thread" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Fork Thread" })).toHaveCount(0);

  // A click on the name: rename, presented inline in the sidebar, as from the palette.
  await header.getByTestId("thread-title").click();
  await expect(page.getByTestId("rename-input")).toBeFocused();
  await page.keyboard.press("Escape");

  // A click on project @ branch: the Worktree surface in the side panel (view.panel.worktree).
  await expect(header.getByTestId("thread-location")).toHaveText("code-foundry@main");
  await header.getByTestId("thread-location").click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "worktree");
  await page.keyboard.press("Meta+w");
  await expect(page.getByTestId("side-panel")).toHaveCount(0);

  // Fork stays in the palette.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Fork Thread");
  await page.getByTestId("palette").locator('[data-command="thread.fork"]').click();
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("thread.fork");
  expect((await invocations()).at(-1)?.context?.activeThreadId).toBe("s-1");
  const fork = page.locator('[data-row-kind="thread"][aria-selected="true"]');
  await expect(fork).toHaveAttribute("data-row-key", /^s:s-new-/);

  // No Close: the daemon starts and stops Claude itself (docs/notes/hide-connection-state.md).
  await row(page, "s:s-1").click();
  await expect(header.getByRole("button", { name: "Close Thread" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Reconnect Thread" })).toHaveCount(0);
});
