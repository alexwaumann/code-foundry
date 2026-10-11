/**
 * What the bottom panel (stores/bottomPanel.ts, components/bottom) does beyond its own
 * state: starting and closing shells through the registry (terminal.new, terminal.close),
 * opening a key's panel when a new shell shows up, and the focusTerminal intent for a
 * shell. Kept apart from the store so the store imports no command code.
 */
import { toast } from "sonner";
import type { UiContextView } from "@/api/command";
import { isNotFound } from "@/api/errors";
import { errorMessage } from "@/api/stream";
import type { TerminalView } from "@/api/terminal";
import { REPO_LABEL, WORKTREE_LABEL } from "@/lib/termlabel";
import { bottomKeyOf, getBottomActiveId, markPendingFocus, openOn, ownerKeyOf, PROJECTS_KEY, requestBottomFocus, sessionOfKey, takePendingFocus, updateBottom } from "./bottomPanel";
import { invokeConfirmed, refreshCommands, runCommand, useCommandsStore } from "./commands";
import { getUiContext, worktreeContext } from "./context";
import { expandPanel, getPanel } from "./panel";
import { useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";
import { useViewsStore } from "./views";

/**
 * The context a bottom panel's actions run in. A thread's panel: the thread's own context
 * (it carries the thread, which owns the new shell). The Projects page's panel: its active
 * tab's worktree (the page itself carries none), so "+" opens another shell beside the
 * active one. Null when there is nothing to own a new shell (the Projects page with no
 * tabs, or a key that is neither).
 */
export function paneContext(key: string): UiContextView | null {
  const session = sessionOfKey(key);
  if (session !== null) return getUiContext({ kind: "session", id: session });
  if (key !== PROJECTS_KEY) return null;
  const active = getBottomActiveId(key);
  const t = active === null ? undefined : useTerminalsStore.getState().byId[active];
  const repo = t?.labels[REPO_LABEL] ?? "";
  const worktree = t?.labels[WORKTREE_LABEL] ?? "";
  return repo && worktree ? worktreeContext(repo, worktree) : null;
}

/**
 * terminal.new for a key's panel (its "+"), in paneContext. The new shell opens there
 * and takes focus (markPendingFocus). False when there is no context for it.
 */
export function newBottomTerminal(key: string): Promise<boolean> {
  const ctx = paneContext(key);
  if (ctx === null) return Promise.resolve(false);
  markPendingFocus(key);
  return runCommand("terminal.new", {}, ctx);
}

/**
 * terminal.new started by this window with its current context (the cmd+t chord, the
 * palette, a CommandButton; keys/bindings.ts runs this before invoking it): the shell it
 * starts takes focus in the bottom panel when it shows up.
 */
export function markTerminalNewFromHere(): void {
  markPendingFocus(bottomKeyOf(useUiStore.getState().selection));
}

/** terminal.new for a thread from elsewhere (its sidebar row's menu). */
export function newThreadTerminal(sessionId: string): Promise<boolean> {
  markPendingFocus(`session:${sessionId}`);
  return runCommand("terminal.new", {}, getUiContext({ kind: "session", id: sessionId }));
}

/** terminal.new in a worktree from the Projects page (its rows): the shell lands in the page's panel. */
export function newWorktreeTerminal(repoId: string, path: string): Promise<boolean> {
  markPendingFocus(PROJECTS_KEY);
  return runCommand("terminal.new", {}, worktreeContext(repoId, path));
}

/**
 * Closes a tab: terminal.close with --id for that terminal, no confirmation (it only
 * closes shells). Its tab goes when the daemon removes the terminal. A shell that is
 * already gone (reaped meanwhile: NotFound, or unavailable because the daemon no longer
 * knows it) is not an error.
 */
export async function closeBottomTerminal(id: string): Promise<void> {
  const ctx: UiContextView = { ...getUiContext(), activeTerminalId: id };
  try {
    await invokeConfirmed("terminal.close", { id }, ctx);
  } catch (err) {
    if (isNotFound(err) || !(id in useTerminalsStore.getState().byId)) return;
    const title = useCommandsStore.getState().commands.find((c) => c.name === "terminal.close")?.title ?? "Close Terminal";
    toast.error(`${title} failed`, { description: errorMessage(err) });
  } finally {
    void refreshCommands();
  }
}

/** Focus the bottom panel, or make it where the open palette returns to. */
function focusBottom(): void {
  const ui = useUiStore.getState();
  if (ui.palette.open) useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "bottom" } }));
  else requestBottomFocus();
}

/** A focusTerminal intent that arrived before its terminal; revealed if it turns out to be a shell. */
let revealOnArrival: string | null = null;

/**
 * The focusTerminal intent for a shell: select its owner (the thread, or the Projects
 * page for a worktree's shell), open that panel with the shell active, and focus it. The
 * settings and usage pages close, and the owner's side panel leaves full width, so the
 * panel shows. False when the terminal is unknown (it is revealed when it arrives, if it
 * is a shell) or no shell.
 */
export function revealShell(id: string): boolean {
  const t = useTerminalsStore.getState().byId[id];
  if (!t) {
    revealOnArrival = id;
    return false;
  }
  const key = ownerKeyOf(t);
  if (key === null) return false;
  const session = sessionOfKey(key);
  useUiStore.getState().select(session !== null ? { kind: "session", id: session } : { kind: "view", name: "projects" });
  useViewsStore.setState({ settingsOpen: false, usageOpen: false });
  if (getPanel(key).expanded) expandPanel(key, false);
  updateBottom(key, (e) => openOn(e, id));
  focusBottom();
  return true;
}

/**
 * A terminal that was not in the store before (a `terminal updated` event). A running
 * shell opens its owner's panel with it active, whether or not that key is selected. It
 * takes focus when this window started it for the selected key (markPendingFocus), or
 * when a focusTerminal intent for it came first.
 */
export function onNewTerminal(t: TerminalView): void {
  const key = ownerKeyOf(t);
  if (key === null || t.state === "exited") return;
  if (revealOnArrival === t.id) {
    revealOnArrival = null;
    revealShell(t.id);
    return;
  }
  updateBottom(key, (e) => openOn(e, t.id));
  if (takePendingFocus(key) && bottomKeyOf(useUiStore.getState().selection) === key) focusBottom();
}
