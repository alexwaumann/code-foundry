/**
 * Settings from the daemon's settings file. Snapshots arrive on the shared events stream
 * (source "settings"), including edits made to the file by hand; the schema is fetched
 * when the settings page opens. Appearance settings are applied here, so they take
 * effect in every window as soon as a snapshot lands.
 */
import { create } from "zustand";
import { getSettingsSchema, SettingsValidationError, updateSettings, type SettingsSchemaView, type SettingsSnapshotView } from "@/api/settings";
import { errorMessage } from "@/api/stream";
import { setThemePreference } from "@/lib/theme";
import { DEFAULT_TERMINAL_FONT_FAMILY, FONT_FALLBACKS } from "@/terminal/fonts";
import { refreshCommands } from "./commands";
import { nextZoom, useUiStore, ZOOM_DEFAULT } from "./ui";

export const KEYS = {
  theme: "appearance.theme",
  fontFamily: "appearance.font_family",
  fontSize: "appearance.font_size",
  zoom: "appearance.zoom",
  density: "appearance.density",
  backdrop: "appearance.backdrop",
  scrollback: "sessions.scrollback_lines",
} as const;

const KEYBINDING_PREFIX = "keybindings.";


export const ROW_HEIGHTS = { compact: 26, comfortable: 30 } as const;

interface SettingsState {
  /** Null until the first snapshot (or forever against a daemon without settings). */
  snapshot: SettingsSnapshotView | null;
  schema: SettingsSchemaView | null;
  schemaError: string | null;
}

export const useSettingsStore = create<SettingsState>()(() => ({ snapshot: null, schema: null, schemaError: null }));

function changed(prev: SettingsSnapshotView | null, next: SettingsSnapshotView, key: string): boolean {
  return !prev || prev.values[key] !== next.values[key];
}

function keybindingsChanged(prev: SettingsSnapshotView, next: SettingsSnapshotView): boolean {
  const keys = new Set([...Object.keys(prev.values), ...Object.keys(next.values)]);
  for (const k of keys) if (k.startsWith(KEYBINDING_PREFIX) && prev.values[k] !== next.values[k]) return true;
  return false;
}

/** Applies a snapshot from the events stream (or a newer one from an Update response). */
export function applySettingsSnapshot(next: SettingsSnapshotView): void {
  const prev = useSettingsStore.getState().snapshot;
  useSettingsStore.setState({ snapshot: next });
  const theme = next.values[KEYS.theme];
  if (theme === "system" || theme === "dark" || theme === "light") setThemePreference(theme);
  if (changed(prev, next, KEYS.fontSize)) {
    const n = Number(next.values[KEYS.fontSize]);
    if (Number.isFinite(n) && n > 0) useUiStore.getState().setFontSize(n);
  }
  // Only a changed value moves the zoom, so a zoom still being saved is not undone.
  if (changed(prev, next, KEYS.zoom)) {
    const n = Number(next.values[KEYS.zoom]);
    if (Number.isFinite(n) && n > 0) useUiStore.getState().setZoom(n);
  }
  document.documentElement.dataset.density = next.values[KEYS.density] === "comfortable" ? "comfortable" : "compact";
  // CommandService.List reports keybinding overrides; the daemon applied them before
  // publishing, so re-list now.
  if (prev && keybindingsChanged(prev, next)) void refreshCommands();
}

export function useSettingValue(key: string): string | undefined {
  return useSettingsStore((s) => s.snapshot?.values[key]);
}

/** CSS font-family for the terminal: the setting plus fallbacks, else the bundled font's stack. */
export function terminalFontFamily(setting: string | undefined): string {
  const v = setting?.trim();
  return v ? `${v}, ${FONT_FALLBACKS}` : DEFAULT_TERMINAL_FONT_FAMILY;
}

export function useTerminalFontFamily(): string {
  return terminalFontFamily(useSettingValue(KEYS.fontFamily));
}

/** Terminal scrollback lines (the daemon keeps the same number). */
export function useScrollbackLines(): number {
  const v = Number(useSettingValue(KEYS.scrollback));
  return Number.isFinite(v) && v > 0 ? v : 10_000;
}

export function useRowHeight(): number {
  return useSettingValue(KEYS.density) === "comfortable" ? ROW_HEIGHTS.comfortable : ROW_HEIGHTS.compact;
}

export async function loadSettingsSchema(): Promise<void> {
  try {
    useSettingsStore.setState({ schema: await getSettingsSchema(), schemaError: null });
  } catch (err) {
    useSettingsStore.setState({ schemaError: errorMessage(err) });
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string; issues: Record<string, string> };

/** Saves a partial change; "" resets a key to its default. */
export async function saveSettings(values: Record<string, string>): Promise<SaveResult> {
  try {
    const snap = await updateSettings(values);
    const cur = useSettingsStore.getState().snapshot;
    // The events stream delivers the same snapshot; apply the response only if newer.
    if (snap && (!cur || snap.revision > cur.revision)) applySettingsSnapshot(snap);
    return { ok: true };
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      return { ok: false, error: err.message, issues: Object.fromEntries(err.issues.map((i) => [i.key, i.message])) };
    }
    return { ok: false, error: errorMessage(err), issues: {} };
  }
}

let zoomTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * cmd+= / cmd+- / cmd+0: steps the page zoom now (the whole window, terminal included,
 * like a browser or T3 Code) and saves it to the settings file shortly after the last
 * press (one write per burst). Without a settings service the zoom is only kept locally.
 */
export function zoomUi(direction: 1 | -1 | null): void {
  const ui = useUiStore.getState();
  ui.setZoom(direction === null ? ZOOM_DEFAULT : nextZoom(ui.zoom, direction));
  if (!useSettingsStore.getState().snapshot) return;
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    const zoom = useUiStore.getState().zoom;
    void saveSettings({ [KEYS.zoom]: zoom === ZOOM_DEFAULT ? "" : String(zoom) });
  }, 400);
}
