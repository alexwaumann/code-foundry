import { useEffect } from "react";
import { Dashboard } from "@/components/Dashboard";
import { Footer } from "@/components/footer/Footer";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { SessionDisconnected } from "@/components/session/SessionParts";
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
import { useUiStore, type FocusRegion } from "@/stores/ui";
import { startUpdateSync } from "@/stores/update";

function regionOf(el: EventTarget | null): FocusRegion {
  const region = el instanceof Element ? el.closest("[data-region]")?.getAttribute("data-region") : null;
  return region === "sidebar" || region === "terminal" || region === "palette" ? region : "content";
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
  const stops = [syncDocumentScheme(), startHealthPolling(2000), startEventSync(), startCommandSync(), installKeybindings(), startUpdateSync()];
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    for (const stop of stops) stop();
  };
}

/**
 * Exactly one thing fills the content area. A session shows its live terminal when it
 * has one, otherwise the "Not connected" panel. TerminalPane stays mounted across
 * terminal/session switches (same element position), so its renderer is reused.
 */
function Content() {
  const sel = useUiStore((s) => s.selection);
  const sessionTerminal = useSessionsStore((s) => (sel.kind === "session" ? s.byId[sel.id]?.terminalId || null : null));
  if (sel.kind === "terminal") return <TerminalPane terminalId={sel.id} />;
  if (sel.kind === "session") {
    return sessionTerminal ? <TerminalPane terminalId={sessionTerminal} sessionId={sel.id} /> : <SessionDisconnected id={sel.id} />;
  }
  return <Dashboard />;
}

export function App() {
  useEffect(() => startApp(), []);
  const scheme = useColorScheme();
  useWindowTitle(useAttentionCount());

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Content />
        </main>
      </div>
      <Footer />
      <CommandPalette />
      <UpdateDialog />
      <Toaster theme={scheme} position="bottom-right" offset={{ bottom: 40, right: 16 }} />
    </div>
  );
}
