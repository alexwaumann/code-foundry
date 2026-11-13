import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, openApp, resetMock, row, threadPrompt, writes } from "./fixtures";
import { openShellApp, paneNode, paneOf, rowNode, seedLayout, threadTab } from "./shell";
import { attachStreams, createShell, inPrompt, inXterm, keyboardIn, openQuick, openSurfaceUnfocused, quickGoneAsDaemon, quickHost, tabHost, terminalTab, terminalTabs } from "./shell-terminals";

/**
 * Terminal tabs and the quick terminal from the keyboard (docs/notes/shell-model.md, "Terminals"
 * and "Keys"; docs/notes/shell-13-terminals.md): where cmd+j, cmd+t, cmd+w, the palette and a
 * shell started elsewhere leave the keyboard, and which terminal holds an Attach stream as tabs
 * and threads change. These were the classic bottom panel's (docs/notes/shell-21-remove-classic.md).
 * What each key runs and with which context, the quick terminal's states, the names and the "+"
 * menu's items are vitest's (shell/terminalActions.test.ts, shell/quickTerminal.test.ts,
 * lib/terminalName.test.ts, components/shell/linkedTabs.test.tsx); xterm in a tab, the streams of
 * hidden terminals and the quick terminal's push and overlay are e2e/shell-terminal.spec.ts's.
 * Mock seeds: t-s1-shell is thread s-1's shell, t-top a shell of the feat/sidebar worktree.
 */

test.beforeEach(async () => {
  await resetMock();
});

const quick = (page: Page) => page.getByTestId("quick-terminal");

/** The last terminal.new the window ran. */
async function lastNew() {
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "terminal.new").length).toBeGreaterThan(0);
  return (await invocations()).filter((i) => i.name === "terminal.new").at(-1);
}

/** The sidebar lists threads only: a shell never gets a row. */
async function noTerminalRows(page: Page): Promise<void> {
  await expect(page.getByTestId("thread-list").locator('[data-row-kind]:not([data-row-kind="thread"]):not([data-row-kind="header"])')).toHaveCount(0);
}

/** Thread `id`'s tab from its row, the keyboard in its prompt. */
async function openThreadTab(page: Page, id: string): Promise<void> {
  await row(page, `s:${id}`).click();
  await expect(page.locator(`[data-testid="thread-pane"][data-thread-id="${id}"]`)).toBeVisible();
  await expect.poll(() => inPrompt(page, id)).toBe(true);
}

test("cmd+j shows and hides a thread's quick terminal, and the keyboard goes in and back to the prompt", async ({ page }) => {
  await openApp(page);
  await openThreadTab(page, "s-1");
  await expect(quick(page)).toHaveCount(0);
  const id = await openQuick(page);

  // cmd+j from the quick terminal hides it and gives the keyboard back to the thread's prompt.
  await page.keyboard.press("Meta+j");
  await expect(quick(page)).toHaveCount(0);
  await expect.poll(() => inPrompt(page, "s-1")).toBe(true);
  // And from there brings the same shell back, focused (closing only hides it).
  await page.keyboard.press("Meta+j");
  await expect(quickHost(page)).toHaveAttribute("data-terminal-id", id);
  await expect.poll(() => keyboardIn(page, "quick-terminal-host")).toBe(true);
  // The keyboard elsewhere, cmd+j only moves it back in.
  await threadPrompt(page).click();
  await page.keyboard.press("Meta+j");
  await expect(quick(page)).toBeVisible();
  await expect.poll(() => keyboardIn(page, "quick-terminal-host")).toBe(true);
  // Its close button hides it too.
  await page.getByTestId("quick-terminal-close").click();
  await expect(quick(page)).toHaveCount(0);
  await expect.poll(attachStreams).toBe(0);
});

test("Toggle Quick Terminal from the palette starts the thread's own, with the keyboard in it; each thread keeps its own", async ({ page }) => {
  await openApp(page);
  await openThreadTab(page, "s-1");
  const s1 = await openQuick(page);
  // s-3 (its tab over s-1's in the pane) has none open: the palette's verb starts its own.
  await openThreadTab(page, "s-3");
  await expect(quick(page)).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Toggle Quick Terminal");
  await page.getByTestId("palette").locator('[data-command="terminal.quick"]').click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(quickHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect(quickHost(page)).not.toHaveAttribute("data-terminal-id", s1);
  await expect.poll(() => keyboardIn(page, "quick-terminal-host")).toBe(true);
  // Back on s-1: its own, still open.
  await openThreadTab(page, "s-1");
  await expect(quickHost(page)).toHaveAttribute("data-terminal-id", s1);
  await expect.poll(attachStreams).toBe(1);
});

test("cmd+t on a thread starts a terminal tab linked to it, beside it, with the keyboard in it; cmd+t and the + menu there add more", async ({ page }) => {
  await openApp(page);
  await openThreadTab(page, "s-3");
  // At once, not after the thread settles: the keyup of cmd+t can reach the new xterm after it took
  // the keyboard, and xterm refocuses itself on a keyup unless told it is an app chord (terminal/xterm.ts).
  await page.keyboard.press("Meta+t");
  await expect(terminalTabs(page)).toHaveCount(1);
  await expect(tabHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => keyboardIn(page, "shell-terminal-host")).toBe(true);
  expect((await lastNew())?.context).toMatchObject({ activeThreadId: "s-3" });
  // Linked to s-3, in a pane beside the thread's, which stays on screen.
  const termPane = page.locator('[data-testid="shell-pane"][data-focused]');
  await expect(termPane.getByTestId("shell-linked-row")).toContainText("Fix resize race");
  await expect(page.locator('[data-testid="thread-pane"][data-thread-id="s-3"]')).toBeVisible();
  await noTerminalRows(page);
  // The new tab is the feedback: no "created terminal" toast.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  const first = (await tabHost(page).getAttribute("data-terminal-id")) ?? "";

  // cmd+t from the terminal (a chord xterm yields): a second tab of s-3, in the same pane, active, focused.
  await page.keyboard.press("Meta+t");
  await expect(termPane.locator('[data-testid="shell-tab"][data-kind="terminal"]')).toHaveCount(2);
  await expect(tabHost(page)).not.toHaveAttribute("data-terminal-id", first);
  await expect(tabHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => keyboardIn(page, "shell-terminal-host")).toBe(true);

  // The pane's "+" ▸ Terminal: a third, linked to nothing, in that pane, focused.
  const second = (await tabHost(page).getAttribute("data-terminal-id")) ?? "";
  await termPane.getByTestId("pane-plus").click();
  await page.getByTestId("pane-plus-menu").locator('[data-item="terminal"]').click();
  await expect(termPane.locator('[data-testid="shell-tab"][data-kind="terminal"]')).toHaveCount(3);
  await expect(tabHost(page)).not.toHaveAttribute("data-terminal-id", second);
  await expect(tabHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect(termPane.getByTestId("shell-linked-row")).toHaveCount(0);
  await expect.poll(() => keyboardIn(page, "shell-terminal-host")).toBe(true);
  // One stream: the shown tab's.
  await expect.poll(attachStreams).toBe(1);
  await noTerminalRows(page);
});

test("cmd+w in a terminal tab closes it and ends its terminal; the keyboard goes back to the thread's prompt", async ({ page }) => {
  await openApp(page);
  await openThreadTab(page, "s-3");
  await page.keyboard.press("Meta+t");
  await expect(tabHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => keyboardIn(page, "shell-terminal-host")).toBe(true);
  const id = (await tabHost(page).getAttribute("data-terminal-id")) ?? "";

  await page.keyboard.press("Meta+w");
  await expect(terminalTabs(page)).toHaveCount(0);
  await expect.poll(() => inPrompt(page, "s-3")).toBe(true);
  await expect.poll(attachStreams).toBe(0);
  // Closing a terminal's tab by itself ends the terminal.
  const known = () => page.evaluate(`__cfModule("/src/stores/terminals.ts").then((m) => ${JSON.stringify(id)} in m.useTerminalsStore.getState().byId)`);
  await expect.poll(known).toBe(false);

  // The × on a tab does the same.
  await page.keyboard.press("Meta+t");
  await expect(terminalTabs(page)).toHaveCount(1);
  const other = (await tabHost(page).getAttribute("data-terminal-id")) ?? "";
  await terminalTabs(page).hover();
  await terminalTabs(page).getByTestId("shell-tab-close").click();
  await expect(terminalTabs(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(`__cfModule("/src/stores/terminals.ts").then((m) => ${JSON.stringify(other)} in m.useTerminalsStore.getState().byId)`)).toBe(false);
});

/** s-1's tab beside a pane holding its shell's tab (t-s1-shell), with the keyboard in the shell. */
async function s1ShellTab(page: Page): Promise<void> {
  await seedLayout(rowNode([paneNode("p-1", [threadTab("s-1")]), paneNode("p-2", [terminalTab("t-sh", "t-s1-shell", "s-1")])], [0.55, 0.45]), "p-2");
  await openShellApp(page);
  await expect(tabHost(page)).toHaveAttribute("data-attach-phase", "live");
  await tabHost(page).locator(".xterm-screen").click();
  await expect.poll(() => inXterm(page)).toBe(true);
}

test("Escape from the palette hands the keyboard back to the terminal tab or the quick terminal it came from", async ({ page }) => {
  await s1ShellTab(page);
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect.poll(() => keyboardIn(page, "shell-terminal-host")).toBe(true);

  await openThreadTab(page, "s-1");
  await openQuick(page);
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboardIn(page, "quick-terminal-host")).toBe(true);
});

test("a terminal tab stays attached under the settings and usage sheets", async ({ page }) => {
  await s1ShellTab(page);
  await expect.poll(attachStreams).toBe(1);
  // The settings sheet is a modal over the window: the tab stays laid out under it, with its stream.
  await page.getByTestId("status-settings").click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(tabHost(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await expect(tabHost(page)).toHaveAttribute("data-attach-phase", "live");
  // So is the Usage sheet.
  await page.getByTestId("status-usage").click();
  await expect(page.getByTestId("usage-page")).toBeVisible();
  await expect(tabHost(page)).toHaveAttribute("data-attach-phase", "live");
  await page.getByTestId("usage-page-close").click();
  await expect(page.getByTestId("usage-page")).toHaveCount(0);
  await expect(tabHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(attachStreams).toBe(1);
});

test("a shell this window did not start does not take the keyboard from the terminal being typed in", async ({ page }) => {
  await s1ShellTab(page);
  await page.keyboard.type("ec");
  // A shell of s-1 its model started (`code-foundry terminal new` from the thread): its tab opens
  // without the focus, in the pane that holds s-1's terminals.
  const other = await createShell({ kind: "shell", thread: "s-1", project: "repo-cf", worktree: CF }, CF);
  await openSurfaceUnfocused({ kind: "terminal", thread: "s-1", params: { terminal: other } });
  await expect(paneOf(page, "p-2").locator('[data-testid="shell-tab"][data-kind="terminal"]')).toHaveCount(2);
  // The tab being typed in stays shown and keeps the keys.
  await expect(tabHost(page)).toHaveAttribute("data-terminal-id", "t-s1-shell");
  expect(await inXterm(page)).toBe(true);
  await page.keyboard.type("ho");
  await expect.poll(async () => (await writes()).filter((w) => w.id === "t-s1-shell").map((w) => w.data).join("")).toBe("echo");
  expect((await writes()).some((w) => w.id === other)).toBe(false);
});

// Smart swap of a pane's terminal tabs (the daemon's internal/layout/swap.go) is not in the mock.
test("switching between two threads with open quick terminals keeps one Attach stream, and the prompt takes the keyboard", async ({ page }) => {
  await openApp(page);
  await openThreadTab(page, "s-1");
  const s1 = await openQuick(page);
  await openThreadTab(page, "s-3");
  const s3 = await openQuick(page);
  await expect.poll(attachStreams).toBe(1);
  // s-1's tab again (the pane's tab, shown over s-3's): its own quick terminal, on the one stream.
  await page.locator('[data-testid="shell-tab"][data-tab-id] [role="tab"]').filter({ hasText: "Refactor sidebar tree" }).click();
  await expect(page.locator('[data-testid="thread-pane"][data-thread-id="s-1"]')).toBeVisible();
  await expect(quickHost(page)).toHaveAttribute("data-terminal-id", s1);
  await expect(quickHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(attachStreams).toBe(1);
  // From the sidebar: the thread's prompt takes the keyboard, its quick terminal still shown.
  await openThreadTab(page, "s-3");
  await expect(quickHost(page)).toHaveAttribute("data-terminal-id", s3);
  await expect(quickHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(attachStreams).toBe(1);
});

test("cmd+j on a thread without a quick terminal starts one with the keyboard in it; after its shell exits, the next cmd+j starts a fresh one", async ({ page }) => {
  await openApp(page);
  await openThreadTab(page, "s-3");
  const first = await openQuick(page);

  // The shell exits (`exit` typed): the daemon draws the quick terminal closed.
  await mockPost(`terminal/exit?id=${first}&code=0`);
  await quickGoneAsDaemon("s-3");
  await expect(quick(page)).toHaveCount(0);

  await threadPrompt(page).click();
  await page.keyboard.press("Meta+j");
  await expect(quickHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect(quickHost(page)).not.toHaveAttribute("data-terminal-id", first);
  await expect.poll(() => keyboardIn(page, "quick-terminal-host")).toBe(true);
});

test("cmd+j on a thread without shells starts one with the keyboard in it; its exit hands the keyboard back; the next cmd+j starts a fresh one", async ({ page }) => {
  await openApp(page);
  await openThreadTab(page, "s-3");
  const first = await openQuick(page);
  await mockPost(`terminal/exit?id=${first}&code=0`);
  await quickGoneAsDaemon("s-3");
  await expect(quick(page)).toHaveCount(0);
  await expect.poll(() => inPrompt(page, "s-3")).toBe(true);
  await page.keyboard.press("Meta+j");
  await expect(quickHost(page)).not.toHaveAttribute("data-terminal-id", first);
  await expect.poll(() => keyboardIn(page, "quick-terminal-host")).toBe(true);
});

test("a daemon restart that pruned the shells leaves the quick terminal closed; cmd+j starts a fresh one", async ({ page }) => {
  await openApp(page);
  await openThreadTab(page, "s-3");
  const first = await openQuick(page);
  await mockPost("daemon/restart");
  // The restarted daemon's start sweep draws a quick terminal without a shell closed.
  await quickGoneAsDaemon("s-3");
  await expect(quick(page)).toHaveCount(0);
  await threadPrompt(page).click();
  await page.keyboard.press("Meta+j");
  await expect(quickHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect(quickHost(page)).not.toHaveAttribute("data-terminal-id", first);
  await expect.poll(() => keyboardIn(page, "quick-terminal-host")).toBe(true);
});

test("cmd+t from a Projects-page shell starts another in its worktree", async ({ page }) => {
  // t-top (the feat/sidebar worktree's shell) in a tab of its own, the keyboard in it.
  await seedLayout(rowNode([paneNode("p-1", [threadTab("s-3")]), paneNode("p-2", [terminalTab("t-top-tab", "t-top")])]), "p-2");
  await openShellApp(page);
  await expect(tabHost(page)).toHaveAttribute("data-terminal-id", "t-top");
  await tabHost(page).locator(".xterm-screen").click();
  await expect.poll(() => inXterm(page)).toBe(true);
  await page.keyboard.press("Meta+t");
  expect((await lastNew())?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: `${CF}.worktrees/feat-sidebar` });
  await expect(paneOf(page, "p-2").locator('[data-testid="shell-tab"][data-kind="terminal"]')).toHaveCount(2);
  await expect(tabHost(page)).not.toHaveAttribute("data-terminal-id", "t-top");
  await expect.poll(() => keyboardIn(page, "shell-terminal-host")).toBe(true);
});
