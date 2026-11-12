/**
 * The window shell's presenters of the spec's key table (docs/notes/shell-model.md, "Keys").
 * The chords are the commands' default keybindings (internal/command; the settings page
 * rebinds them); a chord, the palette or a menu starts the command, and its presenter here does
 * it in this window: from the frame it draws (the neighbour of a pane), with the focus applied
 * before the daemon answers, and the keyboard following into the pane that has the focus after.
 * The CLI's run on the daemon. See docs/notes/shell-20-cutover.md.
 *
 * Called only while the shell draws the window and with no args of the caller's own (a caller
 * that names its tab or pane invokes the verb as it is). keys/bindings.ts presentCommand.
 */
import { afterRev, focusTabNow, runLayoutCommand } from "./commands";
import { closePaneAsked, closeTabAsked } from "./closeTab";
import { neighbour, type Direction } from "./geometry/neighbours";
import { focusPane, useLayoutStore } from "@/stores/layout";
import { focusedTab } from "@/stores/selectionBridge";
import { requestPaneFocus, useShellViewStore } from "@/stores/shellView";
import { autoNameFocusedTab, cycleTerminals, newFreeTerminalTab, newTerminalTab, quickKey, renameFocusedTab } from "./terminalActions";
import { fullscreenOn } from "./fullscreen";

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

/** The neighbour on that side of the drawn frame (rails included); null in full screen or with none. */
function neighbourOn(dir: Direction): { from: string; to: string } | null {
  if (fullscreenOn()) return null;
  const from = focusedPane();
  const frame = useShellViewStore.getState().frame;
  const to = frame && from ? neighbour(frame, from, dir) : null;
  return to ? { from, to } : null;
}

/** Focuses the neighbour on that side, and moves the keyboard there. Nothing in full screen. */
function focusSide(dir: Direction): void {
  const n = neighbourOn(dir);
  if (!n) return;
  void focusPane(n.to, async () => (await runLayoutCommand(`pane.focus.${dir}`, { pane: n.from, to: n.to, focus: "true" }))?.rev ?? null);
  requestPaneFocus(n.to);
}

/** Swaps the focused pane with its neighbour on that side. Nothing in full screen. */
function moveSide(dir: Direction): void {
  const n = neighbourOn(dir);
  if (n) void runLayoutCommand(`pane.move.${dir}`, { pane: n.from, to: n.to });
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

const DIRECTIONS: readonly Direction[] = ["left", "down", "up", "right"];

/** command name -> what it does in the shell window. Each returns true: it was presented. */
export const SHELL_PRESENTERS: Readonly<Record<string, () => void>> = {
  "tab.close": () => {
    const tab = focusedTab(useLayoutStore.getState());
    // A tab with unsaved work asks first (shell/closeTab.ts).
    if (tab) void closeTabAsked(tab.id).then((r) => thenFocus(r?.rev));
  },
  "pane.close": () => {
    const pane = focusedPane();
    if (pane) void closePaneAsked(pane).then((r) => thenFocus(r?.rev));
  },
  "tab.previous": () => {
    stepTab(-1);
  },
  "tab.next": () => {
    stepTab(1);
  },
  "terminal.new": () => void newTerminalTab(),
  "terminal.new-free": () => void newFreeTerminalTab(),
  "terminal.quick": () => void quickKey(),
  "terminal.cycle": () => void cycleTerminals(),
  "tab.rename": renameFocusedTab,
  "tab.auto-name": autoNameFocusedTab,
  // From a thread or a surface linked to it: the thread's diff; from that diff, back. The keyboard follows.
  "view.thread-diff": () => {
    const tab = focusedTab(useLayoutStore.getState());
    if (tab) void runLayoutCommand("view.thread-diff", { tab: tab.id, focus: "true" }).then((r) => thenFocus(r?.rev));
  },
  ...Object.fromEntries(
    DIRECTIONS.flatMap((dir) => [
      [`pane.focus.${dir}`, () => {
        focusSide(dir);
      }],
      [`pane.move.${dir}`, () => {
        moveSide(dir);
      }],
    ]),
  ),
};

/**
 * Presents a command of the key table in the shell window: true when it did. Undefined for a
 * command it has nothing for, or one started with args of the caller's own (it is invoked as it is).
 */
export function presentShellCommand(name: string, args?: Readonly<Record<string, string>>): boolean | undefined {
  const present = SHELL_PRESENTERS[name];
  if (!present || (args && Object.keys(args).length > 0)) return undefined;
  present();
  return true;
}
