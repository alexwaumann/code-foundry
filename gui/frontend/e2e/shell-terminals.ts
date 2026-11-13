import { expect, type Locator, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { mockUrl, openStreams } from "./fixtures";

/**
 * Helpers for the specs that drive terminals in the window shell (docs/notes/shell-model.md,
 * "Terminals"): a terminal tab in a seeded layout, the thread's quick terminal, where the keyboard
 * is, the Attach streams, and a shell or a tab started by someone other than this window.
 */

/** A terminal tab (linked to `thread` when given) showing terminal `terminalId`. */
export const terminalTab = (tab: string, terminalId: string, thread = ""): Record<string, unknown> => ({ id: tab, kind: "terminal", ...(thread ? { thread } : {}), params: { terminal: terminalId } });

/** The host of the terminal tab shown in a pane (the pane mounts only its active tab). */
export const tabHost = (page: Page): Locator => page.getByTestId("shell-terminal-host");
/** The quick terminal's host, under its thread's conversation. */
export const quickHost = (page: Page): Locator => page.getByTestId("quick-terminal-host");
/** Terminal tabs, in strip order. */
export const terminalTabs = (page: Page): Locator => page.locator('[data-testid="shell-tab"][data-kind="terminal"]');

/** TerminalService/Attach streams the mock has open. */
export async function attachStreams(): Promise<number> {
  return (await openStreams())["TerminalService/Attach"] ?? 0;
}

/** Whether the keyboard is in xterm (its helper textarea), in any terminal. */
export function inXterm(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false);
}

/** Whether the keyboard is inside the element with this test id. */
export function keyboardIn(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => document.activeElement?.closest(`[data-testid="${id}"]`) != null, testId);
}

/** Whether the keyboard is in thread `id`'s prompt (its pane's composer). */
export function inPrompt(page: Page, id: string): Promise<boolean> {
  return page.evaluate((t) => document.activeElement?.closest(`[data-testid="thread-pane"][data-thread-id="${t}"] [data-testid="composer-input"]`) != null, id);
}

/** cmd+j from the focused thread's prompt: its quick terminal opens, attached, with the keyboard in it. Its terminal id. */
export async function openQuick(page: Page): Promise<string> {
  await page.keyboard.press("Meta+j");
  await expect(quickHost(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => keyboardIn(page, "quick-terminal-host")).toBe(true);
  return (await quickHost(page).getAttribute("data-terminal-id")) ?? "";
}

/** TerminalService.Create with labels, as the CLI or another window starts a shell: no command, so no tab. Its id. */
export async function createShell(labels: Record<string, string>, cwd: string): Promise<string> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.TerminalService/Create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ argv: ["/bin/zsh"], cwd, labels }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { terminal: { id: string } }).terminal.id;
}

/**
 * Opens a surface's tab without the focus, as the daemon does for a command that is not the user's
 * (a thread's model running `code-foundry terminal new`: internal/command openTerminalTab, Focus
 * false and KeepFocus). LayoutService.Apply open_surface.
 */
export async function openSurfaceUnfocused(tab: { kind: string; thread?: string; params: Record<string, string> }): Promise<void> {
  await applyAsDaemon({ openSurface: { tab: { kind: tab.kind, threadId: tab.thread ?? "", params: tab.params }, focus: false } });
}

/**
 * Closes thread `id`'s quick terminal as the daemon's layout glue does when its shell is gone
 * (internal/daemon/layout.go: a quick terminal removed, and the start sweep after a restart, draw
 * it closed). The mock does not port that glue.
 */
export async function quickGoneAsDaemon(id: string): Promise<void> {
  await applyAsDaemon({ setQuick: { threadId: id, open: false } });
}

/** One LayoutService.Apply op (a LayoutOp as Connect JSON), from no window. */
async function applyAsDaemon(op: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.LayoutService/Apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ op }),
  });
  expect(res.ok, await res.clone().text()).toBe(true);
}

/** The text of the terminal host mounted last (renderer-agnostic: works for WebGL too). */
export function screenText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __cfTerminal?: { renderer: { getText(): string } } }).__cfTerminal?.renderer.getText() ?? "");
}
