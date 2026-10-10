import { Browser, Events } from "@wailsio/runtime";
import { Info, PickDirectory, SetZoom } from "../../bindings/github.com/alexwaumann/code-foundry/gui/appservice";

/** The Wails host (window shell). */
export interface AppInfoView {
  /** The GUI binary's version (same ldflag as the daemon's). */
  version: string;
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
    Info().then((i): AppInfoView => ({ version: i.version })),
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

/**
 * Shows the native folder picker, opened at startDir (a typed path; the host falls back
 * to the nearest existing directory, else home). Resolves to the chosen directory, or
 * null when cancelled. Only call it when appInfo() found the host.
 */
export async function pickDirectory(startDir: string): Promise<string | null> {
  const path = await PickDirectory(startDir);
  return path === "" ? null : path;
}

/**
 * Tells the Wails host the page zoom in percent, so it keeps the native traffic lights
 * centred on the zoomed title band (gui/trafficlights_darwin.go). No-op without a host.
 */
export async function setHostZoom(percent: number): Promise<void> {
  if (!(await appInfo())) return;
  try {
    await SetZoom(percent);
  } catch (err: unknown) {
    console.warn("host zoom", err);
  }
}

/** Calls fn when the app menu's "Check for Updates…" is chosen. Returns an unsubscribe. */
export function onCheckForUpdatesMenu(fn: () => void): () => void {
  return Events.On(EVENT_CHECK_FOR_UPDATES, () => {
    fn();
  });
}
