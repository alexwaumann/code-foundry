import { expect, test } from "@playwright/test";
import { CF, invocations, openApp, resetMock, row } from "./fixtures";

const FIX_RESIZE = `${CF}.worktrees/fix-resize`;
const DOTFILES = "/Users/dev/dotfiles";

test.beforeEach(async () => {
  await resetMock();
});

test("no footer and no chord hints outside the palette and help", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("footer")).toHaveCount(0);
  await expect(page.getByTestId("hints")).toHaveCount(0);
  // The welcome panel and the sidebar name no chords.
  await expect(page.locator("kbd")).toHaveCount(0);
  await expect(page.getByTestId("nav-pullrequests")).toHaveText("Pull Requests");
});

test("sidebar new-thread button opens the project picker, then the composer", async ({ page }) => {
  await openApp(page);
  const button = page.getByTestId("sidebar-new-session");
  // Nothing selected: the picker supplies the repo, so the button is enabled anyway.
  await expect(button).toBeEnabled();
  await row(page, `w:repo-gp::/Users/dev/src/ghostty-playground`).click();
  await button.click();

  // The selected repo is highlighted first; Enter picks it.
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  await expect(palette.locator('[data-project="repo-gp"]')).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in ghostty-playground?");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.keyboard.type("Port the renderer");
  await page.keyboard.press("Enter");

  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.new");
  const last = (await invocations()).at(-1);
  expect(last?.args).toMatchObject({ repo: "repo-gp", "new-worktree": "true", prompt: "Port the renderer" });
  expect(last?.context).toMatchObject({ activeRepoId: "repo-gp", activeWorktreePath: "", activeView: "compose" });
  const created = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(created).toBeVisible();
  expect(await created.getAttribute("data-row-key")).toMatch(/^s:s-new-/);
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
});

test("sidebar new-terminal button starts a terminal in the selected worktree", async ({ page }) => {
  await openApp(page);
  await row(page, `w:repo-cf::${FIX_RESIZE}`).click();
  await page.getByTestId("sidebar-new-terminal").click();
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("terminal.new");
  const last = (await invocations()).at(-1);
  expect(last?.name).toBe("terminal.new");
  expect(last?.context?.activeWorktreePath).toBe(FIX_RESIZE);
  await expect(page.locator('[data-row-kind="terminal"][aria-selected="true"]')).toBeVisible();
});

test("status row buttons open settings, help and the palette", async ({ page }) => {
  await openApp(page);
  const status = page.getByTestId("sidebar-status");
  await expect(status.getByTestId("daemon-status")).toBeVisible();

  await status.getByTestId("status-settings").click();
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

test("session pane header: rename, fork and close buttons run the session commands", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  const header = page.getByTestId("terminal-header");
  await expect(header.getByTestId("terminal-title")).toHaveText("Refactor sidebar tree");
  // 44px, like every pane header (window/PaneHeader; layout.spec.ts).
  expect((await header.boundingBox())?.height).toBe(44);

  // Rename is presented inline in the sidebar, as from the palette.
  await header.getByRole("button", { name: "Rename Thread" }).click();
  await expect(page.getByTestId("rename-input")).toBeFocused();
  await page.keyboard.press("Escape");

  await header.getByRole("button", { name: "Fork Thread" }).click();
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.fork");
  expect((await invocations()).at(-1)?.context?.activeSessionId).toBe("s-1");
  const fork = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(fork).toHaveAttribute("data-row-key", /^s:s-new-/);

  await row(page, "s:s-1").click();
  await header.getByRole("button", { name: "Close Thread" }).click();
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.close");
  expect((await invocations()).at(-1)?.context?.activeSessionId).toBe("s-1");
  // Closing: session.close is no longer available, so its button goes away.
  await expect(header.getByRole("button", { name: "Close Thread" })).toHaveCount(0);
});

test("terminal pane header: kill asks for confirmation", async ({ page }) => {
  await openApp(page);
  await row(page, "t:t-logs").click();
  const header = page.getByTestId("terminal-header");
  await expect(header.getByRole("button", { name: "Rename Thread" })).toHaveCount(0);
  await header.getByRole("button", { name: "Kill Terminal" }).click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
});

test("empty states and the welcome panel offer buttons", async ({ page }) => {
  await openApp(page);
  const welcome = page.getByTestId("welcome-actions");
  await welcome.getByRole("button", { name: "New thread" }).click();
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await welcome.getByRole("button", { name: "Command palette" }).click();
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Escape");

  await row(page, `w:repo-dot::${DOTFILES}`).click();
  await page.getByTestId("empty-new-terminal").click();
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("terminal.new");
  const last = (await invocations()).at(-1);
  expect(last?.name).toBe("terminal.new");
  expect(last?.context?.activeWorktreePath).toBe(DOTFILES);
});
