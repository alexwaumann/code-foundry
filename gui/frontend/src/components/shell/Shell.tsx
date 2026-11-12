import { useEffect } from "react";
import { toast } from "sonner";
import { startComposerDrafts } from "@/shell/composerDrafts";
import { startSelectionBridge } from "@/stores/selectionBridge";
import { startFocusHistory } from "@/stores/focusHistory";
import { useLayoutStore } from "@/stores/layout";
import { setShellMode, useShellViewStore } from "@/stores/shellView";
import { escapeLeaves, fullscreenOn, leaveFullscreen } from "@/shell/fullscreen";
import { NeedsPopup } from "@/components/needs/NeedsPopup";
import { PaneGrid } from "./PaneGrid";

/** How long the window waits for the daemon's layout before it falls back to the classic window. */
export const LAYOUT_WAIT_MS = 5000;

/**
 * The window shell (docs/notes/shell-model.md) in the content area, behind the shell flag: the
 * current space's pane grid. It draws once the daemon's layout arrived; a daemon without one (an
 * older build) never sends it, and the window then stays classic and says so once (plan 2.12).
 * While it draws, the selection bridge runs: select() opens tabs and the selection follows the
 * focused tab. Tabs, panes and the sidebar's thread rows drag inside ShellDnd (App.tsx).
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
  // Composer drafts' text back from storage, kept there, dropped with the draft (shell/composerDrafts.ts).
  useEffect(() => (mode === "shell" ? startComposerDrafts() : undefined), [mode]);
  useEffect(() => (mode === "shell" ? startFocusHistory() : undefined), [mode]);
  // Escape leaves full screen when nothing before it took the key (a menu, a popover, the
  // floating composer collapsing, a terminal): this listener bubbles last, after the keymap's.
  useEffect(() => {
    if (mode !== "shell") return;
    const onKey = (e: KeyboardEvent) => {
      if (!fullscreenOn() || !escapeLeaves(e)) return;
      e.preventDefault();
      leaveFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      leaveFullscreen();
    };
  }, [mode]);
  return (
    // The top bar (TopBar) is the gap above the panes: they start right under it.
    <div className="m-shell mt-0 flex min-h-0 min-w-0 flex-1 flex-col" data-testid="shell" data-shell-mode={mode}>
      {mode === "shell" && <PaneGrid />}
      {/* The Needs-you popup (components/needs/NeedsPopup.tsx): one per window, over everything. */}
      {mode === "shell" && <NeedsPopup />}
    </div>
  );
}
