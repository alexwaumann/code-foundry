import type { ComponentType } from "react";
import type { SettingFieldView } from "@/api/settings";
import { BackdropEditor } from "./BackdropEditor";
import { BranchNamingOff } from "./BranchNamingOff";
import { DictationMicrophoneDescription, DictationMicrophoneEditor, DictationNeedsModel, DictationStateChip, DictationToggleEditor } from "./DictationSettings";
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
  "dictation.microphone": DictationMicrophoneEditor,
};

/**
 * State beside a setting's title (a chip), by key: a setting whose row also reports
 * something the daemon knows (dictation.enabled: Ready, Unloaded, the engine's failure).
 */
export const keyTitleChips: Readonly<Partial<Record<string, ComponentType>>> = {
  "dictation.enabled": DictationStateChip,
};

/** Words after a setting's description, by key, that depend on state ("Needs the model below."). */
export const keyDescriptionTails: Readonly<Partial<Record<string, ComponentType<{ field: SettingFieldView }>>>> = {
  "dictation.enabled": DictationNeedsModel,
  "projects.branch_naming": BranchNamingOff,
};

/** A description that depends on state, by key, in place of the setting's own (its `fallback`). The search still shows and marks the setting's own. */
export const keyDescriptions: Readonly<Partial<Record<string, ComponentType<{ fallback: string }>>>> = {
  "dictation.microphone": DictationMicrophoneDescription,
};

/**
 * Key editors taller than one control (the backdrop's gallery): their row aligns to the
 * top, so the title sits beside the editor's first control and the reset arrow beside it.
 */
export const tallKeyEditors: ReadonlySet<string> = new Set(["appearance.backdrop", "ember.worker_models"]);
