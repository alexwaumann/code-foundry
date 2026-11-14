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
import { shellFrame } from "./geometry/rails";
import { focusPane, geoTree, useLayoutStore } from "@/stores/layout";
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

/**
 * The pane the last focus key left, and the one it reached. The daemon's MRU holds the focused
 * pane's tab only when a focus touched it (a pane that took the focus because its neighbour
 * closed, or a layout loaded as stored, is not in it), so the pane a key just left counts as the
 * most recently focused one, whatever the MRU says, while the focus is still where the key took it.
 */
let left: { space: string; from: string; to: string; head: string } | null = null;

/** The head of a space's MRU, which tells whether anything was focused since a key moved the focus. */
const headOf = (mru: readonly string[]) => mru.slice(0, 2).join("\n");

/**
 * The neighbour on that side (rails included), the most recently focused of several; null in full
 * screen or with none. On the frame the grid draws for the layout as it is now: the drawn frame in
 * the view store lags a focus applied at once by a render, and with rails the focus decides what
 * folds, so a second key before the redraw would go from a stale frame (docs/notes/shell-25b-audits.md).
 */
function neighbourOn(dir: Direction): { space: string; from: string; to: string } | null {
  if (fullscreenOn()) return null;
  const s = useLayoutStore.getState();
  const space = s.spaces[s.currentSpaceId];
  const from = space?.focus ?? "";
  const drawn = useShellViewStore.getState().frame;
  if (!space || !from || !drawn) return null;
  const root = geoTree(s, space.id);
  const frame = shellFrame({ root, w: drawn.w, h: drawn.h, focus: from, mru: space.mru });
  const came = left?.space === space.id && left.to === from && left.head === headOf(space.mru) ? s.panes[left.from]?.active : undefined;
  const mru = came ? [came, ...space.mru.filter((m) => m !== came)] : space.mru;
  const to = neighbour(frame, from, dir, { root, mru });
  return to ? { space: space.id, from, to } : null;
}

/**
 * The pane moves sent and not yet in the layout. A move is not applied before the daemon answers,
 * so a second key meanwhile would find the same neighbour in the old tree and swap the pane back
 * (or focus a pane that is about to change places): a direction key waits for the moves before it
 * to land, then finds its neighbour. With none on its way it runs at once.
 */
let moving: Promise<void> | null = null;

/** The longest a move holds the keys back: a daemon that never answers must not stop them for good. */
export const MOVE_HOLD_MS = 3000;

function afterMoves(run: () => Promise<void> | void): void {
  if (!moving) {
    const p = run();
    if (p) track(p);
    return;
  }
  track(moving.then(run));
}

function track(p: Promise<void>): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const held = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, MOVE_HOLD_MS);
  });
  const mine: Promise<void> = Promise.race([p.catch(() => undefined), held]).finally(() => {
    clearTimeout(timer);
    if (moving === mine) moving = null;
  });
  moving = mine;
}

/** Focuses the neighbour on that side, and moves the keyboard there. Nothing in full screen. */
function focusSide(dir: Direction): void {
  const n = neighbourOn(dir);
  if (!n) return;
  void focusPane(n.to, async () => (await runLayoutCommand(`pane.focus.${dir}`, { pane: n.from, to: n.to, focus: "true" }))?.rev ?? null);
  // The focus is applied at once: the MRU's head now is the key's.
  left = { ...n, head: headOf(useLayoutStore.getState().spaces[n.space]?.mru ?? []) };
  requestPaneFocus(n.to);
}

/** Swaps the focused pane with its neighbour on that side. Nothing in full screen. */
async function moveSide(dir: Direction): Promise<void> {
  const n = neighbourOn(dir);
  if (!n) return;
  const res = await runLayoutCommand(`pane.move.${dir}`, { pane: n.from, to: n.to });
  if (res) await afterRev(res.rev);
}

/** Back to the start: no pane remembered, no move on its way (tests). */
export function resetKeyPresenters(): void {
  left = null;
  moving = null;
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
        afterMoves(() => {
          focusSide(dir);
        });
      }],
      [`pane.move.${dir}`, () => {
        afterMoves(() => moveSide(dir));
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
