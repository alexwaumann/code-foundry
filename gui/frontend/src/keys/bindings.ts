import type { CommandView, UiContextView } from "@/api/command";
import { promptedArgs } from "@/palette/args";
import { lastInputWasKeyboard } from "@/lib/inputModality";
import { keyTarget } from "@/lib/keyTarget";
import { canNewLike, canRunElsewhere } from "@/lib/threadRow";
import { refreshCommands, runCommandForResult, useCommandsStore, whenListed } from "@/stores/commands";
import { contextKey, getUiContext } from "@/stores/context";
import { sidebarThreadOrder } from "@/stores/shellList";
import { openAddProject } from "@/stores/addProject";
import { composeLike, openNewThreadPicker } from "@/stores/compose";
import { canMoveThread, openMovePicker } from "@/stores/movePicker";
import { openPublishDialog } from "@/stores/publish";
import { openNewWorkspaceDialog } from "@/stores/workspaceActions";
import { allSurfaces } from "@/stores/plugins";
import { presentPromptHistory } from "@/stores/historyComposers";
import { canSaveFile } from "@/stores/fileEdit";
import { presentFileSave } from "@/stores/fileRequest";
import { presentFileFinder } from "@/stores/fileFinder";
import { canSearchFile, fileFindTabAt, handOffFileFind, presentFileFind } from "@/stores/fileFind";
import { presentTerminalFind } from "@/stores/terminalFind";
import { presentThreadFind } from "@/stores/threadFind";
import { presentSearch } from "@/stores/threadSearch";
import { presentDictationToggle } from "@/stores/dictation";
import { cancelSetup } from "@/stores/setupActions";
import { presentSnooze } from "@/stores/snoozeDialog";
import { getViewing, leaveSubagent } from "@/stores/subagentView";
import { jumpToNeighbour } from "@/stores/threadNeighbours";
import { toggleThreadInfo, useCardRoom } from "@/stores/threadInfoOverlay";
import { useThreadsStore } from "@/stores/threads";
import { zoomUi } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { openUpdateDialog, runUpdateAction } from "@/stores/update";
import { historyCommand, openThemes, showView, toggleHelp, toggleView } from "@/stores/views";
import { presentShellCommand, SHELL_PRESENTERS } from "@/shell/keyPresenters";
import { presentFullscreen } from "@/shell/fullscreen";
import { switchSpaceAt } from "@/shell/spaceActions";
import { shellDrawn } from "@/stores/shellView";
import { openNextNeedsPopup } from "@/stores/needs";
import { chordFromEvent, normalizeChord, terminalYieldable } from "./chord";

/**
 * GUI-local view actions. They change only what the window shows (palette, sidebar,
 * zoom, which row is selected), never daemon state, so they are not registry commands.
 * Every chord here is "global": it wins even when a terminal has the keyboard.
 */
export interface ViewAction {
  chord: string;
  title: string;
  run: () => void;
}

/** Selects the Nth thread in sidebar order: only rows on screen count (not a collapsed section's, but for the open thread's, nor hidden threads). */
function jumpTo(n: number): void {
  const id = sidebarThreadOrder()[n - 1];
  if (id !== undefined) useUiStore.getState().select({ kind: "thread", id }, { focusPrompt: true });
}

/**
 * cmd+shift+a: the popup of the next thread in the Needs you list (stores/needs.ts; nothing
 * visible when none waits). Before the window's first draw (the first-load import) the popup
 * shows once it draws. True when it went somewhere.
 */
export function nextAttention(): boolean {
  return openNextNeedsPopup();
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

/** cmd+b (a GUI view action), and the top bar's sidebar toggle. */
export function toggleSidebar(): void {
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
  { chord: "cmd+shift+a", title: "Next thread needing attention", run: () => void nextAttention() },
  ...Array.from({ length: 9 }, (_, i) => ({
    chord: `cmd+${String(i + 1)}`,
    title: `Jump to thread ${String(i + 1)}`,
    run: () => {
      jumpTo(i + 1);
    },
  })),
  // space.switch --index n: a chord cannot carry an argument (internal/command chord.go ReservedChords).
  ...Array.from({ length: 9 }, (_, i) => ({
    chord: `cmd+ctrl+${String(i + 1)}`,
    title: `Switch to space ${String(i + 1)}`,
    run: () => {
      if (shellDrawn()) switchSpaceAt(i + 1);
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
 * project picker picks the project; cmd+t's terminal.new opens a free terminal in the home
 * directory where no thread is in context (shell/terminalActions.ts newTerminalTab). They start
 * (palette, chord, button) even where the daemon lists them as unavailable, e.g. with nothing
 * selected.
 */
const contextSupplied: ReadonlySet<string> = new Set(["thread.new", "terminal.new"]);

/**
 * What a subagent's view does not start from the keyboard, the palette or a command button
 * (docs/notes/subagent-as-thread.md): the thread's menu, its composer's controls, and the
 * card's rows that act on it, which the view leaves out. The thread stays selected, so the
 * daemon lists them: this is the view's own read-only rule. The sidebar row's menu stays,
 * as it names its thread and runs by name.
 */
const notInSubagent: ReadonlySet<string> = new Set([
  "composer.history",
  "git.pull",
  "git.push",
  "thread.archive",
  "thread.fork",
  "thread.interrupt",
  "thread.move.open",
  "thread.pin",
  "thread.regenerate-name",
  "thread.remove",
  "thread.rename",
  "thread.restart",
  "thread.run-in",
  "thread.set-effort",
  "thread.set-mode",
  "thread.set-model",
  "thread.snooze",
  "thread.stop-waiting",
]);

/** Whether the GUI can start this command here (see contextSupplied, notInSubagent). */
export function isStartable(c: CommandView): boolean {
  if (notInSubagent.has(c.name) && getViewing() !== null) return false;
  return c.available || contextSupplied.has(c.name);
}

/**
 * Whether the palette lists this command: startable here, and not one the daemon marks
 * NoPalette (Command.no_palette: queries, model and CLI verbs, opaque-id prompts, Ember's
 * task board; internal/command/palette_test.go keeps the list). thread.run-in only for a
 * thread with somewhere else to run and thread.new-like only for one with a project or
 * workspace (lib/threadRow; the daemon's availability is the same rule, this keeps a list
 * fetched before the thread changed honest), thread.move.open only for one the move picker
 * takes (lib/move canMove), file.save only over a tab that is editing.
 */
export function inPalette(c: CommandView): boolean {
  if (c.name === "thread.run-in" && !canRunElsewhere(activeThread())) return false;
  if (c.name === "thread.new-like" && !canNewLike(activeThread())) return false;
  // thread.move.open: not for an archived, resident or moving thread either (lib/move canMove).
  if (c.name === "thread.move.open" && !canMoveThread(getUiContext().activeThreadId)) return false;
  // file.save: only with a File tab editing in front of it.
  if (c.name === "file.save" && !canSaveFile()) return false;
  // file.search and its steps: only with a File tab that can search on screen.
  if (fileScoped.has(c.name) && !canSearchFile()) return false;
  return isStartable(c) && !c.noPalette;
}

function activeThread() {
  return useThreadsStore.getState().byId[getUiContext().activeThreadId];
}

/** Presenters that also replace the palette's arg prompts when the command is picked there. */
const paletteSupplied: ReadonlySet<string> = new Set(["thread.new", "thread.new-like", "thread.interrupt", "thread.run-in", "thread.move.open", "thread.snooze", "project.clone", "project.create", "project.github.publish", "workspace.new", "theme.pick"]);

/**
 * Commands that share their chords with another (internal/command SharedChords): they run
 * only while the keyboard is in their place, where they win over it, so cmd+f finds in the
 * terminal in a terminal, in the file in a File tab, and in the thread everywhere else.
 * Decided by where the keyboard is, not by availability: the list can be a debounce behind
 * a focus change, and a plugin's terminal node is in no context.
 */
const terminalScoped: ReadonlySet<string> = new Set(["terminal.find", "terminal.find.next", "terminal.find.previous"]);
const fileScoped: ReadonlySet<string> = new Set(["file.search", "file.search.next", "file.search.previous"]);

let bindingCache: { commands: readonly CommandView[]; inSubagent: boolean; map: Map<string, CommandView> } | null = null;

/**
 * chord -> command, from Command.keybindings. Only startable commands bind; a terminal's own
 * are in terminalCommand. Cached per list and per subagent view (isStartable reads it, and
 * the list is re-read a debounce after the view changes).
 */
export function commandBindings(commands: readonly CommandView[]): Map<string, CommandView> {
  const inSubagent = getViewing() !== null;
  if (bindingCache?.commands === commands && bindingCache.inSubagent === inSubagent) return bindingCache.map;
  const map = new Map<string, CommandView>();
  for (const c of commands) {
    if (!isStartable(c) || terminalScoped.has(c.name) || fileScoped.has(c.name)) continue;
    for (const k of c.keybindings) {
      const chord = normalizeChord(k);
      if (chord && !map.has(chord)) map.set(chord, c);
    }
  }
  bindingCache = { commands, inSubagent, map };
  return map;
}

const scopedCache = new Map<ReadonlySet<string>, { commands: readonly CommandView[]; map: Map<string, CommandView> }>();

/** The command of `scope` this chord runs (any chord with cmd, ctrl or alt). */
function scopedCommand(scope: ReadonlySet<string>, chord: string): CommandView | undefined {
  if (!/^(cmd|ctrl|alt)\+/.test(chord)) return undefined;
  const { commands } = useCommandsStore.getState();
  let cache = scopedCache.get(scope);
  if (cache?.commands !== commands) {
    const map = new Map<string, CommandView>();
    for (const c of commands) {
      if (!scope.has(c.name)) continue;
      for (const k of c.keybindings) {
        const bound = normalizeChord(k);
        if (bound && !map.has(bound)) map.set(bound, c);
      }
    }
    cache = { commands, map };
    scopedCache.set(scope, cache);
  }
  return cache.map.get(chord);
}

/**
 * The command of terminalScoped this chord runs in a terminal. Any chord with cmd, ctrl or
 * alt: unlike a command's chord in a shell (terminalYieldable), a user who binds ctrl+f here
 * means this terminal's find, not the program's. A bare key stays the program's.
 */
function terminalCommand(chord: string): CommandView | undefined {
  return scopedCommand(terminalScoped, chord);
}

/**
 * The command of fileScoped this chord runs with the keyboard in a File tab that can search
 * (its code, its editor, its header; not a text field of its own, whose keys are its own,
 * nor the editor's find and replace panel). Rebind file.search away and cmd+f there is the
 * editor's own find again in edit mode (codeEditorChords), the thread's in view mode.
 */
function fileCommand(e: KeyboardEvent, target: Element | null, code: boolean, chord: string): { command: CommandView; tab: string } | undefined {
  if (!code && isEditable(target)) return undefined;
  if (keyTarget(e)?.closest("[data-search-panel]")) return undefined;
  const command = scopedCommand(fileScoped, chord);
  const tab = command ? fileFindTabAt(target) : null;
  return command && tab !== null ? { command, tab } : undefined;
}

/**
 * Commands for the File tab's code editor: it yields their chords, a prompt or a shell does
 * not. cmd+S in a prompt belongs to its prompt history picker, and a save must not leave a
 * file from a field the user was typing something else in.
 */
const editorOnly: ReadonlySet<string> = new Set(["file.save"]);

/**
 * The command a focused terminal (a terminal tab or the quick terminal) or thread prompt
 * ([data-chord-yield]) yields this chord to (see terminalYieldable), so
 * thread.rename, cmd+j and cmd+t still fire while typing to Claude or a shell. The code
 * editor (`code`) yields the same, and its own commands.
 */
function terminalYields(chord: string, code = false): CommandView | undefined {
  if (!terminalYieldable(chord)) return undefined;
  const c = commandBindings(useCommandsStore.getState().commands).get(chord);
  return c && (code || !editorOnly.has(c.name)) ? c : undefined;
}

/**
 * Commands whose chords also leave a focused text field (the settings search, which the
 * settings sheet focuses on open; a filter box): back and forward, as in Safari, and the
 * settings toggle, so cmd+, closes the sheet it just opened; and dictation, so a chord bound
 * to it works in a pull request tab's review composer (a plain textarea); and search.open, which works from
 * anywhere (a thread's find bar included). Only cmd chords that do not move or delete text
 * (a user may rebind these to cmd+arrow).
 */
const fieldYielded: ReadonlySet<string> = new Set(["view.back", "view.forward", "view.settings", "dictation.toggle", "search.open"]);

/** A chord that moves or deletes text in a field (cmd+arrows, cmd+backspace, …). */
function editingChord(chord: string): boolean {
  return /\+(arrow\w+|backspace|delete|home|end|enter|tab)$/.test(chord);
}

/** The command a focused text field yields this chord to (see fieldYielded). */
function fieldYields(chord: string): CommandView | undefined {
  if (!terminalYieldable(chord) || editingChord(chord)) return undefined;
  const c = commandBindings(useCommandsStore.getState().commands).get(chord);
  return c && fieldYielded.has(c.name) ? c : undefined;
}

/**
 * What the File tab's code editor keeps for itself: the cmd chords of the library's keymap
 * (@pierre/diffs editor/command.js) that the app also binds or could. Its other cmd chords
 * are clipboard and history (terminalYieldable) or move the caret (editingChord).
 */
const codeEditorChords: ReadonlySet<string> = new Set(["cmd+f", "cmd+alt+f", "cmd+g", "cmd+shift+g", "cmd+d", "cmd+[", "cmd+]", "cmd+/"]);

/**
 * Whether the keys go to the File tab's code editor (or its find field): the host is what
 * `e.target` shows, the shadow root holds what has focus. Like a thread prompt, it types
 * and yields the cmd chords bound to commands (cmd+s among them), but not its own.
 */
function inCodeEditor(e: KeyboardEvent, target: Element | null): boolean {
  return Boolean(target?.closest("[data-code-editor]")) && isEditable(keyTarget(e));
}

/** The chord is bound to one of `names`. */
function chordOf(chord: string, names: ReadonlySet<string>): boolean {
  const c = commandBindings(useCommandsStore.getState().commands).get(chord);
  return c !== undefined && names.has(c.name);
}

/** Some listed command declares the chord, whether or not it is available in this context. */
function declaredChord(chord: string): boolean {
  return useCommandsStore.getState().commands.some((c) => c.keybindings.some((k) => normalizeChord(k) === chord));
}

/** True when the chord must reach the app even while xterm has focus. */
export function isGlobalChord(chord: string): boolean {
  return viewActionMap.has(chord) || terminalCommand(chord) !== undefined || terminalYields(chord) !== undefined;
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
const commandPresenters: Readonly<Record<string, (args?: Readonly<Record<string, string>>) => boolean>> = {
  // While a setup runs there is no Claude to interrupt: Cancel has that place, on its key too.
  "thread.interrupt": () => presentInterrupt(),
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
  // The move picker under the active thread's crumb (a thread without a project); its Move invokes thread.move.
  "thread.move.open": () => openMovePicker(getUiContext().activeThreadId),
  // Snooze: the custom date dialog for the active thread (the menus offer presets), or
  // unsnooze it when it is snoozed; both invoke thread.snooze.
  "thread.snooze": () => presentSnooze(getUiContext().activeThreadId),
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
  // Window-local: this window's own focus history (shell/focusHistory.ts; the CLI's view.back
  // and view.forward reach every window through ShowView).
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
  // Window-local: this window leaves its subagent view (Escape, the
  // view's back buttons, the palette). The CLI's reaches every window through ShowView.
  "thread.agent.up": () => {
    leaveSubagent();
    return true;
  },
  // Window-local: this window's thread info card, or its overlay on a narrow pane, focused
  // when a key started it (the CLI's reaches every window through ShowView).
  "view.thread-info": () => {
    toggleThreadInfo(lastInputWasKeyboard());
    return true;
  },
  // Window-local: the full screen pane (shell/fullscreen.ts); the CLI's reaches every window
  // through ShowView. Nothing before the first draw.
  "pane.fullscreen": (args) => !shellDrawn() || presentFullscreen(args),
  // Window-local: the focused composer's Previous prompts picker, else the palette's
  // prompts page (stores/promptHistory.ts). The CLI's reaches every window through ShowView.
  "composer.history": () => presentPromptHistory(),
  // Window-local: the palette's file finder over the selected thread (stores/fileFinder.ts).
  // The CLI's reaches every window through ShowView.
  "file.find": () => presentFileFinder(),
  // Window-local, and only here: saves the File tab in front (stores/fileEdit.ts). The daemon
  // refuses every other caller, so an agent cannot save a user's half-typed draft.
  "file.save": () => presentFileSave(),
  // Window-local: the find bar of the thread in the content pane, or a step through its
  // matches (stores/threadFind.ts). The CLI's reach every window through ShowView.
  "thread.find": () => presentThreadFind("open") || true,
  "thread.find.next": () => presentThreadFind("next") || true,
  "thread.find.previous": () => presentThreadFind("previous") || true,
  // Window-local: the find bar of the terminal with the keyboard, or a step through its
  // matches (stores/terminalFind.ts). The CLI's reach every window through ShowView.
  "terminal.find": () => presentTerminalFind("open") || true,
  "terminal.find.next": () => presentTerminalFind("next") || true,
  "terminal.find.previous": () => presentTerminalFind("previous") || true,
  // Window-local: the find bar of the File tab with the keyboard, or a step through its
  // matches (stores/fileFind.ts). The CLI's reach every window through ShowView.
  "file.search": () => presentFileFind("open") || true,
  "file.search.next": () => presentFileFind("next") || true,
  "file.search.previous": () => presentFileFind("previous") || true,
  // Window-local: the palette's Find dialog over every thread (stores/threadSearch.ts), from
  // any view, on the search `id` names (the sidebar's search row). The CLI's reaches every
  // window through ShowView.
  "search.open": (args) => presentSearch(args?.id),
  // Window-local: dictation into the focused composer, else the one dictating (it stops),
  // else the content pane's (stores/dictation.ts). The CLI's reaches every window through ShowView.
  "dictation.toggle": () => presentDictationToggle(),
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
 * A plugin surface's show command (plugin.<plugin>.show.<surface>), window-local: this window
 * opens the surface's tab for its selection (a sheet over the window closes). The CLI's runs on the daemon and reaches windows as a ShowView.
 */
function presentPluginShow(name: string): boolean {
  const m = allSurfaces().find((s) => s.showCommand === name);
  return m ? showView(`panel.${m.kind}`) : false;
}

/** thread.interrupt on the selected thread: false for a thread with no setup running, which the daemon interrupts as usual. */
function presentInterrupt(): boolean {
  const sel = useUiStore.getState().selection;
  const setup = sel.kind === "thread" ? useThreadsStore.getState().byId[sel.id]?.setup : null;
  if (sel.kind !== "thread" || setup?.phase !== "running") return false;
  if (setup.background) void cancelSetup(sel.id);
  return true;
}

/** Whether this window presents the command itself in the shell (a presenter here or in shell/keyPresenters.ts). */
export function hasShellPresenter(name: string): boolean {
  return name in SHELL_PRESENTERS || name in commandPresenters;
}

/** Runs the command's presenter, if it has one; false means "invoke it normally". */
export function presentCommand(name: string, args?: Readonly<Record<string, string>>): boolean {
  // The window's key table (shell/keyPresenters.ts); before the first draw there is no pane to act on.
  if (shellDrawn()) {
    const shell = presentShellCommand(name, args);
    if (shell !== undefined) return shell;
  } else if (name in SHELL_PRESENTERS && !(name in commandPresenters)) {
    return true;
  }
  return commandPresenters[name]?.(args) ?? presentPluginShow(name);
}

/** Picked in the palette: runs its presenter instead of the arg prompts, if it has that kind. */
export function presentInPalette(name: string): boolean {
  return paletteSupplied.has(name) && presentCommand(name);
}

/**
 * Commands whose success this window shows by itself, so starting one here toasts only a
 * failure, not the result message: terminal.new's shell opens as a new tab.
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
  // The floating card takes Escape first (ThreadInfoOverlay): it closes, and a subagent's view stays.
  if (chord === "escape" && useCardRoom.getState().overlayFor !== null) return false;
  return Boolean(target?.closest('[data-region="content"]')) && !target?.closest("[data-keys-local]");
}

/** Invokes a command started in this window (a chord, the palette, a CommandButton), toasting the result unless it is quiet. */
export function invokeStarted(name: string, args: Record<string, string> = {}, ctx: UiContextView = getUiContext()): void {
  void runCommandForResult(name, args, { ctx, quiet: quietCommands.has(name) });
}

/** Starts a command from the keyboard or palette: prompts for args it needs, else invokes. */
export function startCommand(c: CommandView, args?: Readonly<Record<string, string>>): void {
  if (presentCommand(c.name, args)) return;
  if (promptedArgs(c).length > 0) useUiStore.getState().openPalette("", c.name);
  else invokeStarted(c.name);
}

/** startCommand for a command by name, when it is available in the current context. `args` reach its presenter. */
export function startCommandNamed(name: string, args?: Readonly<Record<string, string>>): boolean {
  const c = useCommandsStore.getState().commands.find((x) => x.name === name && isStartable(x));
  if (c) startCommand(c, args);
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
 *  1. Global view actions (cmd+k, cmd+shift+p, cmd+b, cmd+shift+a, cmd+1..9, ctrl+cmd+1..9,
 *     zoom) always win (cmd+1..9 belong to the project picker while it is open).
 *  2. A focused terminal, a thread prompt's text ([data-chord-yield]) or the File tab's code
 *     editor consumes everything else, except cmd chords bound to commands (see
 *     terminalYields); the editor keeps its own (see codeEditorChords). In a terminal its
 *     own commands come first (see terminalCommand).
 *  3. A focused text field (palette input, rename field) consumes everything else, except
 *     the cmd chords of the commands it yields to (back, forward, settings, dictation and
 *     search; see fieldYielded) outside the palette.
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
  const code = inCodeEditor(e, target);
  const inFile = useUiStore.getState().palette.open ? undefined : fileCommand(e, target, code, chord);
  if (inFile) {
    e.preventDefault();
    e.stopPropagation();
    startCommand(inFile.command);
    return;
  }
  // The editor's find and replace panel (the library's) opening: the tab's bar hands it the query.
  if (code && chord === "cmd+alt+f") {
    const tab = fileFindTabAt(target);
    if (tab !== null) handOffFileFind(tab);
  }
  if (code && (codeEditorChords.has(chord) || editingChord(chord))) return;
  // Only the prompt's text yields: a composer button or picker keeps the usual keys
  // (F2 renames).
  if (shell || code || (isEditable(target) && target?.closest("[data-chord-yield]"))) {
    if (useUiStore.getState().palette.open) return;
    const yielded = (shell ? terminalCommand(chord) : undefined) ?? terminalYields(chord, code);
    if (yielded) {
      e.preventDefault();
      e.stopPropagation();
      startCommand(yielded);
    } else if (terminalYieldable(chord) && !chordOf(chord, editorOnly) && (shell || declaredChord(chord) || (useCommandsStore.getState().contextKey === null && !editingChord(chord)))) {
      // Focusing a shell or selecting a thread changes the context (a Projects-page shell
      // brings its worktree): cmd+t or cmd+r right after it must not be lost to the
      // debounced re-list. In a prompt only for a chord some command declares: the
      // others edit (cmd+arrows, cmd+backspace) and must not be held. Before the first
      // list (the window opens on the composer, its prompt focused) nothing is declared
      // yet: a chord that does not edit waits for it, as it would outside the prompt.
      startWhenListed(e, chord, shell);
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
function startWhenListed(e: KeyboardEvent, chord: string, shell = false): void {
  const ctx = getUiContext();
  if (useCommandsStore.getState().contextKey === contextKey(ctx)) return;
  e.preventDefault();
  // Another refresh may abort this one (startup, context changes): wait for the list
  // for ctx from whichever refresh completes, not just this call.
  void refreshCommands(ctx)
    .then(() => whenListed(ctx))
    .then(() => {
      const late = (shell ? terminalCommand(chord) : undefined) ?? commandBindings(useCommandsStore.getState().commands).get(chord);
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
