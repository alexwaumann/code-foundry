import { useEffect, useState } from "react";
import { startComposerDrafts } from "@/shell/composerDrafts";
import { importSettled, runLegacyImport, useLegacyImportStore } from "@/shell/legacyImport";
import { startSelectionBridge } from "@/stores/selectionBridge";
import { startFocusHistory } from "@/stores/focusHistory";
import { startFileRequests } from "@/stores/fileRequestArrivals";
import { useLayoutStore } from "@/stores/layout";
import { setShellMode, useShellViewStore } from "@/stores/shellView";
import { escapeLeaves, fullscreenOn, leaveFullscreen } from "@/shell/fullscreen";
import { NeedsPopup } from "@/components/needs/NeedsPopup";
import { PaneGrid } from "./PaneGrid";
import { NewerLayoutLine, ShellNotice } from "./ShellNotice";

/** How long the window waits for the daemon's layout before it says it is waiting. */
export const LAYOUT_WAIT_MS = 5000;

/**
 * The window shell (docs/notes/shell-model.md): the current space's pane grid, the window's
 * default since the cutover (docs/notes/shell-20-cutover.md). It draws once the daemon's layout
 * arrived and the first-load import has run (shell/legacyImport.ts: once per daemon, before the
 * first draw, from the classic window's stored panels). A failed import shows what happened with
 * Try again and "Open without them" (ShellNotice). A daemon without a layout (one from before the
 * shell) never sends it: the update dialog asks for Restart Now (lib/update.ts SHELL_SINCE), and
 * after a wait the pane area says it is waiting; there is no classic fallback (plan 2.12).
 * While it draws, the selection bridge runs: select() opens tabs and the selection follows the
 * focused tab. Tabs, panes and the sidebar's thread rows drag inside ShellDnd (App.tsx).
 * See docs/notes/shell-11-pane-grid.md.
 */
export function Shell() {
  const loaded = useLayoutStore((s) => s.loaded);
  const imported = useLayoutStore((s) => s.legacyImported);
  const phase = useLegacyImportStore((s) => s.phase);
  const mode = useShellViewStore((s) => s.mode);
  const ready = importSettled(loaded, imported, phase);
  const [slow, setSlow] = useState(false);
  // Before the first draw: the import, once, when the daemon's layout says it has not run.
  useEffect(() => {
    if (loaded && !imported && phase === "idle") void runLegacyImport();
  }, [loaded, imported, phase]);
  useEffect(() => {
    if (ready) setShellMode("shell");
  }, [ready]);
  useEffect(() => {
    if (loaded) return;
    const timer = setTimeout(() => {
      setSlow(true);
    }, LAYOUT_WAIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [loaded]);
  useEffect(() => (mode === "shell" ? startSelectionBridge() : undefined), [mode]);
  // Composer drafts' text back from storage, kept there, dropped with the draft (shell/composerDrafts.ts).
  useEffect(() => (mode === "shell" ? startComposerDrafts() : undefined), [mode]);
  useEffect(() => (mode === "shell" ? startFocusHistory() : undefined), [mode]);
  // A thread's request to edit a file: the caret on its line with --focus, else behind the editor in use.
  useEffect(() => (mode === "shell" ? startFileRequests() : undefined), [mode]);
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
    <div className="relative m-shell mt-0 flex min-h-0 min-w-0 flex-1 flex-col" data-testid="shell" data-shell-mode={mode}>
      {mode === "shell" && <PaneGrid />}
      {/* A newer build's layout: shown, changed in memory, not saved (ShellNotice.tsx). */}
      {mode === "shell" && <NewerLayoutLine />}
      {mode !== "shell" && phase === "failed" && <ShellNotice kind="import-failed" />}
      {mode !== "shell" && !loaded && slow && <ShellNotice kind="no-layout" />}
      {/* The Needs-you popup (components/needs/NeedsPopup.tsx): one per window, over everything. */}
      {mode === "shell" && <NeedsPopup />}
    </div>
  );
}
