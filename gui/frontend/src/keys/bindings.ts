import type { CommandView, UiContextView } from "@/api/command";
import { promptedArgs } from "@/palette/args";
import { sidebarAnchor } from "@/lib/inSidebar";
import { canNewLike, canRunElsewhere } from "@/lib/threadRow";
import { nextAfter, threadOrder } from "@/lib/tree";
import { refreshCommands, runCommandForResult, useCommandsStore, whenListed } from "@/stores/commands";
import { contextKey, getListOptions, getListThreads, getUiContext } from "@/stores/context";
import { openAddProject } from "@/stores/addProject";
import { composeLike, openNewThreadPicker } from "@/stores/compose";
import { getEmberAttentionId } from "@/stores/ember";
import { openPublishDialog } from "@/stores/publish";
import { openNewWorkspaceDialog } from "@/stores/workspaceActions";
import { allSurfaces } from "@/stores/plugins";
import { presentSnooze } from "@/stores/snoozeDialog";
import { leaveSubagent } from "@/stores/subagentView";
import { jumpToNeighbour } from "@/stores/threadNeighbours";
import { toggleThreadSidebar } from "@/stores/threadActions";
import { attentionIds, useThreadsStore } from "@/stores/threads";
import { getShowCreatedThreads, zoomUi } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { openUpdateDialog, runUpdateAction } from "@/stores/update";
import { markTerminalNewFromHere, toggleBottomFromHere } from "@/stores/bottomActions";
import { expandPanelCommand, historyCommand, linkedPrsPanelCommand, newPanelTabCommand, openThemes, showView, splitPanelCommand, toggleHelp, togglePanelCommand, toggleView, worktreePanelCommand } from "@/stores/views";
import { chordFromEvent, normalizeChord, terminalYieldable } from "./chord";

/**
 * GUI-local view actions. They change only what the window shows (palette, sidebar,
 * zoom, which row is selected), never daemon state, so they are not registry commands.
 * Every chord here is "global": it wins even when a bottom panel shell has focus.
 */
export interface ViewAction {
  chord: string;
  title: string;
  run: () => void;
}

/** Selects the Nth thread in sidebar order (rows of a collapsed section and hidden threads do not count). */
function jumpTo(n: number): void {
  const id = threadOrder(getListThreads(getShowCreatedThreads()), getListOptions())[n - 1];
  if (id !== undefined) useUiStore.getState().select({ kind: "thread", id }, { focusPrompt: true });
}

/** Selects the next thread that needs attention after the current one, wrapping. */
export function jumpToAttention(): boolean {
  const showCreated = getShowCreatedThreads();
  const waiting = new Set(attentionIds(useThreadsStore.getState(), showCreated));
  const sel = useUiStore.getState().selection;
  // Threads that need attention are never in the collapsible Working section (threadGroup).
  // A hidden thread selected (from its creator's Threads tab) starts from its creator's row.
  const order = threadOrder(getListThreads(showCreated), getListOptions());
  const from = sel.kind === "thread" ? sidebarAnchor(useThreadsStore.getState().byId, sel.id, showCreated) : null;
  // Ember's row is the sidebar's first; it counts while it waits on the user (stores/ember.ts).
  const ember = getEmberAttentionId();
  if (ember) waiting.add(ember);
  const next = nextAfter(ember ? [ember, ...order] : order, from, (id) => waiting.has(id));
  if (next === null) return false;
  useUiStore.getState().select({ kind: "thread", id: next }, { focusPrompt: true });
  return true;
}

function togglePalette(): void {
  const ui = useUiStore.getState();
  if (ui.palette.open) ui.closePalette();
  else ui.openPalette();
}

/** A selected thread's prompt takes the keyboard (ThreadComposer). */
function focusThreadPrompt(): void {
  if (useUiStore.getState().selection.kind === "thread") useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
}

function toggleSidebar(): void {
  const ui = useUiStore.getState();
  if (ui.sidebarVisible) {
    ui.toggleSidebar();
    focusThreadPrompt();
  } else {
    ui.focusSidebar();
  }
}

/** Page zoom; saved to appearance.zoom in the settings file. */
function zoom(direction: 1 | -1 | null): void {
  zoomUi(direction);
}

export const viewActions: readonly ViewAction[] = [
  { chord: "cmd+k", title: "Command palette", run: togglePalette },
  { chord: "cmd+shift+p", title: "Command palette", run: togglePalette },
  { chord: "cmd+b", title: "Toggle sidebar", run: toggleSidebar },
  { chord: "cmd+shift+a", title: "Next thread needing attention", run: () => void jumpToAttention() },
  ...Array.from({ length: 9 }, (_, i) => ({
    chord: `cmd+${String(i + 1)}`,
    title: `Jump to thread ${String(i + 1)}`,
    run: () => {
      jumpTo(i + 1);
    },
  })),
  { chord: "cmd+=", title: "Zoom in", run: () => { zoom(1); } },
  { chord: "cmd+-", title: "Zoom out", run: () => { zoom(-1); } },
  { chord: "cmd+0", title: "Reset zoom", run: () => { zoom(null); } },
];

const viewActionMap = new Map(viewActions.map((a) => [normalizeChord(a.chord) ?? a.chord, a]));

/** True for a chord a GUI view action owns (a command bound to it never fires). */
export function isViewActionChord(chord: string): boolean {
  return viewActionMap.has(normalizeChord(chord) ?? chord);
}

/**
 * Commands whose GUI presenter supplies the context the daemon needs: thread.new's
 * project picker picks the project. They start (palette, chord, button) even where the
 * daemon lists them as unavailable, e.g. with nothing selected.
 */
const contextSupplied: ReadonlySet<string> = new Set(["thread.new"]);

/** Whether the GUI can start this command here (see contextSupplied). */
export function isStartable(c: CommandView): boolean {
  return c.available || contextSupplied.has(c.name);
}

/**
 * Whether the palette lists this command: startable here, and not one the daemon marks
 * NoPalette (Command.no_palette: queries, model and CLI verbs, opaque-id prompts, Ember's
 * task board; internal/command/palette_test.go keeps the list). thread.run-in only for a
 * thread with somewhere else to run and thread.new-like only for one with a project or
 * workspace (lib/threadRow; the daemon's availability is the same rule, this keeps a list
 * fetched before the thread changed honest).
 */
export function inPalette(c: CommandView): boolean {
  if (c.name === "thread.run-in" && !canRunElsewhere(activeThread())) return false;
  if (c.name === "thread.new-like" && !canNewLike(activeThread())) return false;
  return isStartable(c) && !c.noPalette;
}

function activeThread() {
  return useThreadsStore.getState().byId[getUiContext().activeThreadId];
}

/** Presenters that also replace the palette's arg prompts when the command is picked there. */
const paletteSupplied: ReadonlySet<string> = new Set(["thread.new", "thread.new-like", "thread.run-in", "thread.snooze", "thread.sidebar","project.clone", "project.create", "project.github.publish", "workspace.new", "theme.pick"]);

let bindingCache: { commands: readonly CommandView[]; map: Map<string, CommandView> } | null = null;

/** chord -> command, from Command.keybindings. Only startable commands bind. */
export function commandBindings(commands: readonly CommandView[]): Map<string, CommandView> {
  if (bindingCache?.commands === commands) return bindingCache.map;
  const map = new Map<string, CommandView>();
  for (const c of commands) {
    if (!isStartable(c)) continue;
    for (const k of c.keybindings) {
      const chord = normalizeChord(k);
      if (chord && !map.has(chord)) map.set(chord, c);
    }
  }
  bindingCache = { commands, map };
  return map;
}

/**
 * The command a focused terminal (a bottom panel shell) or thread prompt
 * ([data-chord-yield]) yields this chord to (see terminalYieldable), so
 * thread.rename, cmd+j and cmd+t still fire while typing to Claude or a shell.
 */
function terminalYields(chord: string): CommandView | undefined {
  if (!terminalYieldable(chord)) return undefined;
  return commandBindings(useCommandsStore.getState().commands).get(chord);
}

/**
 * Commands whose chords also leave a focused text field (the settings search, which the
 * settings page focuses on open; a filter box): back and forward, as in Safari. Only cmd
 * chords that do not move or delete text (a user may rebind these to cmd+arrow).
 */
const fieldYielded: ReadonlySet<string> = new Set(["view.back", "view.forward"]);

/** The command a focused text field yields this chord to (see fieldYielded). */
function fieldYields(chord: string): CommandView | undefined {
  if (!terminalYieldable(chord) || /\+(arrow\w+|backspace|delete|home|end|enter|tab)$/.test(chord)) return undefined;
  const c = commandBindings(useCommandsStore.getState().commands).get(chord);
  return c && fieldYielded.has(c.name) ? c : undefined;
}

/** Some listed command declares the chord, whether or not it is available in this context. */
function declaredChord(chord: string): boolean {
  return useCommandsStore.getState().commands.some((c) => c.keybindings.some((k) => normalizeChord(k) === chord));
}

/** True when the chord must reach the app even while xterm has focus. */
export function isGlobalChord(chord: string): boolean {
  return viewActionMap.has(chord) || terminalYields(chord) !== undefined;
}

/**
 * Opens the "Run in…" picker for a thread with somewhere else to run (lib/threadRow
 * canRunElsewhere). False otherwise, so the command falls back to its default presentation.
 */
export function openRunInPicker(threadId: string): boolean {
  if (!canRunElsewhere(useThreadsStore.getState().byId[threadId])) return false;
  const ui = useUiStore.getState();
  const returnTo = ui.palette.open ? ui.palette.returnTo : ui.focus;
  // Deferred: picked inside the palette, the palette closes after the presenter runs.
  queueMicrotask(() => {
    useUiStore.getState().openRunInPicker(threadId, returnTo);
  });
  return true;
}

/** Starts inline rename of the active thread's sidebar row. */
export function beginRename(threadId: string | null = getUiContext().activeThreadId || null): boolean {
  if (!threadId || !useThreadsStore.getState().byId[threadId]) return false;
  const ui = useUiStore.getState();
  if (!ui.sidebarVisible) ui.toggleSidebar();
  ui.setRenaming(threadId);
  return true;
}

/**
 * GUI presentations of specific registry commands. The command still runs through the
 * registry (thread.rename is invoked when the inline edit is committed); this only
 * replaces the generic palette prompt. Return false to fall back to the default.
 */
const commandPresenters: Readonly<Record<string, () => boolean>> = {
  "thread.rename": () => beginRename(),
  // The project picker, then the composer; the composer invokes thread.new.
  "thread.new": () => {
    openNewThreadPicker();
    return true;
  },
  // "New thread on this branch": the composer prefilled with the active thread's set,
  // branch, primary, workspace and mode; it invokes thread.new-like.
  "thread.new-like": () => composeLike(getUiContext().activeThreadId),
  // "Run in…": the picker of the active thread's other places to run; it invokes thread.run-in.
  "thread.run-in": () => openRunInPicker(getUiContext().activeThreadId),
  // Snooze: the custom date dialog for the active thread (the menus offer presets), or
  // unsnooze it when it is snoozed; both invoke thread.snooze.
  "thread.snooze": () => presentSnooze(getUiContext().activeThreadId),
  // Show or hide in the sidebar: toggles the active thread (the header's button, the
  // palette), so `shown` is never prompted for. The daemon refuses a thread the user created.
  "thread.sidebar": () => toggleThreadSidebar(getUiContext().activeThreadId),
  // The Add Project dialog; its tabs call ProjectService.Register (project.add's CLI form with
  // a folder), stream ProjectService.Clone (project.clone's CLI form), or invoke project.create.
  // project.add's optional path is never prompted for. project.clone opens it on the GitHub tab.
  "project.add": () => {
    openAddProject();
    return true;
  },
  "project.clone": () => {
    openAddProject("github");
    return true;
  },
  // The New tab invokes project.create itself; from the palette it opens the dialog there.
  "project.create": () => {
    openAddProject("new");
    return true;
  },
  // The publish dialog (owner and visibility pickers) for the active project; it
  // invokes project.github.publish.
  "project.github.publish": () => openPublishDialog(getUiContext().activeProjectId),
  // The New workspace dialog (a name and its projects); it invokes workspace.new.
  "workspace.new": () => openNewWorkspaceDialog(),
  // Window-local: only this window opens, without a round trip (the CLI and palette
  // reach every window through UiIntent.ShowView instead).
  "view.settings": () => toggleView("settings"),
  // The Usage page: window-local like view.settings, and like it a toggle here (toggleView).
  "view.usage": () => toggleView("usage"),
  // The Themes page, window-local like view.settings, on the slot in use (its slot chips
  // switch; the palette's slot prompt is skipped). The CLI's theme pick [slot] reaches
  // every window through ShowView "themes[.slot]".
  "theme.pick": () => {
    openThemes();
    return true;
  },
  "view.help": () => {
    toggleHelp();
    return true;
  },
  // Window-local like view.settings: toggles this window's panel for its selection.
  "view.panel.toggle": () => {
    togglePanelCommand();
    return true;
  },
  // Same for full width: this window's panel for its selection.
  "view.panel.expand": () => {
    expandPanelCommand();
    return true;
  },
  // Same for the surface list ("+"): this window's panel for its selection.
  "view.panel.new-tab": () => {
    newPanelTabCommand();
    return true;
  },
  // Same for splitting or joining the panel's tab groups: this window's panel for its selection.
  "view.panel.split": () => {
    splitPanelCommand();
    return true;
  },
  // And for the Linked PRs surface: this window's thread's panel (or a toast without links).
  "view.panel.linked-prs": () => {
    linkedPrsPanelCommand();
    return true;
  },
  // And for the Worktree surface: this window's thread's own worktree in its panel.
  "view.panel.worktree": () => {
    worktreePanelCommand();
    return true;
  },
  // Window-local like view.panel.toggle: this window's own selection history (the CLI's
  // view.back and view.forward reach every window through ShowView).
  "view.back": () => {
    historyCommand(-1);
    return true;
  },
  "view.forward": () => {
    historyCommand(1);
    return true;
  },
  // Window-local too: this window's sidebar order (the CLI's reach every window).
  "thread.previous": () => {
    jumpToNeighbour(-1);
    return true;
  },
  "thread.next": () => {
    jumpToNeighbour(1);
    return true;
  },
  // Window-local like view.panel.toggle: this window leaves its subagent view (Escape, the
  // view's back buttons, the palette). The CLI's reaches every window through ShowView.
  "thread.agent.up": () => {
    leaveSubagent();
    return true;
  },
  // And for the bottom terminal panel: this window's panel for its selection. Opening an
  // empty one starts a shell there (the CLI's ShowView only toggles).
  "view.bottom.toggle": () => {
    toggleBottomFromHere();
    return true;
  },
  // Not a presentation: terminal.new still runs as usual (false). Started here (cmd+t,
  // the palette, a button), the shell it starts takes focus in the bottom panel.
  "terminal.new": () => {
    markTerminalNewFromHere();
    return false;
  },
  // Like cmd+k: opens this window's palette without a round trip. Deferred so that
  // picking it inside the palette (which closes after a presenter runs) reopens it.
  "ui.palette.open": () => {
    queueMicrotask(() => {
      useUiStore.getState().openPalette();
    });
    return true;
  },
  // Update commands show their progress in the update dialog. daemon.restart has no
  // presenter: the registry's confirm flow asks (with the live-thread count).
  "app.update.check": () => {
    openUpdateDialog({ check: true });
    return true;
  },
  "app.update": () => {
    openUpdateDialog();
    void runUpdateAction("download");
    return true;
  },
};

/**
 * A plugin surface's show command (plugin.<plugin>.show.<surface>), window-local like
 * view.panel.*: this window's panel for its selection opens the surface's tab (a page over
 * the content area closes). The CLI's runs on the daemon and reaches windows as a ShowView.
 */
function presentPluginShow(name: string): boolean {
  const m = allSurfaces().find((s) => s.showCommand === name);
  return m ? showView(`panel.${m.kind}`) : false;
}

/** Runs the command's presenter, if it has one; false means "invoke it normally". */
export function presentCommand(name: string): boolean {
  return commandPresenters[name]?.() ?? presentPluginShow(name);
}

/** Picked in the palette: runs its presenter instead of the arg prompts, if it has that kind. */
export function presentInPalette(name: string): boolean {
  return paletteSupplied.has(name) && presentCommand(name);
}

/**
 * Commands whose success this window shows by itself, so starting one here toasts only a
 * failure, not the result message: terminal.new's shell opens as a new bottom panel tab.
 * The CLI still prints the message.
 */
const quietCommands: ReadonlySet<string> = new Set(["terminal.new", "thread.interrupt"]);

/**
 * Whether a command's chord fires for this key event: a key without cmd, ctrl or alt (a
 * bare Escape) only fires inside the content pane and outside elements that handle their
 * own keys ([data-keys-local], the docked prompts), so it never steals keys from lists,
 * dialogs or popovers.
 */
export function chordFires(chord: string, target: Element | null): boolean {
  if (/^(cmd|ctrl|alt)\+/.test(chord)) return true;
  return Boolean(target?.closest('[data-region="content"]')) && !target?.closest("[data-keys-local]");
}

/** Invokes a command started in this window (a chord, the palette, a CommandButton), toasting the result unless it is quiet. */
export function invokeStarted(name: string, args: Record<string, string> = {}, ctx: UiContextView = getUiContext()): void {
  void runCommandForResult(name, args, { ctx, quiet: quietCommands.has(name) });
}

/** Starts a command from the keyboard or palette: prompts for args it needs, else invokes. */
export function startCommand(c: CommandView): void {
  if (presentCommand(c.name)) return;
  if (promptedArgs(c).length > 0) useUiStore.getState().openPalette("", c.name);
  else invokeStarted(c.name);
}

/** startCommand for a command by name, when it is available in the current context. */
export function startCommandNamed(name: string): boolean {
  const c = useCommandsStore.getState().commands.find((x) => x.name === name && isStartable(x));
  if (c) startCommand(c);
  return c !== undefined;
}

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest("[data-terminal-host]")) return false; // xterm's hidden textarea
  // isContentEditable, spelled out for DOMs without it (jsdom).
  const editableText = el.isContentEditable || el.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !== null;
  return editableText || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/**
 * Key precedence:
 *  1. Global view actions (cmd+k, cmd+shift+p, cmd+b, cmd+shift+a, cmd+1..9, zoom) always win
 *     (cmd+1..9 belong to the project picker while it is open).
 *  2. A focused terminal or a thread prompt's text ([data-chord-yield]) consumes everything
 *     else, except cmd chords bound to commands (see terminalYields).
 *  3. A focused text field (palette input, rename field) consumes everything else, except
 *     view.back and view.forward's cmd chords outside the palette (see fieldYielded).
 *  4. F2 renames the selected thread (the cursor row inside the tree); command
 *     keybindings from CommandService.List for the current context.
 */
export function handleKeyDown(e: KeyboardEvent): void {
  if (e.isComposing || e.defaultPrevented) return;
  // A keybinding recorder (settings page) captures every chord, reserved ones included.
  if (e.target instanceof Element && e.target.closest("[data-key-recorder]")) return;
  const chord = chordFromEvent(e);
  if (!chord) return;
  // The project picker takes cmd+1..9 for its rows (the picker handles them itself).
  const palette = useUiStore.getState().palette;
  if (palette.open && palette.page === "projects" && /^cmd\+[1-9]$/.test(chord)) return;
  const action = viewActionMap.get(chord);
  if (action) {
    e.preventDefault();
    e.stopPropagation();
    action.run();
    return;
  }
  const target = e.target instanceof Element ? e.target : null;
  const shell = Boolean(target?.closest("[data-terminal-host]"));
  // Only the prompt's text yields: a composer button or picker keeps the usual keys
  // (F2 renames).
  if (shell || (isEditable(target) && target?.closest("[data-chord-yield]"))) {
    if (useUiStore.getState().palette.open) return;
    const yielded = terminalYields(chord);
    if (yielded) {
      e.preventDefault();
      e.stopPropagation();
      startCommand(yielded);
    } else if (terminalYieldable(chord) && (shell || declaredChord(chord))) {
      // Focusing a shell or selecting a thread changes the context (a Projects-page shell
      // brings its worktree): cmd+t or cmd+r right after it must not be lost to the
      // debounced re-list. In a prompt only for a chord some command declares: the
      // others edit (cmd+arrows, cmd+backspace) and must not be held.
      startWhenListed(e, chord);
    }
    return;
  }
  if (useUiStore.getState().palette.open) return;
  if (isEditable(target)) {
    const yielded = fieldYields(chord);
    if (yielded) {
      e.preventDefault();
      e.stopPropagation();
      startCommand(yielded);
    }
    return;
  }
  // In the tree, F2 renames the row under the cursor (Sidebar handles it).
  if (chord === "f2" && !target?.closest('[role="tree"]') && beginRename()) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const cmd = commandBindings(useCommandsStore.getState().commands).get(chord);
  if (cmd && chordFires(chord, target)) {
    e.preventDefault();
    e.stopPropagation();
    startCommand(cmd);
    return;
  }
  if (/^(cmd|ctrl|alt)\+/.test(chord)) startWhenListed(e, chord);
}

/**
 * Clicking a worktree and pressing cmd+n at once beats the debounced re-list: when the
 * list is for an older context, re-list now and look the chord up again. Nothing happens
 * when the list is current (the chord is simply unbound).
 */
function startWhenListed(e: KeyboardEvent, chord: string): void {
  const ctx = getUiContext();
  if (useCommandsStore.getState().contextKey === contextKey(ctx)) return;
  e.preventDefault();
  // Another refresh may abort this one (startup, context changes): wait for the list
  // for ctx from whichever refresh completes, not just this call.
  void refreshCommands(ctx)
    .then(() => whenListed(ctx))
    .then(() => {
      const late = commandBindings(useCommandsStore.getState().commands).get(chord);
      if (late && contextKey(getUiContext()) === contextKey(ctx)) startCommand(late);
    });
}

/** Installs the global key handler (capture phase, ahead of xterm). */
export function installKeybindings(target: Window = window): () => void {
  target.addEventListener("keydown", handleKeyDown, { capture: true });
  return () => {
    target.removeEventListener("keydown", handleKeyDown, { capture: true });
  };
}
