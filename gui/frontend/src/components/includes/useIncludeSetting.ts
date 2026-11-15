import { useMemo } from "react";
import { formatPatterns, INCLUDE_SETTING, parseIncludeSetting, patternErrorText } from "@/lib/includePatterns";
import { saveSettings, useSettingValue } from "@/stores/settings";

const NONE: readonly string[] = [];

/**
 * files.include_ignored as a list, and saving a whole new list through the settings update
 * path (an empty list is stored as `none`). `save` answers the daemon's message for a
 * refused value (the pattern's own, without "invalid argument: "), or null once saved.
 * `known`: the settings snapshot has arrived (before, the list reads empty).
 */
export function useIncludeSetting(): { patterns: readonly string[]; known: boolean; save: (next: readonly string[]) => Promise<string | null> } {
  const value = useSettingValue(INCLUDE_SETTING);
  const patterns = useMemo(() => (value === undefined ? NONE : parseIncludeSetting(value)), [value]);
  return { patterns, known: value !== undefined, save: saveIncludeSetting };
}

export async function saveIncludeSetting(next: readonly string[]): Promise<string | null> {
  const res = await saveSettings({ [INCLUDE_SETTING]: formatPatterns(next) });
  return res.ok ? null : patternErrorText(res.issues[INCLUDE_SETTING] ?? res.error);
}
