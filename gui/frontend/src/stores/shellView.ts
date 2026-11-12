/**
 * The window shell's view state (docs/notes/shell-plan.md 2.5, 2.13): what one window draws
 * and is never stored in the daemon or in localStorage. The layout itself (spaces, panes, tabs,
 * the focused pane) is the daemon's (stores/layout.ts).
 *
 * - `mode`: the shell flag is on (shell/flag.ts) and this window waits for the daemon's layout,
 *   draws the shell, or fell back to the classic window (an older daemon sent no layout).
 * - `frame`: the pane grid as last drawn (rectangles in layout px): the direction keys find
 *   neighbours on it (shell/keys.ts), as the spec says they do on the rendered frame.
 * - `focusRequest`: asks a pane to take the keyboard into its active tab (a key or a command
 *   moved the focus; a click puts the keyboard where it clicked by itself).
 * See docs/notes/shell-11-pane-grid.md.
 */
import { create } from "zustand";
import type { Frame } from "@/shell/geometry/types";

export type ShellMode = "waiting" | "shell" | "classic";

interface ShellViewState {
  mode: ShellMode;
  /** The current space's frame as drawn; null before the grid has measured or with no pane. */
  frame: Frame | null;
  /** The pane asked to take the keyboard, and a counter so the same pane can be asked again. */
  focusRequest: { paneId: string; seq: number };
}

const INITIAL: ShellViewState = { mode: "waiting", frame: null, focusRequest: { paneId: "", seq: 0 } };

export const useShellViewStore = create<ShellViewState>()(() => INITIAL);

export function setShellMode(mode: ShellMode): void {
  if (useShellViewStore.getState().mode !== mode) useShellViewStore.setState({ mode });
}

/** Whether the shell draws this window (the flag is on and the layout arrived). */
export function shellDrawn(): boolean {
  return useShellViewStore.getState().mode === "shell";
}

export function setShellFrame(frame: Frame | null): void {
  useShellViewStore.setState({ frame });
}

/** Asks a pane to move the keyboard into its active tab. */
export function requestPaneFocus(paneId: string): void {
  useShellViewStore.setState((s) => ({ focusRequest: { paneId, seq: s.focusRequest.seq + 1 } }));
}

/** Back to the start (tests). */
export function resetShellView(): void {
  useShellViewStore.setState(INITIAL, true);
}
