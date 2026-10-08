import type { CommandView } from "@/api/command";
import { promptedArgs } from "@/palette/args";
import { leafOrder, nextAfter, sessionOrder } from "@/lib/tree";
import { refreshCommands, runCommand, useCommandsStore, whenListed } from "@/stores/commands";
import { contextKey, getTreeInputs, getUiContext } from "@/stores/context";
import { attentionIds, useSessionsStore } from "@/stores/sessions";
import { zoomFont } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { showView, toggleHelp } from "@/stores/views";
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

/** Selects the Nth session or terminal in sidebar order (ignoring collapse). */
function jumpTo(n: number): void {
  const { repos, terminals, sessions } = getTreeInputs();
  const row = leafOrder(repos, terminals, sessions)[n - 1];
  if (!row) return;
  const sel = row.kind === "session" ? ({ kind: "session", id: row.sessionId } as const) : ({ kind: "terminal", id: row.terminalId } as const);
  useUiStore.getState().select(sel, { focusTerminal: true });
}

/** Selects the next session that needs attention after the current one, wrapping. */
export function jumpToAttention(): boolean {
  const { repos, terminals, sessions } = getTreeInputs();
  const waiting = new Set(attentionIds(useSessionsStore.getState()));
  const sel = useUiStore.getState().selection;
  const next = nextAfter(sessionOrder(repos, terminals, sessions), sel.kind === "session" ? sel.id : null, (id) => waiting.has(id));
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
  { chord: "cmd+shift+a", title: "Next session needing attention", run: () => void jumpToAttention() },
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

let bindingCache: { commands: readonly CommandView[]; map: Map<string, CommandView> } | null = null;

/** chord -> command, from Command.keybindings. Only available commands bind. */
export function commandBindings(commands: readonly CommandView[]): Map<string, CommandView> {
  if (bindingCache?.commands === commands) return bindingCache.map;
  const map = new Map<string, CommandView>();
  for (const c of commands) {
    if (!c.available) continue;
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
  // Window-local: only this window opens, without a round trip (the CLI and palette
  // reach every window through UiIntent.ShowView instead).
  "view.settings": () => showView("settings"),
  "view.help": () => {
    toggleHelp();
    return true;
  },
};

/** Starts a command from the keyboard or palette: prompts for args it needs, else invokes. */
export function startCommand(c: CommandView): void {
  if (commandPresenters[c.name]?.()) return;
  if (promptedArgs(c).length > 0) useUiStore.getState().openPalette("", c.name);
  else void runCommand(c.name);
}

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest("[data-terminal-host]")) return false; // xterm's hidden textarea
  return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/**
 * Key precedence:
 *  1. Global view actions (cmd+k, cmd+shift+p, cmd+b, cmd+shift+a, cmd+1..9, zoom) always win.
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
