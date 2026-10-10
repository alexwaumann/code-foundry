import { expect, test } from "@playwright/test";
import { CF, emit, expectTerminalText, invocations, openApp, openProjects, resetMock, row, selectWorktree, writes } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

test("sidebar lists threads, then terminals no thread owns; repos and worktrees are on the Projects page", async ({ page }) => {
  await openApp(page);
  const list = page.getByTestId("thread-list");
  const keys = await list.locator("[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));
  // Sessions own t-claude and t-ghostty, so those terminals have no rows of their own.
  expect(keys).toEqual(["h:attention", "s:s-2", "h:threads", "s:s-5", "s:s-1", "s:s-6", "s:s-4", "s:s-3", "h:terminals", "t:t-logs", "t:t-top", "t:t-tests", "t:t-tmp"]);
  await expect(list.locator('[data-row-kind="repo"], [data-row-kind="worktree"]')).toHaveCount(0);
  await openProjects(page);
  await expect(page.getByTestId("project-name")).toHaveText(["code-foundry", "dotfiles", "ghostty-playground", "sketches"]);
  await expect(page.locator('[data-testid="project"][data-repo="repo-cf"]').getByTestId("worktree-branch")).toHaveText(["main", "feat/sidebar", "fix/resize"]);
  await expect(page.getByTestId("daemon-status")).toContainText("mock");
});

test("selecting a session attaches its terminal and shows the snapshot", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  const host = page.getByTestId("terminal-host");
  await expect(host).toHaveAttribute("data-terminal-id", "t-claude");
  await expect(host).toHaveAttribute("data-attach-phase", "live");
  await expectTerminalText(page, "Welcome to Claude Code!");

  // Switching aborts the old stream and resets before the new snapshot.
  await row(page, "t:t-tests").click();
  await expect(host).toHaveAttribute("data-terminal-id", "t-tests");
  await expectTerminalText(page, "TestResizeAppliesToPTY");
  await expect(page.getByTestId("exit-overlay")).toContainText("code 1");
  const text = await page.evaluate(() => (window as unknown as { __cfTerminal: { renderer: { getText(): string } } }).__cfTerminal.renderer.getText());
  expect(text).not.toContain("Welcome to Claude Code!");
});

test("keystrokes are written to the attached terminal in order", async ({ page }) => {
  await openApp(page);
  await row(page, "t:t-tmp").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await page.keyboard.type("echo hi");
  await page.keyboard.press("Enter");
  await expectTerminalText(page, "command not found: echo");
  const sent = (await writes()).filter((w) => w.id === "t-tmp").map((w) => w.data).join("");
  expect(sent).toBe("echo hi\r");
});

test("palette opens with cmd+k and lists only commands available in context", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await expect(palette.locator('[data-command="terminal.new"]')).toBeVisible();
  await expect(palette.locator('[data-command="terminal.kill"]')).toHaveCount(0);
  // session.new is unavailable with nothing selected, but its project picker supplies the repo.
  await expect(palette.locator('[data-command="session.new"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // With a running session's terminal focused, cmd+shift+p still reaches the app (global chord).
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await page.keyboard.press("Meta+Shift+p");
  await expect(palette.locator('[data-command="terminal.kill"]')).toBeVisible();
  await expect(palette.locator('[data-command="session.new"]')).toBeVisible();
  await expect(palette.locator('[data-command="terminal.remove"]')).toHaveCount(0);
  // Keybindings are shown.
  await expect(palette.locator('[data-command="session.new"]')).toContainText("⌘N");
});

test("invoking a command sends the current context", async ({ page }) => {
  await openApp(page);
  await row(page, "t:t-logs").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("kill term");
  await page.keyboard.press("Enter");
  // terminal.kill requires confirmation; the confirm button has focus.
  await expect(page.getByTestId("confirm-dialog")).toContainText("Kill terminal t-logs?");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("exit-overlay")).toContainText("code 129");
  const last = (await invocations()).at(-1);
  expect(last?.name).toBe("terminal.kill");
  expect(last?.context).toEqual({
    activeTerminalId: "t-logs",
    activeSessionId: "",
    activeRepoId: "repo-cf",
    activeWorktreePath: CF,
    activeView: "terminal",
    activeWorkspaceId: "",
  });

  // A session contributes its id, terminal and worktree.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-terminal-id", "t-claude");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("daemon status");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("daemon.status");
  expect((await invocations()).at(-1)?.context).toEqual({
    activeTerminalId: "t-claude",
    activeSessionId: "s-1",
    activeRepoId: "repo-cf",
    activeWorktreePath: CF,
    activeView: "session",
    activeWorkspaceId: "",
  });
});

test("required args are prompted inline before invoking", async ({ page }) => {
  await openApp(page);
  await selectWorktree(page, "repo-cf", `${CF}.worktrees/feat-sidebar`);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("create worktree");
  await page.keyboard.press("Enter");
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "args");
  await page.keyboard.type("feat/palette");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  const last = (await invocations()).at(-1);
  expect(last?.name).toBe("worktree.create");
  expect(last?.args).toEqual({ branch: "feat/palette" });
  expect(last?.context?.activeWorktreePath).toBe(`${CF}.worktrees/feat-sidebar`);
  // The command emits FocusRepo for the new worktree, created under ~/.code-foundry/worktrees/<owner>/<repo>: its overview shows.
  await expect(page.getByTestId("overview-title")).toHaveText("code-foundry@feat/palette");

  // Enum args list their values, the default highlighted.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("test notification");
  await page.keyboard.press("Enter");
  await expect(palette.getByRole("option", { name: /^info/ })).toBeVisible();
  await palette.getByRole("option", { name: /^warning/ }).click();
  await expect(palette).toHaveCount(0);
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("ui.notify");
  expect((await invocations()).at(-1)?.args).toEqual({ level: "warning" });
});

test("FocusTerminal intent switches the selection", async ({ page }) => {
  await openApp(page);
  await expect.poll(() => emit({ focusTerminal: { terminalId: "t-top" } })).toBeGreaterThan(0);
  await expect(row(page, "t:t-top")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-terminal-id", "t-top");
  await expectTerminalText(page, "PID USER");
});

test("OpenPalette and Notify intents", async ({ page }) => {
  await openApp(page);
  await expect.poll(() => emit({ notify: { level: "LEVEL_WARNING", title: "Disk almost full", body: "3% left" } })).toBeGreaterThan(0);
  await expect(page.getByText("Disk almost full")).toBeVisible();
  await emit({ openPalette: { query: "refresh" } });
  await expect(page.getByRole("combobox")).toHaveValue("refresh");
  await expect(page.getByTestId("palette").locator('[data-command="repo.refresh"]')).toBeVisible();
});

test("sidebar is keyboard navigable", async ({ page }) => {
  await openApp(page);
  const list = page.getByTestId("thread-list");
  await list.focus();
  await page.keyboard.press("Home"); // s-2 (needs attention, on top)
  await page.keyboard.press("ArrowDown"); // s-5 (headers are skipped)
  await page.keyboard.press("ArrowDown"); // s-1
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-terminal-id", "t-claude");
  await list.focus();
  await page.keyboard.press("End");
  await expect(list).toHaveAttribute("aria-activedescendant", "row-t:t-tmp");
  // cmd+N jumps to the Nth thread or terminal in sidebar order: s-2, s-5, s-1, s-6, s-4, s-3, t-logs, t-top, …
  await page.keyboard.press("Meta+7");
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-terminal-id", "t-logs");
  await page.keyboard.press("Meta+8");
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-terminal-id", "t-top");
});

test("WebGL context loss falls back to the DOM renderer", async ({ page, browserName }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  const host = page.getByTestId("terminal-host");
  await expect(host).toHaveAttribute("data-attach-phase", "live");
  const kind = await host.getAttribute("data-renderer");
  test.info().annotations.push({ type: "renderer", description: `${browserName}: ${kind ?? "?"}` });
  if (kind === "webgl") {
    const lost = await page.evaluate(() => {
      // The WebGL canvas; .xterm-link-layer is a 2D canvas.
      const canvas = document.querySelector<HTMLCanvasElement>("[data-terminal-host] .xterm-screen canvas:not(.xterm-link-layer)");
      const gl = canvas?.getContext("webgl2");
      const ext = gl?.getExtension("WEBGL_lose_context");
      ext?.loseContext();
      return Boolean(ext);
    });
    expect(lost).toBe(true);
    await expect(host).toHaveAttribute("data-renderer", "dom");
  }
  // The DOM renderer draws text into .xterm-rows.
  await expect(host.locator(".xterm-rows")).toContainText("Welcome to Claude Code!");
});
