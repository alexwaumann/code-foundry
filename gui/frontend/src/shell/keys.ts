/**
 * The interim key table (docs/notes/shell-plan.md 2.11): while the window shell draws the window,
 * these chords of the spec's key table (docs/notes/shell-model.md, "Keys") run the layout verbs
 * ahead of the registry's bindings, which still carry the classic window's chords (cmd+w closes a
 * side panel tab; cmd+shift+[ and ] go to the previous and next thread). Only the keys whose verbs
 * exist are here; the others arrive with their PRs, and at the cutover (PR 20) the chords move into
 * the commands' keybindings and this file goes. keys.test.ts checks it against the spec's table.
 * See docs/notes/shell-11-pane-grid.md.
 */
import { normalizeChord } from "@/keys/chord";
import { afterRev, focusTabNow, runLayoutCommand } from "./commands";
import { neighbour, type Direction } from "./geometry/neighbours";
import { focusPane, useLayoutStore } from "@/stores/layout";
import { focusedTab } from "@/stores/selectionBridge";
import { requestPaneFocus, useShellViewStore } from "@/stores/shellView";
import { autoNameFocusedTab, cycleTerminals, newFreeTerminalTab, newTerminalTab, quickKey, renameFocusedTab } from "./terminalActions";
import { toggleThreadInfo } from "@/stores/threadInfoOverlay";

export interface ShellKey {
  /** Canonical chords (keys/chord.ts). */
  chords: readonly string[];
  /** The "Key" cell of the spec's table row it implements, verbatim. */
  spec: string;
  /** The verb it runs. */
  command: string;
  run: () => void;
}

/** The current space's focused pane; "" when it has none. */
function focusedPane(): string {
  const s = useLayoutStore.getState();
  return s.spaces[s.currentSpaceId]?.focus ?? "";
}

/** After a verb that moved the focus (a close), the keyboard follows it into the newly focused pane. */
async function thenFocus(rev: number | undefined): Promise<void> {
  if (rev === undefined) return;
  await afterRev(rev);
  const pane = focusedPane();
  if (pane) requestPaneFocus(pane);
}

/** Focuses the neighbour on that side of the drawn frame (rails included), and moves the keyboard there. */
function focusSide(dir: Direction): void {
  const from = focusedPane();
  const frame = useShellViewStore.getState().frame;
  const to = frame && from ? neighbour(frame, from, dir) : null;
  if (!to) return;
  void focusPane(to, async () => (await runLayoutCommand(`pane.focus.${dir}`, { pane: from, to, focus: "true" }))?.rev ?? null);
  requestPaneFocus(to);
}

/** Swaps the focused pane with its neighbour on that side of the drawn frame. */
function moveSide(dir: Direction): void {
  const from = focusedPane();
  const frame = useShellViewStore.getState().frame;
  const to = frame && from ? neighbour(frame, from, dir) : null;
  if (to) void runLayoutCommand(`pane.move.${dir}`, { pane: from, to });
}

/** Focuses the tab `step` away from the focused one in its pane, round the strip. */
function stepTab(step: 1 | -1): void {
  const s = useLayoutStore.getState();
  const pane = s.panes[focusedPane()];
  if (!pane || pane.tabIds.length < 2) return;
  const i = pane.tabIds.indexOf(pane.active);
  const n = pane.tabIds.length;
  const next = pane.tabIds[(((i + step) % n) + n) % n];
  if (!next) return;
  void focusTabNow(next);
  requestPaneFocus(pane.id);
}

const DIRS: readonly [Direction, string, string][] = [
  ["left", "h", "arrowleft"],
  ["down", "j", "arrowdown"],
  ["up", "k", "arrowup"],
  ["right", "l", "arrowright"],
];

const PANE_KEYS = "ctrl+cmd+h j k l, ctrl+cmd+arrows";

export const SHELL_KEYS: readonly ShellKey[] = [
  {
    chords: ["cmd+w"],
    spec: "cmd+w",
    command: "tab.close",
    run: () => {
      const tab = focusedTab(useLayoutStore.getState());
      if (tab) void runLayoutCommand("tab.close", { tab: tab.id }).then((r) => thenFocus(r?.rev));
    },
  },
  {
    chords: ["cmd+shift+w"],
    spec: "cmd+shift+w",
    command: "pane.close",
    run: () => {
      const pane = focusedPane();
      if (pane) void runLayoutCommand("pane.close", { pane }).then((r) => thenFocus(r?.rev));
    },
  },
  { chords: ["cmd+shift+["], spec: "cmd+shift+[ / cmd+shift+]", command: "tab.previous", run: () => {
      stepTab(-1);
    },
  },
  { chords: ["cmd+shift+]"], spec: "cmd+shift+[ / cmd+shift+]", command: "tab.next", run: () => {
      stepTab(1);
    },
  },
  { chords: ["cmd+t"], spec: "cmd+t", command: "terminal.new", run: () => void newTerminalTab() },
  { chords: ["cmd+shift+t"], spec: "cmd+shift+t", command: "terminal.new-free", run: () => void newFreeTerminalTab() },
  { chords: ["cmd+j"], spec: "cmd+j", command: "terminal.quick", run: () => void quickKey() },
  { chords: ["cmd+shift+j"], spec: "cmd+shift+j", command: "terminal.cycle", run: () => void cycleTerminals() },
  { chords: ["cmd+r"], spec: "cmd+r", command: "tab.rename", run: renameFocusedTab },
  { chords: ["cmd+shift+r"], spec: "cmd+shift+r", command: "tab.rename", run: autoNameFocusedTab },
  {
    chords: ["cmd+shift+d"],
    spec: "cmd+shift+d",
    command: "view.thread-diff",
    // From a thread or a surface linked to it: the thread's diff; from that diff, back. The keyboard follows.
    run: () => {
      const tab = focusedTab(useLayoutStore.getState());
      if (tab) void runLayoutCommand("view.thread-diff", { tab: tab.id, focus: "true" }).then((r) => thenFocus(r?.rev));
    },
  },
  {
    chords: ["cmd+shift+i"],
    spec: "cmd+shift+i",
    command: "view.thread-info",
    // view.thread-info's presenter (keys/bindings.ts): the focused thread's card, or its overlay in a narrow pane, focused.
    run: () => {
      toggleThreadInfo(true);
    },
  },
  ...DIRS.flatMap(([dir, letter, arrow]): ShellKey[] => [
    { chords: [`cmd+ctrl+${letter}`, `cmd+ctrl+${arrow}`], spec: PANE_KEYS, command: `pane.focus.${dir}`, run: () => {
        focusSide(dir);
      },
    },
    { chords: [`cmd+ctrl+shift+${letter}`, `cmd+ctrl+shift+${arrow}`], spec: PANE_KEYS, command: `pane.move.${dir}`, run: () => {
        moveSide(dir);
      },
    },
  ]),
];

const byChord = new Map(SHELL_KEYS.flatMap((k) => k.chords.map((c) => [normalizeChord(c) ?? c, k] as const)));

/** The shell key for a canonical chord, if the table has one. */
export function shellKeyFor(chord: string): ShellKey | undefined {
  return byChord.get(chord);
}
