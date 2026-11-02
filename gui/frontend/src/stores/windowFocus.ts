/**
 * Which of a daemon's windows a window-local intent from the CLI acts in: the focused one,
 * else the one focused most recently. The daemon sends a UiIntent to every window; most
 * ShowViews are meant for all of them, but some open a popover that only one window should
 * show (thread.move.open's move picker, docs/notes/move-no-project-2-gui.md).
 *
 * Every window writes its id to localStorage when it takes the focus. WebKit's localStorage
 * is shared by every window on this machine (stores/persisted.ts), so the key names the
 * daemon: another daemon's windows (an isolated CODE_FOUNDRY_HOME) keep their own.
 */
import { daemon } from "@/api/endpoint";

const PREFIX = "cf.window.lastFocused ";

/** This window's id: random per page load. */
export const WINDOW_ID = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

/** The key for this window's daemon (its address); the bare prefix when it cannot be resolved. */
async function storageKey(): Promise<string> {
  try {
    return PREFIX + (await daemon.resolveEndpoint()).baseUrl;
  } catch {
    return PREFIX;
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The key this window last wrote its id under (forgetWindow clears it). */
let written: string | null = null;

/** Records this window as its daemon's most recently focused. */
export async function markWindowFocused(): Promise<void> {
  const key = await storageKey();
  try {
    localStorage.setItem(key, WINDOW_ID);
    written = key;
  } catch {
    // No storage: every window acts (isActingWindow).
  }
}

/** A closing window: when it was the last focused, no window is (so every one acts until one is focused). */
function forgetWindow(): void {
  if (written === null || read(written) !== WINDOW_ID) return;
  try {
    localStorage.removeItem(written);
  } catch {
    // Nothing to forget.
  }
}

/** Follows this window's focus (App startApp). Returns the stop function. */
export function startWindowFocus(): () => void {
  const onFocus = () => {
    void markWindowFocused();
  };
  window.addEventListener("focus", onFocus);
  window.addEventListener("pagehide", forgetWindow);
  if (document.hasFocus()) onFocus();
  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("pagehide", forgetWindow);
  };
}

/**
 * Whether a window-local intent acts in this window: it is focused, or it is the one its
 * daemon's windows focused last. When none has recorded a focus (no storage, or never
 * focused), every window acts, as before.
 */
export async function isActingWindow(): Promise<boolean> {
  if (document.hasFocus()) return true;
  const last = read(await storageKey());
  return last === null || last === WINDOW_ID;
}
