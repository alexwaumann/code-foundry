/**
 * The window shell's view state (docs/notes/shell-11-pane-grid.md, shell-19-rails-fullscreen.md): what one window draws
 * and is never stored in the daemon or in localStorage. The layout itself (spaces, panes, tabs,
 * the focused pane) is the daemon's (stores/layout.ts).
 *
 * - `mode`: this window waits for the daemon's layout (and the first-load import), or draws it.
 * - `frame`: the pane grid as last drawn (rectangles in layout px): the direction keys find
 *   neighbours on it (shell/keyPresenters.ts), as the spec says they do on the rendered frame.
 * - `focusRequest`: asks a pane to take the keyboard into its active tab (a key or a command
 *   moved the focus; a click puts the keyboard where it clicked by itself).
 * - `fullscreen`: the space full screen was turned on in ("" off). The pane it shows is always
 *   that space's focused pane (shell/fullscreen.ts); it ends when the window leaves the space.
 * - `floating`: the floating composer of a full-screened linked tab: expanded or a pill, and
 *   where it was dragged from its spot. Back to the start whenever full screen ends.
 * See docs/notes/shell-11-pane-grid.md and docs/notes/shell-19-rails-fullscreen.md.
 */
import { create } from "zustand";
import type { Frame } from "@/shell/geometry/types";

export type ShellMode = "waiting" | "shell";

interface ShellViewState {
  mode: ShellMode;
  /** The current space's frame as drawn; null before the grid has measured or with no pane. */
  frame: Frame | null;
  /** The pane asked to take the keyboard, and a counter so the same pane can be asked again. */
  focusRequest: { paneId: string; seq: number };
  /** Counts the focus requests that close a sheet over the window (requestPaneFocusOverSheets). */
  overSheetsSeq: number;
  /** The space full screen is on in; "" when it is off. */
  fullscreen: string;
  floating: FloatingState;
}

/** The floating composer: expanded or a pill, and its drag from the spot it opens at (layout px). */
export interface FloatingState {
  expanded: boolean;
  x: number;
  y: number;
}

export const FLOATING_START: FloatingState = { expanded: false, x: 0, y: 0 };

const INITIAL: ShellViewState = { mode: "waiting", frame: null, focusRequest: { paneId: "", seq: 0 }, overSheetsSeq: 0, fullscreen: "", floating: FLOATING_START };

export const useShellViewStore = create<ShellViewState>()(() => INITIAL);

export function setShellMode(mode: ShellMode): void {
  if (useShellViewStore.getState().mode !== mode) useShellViewStore.setState({ mode });
}

/** Whether the shell draws this window (the layout arrived and the first-load import settled). */
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

/**
 * Asks a pane to take the keyboard where a sheet over the window would keep it from it: a terminal
 * this window started or showed. The sheet closes (stores/views.ts startViewSync). Other requests
 * leave a sheet alone: one may arrive late (a tab drawn after a click), after the user opened it.
 */
export function requestPaneFocusOverSheets(paneId: string): void {
  useShellViewStore.setState((s) => ({ focusRequest: { paneId, seq: s.focusRequest.seq + 1 }, overSheetsSeq: s.overSheetsSeq + 1 }));
}

/** Full screen on in a space, or off (""); turning it off or on again puts the floating composer back at its start. */
export function setFullscreen(spaceId: string): void {
  const s = useShellViewStore.getState();
  if (s.fullscreen === spaceId) return;
  useShellViewStore.setState({ fullscreen: spaceId, floating: FLOATING_START });
}

export function setFloating(change: Partial<FloatingState>): void {
  useShellViewStore.setState((s) => ({ floating: { ...s.floating, ...change } }));
}

/** Back to the start (tests). */
export function resetShellView(): void {
  useShellViewStore.setState(INITIAL, true);
}
