import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Composer } from "@/components/compose/Composer";
import { AddProjectDialog } from "@/components/addproject/AddProjectDialog";
import { BottomPanel } from "@/components/bottom/BottomPanel";
import { PublishDialog } from "@/components/publish/PublishDialog";
import { ConfirmDialog } from "@/components/confirm/ConfirmDialog";
import { StartPage } from "@/components/start/StartPage";
import { HelpOverlay } from "@/components/help/HelpOverlay";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { UsagePage } from "@/components/usage/UsagePage";
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
import { layoutWidth, startZoomSync, zoomFactor } from "@/lib/zoom";
import { CONTENT_MIN, useUiStore, type FocusRegion } from "@/stores/ui";
import { selectPageOpen, startViewSync, useViewsStore } from "@/stores/views";
import { startUpdateSync } from "@/stores/update";

function regionOf(el: EventTarget | null): FocusRegion {
  const region = el instanceof Element ? el.closest("[data-region]")?.getAttribute("data-region") : null;
  return region === "sidebar" || region === "terminal" || region === "palette" || region === "panel" || region === "bottom" ? region : "content";
}

/**
 * Starts the daemon sync and global listeners; returns one stop function. Long-lived
 * connections: one EventService.Watch (all slices) plus an Attach for the content pane's
 * terminal and one for the bottom panel's active terminal, each only while visible.
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
  if (sel.kind === "view" && sel.name === "dashboard") return <StartPage />;
  if (sel.kind === "view" && sel.name === "pullrequests") return <PullRequestsPage />;
  if (sel.kind === "view" && sel.name === "projects") return <ProjectsPage />;
  if (sel.kind === "compose") return <Composer key={sel.workspaceId ? `ws:${sel.workspaceId}` : sel.repoId} repoId={sel.repoId} workspaceId={sel.workspaceId} />;
  if (sel.kind === "session") {
    return sessionTerminal ? <TerminalPane terminalId={sessionTerminal} sessionId={sel.id} /> : <SessionDisconnected id={sel.id} />;
  }
  return <StartPage />;
}

/**
 * The content pane: the page or terminal the selection shows. On a focus request (ui
 * contentFocusSeq) it focuses the page's `[data-focus-root]` element (a page's keyboard
 * list or its root section); a terminal answers the same request itself (TerminalPane),
 * and has no focus root.
 */
function ContentPane({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const focusSeq = useUiStore((s) => s.contentFocusSeq);
  useEffect(() => {
    if (focusSeq === 0) return;
    ref.current?.querySelector<HTMLElement>("[data-focus-root]")?.focus({ preventScroll: true });
  }, [focusSeq]);
  return (
    <main
      ref={ref}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-pane-border bg-pane shadow-xs"
      data-testid="content-pane"
    >
      {children}
    </main>
  );
}

/**
 * An element's height in layout px (viewport px divided by the page zoom, lib/zoom.ts),
 * kept current with a ResizeObserver. 0 while it is hidden.
 */
function useColumnHeight(ref: RefObject<HTMLElement | null>, hidden: boolean): number {
  const [h, setH] = useState(0);
  // Measured again when `hidden` flips, before paint: shown again (the side panel left full
  // width), the bottom panel must not render one frame at its unclamped height (its
  // terminal would send the PTY a Resize, then another).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setH(el.getBoundingClientRect().height / zoomFactor());
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [ref, hidden]);
  return h;
}

/**
 * The content column: the content pane and, under it, the selection's bottom terminal
 * panel (components/bottom), the same width, 8px apart. Hidden (display: none), not
 * unmounted, while the side panel is expanded over it: the terminal keeps its Attach
 * stream and xterm state, and its fit skips the zero-size host (terminal/xterm.ts). The
 * bottom panel unmounts then (its terminal detaches).
 */
function ContentColumn({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const height = useColumnHeight(ref, hidden);
  return (
    <div
      ref={ref}
      className={cn("m-2 min-h-0 min-w-0 flex-1 flex-col", hidden ? "hidden" : "flex")}
      // The side panel shrinks, then hides, before the content column gets narrower than this.
      style={{ minWidth: CONTENT_MIN }}
      data-testid="content-column"
    >
      {children}
      <BottomPanel columnHeight={height} />
    </div>
  );
}

export function App() {
  useEffect(() => startApp(), []);
  const scheme = useColorScheme();
  const settingsOpen = useViewsStore((s) => s.settingsOpen);
  const usageOpen = useViewsStore((s) => s.usageOpen);
  // Settings and usage hide the panel, so the content pane shows the page even then.
  const pageOpen = useViewsStore(selectPageOpen);
  const panelExpanded = usePanelExpanded() && !pageOpen;
  useWindowTitle(useAttentionCount());

  return (
    // The sheet: one background under the sidebar. The content area is a pane floating
    // on it (rounded, lighter, 8px in from its neighbours and the window's top, right
    // and bottom edges), with the selection's bottom terminal panel under it; the selection's side panel, when open, is a second pane to its
    // right (components/panel, docs/notes/side-panel.md). Nothing spans the title band
    // (components/window/titleBand.ts): the sidebar's top band and the pane headers fill it.
    <div className="relative flex h-full flex-col overflow-hidden bg-sheet text-foreground">
      {/* The sheet above the panes drags the window too (as the sidebar band and the pane
          headers do), so a page without a header (dashboard, composer, a disconnected
          thread) still has a drag surface when the sidebar is hidden. */}
      <div className="absolute inset-x-0 top-0 h-2 [--wails-draggable:drag]" data-testid="window-drag-edge" aria-hidden />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <ContentColumn hidden={panelExpanded}>
          <ContentPane>{settingsOpen ? <SettingsPage /> : usageOpen ? <UsagePage /> : <Content />}</ContentPane>
        </ContentColumn>
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
