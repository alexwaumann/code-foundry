import type { CommandView } from "@/api/command";
import { promptedArgs } from "@/palette/args";
import { leafOrder, nextAfter, sessionOrder } from "@/lib/tree";
import { refreshCommands, runCommand, useCommandsStore, whenListed } from "@/stores/commands";
import { contextKey, getListInputs, getUiContext } from "@/stores/context";
import { openAddProject } from "@/stores/addProject";
import { openNewThreadPicker } from "@/stores/compose";
import { attentionIds, useSessionsStore } from "@/stores/sessions";
import { zoomFont } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { openUpdateDialog, runUpdateAction } from "@/stores/update";
import { expandPanelCommand, linkedPrsPanelCommand, showView, toggleHelp, togglePanelCommand, workspacePanelCommand } from "@/stores/views";
import { chordFromEvent, normalizeChord, terminalYieldable } from "./chord";

/**
 * GUI-local view actions. They change only what the window shows (palette, sidebar,
 * zoom, which row is selected), never daemon state, so they are not registry commands.
 * Every chord here is "global": it wins even when the terminal has focus.
 */
export interface ViewAction {
  chord: string;
  title: string;
  run: () => void;
}

/** Selects the Nth thread or terminal in sidebar order. */
function jumpTo(n: number): void {
  const { sessions, terminals } = getListInputs();
  const row = leafOrder(sessions, terminals)[n - 1];
  if (!row) return;
  const sel = row.kind === "session" ? ({ kind: "session", id: row.sessionId } as const) : ({ kind: "terminal", id: row.terminalId } as const);
  useUiStore.getState().select(sel, { focusTerminal: true });
}

/** Selects the next session that needs attention after the current one, wrapping. */
export function jumpToAttention(): boolean {
  const { sessions, terminals } = getListInputs();
  const waiting = new Set(attentionIds(useSessionsStore.getState()));
  const sel = useUiStore.getState().selection;
  const next = nextAfter(sessionOrder(sessions, terminals), sel.kind === "session" ? sel.id : null, (id) => waiting.has(id));
  if (next === null) return false;
  useUiStore.getState().select({ kind: "session", id: next }, { focusTerminal: true });
  return true;
}

function togglePalette(): void {
  const ui = useUiStore.getState();
  if (ui.palette.open) ui.closePalette();
  else ui.openPalette();
}

function focusContentTerminal(): void {
  const kind = useUiStore.getState().selection.kind;
  if (kind === "terminal" || kind === "session") useUiStore.setState((s) => ({ terminalFocusSeq: s.terminalFocusSeq + 1 }));
}

function toggleSidebar(): void {
  const ui = useUiStore.getState();
  if (ui.sidebarVisible) {
    ui.toggleSidebar();
    focusContentTerminal();
  } else {
    ui.focusSidebar();
  }
}

/** Font size; saved to appearance.font_size in the settings file. */
function zoom(delta: number | null): void {
  zoomFont(delta);
}

export const viewActions: readonly ViewAction[] = [
  { chord: "cmd+k", title: "Command palette", run: togglePalette },
  { chord: "cmd+shift+p", title: "Command palette", run: togglePalette },
  { chord: "cmd+b", title: "Toggle sidebar", run: toggleSidebar },
  { chord: "cmd+shift+a", title: "Next thread needing attention", run: () => void jumpToAttention() },
  ...Array.from({ length: 9 }, (_, i) => ({
    chord: `cmd+${String(i + 1)}`,
    title: `Jump to item ${String(i + 1)}`,
    run: () => {
      jumpTo(i + 1);
    },
  })),
  { chord: "cmd+=", title: "Increase font size", run: () => { zoom(1); } },
  { chord: "cmd+-", title: "Decrease font size", run: () => { zoom(-1); } },
  { chord: "cmd+0", title: "Reset font size", run: () => { zoom(null); } },
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
const paletteSupplied: ReadonlySet<string> = new Set(["session.new", "session.run-in", "repo.clone"]);

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
 * The command a focused terminal yields this chord to (see terminalYieldable). Sessions
 * are terminals, so without this session.close/rename/reconnect would never fire from
 * the main view.
 */
function terminalYields(chord: string): CommandView | undefined {
  if (!terminalYieldable(chord)) return undefined;
  return commandBindings(useCommandsStore.getState().commands).get(chord);
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
  // The Add Project dialog; its tabs invoke repo.register, or stream RepoService.Clone
  // (repo.clone's CLI form). repo.clone opens it on the GitHub tab.
  "repo.add": () => {
    openAddProject();
    return true;
  },
  "repo.clone": () => {
    openAddProject("github");
    return true;
  },
  // Window-local: only this window opens, without a round trip (the CLI and palette
  // reach every window through UiIntent.ShowView instead).
  "view.settings": () => showView("settings"),
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

/** Starts a command from the keyboard or palette: prompts for args it needs, else invokes. */
export function startCommand(c: CommandView): void {
  if (presentCommand(c.name)) return;
  if (promptedArgs(c).length > 0) useUiStore.getState().openPalette("", c.name);
  else void runCommand(c.name);
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
  return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/**
 * Key precedence:
 *  1. Global view actions (cmd+k, cmd+shift+p, cmd+b, cmd+shift+a, cmd+1..9, zoom) always win
 *     (cmd+1..9 belong to the project picker while it is open).
 *  2. A focused terminal consumes everything else, except cmd chords bound to commands
 *     (see terminalYields).
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
  if (target?.closest("[data-terminal-host]")) {
    const yielded = terminalYields(chord);
    if (!yielded || useUiStore.getState().palette.open) return;
    e.preventDefault();
    e.stopPropagation();
    startCommand(yielded);
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
  if (cmd) {
    e.preventDefault();
    e.stopPropagation();
    startCommand(cmd);
    return;
  }
  // Clicking a worktree and pressing cmd+n at once beats the debounced re-list: when the
  // list is for an older context, re-list now and look the chord up again.
  const ctx = getUiContext();
  if (/^(cmd|ctrl|alt)\+/.test(chord) && useCommandsStore.getState().contextKey !== contextKey(ctx)) {
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
}

/** Installs the global key handler (capture phase, ahead of xterm). */
export function installKeybindings(target: Window = window): () => void {
  target.addEventListener("keydown", handleKeyDown, { capture: true });
  return () => {
    target.removeEventListener("keydown", handleKeyDown, { capture: true });
  };
}
