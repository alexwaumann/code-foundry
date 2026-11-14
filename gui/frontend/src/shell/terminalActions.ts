/**
 * What the shell window's terminal keys and controls run (docs/notes/shell-model.md, "Terminals"
 * and the key table): each is a command (terminal.new, terminal.new-free, terminal.quick,
 * terminal.cycle, terminal.reset, terminal.rerun, tab.rename), invoked quietly with the window's
 * context; the window then moves the keyboard to where the command put the focus.
 * See docs/notes/shell-13-terminals.md.
 */
import { create } from "zustand";
import { toast } from "sonner";
import { isNotFound } from "@/api/errors";
import { errorMessage } from "@/api/stream";
import type { UiContextView } from "@/api/command";
import { terminalIdFromResult } from "@/api/terminal";
import { PROJECT_LABEL, THREAD_LABEL, WORKTREE_LABEL } from "@/lib/termlabel";
import { activeTerminalId, getUiContext, worktreeContext } from "@/stores/context";
import { invokeConfirmed, refreshCommands, runCommandForResult, useCommandsStore } from "@/stores/commands";
import { useTerminalsStore } from "@/stores/terminals";
import { applyLayout, useLayoutStore, type TabEntry } from "@/stores/layout";
import { focusedTab } from "@/stores/selectionBridge";
import { requestPaneFocus, requestPaneFocusOverSheets } from "@/stores/shellView";
import { useUiStore } from "@/stores/ui";
import { afterRev, layoutResultOf, runLayoutCommand } from "./commands";
import { focusQuick, quickHasFocus, quickKeyAction, quickTerminalOf } from "./quickTerminal";

/** The tab whose name is being edited in its strip; "" for none. */
export const useTabRenameStore = create<{ tabId: string }>()(() => ({ tabId: "" }));

export function beginTabRename(tabId: string): void {
  useTabRenameStore.setState({ tabId });
}

export function endTabRename(): void {
  useTabRenameStore.setState({ tabId: "" });
}

/** A rename picked in a tab's context menu, started once the menu has closed (its focus trap would take the field's focus). */
let renameAfterMenu = "";

export function renameAfterMenuCloses(tabId: string): void {
  renameAfterMenu = tabId;
}

/** As the tab's menu closes: starts the rename picked in it, if any (true: the field takes the focus, not the trigger). */
export function takeRenameAfterMenu(tabId: string): boolean {
  if (renameAfterMenu !== tabId) return false;
  renameAfterMenu = "";
  beginTabRename(tabId);
  return true;
}

/** The terminal id a terminal tab shows. */
export function terminalOfTab(tab: Pick<TabEntry, "params">): string {
  return tab.params.terminal ?? "";
}

/**
 * Resolves the tab that shows terminal `id` once the layout shows it: the active tab of its pane,
 * as the command that focused it committed (or null after `timeoutMs`). A tab that was already
 * open but hidden is there before that commit arrives; asked for then, the keyboard went to the
 * tab still showing.
 */
function whenTerminalTab(id: string, timeoutMs = 3000): Promise<TabEntry | null> {
  const find = () => {
    const s = useLayoutStore.getState();
    const t = Object.values(s.tabs).find((x) => x.kind === "terminal" && terminalOfTab(x) === id);
    return t && s.panes[t.paneId]?.active === t.id ? t : null;
  };
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

/**
 * After a command started terminal `id` with the user's focus on its new tab, the keyboard goes
 * into it (an action run, a skill's setup, "New terminal here" too).
 */
export async function intoNewTerminal(resultJson: string | undefined): Promise<void> {
  const id = terminalIdFromResult(resultJson ?? "");
  if (id) await focusTerminalTab(id);
}

/** Moves the keyboard into the tab that shows terminal `id`, once the layout shows it; a sheet over the window closes. */
export async function focusTerminalTab(id: string): Promise<void> {
  const tab = await whenTerminalTab(id);
  if (tab) requestPaneFocusOverSheets(tab.paneId);
}

/**
 * ui.focus.terminal's FocusTerminal intent (the CLI's or this window's call; the daemon has
 * focused its tab or opened the quick terminal under its thread's focused tab): the keyboard
 * follows into the terminal.
 */
export function followFocusTerminal(id: string): void {
  const t = useTerminalsStore.getState().byId[id];
  if (t?.labels.slot === "quick" && t.labels.thread) focusQuick(t.labels.thread);
  else void focusTerminalTab(id);
}

/**
 * Shows a terminal: its tab takes the focus, opened by the placement rules when it has none
 * (ui.focus.terminal), and the keyboard goes into it. False when the daemon refused.
 */
export async function showTerminal(id: string): Promise<boolean> {
  const res = await runCommandForResult("ui.focus.terminal", { id }, { quiet: true });
  if (!res) return false;
  await focusTerminalTab(id);
  return true;
}

/**
 * terminal.new in `ctx` (a thread's, a worktree's; `cwd`: another folder of it), its tab opened by
 * the daemon with the keyboard in it. False when the daemon refused.
 */
export async function newTerminalInContext(ctx: UiContextView, cwd?: string): Promise<boolean> {
  const res = await runCommandForResult("terminal.new", cwd ? { cwd } : {}, { ctx, quiet: true });
  if (!res) return false;
  await intoNewTerminal(res.resultJson);
  return true;
}

/**
 * Closes terminal `id` (terminal.close, no confirmation: a Rerun's old run); its tab goes when the
 * daemon removes it. One already gone (reaped meanwhile: NotFound, or unknown to the daemon) is
 * not an error; any other failure toasts.
 */
export async function closeTerminal(id: string): Promise<void> {
  try {
    await invokeConfirmed("terminal.close", { id }, terminalCtx(id));
  } catch (err) {
    if (isNotFound(err) || !(id in useTerminalsStore.getState().byId)) return;
    const title = useCommandsStore.getState().commands.find((c) => c.name === "terminal.close")?.title ?? "Close Terminal";
    toast.error(`${title} failed`, { description: errorMessage(err) });
  } finally {
    void refreshCommands();
  }
}

/** The thread of the focused tab (a thread's tab or a surface linked to it); "" for none. */
function currentThread(): string {
  return focusedTab(useLayoutStore.getState())?.thread ?? "";
}

/** The checkout of the focused shell when it belongs to one and to no thread (a Projects page's); null otherwise. */
function focusedCheckoutShell(): { project: string; worktree: string } | null {
  const id = activeTerminalId();
  const labels = id ? useTerminalsStore.getState().byId[id]?.labels : undefined;
  if (!labels || labels[THREAD_LABEL]) return null;
  const project = labels[PROJECT_LABEL] ?? "";
  const worktree = labels[WORKTREE_LABEL] ?? "";
  return project && worktree ? { project, worktree } : null;
}

/**
 * cmd+t: a new terminal tab linked to the focused tab's thread, placed by the rules; from a shell
 * of a checkout and no thread (a Projects page's), another in that checkout; otherwise a free one
 * in the home directory (docs/notes/shell-model.md, "Keys"). A pane's "+" menu names the thread
 * (`thread`, "" for its general Terminal: a free one) and its pane (`pane`: the tab opens there).
 */
export async function newTerminalTab(opts: { thread?: string; pane?: string } = {}): Promise<void> {
  const thread = opts.thread ?? currentThread();
  const checkout = opts.thread === undefined && !thread ? focusedCheckoutShell() : null;
  if (!thread && !checkout) {
    await newFreeTerminalTab(opts.pane);
    return;
  }
  const ctx = checkout ? worktreeContext(checkout.project, checkout.worktree) : getUiContext({ kind: "thread", id: thread });
  const res = await runCommandForResult("terminal.new", opts.pane ? { pane: opts.pane } : {}, { ctx, quiet: true });
  await intoNewTerminal(res?.resultJson);
}

/** A terminal tab linked to nothing, in the home directory (cmd+t with no thread, the palette); the "+" menu's Terminal, in its `pane`. */
export async function newFreeTerminalTab(pane = ""): Promise<void> {
  const res = await runCommandForResult("terminal.new-free", pane ? { pane } : {}, { quiet: true });
  await intoNewTerminal(res?.resultJson);
}

/**
 * A running terminal that has no tab (a shell the classic window's bottom panel started) gets one
 * in `pane` (the "+" menu): ui.focus.terminal --pane. The keyboard follows it.
 */
export async function openTerminalIn(id: string, pane: string): Promise<void> {
  const res = await runCommandForResult("ui.focus.terminal", { id, pane }, { quiet: true });
  if (!res) return;
  const tab = await whenTerminalTab(id);
  if (tab) requestPaneFocus(tab.paneId);
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
      await closeQuick(thread);
      return;
    }
  }
}

/**
 * The quick terminal's × and cmd+j in it: closed, the keyboard goes to the thread's prompt when
 * the thread's pane still has the focus once the commit is in (the user may have gone elsewhere
 * while it ran; nothing then moves under them).
 */
export async function closeQuick(threadId: string): Promise<void> {
  const rev = await quickCommand({ id: threadId, close: "true" });
  await afterRev(rev);
  const s = useLayoutStore.getState();
  const tab = Object.values(s.tabs).find((t) => t.kind === "thread" && t.thread === threadId);
  if (tab && s.spaces[s.currentSpaceId]?.focus === tab.paneId) requestPaneFocus(tab.paneId);
}

/**
 * A thread's quick terminal is going (its drawing unmounts): when it had the keyboard and the
 * thread's quick terminal is closed in the layout (its shell exited, cmd+j, ×, the CLI), the
 * keyboard goes to the thread's prompt instead of falling to the body. Leaving the tab (another
 * tab, smart swap) keeps the quick terminal open and moves nothing.
 */
export function handBackFromQuick(threadId: string): void {
  if (!quickHasFocus(threadId)) return;
  const s = useLayoutStore.getState();
  if (s.threads[threadId]?.quick?.open === true) return;
  const tab = Object.values(s.tabs).find((t) => t.kind === "thread" && t.thread === threadId);
  if (!tab) return;
  // After the commit that removes it: asked for now, the prompt would be focused while the terminal still holds the keyboard.
  queueMicrotask(() => {
    requestPaneFocus(tab.paneId);
  });
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
  // The rerun waits for the shell's prompt: a Reset meanwhile put a new shell under the tab, which
  // never ran the line, so it keeps its "Run again".
  const now = useLayoutStore.getState().tabs[tab.id];
  if (res && now && terminalOfTab(now) === id) await forgetRan(now);
}

/**
 * "Run again" on a quick terminal restored after a snooze: its new shell types the command the
 * old one ran, then the thread's quick terminal forgets it (QuickTerminal.ran), so the line goes.
 * A Reset while the rerun waited put a new shell there that never ran it: the line stays.
 */
export async function runQuickAgain(threadId: string, terminalId: string, command: string): Promise<void> {
  const res = await runCommandForResult("terminal.rerun", { id: terminalId, command }, { ctx: terminalCtx(terminalId), quiet: true });
  if (!res) return;
  const now = quickTerminalOf(useTerminalsStore.getState().byId, useTerminalsStore.getState().order, threadId);
  if (now?.id === terminalId) await forgetQuickRan(threadId);
}

/** Drops a thread's quick terminal's "Run again" line, its open state as the layout has it now. */
export async function forgetQuickRan(threadId: string): Promise<void> {
  const quick = useLayoutStore.getState().threads[threadId]?.quick;
  if (!quick?.ran) return;
  try {
    await applyLayout({ op: "set_quick", thread: threadId, open: quick.open, forget_ran: true });
  } catch {
    // The thread went meanwhile: nothing to forget.
  }
}

/**
 * Drops a restored tab's "Run again" line without running it. The params written are the tab's as
 * the layout has them now (set_tab_params replaces them all), not as a caller read them before an
 * await: a reset or rename meanwhile stays.
 */
export async function forgetRan(tab: Pick<TabEntry, "id" | "params">): Promise<void> {
  const now = useLayoutStore.getState().tabs[tab.id];
  if (!now || !("ran" in now.params)) return;
  const { ran: _ran, ...params } = now.params;
  try {
    await applyLayout({ op: "set_tab_params", tab: tab.id, params });
  } catch {
    // The tab went meanwhile: nothing to forget.
  }
}
