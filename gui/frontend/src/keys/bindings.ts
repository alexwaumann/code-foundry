import type { CommandView, UiContextView } from "@/api/command";
import { promptedArgs } from "@/palette/args";
import { nextAfter, sessionOrder } from "@/lib/tree";
import { refreshCommands, runCommandForResult, useCommandsStore, whenListed } from "@/stores/commands";
import { contextKey, getListOptions, getListSessions, getUiContext } from "@/stores/context";
import { openAddProject } from "@/stores/addProject";
import { openNewThreadPicker } from "@/stores/compose";
import { openPublishDialog } from "@/stores/publish";
import { attentionIds, useSessionsStore } from "@/stores/sessions";
import { zoomUi } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { openUpdateDialog, runUpdateAction } from "@/stores/update";
import { markTerminalNewFromHere, toggleBottomFromHere } from "@/stores/bottomActions";
import { expandPanelCommand, linkedPrsPanelCommand, newPanelTabCommand, showView, toggleHelp, togglePanelCommand, workspacePanelCommand, worktreePanelCommand } from "@/stores/views";
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

/** Selects the Nth thread in sidebar order (rows of a collapsed section do not count). */
function jumpTo(n: number): void {
  const id = sessionOrder(getListSessions(), getListOptions())[n - 1];
  if (id !== undefined) useUiStore.getState().select({ kind: "session", id }, { focusPrompt: true });
}

/** Selects the next session that needs attention after the current one, wrapping. */
export function jumpToAttention(): boolean {
  const waiting = new Set(attentionIds(useSessionsStore.getState()));
  const sel = useUiStore.getState().selection;
  // Threads that need attention are never in the collapsible Working section (threadGroup).
  const next = nextAfter(sessionOrder(getListSessions(), getListOptions()), sel.kind === "session" ? sel.id : null, (id) => waiting.has(id));
  if (next === null) return false;
  useUiStore.getState().select({ kind: "session", id: next }, { focusPrompt: true });
  return true;
}

function togglePalette(): void {
  const ui = useUiStore.getState();
  if (ui.palette.open) ui.closePalette();
  else ui.openPalette();
}

/** A selected thread's prompt takes the keyboard (ThreadComposer). */
function focusThreadPrompt(): void {
  if (useUiStore.getState().selection.kind === "session") useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
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
 * Commands whose GUI presenter supplies the context the daemon needs: session.new's
 * project picker picks the repo. They start (palette, chord, button) even where the
 * daemon lists them as unavailable, e.g. with nothing selected.
 */
const contextSupplied: ReadonlySet<string> = new Set(["session.new"]);

/** Whether the GUI can start this command here (see contextSupplied). */
export function isStartable(c: CommandView): boolean {
  return c.available || contextSupplied.has(c.name);
}

/** Presenters that also replace the palette's arg prompts when the command is picked there. */
const paletteSupplied: ReadonlySet<string> = new Set(["session.new", "session.run-in", "repo.clone", "repo.create", "repo.github.publish"]);

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
 * session.close/rename, cmd+j and cmd+t still fire while typing to Claude or a shell.
 */
function terminalYields(chord: string): CommandView | undefined {
  if (!terminalYieldable(chord)) return undefined;
  return commandBindings(useCommandsStore.getState().commands).get(chord);
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
 * Opens the "Run in…" member picker for a workspace thread. False for a project thread
 * (or none), so the command falls back to its default presentation.
 */
export function openRunInPicker(sessionId: string): boolean {
  if (!useSessionsStore.getState().byId[sessionId]?.workspaceId) return false;
  const ui = useUiStore.getState();
  const returnTo = ui.palette.open ? ui.palette.returnTo : ui.focus;
  // Deferred: picked inside the palette, the palette closes after the presenter runs.
  queueMicrotask(() => {
    useUiStore.getState().openRunInPicker(sessionId, returnTo);
  });
  return true;
}

/** Starts inline rename of the active session's sidebar row. */
export function beginRename(sessionId: string | null = getUiContext().activeSessionId || null): boolean {
  if (!sessionId || !useSessionsStore.getState().byId[sessionId]) return false;
  const ui = useUiStore.getState();
  if (!ui.sidebarVisible) ui.toggleSidebar();
  ui.setRenaming(sessionId);
  return true;
}

/**
 * GUI presentations of specific registry commands. The command still runs through the
 * registry (session.rename is invoked when the inline edit is committed); this only
 * replaces the generic palette prompt. Return false to fall back to the default.
 */
const commandPresenters: Readonly<Record<string, () => boolean>> = {
  "session.rename": () => beginRename(),
  // The project picker, then the composer; the composer invokes session.new.
  "session.new": () => {
    openNewThreadPicker();
    return true;
  },
  // "Run in…": the member picker for the active workspace thread; it invokes session.run-in.
  "session.run-in": () => openRunInPicker(getUiContext().activeSessionId),
  // The Add Project dialog; its tabs call RepoService.Register (repo.add's CLI form with
  // a folder), stream RepoService.Clone (repo.clone's CLI form), or invoke repo.create.
  // repo.add's optional path is never prompted for. repo.clone opens it on the GitHub tab.
  "repo.add": () => {
    openAddProject();
    return true;
  },
  "repo.clone": () => {
    openAddProject("github");
    return true;
  },
  // The New tab invokes repo.create itself; from the palette it opens the dialog there.
  "repo.create": () => {
    openAddProject("new");
    return true;
  },
  // The publish dialog (owner and visibility pickers) for the active project; it
  // invokes repo.github.publish.
  "repo.github.publish": () => openPublishDialog(getUiContext().activeRepoId),
  // Window-local: only this window opens, without a round trip (the CLI and palette
  // reach every window through UiIntent.ShowView instead).
  "view.settings": () => showView("settings"),
  // The Usage page, a toggle (stores/views.ts): window-local like view.settings.
  "view.usage": () => showView("usage"),
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
  // Same for the workspace surface: this window's workspace thread's panel.
  "view.panel.workspace": () => {
    workspacePanelCommand();
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
  // presenter: the registry's confirm flow asks (with the live-session count).
  "app.update.check": () => {
    openUpdateDialog({ check: true });
    return true;
  },
  "app.update": () => {
    openUpdateDialog();
    void runUpdateAction("install");
    return true;
  },
};

/** Runs the command's presenter, if it has one; false means "invoke it normally". */
export function presentCommand(name: string): boolean {
  return commandPresenters[name]?.() ?? false;
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
 *  3. A focused text field (palette input, rename field) consumes everything else.
 *  4. F2 renames the selected session (the cursor row inside the tree); command
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
      // brings its worktree): cmd+t or cmd+shift+w right after it must not be lost to the
      // debounced re-list. In a prompt only for a chord some command declares: the
      // others edit (cmd+arrows, cmd+backspace) and must not be held.
      startWhenListed(e, chord);
    }
    return;
  }
  if (isEditable(target) || useUiStore.getState().palette.open) return;
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
