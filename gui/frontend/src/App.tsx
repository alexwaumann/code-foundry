import { useEffect } from "react";
import { Dashboard } from "@/components/Dashboard";
import { Footer } from "@/components/footer/Footer";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { Toaster } from "@/components/ui/sonner";
import { installKeybindings } from "@/keys/bindings";
import { syncDocumentScheme, useColorScheme } from "@/lib/theme";
import { startCommandSync } from "@/stores/commands";
import { startHealthPolling } from "@/stores/health";
import { startIntentWatch } from "@/stores/intents";
import { startRepoSync } from "@/stores/repos";
import { startTerminalSync } from "@/stores/terminals";
import { useUiStore, type FocusRegion } from "@/stores/ui";

function regionOf(el: EventTarget | null): FocusRegion {
  const region = el instanceof Element ? el.closest("[data-region]")?.getAttribute("data-region") : null;
  return region === "sidebar" || region === "terminal" || region === "palette" ? region : "content";
}

/** Starts every daemon stream and global listener; returns one stop function. */
function startApp(): () => void {
  const onFocusIn = (e: FocusEvent) => {
    useUiStore.getState().setFocus(regionOf(e.target));
  };
  document.addEventListener("focusin", onFocusIn);
  const stops = [
    syncDocumentScheme(),
    startHealthPolling(2000),
    startTerminalSync(),
    startRepoSync(),
    startIntentWatch(),
    startCommandSync(),
    installKeybindings(),
  ];
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    for (const stop of stops) stop();
  };
}

function Content() {
  const terminalId = useUiStore((s) => (s.selection.kind === "terminal" ? s.selection.id : null));
  return terminalId ? <TerminalPane terminalId={terminalId} /> : <Dashboard />;
}

export function App() {
  useEffect(() => startApp(), []);
  const scheme = useColorScheme();

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
      <Toaster theme={scheme} position="bottom-right" offset={{ bottom: 40, right: 16 }} />
    </div>
  );
}
