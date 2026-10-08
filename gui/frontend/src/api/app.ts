import { Browser, Events } from "@wailsio/runtime";
import { Info } from "../../bindings/github.com/awaumann/code-foundry/gui/appservice";

/** The Wails host (window shell). */
export interface AppInfoView {
  /** The GUI binary's version (same ldflag as the daemon's). */
  version: string;
  /** The .app the GUI runs from; "" for a dev binary. */
  bundle: string;
}

/** Emitted by the app menu's "Check for Updates…" (gui/app.go EventCheckForUpdates). */
export const EVENT_CHECK_FOR_UPDATES = "app:check-for-updates";

const INFO_TIMEOUT_MS = 2000;

let info: Promise<AppInfoView | null> | null = null;

/**
 * The GUI's own build, or null when there is no Wails host (browser dev, e2e). Asking the
 * host is the detection: a binding that answers means we run inside the app.
 */
export function appInfo(): Promise<AppInfoView | null> {
  info ??= Promise.race([
    Info().then((i): AppInfoView => ({ version: i.version, bundle: i.bundle })),
    new Promise<null>((resolve) => setTimeout(() => {
      resolve(null);
    }, INFO_TIMEOUT_MS)),
  ]).catch(() => null);
  return info;
}

/** Opens a URL in the user's browser (navigating the Wails webview would replace the app). */
export async function openExternal(url: string): Promise<void> {
  if (await appInfo()) {
    await Browser.OpenURL(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** Calls fn when the app menu's "Check for Updates…" is chosen. Returns an unsubscribe. */
export function onCheckForUpdatesMenu(fn: () => void): () => void {
  return Events.On(EVENT_CHECK_FOR_UPDATES, () => {
    fn();
  });
}
