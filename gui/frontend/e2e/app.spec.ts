import { expect, test, type Page } from "@playwright/test";
import { CF, expectProjectRevealed, expectTerminalText, invocations, invokeAs, openApp, openStreams, resetMock, row, threadPrompt, writes } from "./fixtures";
import { openShellApp, paneNode, paneShowing, rowNode, seedLayout, threadTab } from "./shell";
import { inXterm, keyboardIn, openQuick, quickHost, tabHost, terminalTab, terminalTabs } from "./shell-terminals";

test.beforeEach(async () => {
  await resetMock();
});

test("selecting a thread shows its conversation; switching watches the other one instead", async ({ page }) => {
  await openApp(page);
  // A click on a row opens its thread's tab in the focused pane (s-2 waits on the user: its row opens its popup).
  await row(page, "s:s-1").click();
  const pane = page.getByTestId("thread-pane");
  await expect(pane).toHaveAttribute("data-thread-id", "s-1");
  await expect(pane.getByTestId("thread-user").first()).toContainText("Refactor the sidebar tree into a virtualized list.");
  // The prompt takes the keyboard.
  await expect(pane.getByTestId("thread-composer").getByTestId("composer-input")).toBeFocused();

  // The other thread's tab opens in the same pane, over s-1's: only the shown one is watched.
  await row(page, "s:s-3").click();
  await expect(pane).toHaveAttribute("data-thread-id", "s-3");
  await expect(pane.getByTestId("thread-user").first()).toContainText("Fix the resize race in the terminal actor.");
  await expect(pane).not.toContainText("Refactor the sidebar tree");
  await expect(pane.getByTestId("thread-composer").getByTestId("composer-input")).toBeFocused();
  await expect.poll(async () => (await openStreams())["ThreadService/WatchThread"] ?? 0).toBe(1);
});

test("keystrokes are written to the attached terminal in order", async ({ page }) => {
  await openApp(page);
  // s-1's quick terminal (cmd+j opens it with the keyboard in it).
  await row(page, "s:s-1").click();
  await expect(threadPrompt(page)).toBeFocused();
  const id = await openQuick(page);
  await page.keyboard.type("echo hi");
  await page.keyboard.press("Enter");
  await expectTerminalText(page, "command not found: echo");
  const sent = (await writes()).filter((w) => w.id === id).map((w) => w.data).join("");
  expect(sent).toBe("echo hi\r");
});

// A shell that exits: the exit overlay (components/terminal/TerminalHost's); a terminal tab whose
// terminal is gone closes (the daemon's glue, docs/notes/shell-6-lifecycle.md).

/** s-1's tab beside a pane holding its shell's terminal tab (t-s1-shell), with the keyboard in the shell. */
async function s1ShellTab(page: Page): Promise<void> {
  await seedLayout(rowNode([paneNode("p-1", [threadTab("s-1")]), paneNode("p-2", [terminalTab("t-sh", "t-s1-shell", "s-1")])], [0.55, 0.45]), "p-2");
  await openShellApp(page);
  await expect(tabHost(page)).toHaveAttribute("data-attach-phase", "live");
  await tabHost(page).locator(".xterm-screen").click();
  await expect.poll(() => inXterm(page)).toBe(true);
}

// What the palette lists for its context (thread.new by its picker, terminal ones with a shell, no
// NoPalette verb) and the rows' chords: src/components/palette/CommandPalette.commands.test.tsx.
test("cmd+shift+p reaches the app from a focused terminal tab", async ({ page }) => {
  await s1ShellTab(page);
  await page.keyboard.press("Meta+Shift+p");
  await expect(page.getByTestId("palette")).toBeVisible();
  // The chord is the app's: nothing reached the shell.
  expect((await writes()).filter((w) => w.id === "t-s1-shell")).toEqual([]);
});

test("cmd+shift+p reaches the app from a focused shell, and the palette lists for that shell", async ({ page }) => {
  await s1ShellTab(page);
  await page.keyboard.press("Meta+Shift+p");
  await expect(page.getByTestId("palette").locator('[data-command="terminal.kill"]')).toBeVisible();
});

test("invoking a command sends the current context: a thread's", async ({ page }) => {
  await openApp(page);
  // The thread itself (the keyboard in its prompt): its id and worktree, no terminal.
  await row(page, "s:s-1").click();
  await expect(threadPrompt(page)).toBeFocused();
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

test("invoking a command sends the current context", async ({ page }) => {
  // The keyboard in s-1's shell's tab: the shell is the active terminal, the thread its owner.
  await s1ShellTab(page);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("kill term");
  await page.keyboard.press("Enter");
  // terminal.kill requires confirmation; the confirm button has focus.
  await expect(page.getByTestId("confirm-dialog")).toContainText("Kill terminal t-s1-shell?");
  await page.keyboard.press("Enter");
  // A shell that exits is removed: its tab goes.
  await expect(terminalTabs(page)).toHaveCount(0);
  const last = (await invocations()).at(-1);
  expect(last?.name).toBe("terminal.kill");
  expect(last?.context).toMatchObject({ activeTerminalId: "t-s1-shell", activeThreadId: "s-1", activeProjectId: "repo-cf", activeWorktreePath: CF });
});

// The arg prompt, the args and context sent, and an enum's values: CommandPalette.commands.test.tsx.
test("worktree.create from the palette reveals the new worktree on its project's page", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-4").click();
  // The prompt takes the keyboard once the tab draws: a palette opened before that loses it to the prompt.
  await expect(threadPrompt(page)).toBeFocused();
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

// The window ignores the FocusTerminal intent (src/stores/intents.test.ts): ui.focus.terminal's layout commit shows the tab.
test("ui.focus.terminal: a worktree's shell opens as a tab in the focused pane, a thread's beside its thread", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-1");
  // A worktree's shell (no thread): a tab in the focused pane, shown.
  expect((await invokeAs("", "ui.focus.terminal", { id: "t-top" })).ok).toBe(true);
  const top = page.locator('[data-testid="shell-pane"]').filter({ has: page.locator('[data-testid="shell-tab"][data-kind="terminal"][data-active]') });
  await expect(top.getByTestId("shell-terminal-host")).toHaveAttribute("data-terminal-id", "t-top");
  await expect(top.getByTestId("shell-terminal-host")).toHaveAttribute("data-attach-phase", "live");
  await expectTerminalText(page, "PID USER");
  const threadPane = (await paneShowing(page, "terminal").getAttribute("data-pane-id")) ?? "";
  // A thread's shell: linked to it, in a new pane beside the thread's, which takes the focus.
  expect((await invokeAs("", "ui.focus.terminal", { id: "t-s1-shell" })).ok).toBe(true);
  const own = page.locator('[data-testid="shell-pane"][data-focused]');
  await expect(own.locator('[data-testid="shell-tab"][data-kind="terminal"][data-active]')).toHaveCount(1);
  await expect(own.getByTestId("shell-terminal-host")).toHaveAttribute("data-terminal-id", "t-s1-shell");
  await expect(own.getByTestId("shell-linked-row")).toContainText("Refactor sidebar tree");
  expect(await own.getAttribute("data-pane-id")).not.toBe(threadPane);
  await expect(page.getByTestId("shell-pane")).toHaveCount(2);
});

test("FocusTerminal intent: the shell's tab takes the keyboard", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await expect(threadPrompt(page)).toBeFocused();
  expect((await invokeAs("", "ui.focus.terminal", { id: "t-s1-shell" })).ok).toBe(true);
  await expect(tabHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => keyboardIn(page, "shell-terminal-host")).toBe(true);
});

// The OpenPalette and Notify intents: CommandPalette.commands.test.tsx.

test("WebGL context loss falls back to the DOM renderer", async ({ page, browserName }) => {
  await openApp(page);
  // s-1's quick terminal: the only terminal host.
  await row(page, "s:s-1").click();
  await expect(threadPrompt(page)).toBeFocused();
  await openQuick(page);
  const host = quickHost(page);
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
