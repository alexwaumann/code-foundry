import { useEffect } from "react";
import { AddProjectDialog } from "@/components/addproject/AddProjectDialog";
import { ActionDialog } from "@/components/actions/ActionDialog";
import { ActionRunDialog } from "@/components/actions/ActionRunDialog";
import { NewWorkspaceDialog } from "@/components/projects/NewWorkspaceDialog";
import { CleanupWorktreesDialog } from "@/components/projects/CleanupWorktreesDialog";
import { RemoveWorktreeDialog } from "@/components/projects/RemoveWorktreeDialog";
import { PublishDialog } from "@/components/publish/PublishDialog";
import { SaveWorkspaceDialog } from "@/components/thread/SaveWorkspaceDialog";
import { SnoozeDialog } from "@/components/snooze/SnoozeDialog";
import { ConfirmDialog } from "@/components/confirm/ConfirmDialog";
import { ConsentDialog } from "@/components/plugin/ConsentDialog";
import { HelpOverlay } from "@/components/help/HelpOverlay";
import { SettingsSheet } from "@/components/settings/SettingsSheet";
import { UsageSheet } from "@/components/usage/UsageSheet";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { RemoveSpaceDialog } from "@/components/shell/RemoveSpaceDialog";
import { Shell } from "@/components/shell/Shell";
import { ShellDnd } from "@/components/shell/ShellDnd";
import { TopBar } from "@/components/shell/TopBar";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UpdateDialog } from "@/components/update/UpdateDialog";
import { installKeybindings } from "@/keys/bindings";
import { installInputModality } from "@/lib/inputModality";
import { startMenuCommands } from "@/keys/menu";
import { startThemePublish, syncDocumentScheme, useColorScheme } from "@/lib/theme";
import { startThemeReports } from "@/lib/themeReports";
import { syncWindowBackground } from "@/lib/windowBackground";
import { useWindowTitle } from "@/lib/title";
import { startCommandSync } from "@/stores/commands";
import { startEventSync } from "@/stores/events";
import { startHealthPolling } from "@/stores/health";
import { startWindowFocus } from "@/stores/windowFocus";
import { useAttentionCount } from "@/stores/threads";
import { startZoomSync } from "@/lib/zoom";
import { useUiStore, type FocusRegion } from "@/stores/ui";
import { startViewSync } from "@/stores/views";
import { startFileEditGuards } from "@/stores/fileEditGuards";
import { startArchiveCleanup } from "@/stores/archiveCleanup";
import { startWelcomeSync } from "@/stores/welcome";
import { startDockAlerts } from "@/stores/dockAlerts";
import { startUpdateSync } from "@/stores/update";
import { startRecentFiles } from "@/stores/recentFiles";

function regionOf(el: EventTarget | null): FocusRegion {
  const region = el instanceof Element ? el.closest("[data-region]")?.getAttribute("data-region") : null;
  return region === "sidebar" || region === "palette" ? region : "content";
}

/**
 * Starts the daemon sync and global listeners; returns one stop function. Long-lived
 * streams: one EventService.Watch (all slices) plus a ThreadService.WatchThread per visible
 * thread view and a TerminalService.Attach per visible terminal view (the panes' tabs).
 */
function startApp(): () => void {
  const onFocusIn = (e: FocusEvent) => {
    useUiStore.getState().setFocus(regionOf(e.target));
  };
  document.addEventListener("focusin", onFocusIn);
  const stops = [
    startZoomSync(),
    syncDocumentScheme(),
    startThemePublish(),
    startThemeReports(),
    syncWindowBackground(),
    startHealthPolling(2000),
    startEventSync(),
    startCommandSync(),
    // Before the key handler, so a chord's command sees its own key as the last input.
    installInputModality(),
    installKeybindings(),
    startViewSync(),
    startArchiveCleanup(),
    startFileEditGuards(),
    startWelcomeSync(),
    startUpdateSync(),
    startMenuCommands(),
    startDockAlerts(),
    startRecentFiles(),
    startWindowFocus(),
  ];
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    for (const stop of stops) stop();
  };
}

export function App() {
  useEffect(() => startApp(), []);
  const scheme = useColorScheme();
  // Settings, Themes and Usage are modal sheets over the window (SettingsSheet,
  // UsageSheet), which stays laid out under them.
  useWindowTitle(useAttentionCount());

  return (
    // The sheet: one background under the top bar, the sidebar and the window shell's panes
    // (components/shell, docs/notes/shell-model.md). One TooltipProvider for the whole window
    // (docs/notes/theme-3-tooltips.md): its 500 ms delay, and the skip delay when moving from one
    // tooltip trigger to the next, apply across the sidebar, panes and dialogs.
    <TooltipProvider>
      <div className="relative flex h-full flex-col overflow-hidden bg-cf-canvas text-cf-text">
        {/* The sheet above the panes drags the window too, so it has a drag surface whatever
            shows under the top bar. It is the shell gap tall. */}
        <div className="absolute inset-x-0 top-0 h-shell [--wails-draggable:drag]" data-testid="window-drag-edge" aria-hidden />
        {/* The top bar spans the window above the sidebar and the panes (shell-model.md, "Structure"). */}
        <TopBar />
        {/* The drag layer spans the sidebar too: its thread rows drag into the grid and onto the
            bar's space tabs (found in the document, ShellDnd measureTopBar). */}
        <ShellDnd>
          <div className="flex min-h-0 flex-1">
            <Sidebar />
            <Shell />
          </div>
        </ShellDnd>
        <SettingsSheet />
        <UsageSheet />
        <CommandPalette />
        <HelpOverlay />
        <ConfirmDialog />
        <RemoveWorktreeDialog />
        <CleanupWorktreesDialog />
        <ConsentDialog />
        <UpdateDialog />
        <AddProjectDialog />
        <PublishDialog />
        <NewWorkspaceDialog />
        <SnoozeDialog />
        <SaveWorkspaceDialog />
        <ActionDialog />
        <ActionRunDialog />
        <RemoveSpaceDialog />
        <Toaster theme={scheme} position="bottom-right" offset={{ bottom: 20, right: 20 }} />
      </div>
    </TooltipProvider>
  );
}
