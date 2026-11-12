/**
 * What the shell window's terminal keys and controls run (docs/notes/shell-model.md, "Terminals"
 * and the key table): each is a command (terminal.new, terminal.new-free, terminal.quick,
 * terminal.cycle, terminal.reset, terminal.rerun, tab.rename), invoked quietly with the window's
 * context; the window then moves the keyboard to where the command put the focus.
 * See docs/notes/shell-13-terminals.md.
 */
import { create } from "zustand";
import { terminalIdFromResult } from "@/api/terminal";
import { getUiContext } from "@/stores/context";
import { runCommandForResult } from "@/stores/commands";
import { applyLayout, useLayoutStore, type TabEntry } from "@/stores/layout";
import { focusedTab } from "@/stores/selectionBridge";
import { requestPaneFocus } from "@/stores/shellView";
import { useUiStore } from "@/stores/ui";
import { afterRev, layoutResultOf, runLayoutCommand } from "./commands";
import { focusQuick, quickHasFocus, quickKeyAction } from "./quickTerminal";

/** The tab whose name is being edited in its strip; "" for none. */
export const useTabRenameStore = create<{ tabId: string }>()(() => ({ tabId: "" }));

export function beginTabRename(tabId: string): void {
  useTabRenameStore.setState({ tabId });
}

export function endTabRename(): void {
  useTabRenameStore.setState({ tabId: "" });
}

/** The terminal id a terminal tab shows. */
export function terminalOfTab(tab: Pick<TabEntry, "params">): string {
  return tab.params.terminal ?? "";
}

/** Resolves the tab that shows terminal `id` once the layout has it (or null after `timeoutMs`). */
function whenTerminalTab(id: string, timeoutMs = 3000): Promise<TabEntry | null> {
  const find = () => Object.values(useLayoutStore.getState().tabs).find((t) => t.kind === "terminal" && terminalOfTab(t) === id) ?? null;
  const now = find();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = (t: TabEntry | null) => {
      clearTimeout(timer);
      unsub();
      resolve(t);
    };
    const timer = setTimeout(() => {
      done(null);
    }, timeoutMs);
    const unsub = useLayoutStore.subscribe(() => {
      const t = find();
      if (t) done(t);
    });
  });
}

/** After a command started terminal `id` with the user's focus on its new tab, the keyboard goes into it. */
async function intoNewTerminal(resultJson: string | undefined): Promise<void> {
  const id = terminalIdFromResult(resultJson ?? "");
  if (!id) return;
  const tab = await whenTerminalTab(id);
  if (tab) requestPaneFocus(tab.paneId);
}

/** The thread of the focused tab (a thread's tab or a surface linked to it); "" for none. */
function currentThread(): string {
  return focusedTab(useLayoutStore.getState())?.thread ?? "";
}

/**
 * cmd+t: a new terminal tab linked to the current thread, placed by the rules. With no thread a
 * shell of the page's checkout (the Projects page), else one in the home directory.
 */
export async function newTerminalTab(): Promise<void> {
  const thread = currentThread();
  const ctx = thread ? getUiContext({ kind: "thread", id: thread }) : getUiContext();
  const verb = ctx.activeThreadId || ctx.activeWorktreePath ? "terminal.new" : "terminal.new-free";
  const res = await runCommandForResult(verb, {}, { ctx, quiet: true });
  await intoNewTerminal(res?.resultJson);
}

/** cmd+shift+t: a terminal tab linked to nothing, in the home directory. */
export async function newFreeTerminalTab(): Promise<void> {
  const res = await runCommandForResult("terminal.new-free", {}, { quiet: true });
  await intoNewTerminal(res?.resultJson);
}

/** A code block's "Run in terminal": a new terminal tab of the thread, linked to it, runs the command. */
export async function runInLinkedTerminal(threadId: string, command: string): Promise<void> {
  const res = await runCommandForResult("terminal.new", { run: command }, { ctx: getUiContext({ kind: "thread", id: threadId }), quiet: true });
  await intoNewTerminal(res?.resultJson);
}

/** Runs terminal.quick and answers the rev its layout commit got (0 when it failed). */
async function quickCommand(args: Record<string, string>): Promise<number> {
  const res = await runCommandForResult("terminal.quick", args, { quiet: true });
  return res ? (layoutResultOf(res.resultJson)?.rev ?? 0) : 0;
}

/** cmd+j (the three states and the linked surface: quickKeyAction). */
export async function quickKey(): Promise<void> {
  const s = useLayoutStore.getState();
  const tab = focusedTab(s);
  const thread = tab?.thread ?? "";
  const open = s.threads[thread]?.quick?.open === true;
  switch (quickKeyAction(tab, open, thread ? quickHasFocus(thread) : false)) {
    case "none":
      return;
    case "focus":
      focusQuick(thread);
      return;
    case "open":
    case "goto": {
      // Asked first: the terminal mounts once the commit arrives, and takes the keyboard then.
      focusQuick(thread);
      await afterRev(await quickCommand({ id: thread, open: "true", focus: "true" }));
      return;
    }
    case "close": {
      const rev = await quickCommand({ id: thread, close: "true" });
      await afterRev(rev);
      if (tab) requestPaneFocus(tab.paneId);
      return;
    }
  }
}

/** The quick terminal's ×. */
export async function closeQuick(threadId: string): Promise<void> {
  const rev = await quickCommand({ id: threadId, close: "true" });
  await afterRev(rev);
  const s = useLayoutStore.getState();
  const tab = Object.values(s.tabs).find((t) => t.kind === "thread" && t.thread === threadId);
  if (tab && s.spaces[s.currentSpaceId]?.focus === tab.paneId) requestPaneFocus(tab.paneId);
}

/** The quick terminal's height drag, once dropped (layout px). */
export async function setQuickHeight(threadId: string, height: number): Promise<void> {
  await afterRev(await quickCommand({ id: threadId, height: String(Math.round(height)) }));
}

/** cmd+shift+j: the ring of the focused tab's thread (the thread, each terminal tab, the thread). */
export async function cycleTerminals(): Promise<void> {
  const tab = focusedTab(useLayoutStore.getState());
  if (!tab?.thread) return;
  const res = await runLayoutCommand("terminal.cycle", { tab: tab.id, focus: "true" });
  if (!res?.changed) return;
  await afterRev(res.rev);
  const s = useLayoutStore.getState();
  const pane = s.spaces[s.currentSpaceId]?.focus;
  if (pane) requestPaneFocus(pane);
}

/** cmd+r: the focused tab's name, where it can be renamed (a terminal's in its strip, a thread's as today). */
export function renameFocusedTab(): void {
  const tab = focusedTab(useLayoutStore.getState());
  if (tab?.kind === "terminal") beginTabRename(tab.id);
  else if (tab?.kind === "thread") {
    const ui = useUiStore.getState();
    if (!ui.sidebarVisible) ui.toggleSidebar();
    ui.setRenaming(tab.thread);
  }
}

/** cmd+shift+r: the automatic name again (a thread's is generated again; a terminal goes back to what runs in it). */
export function autoNameFocusedTab(): void {
  const tab = focusedTab(useLayoutStore.getState());
  if (tab?.kind === "terminal") void autoNameTab(tab.id);
  else if (tab?.kind === "thread") void runCommandForResult("thread.regenerate-name", { id: tab.thread }, { quiet: true });
}

/** A tab's manual name; "" goes back to the automatic one. */
export function renameTab(tabId: string, name: string): Promise<unknown> {
  return runLayoutCommand("tab.rename", { tab: tabId, name: name.trim() });
}

export function autoNameTab(tabId: string): Promise<unknown> {
  return runLayoutCommand("tab.rename", { tab: tabId, auto: "true" });
}

/** The context a command acting on terminal `id` runs with (its `When` reads the active terminal). */
function terminalCtx(id: string) {
  return { ...getUiContext(), activeTerminalId: id };
}

/** Reset: a fresh shell in the thread's directory under the same tab (or quick slot). */
export async function resetTerminal(id: string): Promise<void> {
  await runCommandForResult("terminal.reset", { id }, { ctx: terminalCtx(id), quiet: true });
}

/**
 * "Run again" on a terminal restored after a snooze: its new shell types the command the old
 * one ran, then the tab forgets it (the `ran` param), so the line goes.
 */
export async function runAgain(tab: Pick<TabEntry, "id" | "params">, command: string): Promise<void> {
  const id = terminalOfTab(tab);
  const res = await runCommandForResult("terminal.rerun", { id, command }, { ctx: terminalCtx(id), quiet: true });
  if (res) await forgetRan(tab);
}

/** Drops a restored tab's "Run again" line without running it. */
export async function forgetRan(tab: Pick<TabEntry, "id" | "params">): Promise<void> {
  const { ran: _ran, ...params } = tab.params;
  try {
    await applyLayout({ op: "set_tab_params", tab: tab.id, params });
  } catch {
    // The tab went meanwhile: nothing to forget.
  }
}
