import type { SettingEditor } from "./editor";
import { VolumeEditor } from "./VolumeEditor";

/**
 * Editors for single settings, by key, ahead of the per-type editor (SettingRow): a
 * setting that needs more than its type's input registers here.
 */
export const keyEditors: Readonly<Partial<Record<string, SettingEditor>>> = {
  "notifications.sound_volume": VolumeEditor,
};
