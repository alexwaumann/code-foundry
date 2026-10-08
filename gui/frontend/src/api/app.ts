import { Browser, Events } from "@wailsio/runtime";
import { Info, Relaunch } from "../../bindings/github.com/awaumann/code-foundry/gui/appservice";

/** The Wails host (window shell): its own version and relaunching itself. */
export interface AppInfoView {
  version: string;
  /** The .app the GUI runs from; "" for a dev binary. */
  bundle: string;
}

/** Emitted by the app menu's "Check for Updates…" (gui/app.go EventCheckForUpdates). */
export const EVENT_CHECK_FOR_UPDATES = "app:check-for-updates";

/** True inside the Wails webview (WKWebView with the host's message handler). */
export function inWails(): boolean {
  const w = window as { _wails?: { environment?: unknown }; webkit?: { messageHandlers?: Record<string, unknown> } };
  return Boolean(w._wails?.environment) || Boolean(w.webkit?.messageHandlers?.external);
}

/** The GUI's own build, or null outside Wails (browser dev, e2e). */
export async function appInfo(): Promise<AppInfoView | null> {
  if (!inWails()) return null;
  const i = await Info();
  return { version: i.version, bundle: i.bundle };
}

/** Asks the host to quit and reopen. Returns false outside Wails. */
export async function relaunchApp(): Promise<boolean> {
  if (!inWails()) return false;
  await Relaunch();
  return true;
}

/** Opens a URL in the user's browser (the Wails webview would navigate away). */
export function openExternal(url: string): void {
  if (inWails()) {
    Browser.OpenURL(url).catch(() => undefined);
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** Calls fn when the app menu's "Check for Updates…" is chosen. Returns an unsubscribe. */
export function onCheckForUpdatesMenu(fn: () => void): () => void {
  if (!inWails()) return () => undefined;
  return Events.On(EVENT_CHECK_FOR_UPDATES, () => {
    fn();
  });
}
