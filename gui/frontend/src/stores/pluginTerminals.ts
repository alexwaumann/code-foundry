/**
 * Plugins' own terminals as tabs (docs/notes/plugins-6-thread-terminal.md). A plugin terminal
 * (lib/termlabel isPluginLabels) belongs to no thread or worktree, so it has no tab by itself:
 * "Open in a tab" on its terminal node asks the daemon to show it (ui.focus.terminal), which opens
 * its tab by the placement rules and focuses it. One Attach per terminal view: while the
 * terminal's tab shows in the current space, its node shows a note instead of a second xterm (two
 * would fight over the PTY's size). It was a tab of the classic bottom panel's strip until that
 * went (docs/notes/shell-21-remove-classic.md).
 */
import { runCommandForResult } from "./commands";
import { useLayoutStore, type LayoutState } from "./layout";

/** Shows a plugin's terminal in a tab of its own, with the keyboard; false when the daemon refused. */
export async function showPluginTerminal(id: string): Promise<boolean> {
  return (await runCommandForResult("ui.focus.terminal", { id }, { quiet: true })) !== null;
}

/** Whether a tab of the current space shows terminal `id` now (it holds the terminal's view). */
export function terminalShown(s: Pick<LayoutState, "currentSpaceId" | "panes" | "tabs">, id: string): boolean {
  return Object.values(s.panes).some((p) => {
    if (p.spaceId !== s.currentSpaceId) return false;
    const tab = s.tabs[p.active];
    return tab?.kind === "terminal" && tab.params.terminal === id;
  });
}

/** terminalShown as a hook. */
export function useTerminalShown(id: string): boolean {
  return useLayoutStore((s) => terminalShown(s, id));
}
