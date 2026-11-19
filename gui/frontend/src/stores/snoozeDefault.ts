/**
 * The default snooze (docs/notes/put-away-chords.md): the setting threads.default_snooze, one of
 * the snooze menu's presets or save for later, tomorrow at 9:00 AM unless the user picks another.
 * Snooze to Default (thread.snooze.default, cmd+shift+s) puts the thread in view there, and the
 * snooze menus mark the preset (SnoozeMenu.tsx).
 */
import { isSnoozePresetId, snoozePresets, type SnoozePresetId } from "@/lib/snooze";
import { saveThreadForLater, snoozeThread } from "./threadActions";
import { useSettingsStore } from "./settings";
import { useThreadsStore } from "./threads";

export const DEFAULT_SNOOZE_KEY = "threads.default_snooze";

/** What the default snooze does: a preset, or save for later. */
export type DefaultSnooze = SnoozePresetId | "save";

/** The setting's value as a default snooze; anything else (unset, unknown) is tomorrow, the daemon's default. */
export function defaultSnoozeOf(v: string | undefined): DefaultSnooze {
  return v === "save" || (v !== undefined && isSnoozePresetId(v)) ? v : "tomorrow";
}

export function useDefaultSnooze(): DefaultSnooze {
  return useSettingsStore((s) => defaultSnoozeOf(s.snapshot?.values[DEFAULT_SNOOZE_KEY]));
}

/**
 * thread.snooze.default's presenter (the chord, the palette): the thread snoozes to the default
 * preset's time as the menu computes it now, through thread.snooze like a menu pick (no
 * confirmation, its toast), or is saved for later. Toasted (`inView` false): the key
 * leaves nothing on screen that says where the thread went. False without such a thread, so the
 * command falls back to the daemon's own run.
 */
export function presentSnoozeDefault(threadId: string, now = Date.now()): boolean {
  if (!useThreadsStore.getState().byId[threadId]) return false;
  const to = defaultSnoozeOf(useSettingsStore.getState().snapshot?.values[DEFAULT_SNOOZE_KEY]);
  if (to === "save") {
    void saveThreadForLater(threadId, { inView: false });
    return true;
  }
  const preset = snoozePresets(now).find((p) => p.id === to);
  if (!preset) return false;
  void snoozeThread(threadId, preset.untilMs, { inView: false });
  return true;
}
