import { useEffect } from "react";
import { Window } from "@wailsio/runtime";

export const BASE_TITLE = "Code Foundry";

/** "Code Foundry", or "Code Foundry (3)" when three sessions need attention. */
export function windowTitle(attention: number): string {
  return attention > 0 ? `${BASE_TITLE} (${String(attention)})` : BASE_TITLE;
}

/** True inside the Wails webview (WKWebView with the host's message handler). */
function inWails(): boolean {
  const w = window as { _wails?: { environment?: unknown }; webkit?: { messageHandlers?: Record<string, unknown> } };
  return Boolean(w._wails?.environment) || Boolean(w.webkit?.messageHandlers?.external);
}

/**
 * Keeps the document title, and the native window title in Wails (which does not follow
 * document.title), in sync with the attention count.
 */
export function useWindowTitle(attention: number): void {
  useEffect(() => {
    const title = windowTitle(attention);
    document.title = title;
    if (inWails()) {
      Window.SetTitle(title).catch(() => undefined);
    }
  }, [attention]);
}
