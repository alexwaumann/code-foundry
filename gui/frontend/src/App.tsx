import { useEffect, useRef, type ReactNode } from "react";
import { Composer } from "@/components/compose/Composer";
import { AddProjectDialog } from "@/components/addproject/AddProjectDialog";
import { PublishDialog } from "@/components/publish/PublishDialog";
import { ConfirmDialog } from "@/components/confirm/ConfirmDialog";
import { StartPage } from "@/components/start/StartPage";
import { HelpOverlay } from "@/components/help/HelpOverlay";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { ProjectsPage } from "@/components/projects/ProjectsPage";
import { PullRequestsPage } from "@/components/prs/PullRequestsPage";
import { SessionDisconnected } from "@/components/session/SessionParts";
import { SidePanel } from "@/components/panel/SidePanel";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { Toaster } from "@/components/ui/sonner";
import { UpdateDialog } from "@/components/update/UpdateDialog";
import { installKeybindings } from "@/keys/bindings";
import { syncDocumentScheme, useColorScheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useWindowTitle } from "@/lib/title";
import { startCommandSync } from "@/stores/commands";
import { startEventSync } from "@/stores/events";
import { startHealthPolling } from "@/stores/health";
import { usePanelExpanded } from "@/stores/panel";
import { useAttentionCount, useSessionsStore } from "@/stores/sessions";
import { layoutWidth, startZoomSync } from "@/lib/zoom";
import { CONTENT_MIN, useUiStore, type FocusRegion } from "@/stores/ui";
import { startViewSync, useViewsStore } from "@/stores/views";
import { startUpdateSync } from "@/stores/update";

function regionOf(el: EventTarget | null): FocusRegion {
  const region = el instanceof Element ? el.closest("[data-region]")?.getAttribute("data-region") : null;
  return region === "sidebar" || region === "terminal" || region === "palette" || region === "panel" ? region : "content";
}

/**
 * Starts the daemon sync and global listeners; returns one stop function. Long-lived
 * connections: one EventService.Watch (all slices) plus the visible terminal's Attach.
 */
function startApp(): () => void {
  const onFocusIn = (e: FocusEvent) => {
    useUiStore.getState().setFocus(regionOf(e.target));
  };
  document.addEventListener("focusin", onFocusIn);
  // The side panel's bounds depend on the window width in layout px (stores/ui.ts
  // panelMax), which the page zoom divides (lib/zoom.ts layoutWidth).
  const onResize = () => {
    useUiStore.getState().setWindowWidth(layoutWidth());
  };
  window.addEventListener("resize", onResize);
  onResize();
  const stops = [
    startZoomSync(onResize),
    syncDocumentScheme(),
    startHealthPolling(2000),
    startEventSync(),
    startCommandSync(),
    installKeybindings(),
    startViewSync(),
    startUpdateSync(),
  ];
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    window.removeEventListener("resize", onResize);
    for (const stop of stops) stop();
  };
}

/**
 * Exactly one thing fills the content area. A session shows its live terminal when it
 * has one, otherwise the "Not connected" panel; "compose" is the new-thread composer. TerminalPane stays mounted across
 * terminal/session switches (same element position), so its renderer is reused.
 */
function Content() {
  const sel = useUiStore((s) => s.selection);
  const sessionTerminal = useSessionsStore((s) => (sel.kind === "session" ? s.byId[sel.id]?.terminalId || null : null));
  if (sel.kind === "terminal") return <TerminalPane terminalId={sel.id} />;
  if (sel.kind === "view" && sel.name === "pullrequests") return <PullRequestsPage />;
  if (sel.kind === "view" && sel.name === "projects") return <ProjectsPage />;
  if (sel.kind === "compose") return <Composer key={sel.workspaceId ? `ws:${sel.workspaceId}` : sel.repoId} repoId={sel.repoId} workspaceId={sel.workspaceId} />;
  if (sel.kind === "session") {
    return sessionTerminal ? <TerminalPane terminalId={sessionTerminal} sessionId={sel.id} /> : <SessionDisconnected id={sel.id} />;
  }
  return <StartPage />;
}

/**
 * The content pane. Hidden (display: none), not unmounted, while the side panel is
 * expanded over it: the terminal keeps its Attach stream and xterm state, and its fit
 * skips the zero-size host (terminal/xterm.ts). On a focus request (ui contentFocusSeq) it focuses the page's
 * `[data-focus-root]` element (a page's keyboard list or its root section); a terminal
 * answers the same request itself (TerminalPane), and has no focus root.
 */
function ContentPane({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const focusSeq = useUiStore((s) => s.contentFocusSeq);
  useEffect(() => {
    if (focusSeq === 0) return;
    ref.current?.querySelector<HTMLElement>("[data-focus-root]")?.focus({ preventScroll: true });
  }, [focusSeq]);
  return (
    <main
      ref={ref}
      className={cn("m-2 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-pane-border bg-pane shadow-xs", hidden ? "hidden" : "flex")}
      // The side panel shrinks, then hides, before the content pane gets narrower than this.
      style={{ minWidth: CONTENT_MIN }}
      data-testid="content-pane"
    >
      {children}
    </main>
  );
}

export function App() {
  useEffect(() => startApp(), []);
  const scheme = useColorScheme();
  const settingsOpen = useViewsStore((s) => s.settingsOpen);
  // Settings hides the panel, so the content pane shows the settings page even then.
  const panelExpanded = usePanelExpanded() && !settingsOpen;
  useWindowTitle(useAttentionCount());

  return (
    // The sheet: one background under the sidebar. The content area is a pane floating
    // on it (rounded, lighter, 8px in from its neighbours and the window's top, right
    // and bottom edges); the selection's side panel, when open, is a second pane to its
    // right (components/panel, docs/notes/side-panel.md). Nothing spans the title band
    // (components/window/titleBand.ts): the sidebar's top band and the pane headers fill it.
    <div className="relative flex h-full flex-col overflow-hidden bg-sheet text-foreground">
      {/* The sheet above the panes drags the window too (as the sidebar band and the pane
          headers do), so a page without a header (dashboard, composer, a disconnected
          thread) still has a drag surface when the sidebar is hidden. */}
      <div className="absolute inset-x-0 top-0 h-2 [--wails-draggable:drag]" data-testid="window-drag-edge" aria-hidden />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <ContentPane hidden={panelExpanded}>{settingsOpen ? <SettingsPage /> : <Content />}</ContentPane>
        <SidePanel />
      </div>
      <CommandPalette />
      <HelpOverlay />
      <ConfirmDialog />
      <UpdateDialog />
      <AddProjectDialog />
      <PublishDialog />
      <Toaster theme={scheme} position="bottom-right" offset={{ bottom: 20, right: 20 }} />
    </div>
  );
}
