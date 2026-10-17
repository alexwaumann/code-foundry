/**
 * What the bottom panel (stores/bottomPanel.ts, components/bottom) does beyond its own
 * state: starting and closing shells through the registry (terminal.new, terminal.close),
 * opening a key's panel when a new shell shows up (and hiding it when its last one goes),
 * this window's cmd+j (a shell when the panel would open empty), and the focusTerminal
 * intent for a shell. Kept apart from the store so the store imports no command code.
 * See docs/notes/bottom-panel-autoshell.md.
 */
import { toast } from "sonner";
import type { UiContextView } from "@/api/command";
import { isNotFound } from "@/api/errors";
import { errorMessage } from "@/api/stream";
import { terminalIdFromResult, type TerminalView } from "@/api/terminal";
import {
  activate,
  activeTabOf,
  bottomKeyOf,
  bottomTabIds,
  clearStarting,
  emptyOpenKeys,
  getBottom,
  getBottomActiveId,
  getBottomTabIds,
  isStarting,
  markPendingFocus,
  markPendingFocusId,
  markStarting,
  neighbourOf,
  openOn,
  ownerKeyOf,
  PENDING_FOCUS_MS,
  PROJECTS_KEY,
  requestBottomFocus,
  threadOfKey,
  setOpen,
  takePendingFocus,
  takePendingFocusId,
  updateBottom,
  useBottomStore,
} from "./bottomPanel";
import { invokeConfirmed, refreshCommands, runCommandForResult, useCommandsStore } from "./commands";
import { getUiContext, projectsShellPlace, worktreeContext } from "./context";
import { expandPanel, getPanel } from "./panel";
import { useTerminalsStore, type TerminalsData } from "./terminals";
import { useUiStore } from "./ui";
import { bottomCanShow, toggleBottomCommand, useViewsStore, visibleBottomKey } from "./views";

/**
 * The context a bottom panel's actions run in. A thread's panel: the thread's own context
 * (it carries the thread, which owns the new shell). The Projects page's panel: its active
 * tab's worktree (the page itself carries none), so "+" opens another shell beside the
 * active one. Null when there is nothing to own a new shell (the Projects page with no
 * tabs, or a key that is neither).
 */
export function paneContext(key: string): UiContextView | null {
  const thread = threadOfKey(key);
  if (thread !== null) return getUiContext({ kind: "thread", id: thread });
  if (key !== PROJECTS_KEY) return null;
  const active = getBottomActiveId(key);
  const place = projectsShellPlace(active === null ? undefined : useTerminalsStore.getState().byId[active]);
  return place ? worktreeContext(place.repoId, place.path) : null;
}

/**
 * Runs terminal.new in `ctx` (with `args`) and puts the keyboard in the shell it returns
 * (by id, from the result JSON): at once if the shell already arrived, else when it does
 * (pendingFocusId). Nothing is left pending when the command fails. Quiet: the new tab is
 * the feedback, so no "created terminal" toast (a failure still toasts).
 */
async function startShell(ctx: UiContextView, args: Record<string, string> = {}): Promise<boolean> {
  const res = await runCommandForResult("terminal.new", args, { ctx, quiet: true });
  if (res === null) return false;
  const id = terminalIdFromResult(res.resultJson);
  if (id !== null) focusOwnShell(id);
  return true;
}

/**
 * Lets the selection's bottom panel show: the Settings and Usage pages close, and its
 * side panel leaves full width (an expanded side panel hides the content column).
 */
function uncoverBottom(key: string): void {
  useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false });
  if (getPanel(key).expanded) expandPanel(key, false);
}

/**
 * A shell this window started: show it in its owner's panel, active. If that panel
 * belongs to the selection, uncover it (a member's "New terminal here" in an expanded
 * side panel, a row menu under Settings) and focus it. One that has not arrived yet is
 * handled on arrival.
 */
function focusOwnShell(id: string): void {
  const t = useTerminalsStore.getState().byId[id];
  if (!t) {
    markPendingFocusId(id);
    return;
  }
  const key = ownerKeyOf(t);
  if (key === null) return;
  showOwnShell(key, id);
}

/**
 * A panel terminal this window started some other way (an action run, stores/actionActions.ts):
 * shown and focused like a shell from "+" (focusOwnShell), now or when it arrives.
 */
export function showOwnTerminal(id: string): void {
  focusOwnShell(id);
}

/** focusOwnShell for a shell in the store: open its panel on it; uncover and focus it when it is the selection's. */
function showOwnShell(key: string, id: string): void {
  clearStarting(key);
  showBottom(key, id);
}

/**
 * Opens a key's panel (on shell `id`, if given). If it is the selection's, uncovers it
 * (Settings, Usage, an expanded side panel) and focuses it (the active terminal, else the
 * panel), or makes it the open palette's return target.
 */
function showBottom(key: string, id?: string): void {
  updateBottom(key, (e) => (id === undefined ? setOpen(e, true) : openOn(e, id)));
  if (bottomKeyOf(useUiStore.getState().selection) !== key) return;
  uncoverBottom(key);
  focusBottom();
}

/** What openBottomShell does beyond making sure the panel shows a shell. */
export interface BottomShellOptions {
  /**
   * Start a new shell even when the panel has tabs (the "+", a code block's "Run in
   * terminal"). Without it an existing active tab is reused.
   */
  fresh?: boolean;
  /**
   * A command line for the new shell: terminal.new --run, so the daemon types it (and
   * Return) once the shell has printed its prompt. The shell stays open after the
   * command. Ignored when an existing tab is reused.
   */
  command?: string;
  /** terminal.new's args (e.g. `cwd`); the context is always paneContext(key). */
  args?: Record<string, string>;
}

/**
 * Makes sure `key`'s bottom panel is open with a shell. A panel with an active tab (and no
 * `fresh`) just shows it on that tab. Otherwise terminal.new runs in paneContext(key); the
 * panel opens at once with a blank body (BottomState.starting, so no "No terminals" flash)
 * and the shell takes it, active and focused, when it arrives. Uncovering and focus only
 * apply when `key` is the selection's (showBottom).
 *
 * Resolves to the shell's id (the reused tab, or the new one, which may not have arrived
 * yet), or null when there is no context to own a shell (nothing changes) or terminal.new
 * failed (it toasts; the panel stays open on its empty state).
 */
export async function openBottomShell(key: string, opts: BottomShellOptions = {}): Promise<string | null> {
  const active = getBottomActiveId(key);
  if (active !== null && !opts.fresh) {
    showOwnShell(key, active);
    return active;
  }
  const ctx = paneContext(key);
  if (ctx === null) return null;
  const at = Date.now();
  markStarting(key, at);
  // The timer only drops this start's mark, never a later one.
  setTimeout(() => {
    clearStarting(key, at);
  }, PENDING_FOCUS_MS);
  // A panel already on screen keeps the keyboard where it is ("+") until the shell arrives.
  if (visibleBottomKey() !== key) showBottom(key);
  const args = opts.command ? { ...opts.args, run: opts.command } : (opts.args ?? {});
  // With --run, terminal.new returns only once the command is typed (after the shell's
  // prompt), so the shell arrives first: the first new shell for this key takes the tab
  // and the keyboard on arrival, as for cmd+t.
  if (opts.command) markPendingFocus(key, at);
  const res = await runCommandForResult("terminal.new", args, { ctx, quiet: true });
  // Still pending: no shell for the key arrived meanwhile.
  const pending = useBottomStore.getState().pendingFocus;
  const unclaimed = Boolean(opts.command) && pending?.key === key && pending.at === at;
  if (unclaimed) markPendingFocus(null);
  const id = res === null ? null : terminalIdFromResult(res.resultJson);
  if (id === null) {
    clearStarting(key, at);
    return null;
  }
  // A --run shell that took the keyboard on arrival is not focused again: the user may
  // have moved on while the daemon waited for the prompt.
  if (!opts.command || unclaimed) focusOwnShell(id);
  return id;
}

/**
 * A code block's "Run in terminal" (components/thread/CodeActions.tsx): a new shell in
 * the thread's bottom panel that runs `command` and stays open (openBottomShell, fresh,
 * terminal.new --run).
 */
export function runInThreadTerminal(threadId: string, command: string): Promise<string | null> {
  const key = bottomKeyOf({ kind: "thread", id: threadId });
  if (key === null) return Promise.resolve(null);
  return openBottomShell(key, { fresh: true, command });
}

/**
 * terminal.new for a key's panel (its "+" and empty state), in paneContext. The new shell
 * opens there and takes focus. False when there is no context for it or the run failed.
 */
export async function newBottomTerminal(key: string): Promise<boolean> {
  return (await openBottomShell(key, { fresh: true })) !== null;
}

/**
 * view.bottom.toggle from this window (cmd+j, the header's toggle, the palette; the
 * presenter in keys/bindings.ts). Like toggleBottomCommand, except that a panel about to
 * open with no tab starts a shell (openBottomShell) instead of showing the empty state,
 * when there is a context for one (a thread always; the Projects page never without a
 * tab, so it gets the empty state's hint), and once the terminals are listed. Hiding stays
 * a plain hide. The CLI's ShowView reaches every window with the plain toggle, so one CLI
 * call never starts a shell per window. Returns the new open state.
 */
export function toggleBottomFromHere(): boolean {
  const key = bottomKeyOf(useUiStore.getState().selection);
  // Before the first List the store has no terminals at all, so "no tab" means nothing yet:
  // a thread with shells would get another one. Until then it is the plain toggle.
  const opensEmpty =
    key !== null && useTerminalsStore.getState().loaded && !getBottom(key).open && bottomCanShow(key) && getBottomTabIds(key).length === 0;
  if (!opensEmpty || isStarting(key) || paneContext(key) === null) return toggleBottomCommand();
  void openBottomShell(key);
  return true;
}

/**
 * terminal.new started by this window with its current context (the cmd+t chord, the
 * palette, a CommandButton; keys/bindings.ts runs this before invoking it). Those paths
 * do not hand back the result, so the first new shell for the selection's key within
 * PENDING_FOCUS_MS takes focus.
 */
export function markTerminalNewFromHere(): void {
  markPendingFocus(bottomKeyOf(useUiStore.getState().selection));
}

/**
 * terminal.new for a thread from elsewhere: its sidebar row's menu (in the thread's
 * worktree), or a member row of its side panel's Workspace surface (`cwd`: that member's
 * worktree). Either way the thread owns the shell, so it opens in the thread's panel.
 */
export function newThreadTerminal(threadId: string, cwd?: string): Promise<boolean> {
  return startShell(getUiContext({ kind: "thread", id: threadId }), cwd ? { cwd } : {});
}

/** terminal.new in a worktree from the Projects page (its rows): the shell lands in the page's panel. */
export function newWorktreeTerminal(repoId: string, path: string): Promise<boolean> {
  return startShell(worktreeContext(repoId, path));
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

/**
 * A focusTerminal intent that arrived before its terminal: revealed if it turns out to be
 * a shell within PENDING_FOCUS_MS. stores/intents.ts clears it (a new intent, a selection).
 */
let revealOnArrival: { id: string; at: number } | null = null;

/** Forgets a pending reveal (stores/intents.ts clearPendingFocus). */
export function clearRevealOnArrival(): void {
  revealOnArrival = null;
}

/** Whether `id` is the pending reveal and still fresh; the slot is used up either way. */
function takeReveal(id: string, now = Date.now()): boolean {
  if (revealOnArrival?.id !== id) return false;
  const fresh = now - revealOnArrival.at <= PENDING_FOCUS_MS;
  revealOnArrival = null;
  return fresh;
}

/**
 * The reconnect's List brings terminals without `updated` events (no onNewTerminal): a
 * pending reveal whose shell is now known is revealed once (events.ts).
 */
export function revealArrived(): void {
  const id = revealOnArrival?.id;
  if (id === undefined) return;
  const t = useTerminalsStore.getState().byId[id];
  if (t && ownerKeyOf(t) !== null && takeReveal(id)) revealShell(id);
}

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
    revealOnArrival = { id, at: Date.now() };
    return false;
  }
  const key = ownerKeyOf(t);
  if (key === null) return false;
  const thread = threadOfKey(key);
  useUiStore.getState().select(thread !== null ? { kind: "thread", id: thread } : { kind: "view", name: "projects" });
  uncoverBottom(key);
  updateBottom(key, (e) => openOn(e, id));
  focusBottom();
  return true;
}

/** Where the keyboard is, or where the open palette returns it. */
function keyboardRegion(): string {
  const ui = useUiStore.getState();
  return ui.palette.open ? ui.palette.returnTo : ui.focus;
}

/**
 * A terminal that was not in the store before (a `terminal updated` event; the store has
 * it now). A running shell opens its owner's panel, whether or not that key is selected.
 * One this window started (pendingFocusId, or the chord/palette's pendingFocus for its key)
 * becomes active and takes focus if its key is selected. Any other becomes active too,
 * unless the keyboard is in that very panel: then it only gets its tab, and the tab the
 * user is typing in stays active.
 */
export function onNewTerminal(t: TerminalView): void {
  const key = ownerKeyOf(t);
  if (key === null || t.state === "exited") return;
  if (takeReveal(t.id)) {
    revealShell(t.id);
    return;
  }
  const mine = takePendingFocusId(t.id) || takePendingFocus(key);
  if (mine) {
    showOwnShell(key, t.id);
    return;
  }
  if (visibleBottomKey() === key && keyboardRegion() === "bottom") {
    // Pin the tab that is active now: with none remembered, the last tab is active, and
    // the new one is last.
    const active = activeTabOf(getBottom(key), getBottomTabIds(key).filter((id) => id !== t.id));
    updateBottom(key, (e) => (active === null ? setOpen(e, true) : activate(setOpen(e, true), active)));
    return;
  }
  updateBottom(key, (e) => openOn(e, t.id));
}

/**
 * A terminal left the store (`before` is the store with it). When it was its panel's last
 * tab, the panel hides (hideEmptyBottom), shown or not, so the next cmd+j starts a fresh
 * shell. When it was its panel's active tab, the tab after it becomes active, else the
 * one before (not the last tab, which is what activeTabOf would fall back to).
 */
export function onRemovedTerminal(t: TerminalView, before: TerminalsData): void {
  const key = ownerKeyOf(t);
  if (key === null) return;
  if (getBottomTabIds(key).length === 0) {
    hideEmptyBottom(key);
    return;
  }
  const ids = bottomTabIds(before, key);
  if (activeTabOf(getBottom(key), ids) !== t.id) return;
  const next = neighbourOf(ids, t.id);
  if (next !== null) updateBottom(key, (e) => activate(e, next));
}

/**
 * Hides a key's panel that has no tab left, unless this window is starting a shell for it.
 * If it was on screen with the keyboard in it, the keyboard goes to the content pane (or
 * the open palette returns there), like cmd+w on an empty panel.
 */
function hideEmptyBottom(key: string): void {
  if (isStarting(key)) return;
  const shown = visibleBottomKey() === key;
  updateBottom(key, (e) => setOpen(e, false));
  if (!shown) return;
  const ui = useUiStore.getState();
  if (ui.palette.open) {
    if (ui.palette.returnTo === "bottom") useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "content" } }));
  } else if (ui.focus === "bottom") {
    ui.focusContent();
  }
}

/**
 * Hides every open panel left without tabs (emptyOpenKeys). events.ts runs it after the
 * reconnect's List: a restarted daemon pruned the shells without `removed` events, and a
 * persisted open state may name a key whose shells are gone.
 */
export function closeEmptyPanels(): void {
  const s = useBottomStore.getState();
  for (const key of emptyOpenKeys(s.byKey, useTerminalsStore.getState(), s.starting)) hideEmptyBottom(key);
}
