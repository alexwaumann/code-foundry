/**
 * The experimental Chrome surface in the window (docs/notes/chrome-surface.md): whether it is
 * on, each surface's last state, and the window's own side of the browser.* commands. Frames do
 * not pass through here: they go from the stream straight to the canvas.
 *
 * A surface's name is its panel's key. Off, no tab, entry or stream exists: this file closes
 * any tab left over, so nothing a window remembered outlives the setting.
 */
import { create } from "zustand";
import { BROWSER_STARTING, browserGo, closeBrowser, reloadBrowser, relaunchBrowser, type BrowserStateView } from "@/api/browser";
import { errorMessage } from "@/api/stream";
import { BROWSER_KIND, browserTab } from "@/surfaces/browserTarget";
import { activeTab, allTabs, closePanelTab, getPanel, keyOf, openSurface, usePanelStore } from "./panel";
import { useSettingsStore } from "./settings";
import { useUiStore, type Selection } from "./ui";

export const CHROME_SURFACE = "experimental.chrome_surface";

/** The setting: off until a snapshot says "true", so a daemon that does not know it reads as off. */
export function browserEnabled(): boolean {
  return useSettingsStore.getState().snapshot?.values[CHROME_SURFACE] === "true";
}

interface BrowserStore {
  states: Readonly<Record<string, BrowserStateView>>;
  /** Addresses waiting for their panel to show, by surface. Nothing starts until one does. */
  pending: Readonly<Record<string, string>>;
  /** What failed last, by surface: a refused address, a call the daemon turned down. */
  errors: Readonly<Record<string, string>>;
  /** Surfaces whose stream is retrying: what they show may be stale. */
  offline: Readonly<Record<string, boolean>>;
}

export const useBrowserStore = create<BrowserStore>()(() => ({ states: {}, pending: {}, errors: {}, offline: {} }));

export function setBrowserState(surface: string, state: BrowserStateView): void {
  useBrowserStore.setState((s) => ({ states: { ...s.states, [surface]: state } }));
}

export function useBrowserState(surface: string): BrowserStateView {
  return useBrowserStore((s) => s.states[surface] ?? BROWSER_STARTING);
}

export function setBrowserError(surface: string, err: unknown): void {
  useBrowserStore.setState((s) => ({ errors: { ...s.errors, [surface]: err === null ? "" : errorMessage(err) } }));
}

export function setBrowserOffline(surface: string, offline: boolean): void {
  if ((useBrowserStore.getState().offline[surface] ?? false) === offline) return;
  useBrowserStore.setState((s) => ({ offline: { ...s.offline, [surface]: offline } }));
}

/** Takes the address waiting for a surface: it goes with the view's Watch, once. */
export function takeBrowserAddress(surface: string): string {
  const url = useBrowserStore.getState().pending[surface] ?? "";
  if (url) {
    useBrowserStore.setState((s) => {
      const { [surface]: _taken, ...pending } = s.pending;
      return { pending };
    });
  }
  return url;
}

/**
 * Opens (or activates) the Browser tab in the selection's panel, with an address to go to when
 * it shows. Returns that panel's key, or null with the setting off or no panel. It does not
 * request focus.
 */
export function openBrowserSurface(sel: Selection = useUiStore.getState().selection, url = ""): string | null {
  const key = keyOf(sel);
  if (key === null || !browserEnabled()) return null;
  if (url) useBrowserStore.setState((s) => ({ pending: { ...s.pending, [key]: url } }));
  return openSurface(key, browserTab()) ? key : null;
}

/** The surface of the Browser tab in front of the selection's panel, or null. */
function surfaceInFront(): string | null {
  const key = keyOf(useUiStore.getState().selection);
  if (key === null || !browserEnabled()) return null;
  const e = getPanel(key);
  return e.open && activeTab(e)?.kind === BROWSER_KIND ? key : null;
}

/** Whether a browser.* command does anything here: the palette lists them only then. */
export function browserInFront(): boolean {
  return surfaceInFront() !== null;
}

function act(surface: string, run: () => Promise<unknown>): void {
  setBrowserError(surface, null);
  run().catch((err: unknown) => {
    setBrowserError(surface, err);
  });
}

export function goBack(surface: string): void {
  act(surface, () => browserGo(surface, -1));
}

export function goForward(surface: string): void {
  act(surface, () => browserGo(surface, 1));
}

export function reload(surface: string): void {
  act(surface, () => reloadBrowser(surface));
}

export function relaunch(surface: string): void {
  act(surface, () => relaunchBrowser());
}

/** The browser.* verbs by name, run by the window itself: the daemon refuses every other caller. */
const present: Readonly<Record<string, (surface: string) => void>> = {
  "browser.back": goBack,
  "browser.forward": goForward,
  "browser.reload": reload,
  "browser.relaunch": relaunch,
};

/** Runs a browser.* verb on the tab in front; handled either way, so it never reaches the daemon. */
export function presentBrowserCommand(name: string): boolean {
  const surface = surfaceInFront();
  if (surface !== null) present[name]?.(surface);
  return true;
}

/** Closing a tab closes its page. */
export function closeBrowserSurface(surface: string): void {
  closeBrowser(surface).catch(() => undefined);
  useBrowserStore.setState((s) => {
    const { [surface]: _gone, ...states } = s.states;
    return { states };
  });
}

/** Closes every Browser tab: the setting went off, or was off when the window restored them. */
function closeAllTabs(): void {
  for (const [key, entry] of Object.entries(usePanelStore.getState().byKey)) {
    for (const tab of allTabs(entry)) {
      if (tab.kind === BROWSER_KIND) closePanelTab(key, tab.id);
    }
  }
}

useSettingsStore.subscribe((s, prev) => {
  if (s.snapshot === prev.snapshot || s.snapshot === null || browserEnabled()) return;
  closeAllTabs();
  useBrowserStore.setState({ states: {}, pending: {}, errors: {}, offline: {} });
});
