/**
 * The user's own themes (docs/notes/user-themes.md), from the EventService theme source:
 * each event carries every theme. The files go to src/themes (setUserThemes), where the
 * Themes page, the settings and lib/theme read them like the catalog's; this store keeps
 * what only the page shows: the files that did not load and the directory.
 */
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import type { ThemeFileIssueView, ThemesSnapshotView } from "@/api/theme";
import { setUserThemes, subscribeUserThemes, userThemes, type Theme } from "@/themes";
import { runCommandForResult } from "./commands";
import { loadSettingsSchema } from "./settings";

interface ThemesState {
  /** A snapshot has arrived from the daemon (before that, the user themes are the last launch's). */
  loaded: boolean;
  issues: readonly ThemeFileIssueView[];
  /** The earlier versions kept of each user theme (a theme card's Undo restores one). */
  history: Readonly<Record<string, readonly string[]>>;
  dir: string;
}

export const useThemesStore = create<ThemesState>()(() => ({ loaded: false, issues: [], history: {}, dir: "" }));

/** What the settings' theme selects list of a user theme: its id, name and scheme. */
const choiceKey = () =>
  userThemes()
    .map((t) => `${t.id}\u0000${t.name}\u0000${t.scheme}`)
    .join("\u0001");

export function applyThemeEvent(ev: ThemesSnapshotView): void {
  const before = choiceKey();
  setUserThemes(ev.user);
  useThemesStore.setState({ loaded: true, issues: ev.issues, history: ev.history, dir: ev.dir });
  // The theme slots' options in Settings come from the schema: fetch it again when the
  // themes they list changed (not on a colour edit).
  if (choiceKey() !== before) void loadSettingsSchema();
}

/**
 * Removes a file of the themes directory that did not load (theme.delete --file, which
 * asks first; docs/notes/theme-fuzz-daemon.md). False when it failed or was cancelled.
 */
export async function deleteThemeFile(file: string): Promise<boolean> {
  const res = await runCommandForResult("theme.delete", { file }, { quiet: true });
  if (!res) return false;
  toast.success(`Deleted ${file}`);
  return true;
}

/** The user's themes (by name); re-renders when they change. */
export function useUserThemes(): readonly Theme[] {
  return useSyncExternalStore(subscribeUserThemes, userThemes, userThemes);
}
