import { expect, test } from "@playwright/test";
import { CF, emit, expectProjectRevealed, expectTerminalText, invocations, openApp, openStreams, resetMock, row, writes } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

test("selecting a thread shows its conversation; switching watches the other one instead", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  const pane = page.getByTestId("thread-pane");
  await expect(pane).toHaveAttribute("data-thread-id", "s-1");
  await expect(pane.getByTestId("thread-user").first()).toContainText("Refactor the sidebar tree into a virtualized list.");
  // The prompt takes the keyboard.
  await expect(pane.getByTestId("thread-composer").getByTestId("composer-input")).toBeFocused();

  // Switching closes the old Watch and shows the new snapshot only.
  await row(page, "s:s-2").click();
  await expect(pane).toHaveAttribute("data-thread-id", "s-2");
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

// A shell that exits: the exit overlay and the struck-through tab until the reaper removes it:
// src/components/bottom/BottomPanel.test.tsx (on the real TerminalHost, its Attach scripted).

// What the palette lists for its context (thread.new by its picker, terminal ones with a shell, no
// NoPalette verb) and the rows' chords: src/components/palette/CommandPalette.commands.test.tsx.
test("cmd+shift+p reaches the app from a focused shell, and the palette lists for that shell", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+j");
  await expect(page.getByTestId("bottom-terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await page.keyboard.press("Meta+Shift+p");
  await expect(page.getByTestId("palette").locator('[data-command="terminal.kill"]')).toBeVisible();
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
    activeProjectId: "repo-cf",
    activeWorktreePath: CF,
    activeView: "thread",
    activeWorkspaceId: "",
  });

  // The thread itself (the keyboard in its prompt): its id and worktree, no terminal.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-composer").getByTestId("composer-input")).toBeFocused();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("open settings file");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("settings.reveal");
  expect((await invocations()).at(-1)?.context).toEqual({
    activeTerminalId: "",
    activeThreadId: "s-1",
    activeProjectId: "repo-cf",
    activeWorktreePath: CF,
    activeView: "thread",
    activeWorkspaceId: "",
  });
});

// The arg prompt, the args and context sent, and an enum's values: CommandPalette.commands.test.tsx.
test("worktree.create from the palette reveals the new worktree on its project's page", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-4").click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("create worktree");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "args");
  await page.keyboard.type("feat/palette");
  await page.keyboard.press("Enter");
  // The command emits FocusProject for the new worktree, created under ~/.code-foundry/worktrees/<owner>/<repo>:
  // the project's page shows it. No thread is on it yet, so it is in Worktrees without threads, not the table.
  await expectProjectRevealed(page, "code-foundry");
  const made = page.locator('[data-testid="leftover-row"]').filter({ hasText: "feat/palette" });
  await expect(made).toBeInViewport();
  await expect(page.locator('[data-testid="project-worktree"]').filter({ hasText: "feat/palette" })).toHaveCount(0);
});

// An unknown id's expiry toast is src/stores/intents.test.ts (it waits out the pending-focus window).
test("FocusTerminal intent: a shell shows in its owner's bottom panel", async ({ page }) => {
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
});

// The OpenPalette and Notify intents: CommandPalette.commands.test.tsx.

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
