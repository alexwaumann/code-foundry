import type { CommandView } from "@/api/command";
import { terminalOrder } from "@/lib/tree";
import { runCommand, useCommandsStore } from "@/stores/commands";
import { getTreeInputs } from "@/stores/context";
import { useUiStore } from "@/stores/ui";
import { chordFromEvent, normalizeChord } from "./chord";

/**
 * GUI-local view actions. They change only what the window shows (palette, sidebar,
 * zoom), never daemon state, so they are not registry commands. Every chord here is
 * "global": it wins even when the terminal has focus.
 */
export interface ViewAction {
  chord: string;
  title: string;
  run: () => void;
}

function jumpTo(n: number): void {
  const { repos, terminals } = getTreeInputs();
  const id = terminalOrder(repos, terminals)[n - 1];
  if (id) useUiStore.getState().select({ kind: "terminal", id }, { focusTerminal: true });
}

function togglePalette(): void {
  const ui = useUiStore.getState();
  if (ui.palette.open) ui.closePalette();
  else ui.openPalette();
}

function toggleSidebar(): void {
  const ui = useUiStore.getState();
  if (ui.sidebarVisible) {
    ui.toggleSidebar();
    if (ui.selection.kind === "terminal") useUiStore.setState((s) => ({ terminalFocusSeq: s.terminalFocusSeq + 1 }));
  } else {
    ui.focusSidebar();
  }
}

function zoom(delta: number | null): void {
  const ui = useUiStore.getState();
  ui.setFontSize(delta === null ? 13 : ui.fontSize + delta);
}

export const viewActions: readonly ViewAction[] = [
  { chord: "cmd+k", title: "Command palette", run: togglePalette },
  { chord: "cmd+shift+p", title: "Command palette", run: togglePalette },
  { chord: "cmd+b", title: "Toggle sidebar", run: toggleSidebar },
  ...Array.from({ length: 9 }, (_, i) => ({
    chord: `cmd+${String(i + 1)}`,
    title: `Jump to terminal ${String(i + 1)}`,
    run: () => {
      jumpTo(i + 1);
    },
  })),
  { chord: "cmd+=", title: "Increase font size", run: () => { zoom(1); } },
  { chord: "cmd+-", title: "Decrease font size", run: () => { zoom(-1); } },
  { chord: "cmd+0", title: "Reset font size", run: () => { zoom(null); } },
];

const viewActionMap = new Map(viewActions.map((a) => [normalizeChord(a.chord) ?? a.chord, a]));

/** True when the chord must reach the app even while xterm has focus. */
export function isGlobalChord(chord: string): boolean {
  return viewActionMap.has(chord);
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

/** Starts a command from the keyboard or palette: prompts for required args, else invokes. */
export function startCommand(c: CommandView): void {
  if (c.args.some((a) => a.required)) useUiStore.getState().openPalette("", c.name);
  else void runCommand(c.name);
}

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest("[data-terminal-host]")) return false; // xterm's hidden textarea
  return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/**
 * Key precedence:
 *  1. Global view actions (cmd+k, cmd+shift+p, cmd+b, cmd+1..9, zoom) always win.
 *  2. A focused terminal consumes everything else (the PTY gets it).
 *  3. A focused text field (palette input) consumes everything else.
 *  4. Command keybindings from CommandService.List for the current context.
 */
export function handleKeyDown(e: KeyboardEvent): void {
  if (e.isComposing || e.defaultPrevented) return;
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
  if (target?.closest("[data-terminal-host]")) return;
  if (isEditable(target) || useUiStore.getState().palette.open) return;
  const cmd = commandBindings(useCommandsStore.getState().commands).get(chord);
  if (!cmd) return;
  e.preventDefault();
  e.stopPropagation();
  startCommand(cmd);
}

/** Installs the global key handler (capture phase, ahead of xterm). */
export function installKeybindings(target: Window = window): () => void {
  target.addEventListener("keydown", handleKeyDown, { capture: true });
  return () => {
    target.removeEventListener("keydown", handleKeyDown, { capture: true });
  };
}
