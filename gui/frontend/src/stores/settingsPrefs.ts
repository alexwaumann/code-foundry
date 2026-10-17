/**
 * The settings page's own view preferences. Persisted (localStorage
 * "code-foundry.settingsPrefs"); not settings: they are not in the file.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsPrefsState {
  /** Keybindings page: list only bound commands; the rest wait behind "N more unbound". */
  boundOnly: boolean;
}

export const useSettingsPrefsStore = create<SettingsPrefsState>()(
  persist((): SettingsPrefsState => ({ boundOnly: true }), { name: "code-foundry.settingsPrefs", version: 1 }),
);

export function setBoundOnly(on: boolean): void {
  useSettingsPrefsStore.setState({ boundOnly: on });
}
