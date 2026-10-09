import { useEffect, useRef, type ReactNode } from "react";
import { Composer } from "@/components/compose/Composer";
import { ConfirmDialog } from "@/components/confirm/ConfirmDialog";
import { Dashboard } from "@/components/Dashboard";
import { HelpOverlay } from "@/components/help/HelpOverlay";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { PullRequestsPage } from "@/components/prs/PullRequestsPage";
import { SessionDisconnected } from "@/components/session/SessionParts";
import { SidePanel } from "@/components/panel/SidePanel";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { Toaster } from "@/components/ui/sonner";
import { UpdateDialog } from "@/components/update/UpdateDialog";
import { installKeybindings } from "@/keys/bindings";
import { syncDocumentScheme, useColorScheme } from "@/lib/theme";
import { useWindowTitle } from "@/lib/title";
import { startCommandSync } from "@/stores/commands";
import { startEventSync } from "@/stores/events";
import { startHealthPolling } from "@/stores/health";
import { useAttentionCount, useSessionsStore } from "@/stores/sessions";
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
  // The side panel's bounds depend on the window width (stores/ui.ts panelMax).
  const onResize = () => {
    useUiStore.getState().setWindowWidth(window.innerWidth);
  };
  window.addEventListener("resize", onResize);
  onResize();
  const stops = [
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
  if (sel.kind === "compose") return <Composer key={sel.repoId} repoId={sel.repoId} />;
  if (sel.kind === "session") {
    return sessionTerminal ? <TerminalPane terminalId={sessionTerminal} sessionId={sel.id} /> : <SessionDisconnected id={sel.id} />;
  }
  return <Dashboard />;
}

/**
 * The content pane. On a focus request (ui contentFocusSeq) it focuses the page's
 * `[data-focus-root]` element (a page's keyboard list or its root section); a terminal
 * answers the same request itself (TerminalPane), and has no focus root.
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
      className="m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-pane-border bg-pane shadow-xs"
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
  useWindowTitle(useAttentionCount());

  return (
    // The sheet: one background under the sidebar. The content area is a pane floating
    // on it (rounded, lighter, 8px in from its neighbours and the window's top, right
    // and bottom edges); the selection's side panel, when open, is a second pane to its
    // right (components/panel, docs/notes/side-panel.md). Nothing spans the title band
    // (components/window/titleBand.ts): the sidebar's top band and the pane headers fill it.
    <div className="flex h-screen flex-col overflow-hidden bg-sheet text-foreground">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <ContentPane>{settingsOpen ? <SettingsPage /> : <Content />}</ContentPane>
        <SidePanel />
      </div>
      <CommandPalette />
      <HelpOverlay />
      <ConfirmDialog />
      <UpdateDialog />
      <Toaster theme={scheme} position="bottom-right" offset={{ bottom: 20, right: 20 }} />
    </div>
  );
}
