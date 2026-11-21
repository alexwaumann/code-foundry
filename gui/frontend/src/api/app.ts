import { Browser, Events } from "@wailsio/runtime";
import { Bounce, Info, PickDirectory, PickFiles, PlaySound, Relaunch, SetBadge, SetWindowBackground, SetZoom } from "../../bindings/github.com/alexwaumann/code-foundry/gui/appservice";

/** The Wails host (window shell). */
export interface AppInfoView {
  /** The GUI binary's version (same ldflag as the daemon's). */
  version: string;
}

/** Emitted by the app menu's "Check for Updates…" (gui/app.go EventCheckForUpdates). */
export const EVENT_CHECK_FOR_UPDATES = "app:check-for-updates";

/** Emitted by app menu items that run a command in the window; data is its name (gui/menu.go EventRunCommand). */
export const EVENT_RUN_COMMAND = "app:run-command";

/** Emitted when files from the OS are dropped on a `data-file-drop-target` element (gui/filedrop.go EventFilesDropped). */
export const EVENT_FILES_DROPPED = "app:files-dropped";

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
 * Shows the native open panel for attaching (files and folders, several, no type filter),
 * opened at startDir when it is an existing directory, else at home (gui/filedrop.go).
 * Resolves to the chosen absolute paths ([] when cancelled), or null without a host.
 */
export async function pickFiles(startDir: string): Promise<string[] | null> {
  if (!(await appInfo())) return null;
  const paths = await PickFiles(startDir);
  return paths ?? [];
}

/** A native file drop (gui/filedrop.go FilesDropped). */
export interface FilesDroppedView {
  /** Absolute paths of the dropped files and folders. */
  paths: string[];
  /** The drop target's `data-drop-id` ("" when it has none). */
  target: string;
}

/** The event's data as a FilesDroppedView, or null when it is not one. */
export function filesDroppedOf(data: unknown): FilesDroppedView | null {
  if (typeof data !== "object" || data === null) return null;
  const { paths, target } = data as { paths?: unknown; target?: unknown };
  if (!Array.isArray(paths) || typeof target !== "string") return null;
  const list = paths.filter((p): p is string => typeof p === "string" && p !== "");
  return list.length > 0 ? { paths: list, target } : null;
}

/**
 * Calls fn with each native file drop on a `data-file-drop-target` element (the host's
 * overlay takes OS file drags, so the page gets no DOM drop for them). Never fires
 * without a host. Returns an unsubscribe.
 */
export function onFilesDropped(fn: (drop: FilesDroppedView) => void): () => void {
  return Events.On(EVENT_FILES_DROPPED, (ev) => {
    const drop = filesDroppedOf(ev.data);
    if (drop) fn(drop);
  });
}

/** The Wails runtime's entry points for a file dragged in from the OS (`window._wails`). */
export interface NativeDropHooks {
  handleDragOver?: (x: number, y: number) => void;
  handlePlatformFileDrop?: (files: string[], x: number, y: number) => void;
}

/**
 * Makes the runtime's native file drag hooks take the host's positions under the window
 * zoom. The host sends a drag's position in view points; the runtime looks the drop target
 * up with elementFromPoint, which takes CSS px, and a CSS px is `zoom()` points, so
 * unscaled a drop lands on the wrong element or outside the page. The result is rounded:
 * the host reads the position back as whole numbers and refuses a drop with a fraction.
 * Returns false while the runtime has not set its hooks yet.
 */
export function scaleNativeDrops(hooks: NativeDropHooks | undefined, zoom: () => number): boolean {
  const over = hooks?.handleDragOver;
  const drop = hooks?.handlePlatformFileDrop;
  if (!hooks || !over || !drop) return false;
  const css = (points: number) => Math.round(points / zoom());
  hooks.handleDragOver = (x, y) => {
    over(css(x), css(y));
  };
  hooks.handlePlatformFileDrop = (files, x, y) => {
    drop(files, css(x), css(y));
  };
  return true;
}

/** The window zoom the host last took, as a factor (1 without a host). */
let hostZoom = 1;
let dropsScaled = false;

/**
 * Zooms the window to percent: the host sets the webview's page zoom, keeps the native
 * traffic lights centred on the zoomed title band and saves the value for the next launch
 * (gui/app.go SetZoom). No-op without a host.
 */
export async function setHostZoom(percent: number): Promise<void> {
  if (!(await appInfo())) return;
  try {
    await SetZoom(percent);
    hostZoom = percent / 100;
    dropsScaled ||= scaleNativeDrops((window as { _wails?: NativeDropHooks })._wails, () => hostZoom);
  } catch (err: unknown) {
    console.warn("host zoom", err);
  }
}

/** The window colours the host keeps (gui/windowbg.go WindowBackground). */
export interface WindowBackgroundView {
  /** appearance.theme. */
  scheme: "system" | "dark" | "light";
  /** The dark and the light theme's `--sheet`, `#rrggbb`. */
  dark: string;
  light: string;
  /** The scheme the page shows now. */
  active: "dark" | "light";
}

/**
 * Paints the native window behind the page in the active sheet and lets the host open the
 * next launch in it (gui/windowbg.go). No-op without a host.
 */
export async function setWindowBackground(bg: WindowBackgroundView): Promise<void> {
  if (!(await appInfo())) return;
  try {
    await SetWindowBackground(bg);
  } catch (err: unknown) {
    console.warn("window background", err);
  }
}

/**
 * Shows the number of threads that need attention on the Dock icon (0 removes the badge,
 * above 99 shows "99+"; gui/notify.go). No-op without a host.
 */
export async function setDockBadge(count: number): Promise<void> {
  if (!(await appInfo())) return;
  try {
    await SetBadge(count);
  } catch (err: unknown) {
    console.warn("dock badge", err);
  }
}

/** Bounces the Dock icon once (macOS ignores it while the app is active). No-op without a host. */
export async function bounceDock(): Promise<void> {
  if (!(await appInfo())) return;
  try {
    await Bounce();
  } catch (err: unknown) {
    console.warn("dock bounce", err);
  }
}

/**
 * Plays the alert sound at volume percent of the Mac's output volume (0 plays nothing).
 * Host-side (NSSound, gui/notify_darwin.go): the webview's audio is subject to WebKit's
 * autoplay policy. No-op without a host.
 */
export async function playAlertSound(volume: number): Promise<void> {
  if (!(await appInfo())) return;
  try {
    await PlaySound(Math.round(volume));
  } catch (err: unknown) {
    console.warn("alert sound", err);
  }
}

/**
 * Asks the Wails host to quit and start its executable again (gui/app.go Relaunch), so the
 * window runs what is on disk and reconnects to whichever daemon is running then.
 * Resolves false without a host; with one the promise may never settle (the page goes away).
 */
export async function relaunchApp(): Promise<boolean> {
  if (!(await appInfo())) return false;
  await Relaunch();
  return true;
}

/**
 * Calls fn with the command name of an app menu item that runs something in the window
 * (Settings…, the Thread and Help menus; gui/menu.go EventRunCommand). Returns an
 * unsubscribe.
 */
export function onRunCommandMenu(fn: (name: string) => void): () => void {
  return Events.On(EVENT_RUN_COMMAND, (ev) => {
    const name: unknown = ev.data;
    if (typeof name === "string" && name !== "") fn(name);
  });
}

/** Calls fn when the app menu's "Check for Updates…" is chosen. Returns an unsubscribe. */
export function onCheckForUpdatesMenu(fn: () => void): () => void {
  return Events.On(EVENT_CHECK_FOR_UPDATES, () => {
    fn();
  });
}
