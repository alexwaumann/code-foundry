import { expect, test } from "@playwright/test";
import { CF, DEFAULT_ORDER, emit, expectTerminalText, invocations, mockPost, openApp, openProjects, openStreams, resetMock, row, writes } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

test("sidebar lists threads only; repos and worktrees are on the Projects page, shells in bottom panels", async ({ page }) => {
  await openApp(page);
  const list = page.getByTestId("thread-list");
  // The waiting thread, the idle ones, then the working ones under Working. No terminal rows:
  // shells (t-top, t-s1-shell) show in their owner's bottom panel.
  await expect.poll(() => list.locator("[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")))).toEqual(DEFAULT_ORDER);
  await expect(list.locator('[data-row-kind]:not([data-row-kind="session"]):not([data-row-kind="header"])')).toHaveCount(0);
  await expect.poll(() => list.locator('[data-row-kind="header"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-section")))).toEqual(["working", "snoozed", "archived"]);
  await openProjects(page);
  await expect(page.getByTestId("project-name")).toHaveText(["code-foundry", "dotfiles", "ghostty-playground", "sketches", "writing"]);
  await expect(page.locator('[data-testid="project"][data-repo="repo-cf"]').getByTestId("worktree-branch")).toHaveText(["main", "feat/sidebar", "fix/resize"]);
  await expect(page.getByTestId("daemon-status")).toContainText("mock");
});

test("selecting a thread shows its conversation; switching watches the other one instead", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  const pane = page.getByTestId("thread-pane");
  await expect(pane).toHaveAttribute("data-session-id", "s-1");
  await expect(pane.getByTestId("thread-user").first()).toContainText("Refactor the sidebar tree into a virtualized list.");
  // The prompt takes the keyboard.
  await expect(pane.getByTestId("thread-composer").getByTestId("composer-input")).toBeFocused();

  // Switching closes the old Watch and shows the new snapshot only.
  await row(page, "s:s-2").click();
  await expect(pane).toHaveAttribute("data-session-id", "s-2");
  await expect(pane.getByTestId("thread-user").first()).toContainText("Port the grid renderer to libghostty-vt.");
  await expect(pane).not.toContainText("Refactor the sidebar tree");
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(1);
});

test("keystrokes are written to the attached terminal in order", async ({ page }) => {
  await openApp(page);
  // s-1's shell, in its bottom panel (cmd+j shows it with the keyboard in the shell).
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+j");
  await expect(page.getByTestId("bottom-terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await page.keyboard.type("echo hi");
  await page.keyboard.press("Enter");
  await expectTerminalText(page, "command not found: echo");
  const sent = (await writes()).filter((w) => w.id === "t-s1-shell").map((w) => w.data).join("");
  expect(sent).toBe("echo hi\r");
});

test("a shell that exits shows the exit overlay until the reaper removes it", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+j");
  const host = page.getByTestId("bottom-terminal-host");
  await expect(host).toHaveAttribute("data-attach-phase", "live");
  // Exited but not reaped yet (keep=1): the overlay says how, the tab is struck through.
  await mockPost("terminal/exit?id=t-s1-shell&code=1&keep=1");
  await expect(page.getByTestId("bottom-panel").getByTestId("exit-overlay")).toContainText("Process exited with code 1");
  await expect(page.locator('[data-tab-id="t-s1-shell"]')).toHaveAttribute("data-exited", "true");
});

test("palette opens with cmd+k and lists only commands available in context", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  // session.new is unavailable with nothing selected, but its project picker supplies the repo.
  await expect(palette.locator('[data-command="thread.new"]')).toBeVisible();
  // A terminal belongs to a thread or a worktree: the dashboard offers none.
  await expect(palette.locator('[data-command="terminal.new"]')).toHaveCount(0);
  await expect(palette.locator('[data-command="terminal.kill"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // With a thread's shell focused, cmd+shift+p still reaches the app (global chord).
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+j");
  await expect(page.getByTestId("bottom-terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await page.keyboard.press("Meta+Shift+p");
  await expect(palette.locator('[data-command="terminal.kill"]')).toBeVisible();
  await expect(palette.locator('[data-command="thread.new"]')).toBeVisible();
  await expect(palette.locator('[data-command="terminal.remove"]')).toHaveCount(0);
  // Keybindings are shown.
  await expect(palette.locator('[data-command="thread.new"]')).toContainText("⌘N");
});

test("invoking a command sends the current context", async ({ page }) => {
  await openApp(page);
  // The keyboard in a thread's bottom panel shell: the shell is the active terminal.
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+j");
  await expect(page.getByTestId("bottom-terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("kill term");
  await page.keyboard.press("Enter");
  // terminal.kill requires confirmation; the confirm button has focus.
  await expect(page.getByTestId("confirm-dialog")).toContainText("Kill terminal t-s1-shell?");
  await page.keyboard.press("Enter");
  // A shell that exits is removed: its tab goes, and as the last one, the panel with it.
  await expect(page.getByTestId("bottom-panel")).toHaveCount(0);
  const last = (await invocations()).at(-1);
  expect(last?.name).toBe("terminal.kill");
  expect(last?.context).toEqual({
    activeTerminalId: "t-s1-shell",
    activeThreadId: "s-1",
    activeRepoId: "repo-cf",
    activeWorktreePath: CF,
    activeView: "session",
    activeWorkspaceId: "",
  });

  // The thread itself (the keyboard in its prompt): its id and worktree, no terminal.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-composer").getByTestId("composer-input")).toBeFocused();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("daemon status");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("daemon.status");
  expect((await invocations()).at(-1)?.context).toEqual({
    activeTerminalId: "",
    activeThreadId: "s-1",
    activeRepoId: "repo-cf",
    activeWorktreePath: CF,
    activeView: "session",
    activeWorkspaceId: "",
  });
});

test("required args are prompted inline before invoking", async ({ page }) => {
  await openApp(page);
  // A thread on feat/sidebar: worktree.create takes its repo from the selection.
  await row(page, "s:s-4").click();
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
  // The command emits FocusRepo for the new worktree, created under ~/.code-foundry/worktrees/<owner>/<repo>:
  // the Projects page shows it in its side panel.
  await expect(page.getByTestId("projects-page")).toBeVisible();
  await expect(page.getByTestId("worktree-surface-title")).toHaveText("code-foundry@feat/palette");

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

test("FocusTerminal intent: a shell shows in its owner's bottom panel; an unknown id says so", async ({ page }) => {
  await openApp(page);
  // A worktree's shell: the Projects page, with the shell active in its bottom panel.
  await expect.poll(() => emit({ focusTerminal: { terminalId: "t-top" } })).toBeGreaterThan(0);
  await expect(page.getByTestId("projects-page")).toBeVisible();
  await expect(page.getByTestId("bottom-terminal-host")).toHaveAttribute("data-terminal-id", "t-top");
  await expectTerminalText(page, "PID USER");
  // A thread's shell: the thread, with the shell in its bottom panel and the keyboard there.
  await emit({ focusTerminal: { terminalId: "t-s1-shell" } });
  await expect(row(page, "s:s-1")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("bottom-terminal-host")).toHaveAttribute("data-terminal-id", "t-s1-shell");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region"))).toBe("bottom");
  // A terminal that never shows up: nothing moves, and a toast says so once the wait ends.
  await emit({ focusTerminal: { terminalId: "t-nowhere" } });
  await expect(page.getByText("Terminal t-nowhere not found")).toBeVisible({ timeout: 12_000 });
  await expect(row(page, "s:s-1")).toHaveAttribute("aria-selected", "true");
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
  for (const want of ["s-6", "s-4", "s-3", "s-5", "s-1"]) {
    // The Working header between s-3 and s-5 is skipped.
    await page.keyboard.press("ArrowDown");
    await expect(list).toHaveAttribute("aria-activedescendant", `row-s:${want}`);
  }
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-session-id", "s-1");
  await list.focus();
  await page.keyboard.press("End");
  await expect(list).toHaveAttribute("aria-activedescendant", "row-s:s-1");
  // cmd+N jumps to the Nth thread in sidebar order: s-2, s-6, s-4, s-3, s-5, s-1.
  await page.keyboard.press("Meta+1");
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-session-id", "s-2");
  await page.keyboard.press("Meta+3");
  await expect(row(page, "s:s-4")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("thread-composer")).toBeVisible();
  // Past the last thread: nothing changes.
  await page.keyboard.press("Meta+9");
  await expect(row(page, "s:s-4")).toHaveAttribute("aria-selected", "true");
});

test("WebGL context loss falls back to the DOM renderer", async ({ page, browserName }) => {
  await openApp(page);
  // The bottom panel's shell: the only terminal host.
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+j");
  const host = page.getByTestId("bottom-terminal-host");
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
  await expect(host.locator(".xterm-rows")).toContainText("Last login");
});
