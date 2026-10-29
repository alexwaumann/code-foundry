import type { ComponentType } from "react";
import { BackdropEditor } from "./BackdropEditor";
import { DictationNeedsModel, DictationStateChip, DictationToggleEditor } from "./DictationSettings";
import type { SettingEditor } from "./editor";
import { ThemeDarkEditor, ThemeLightEditor } from "./ThemeSlotEditor";
import { VolumeEditor } from "./VolumeEditor";
import { WorkerModelsEditor } from "./WorkerModelsEditor";

/**
 * Editors for single settings, by key, ahead of the per-type editor (SettingRow): a
 * setting that needs more than its type's input registers here.
 */
export const keyEditors: Readonly<Partial<Record<string, SettingEditor>>> = {
  "notifications.sound_volume": VolumeEditor,
  "appearance.theme_dark": ThemeDarkEditor,
  "appearance.theme_light": ThemeLightEditor,
  "appearance.backdrop": BackdropEditor,
  "ember.worker_models": WorkerModelsEditor,
  "dictation.enabled": DictationToggleEditor,
};

/**
 * State beside a setting's title (a chip), by key: a setting whose row also reports
 * something the daemon knows (dictation.enabled: Ready, Unloaded, the engine's failure).
 */
export const keyTitleChips: Readonly<Partial<Record<string, ComponentType>>> = {
  "dictation.enabled": DictationStateChip,
};

/** Words after a setting's description, by key, that depend on state ("Needs the model below."). */
export const keyDescriptionTails: Readonly<Partial<Record<string, ComponentType>>> = {
  "dictation.enabled": DictationNeedsModel,
};

/**
 * Key editors taller than one control (the backdrop's gallery): their row aligns to the
 * top, so the title sits beside the editor's first control and the reset arrow beside it.
 */
export const tallKeyEditors: ReadonlySet<string> = new Set(["appearance.backdrop", "ember.worker_models"]);
