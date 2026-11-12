import { useEffect } from "react";
import { toast } from "sonner";
import { startSelectionBridge } from "@/stores/selectionBridge";
import { startFocusHistory } from "@/stores/focusHistory";
import { useLayoutStore } from "@/stores/layout";
import { setShellMode, useShellViewStore } from "@/stores/shellView";
import { PaneGrid } from "./PaneGrid";
import { ShellDnd } from "./ShellDnd";

/** How long the window waits for the daemon's layout before it falls back to the classic window. */
export const LAYOUT_WAIT_MS = 5000;

/**
 * The window shell (docs/notes/shell-model.md) in the content area, behind the shell flag: the
 * current space's pane grid. It draws once the daemon's layout arrived; a daemon without one (an
 * older build) never sends it, and the window then stays classic and says so once (plan 2.12).
 * While it draws, the selection bridge runs: select() opens tabs and the selection follows the
 * focused tab. Tabs and panes drag inside ShellDnd. The sidebar is still the classic one.
 * See docs/notes/shell-11-pane-grid.md.
 */
export function Shell() {
  const loaded = useLayoutStore((s) => s.loaded);
  const mode = useShellViewStore((s) => s.mode);
  useEffect(() => {
    if (loaded) {
      setShellMode("shell");
      return;
    }
    const timer = setTimeout(() => {
      if (useLayoutStore.getState().loaded) return;
      setShellMode("classic");
      toast.info("This daemon has no window layout yet: showing the classic window", { id: "shell-no-layout" });
    }, LAYOUT_WAIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [loaded]);
  useEffect(() => (mode === "shell" ? startSelectionBridge() : undefined), [mode]);
  useEffect(() => (mode === "shell" ? startFocusHistory() : undefined), [mode]);
  return (
    // The top bar (TopBar) is the gap above the panes: they start right under it.
    <div className="m-shell mt-0 flex min-h-0 min-w-0 flex-1 flex-col" data-testid="shell" data-shell-mode={mode}>
      {mode === "shell" && (
        <ShellDnd>
          <PaneGrid />
        </ShellDnd>
      )}
    </div>
  );
}
