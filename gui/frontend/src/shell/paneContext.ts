/**
 * What a surface knows of the shell pane it is drawn in (docs/notes/shell-11-pane-grid.md).
 * Outside a pane (a test, the shot page) there is no pane: the defaults say
 * so, and a surface behaves as it always has.
 */
import { createContext, useContext } from "react";

export interface ShellPane {
  paneId: string;
  /** The pane has the space's focus. */
  focused: boolean;
}

export const ShellPaneContext = createContext<ShellPane | null>(null);

/** The shell pane around a surface; null outside the shell. */
export function useShellPane(): ShellPane | null {
  return useContext(ShellPaneContext);
}

/**
 * Whether a window-wide focus request (ui promptFocusSeq, contentFocusSeq) is this surface's to
 * serve: always outside the shell, and in it only in the focused pane, so two thread panes on
 * screen do not race for the keyboard.
 */
export function useServesFocusRequests(): boolean {
  const pane = useShellPane();
  return pane === null || pane.focused;
}
