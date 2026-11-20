import { useMemo } from "react";
import type { SettingFieldView } from "@/api/settings";
import { useSettingsStore } from "@/stores/settings";

/**
 * Fields left out of their section while the bool they depend on is off: Dictation's settings
 * come and go with its switch. The search still finds them, dimmed, saying why (SearchResults).
 * The other bool dependents stay on the page and dim (SectionCard's FieldRow). A field with a
 * dependsOnValue is left out of the section while its parent has another value; the search
 * still finds it, dimmed, too.
 */
const HIDDEN_WHILE_OFF: ReadonlySet<string> = new Set([
  "dictation.anywhere",
  "dictation.hold_key",
  "dictation.microphone",
  "dictation.sounds",
  "dictation.other_audio",
  "dictation.avoid_bluetooth",
  "dictation.spoken_symbols",
  "dictation.spoken_formatting",
]);

/** Whether the field leaves its section while its bool is off, rather than dimming in it (and so is never indented under it). */
export function hiddenWhileOff(key: string): boolean {
  return HIDDEN_WHILE_OFF.has(key);
}

/** The keys of `fields` hidden from their section now. The search hides none: it dims what is unused. */
export function hiddenFieldKeys(fields: readonly SettingFieldView[], values: Readonly<Record<string, string>>): string[] {
  const hidden = (f: SettingFieldView) => (HIDDEN_WHILE_OFF.has(f.key) && values[f.dependsOn] !== "true") || (f.dependsOnValue !== "" && values[f.dependsOn] !== f.dependsOnValue);
  return fields.filter(hidden).map((f) => f.key);
}

/** hiddenFieldKeys over the daemon's values, changing only when the answer does. */
export function useHiddenFields(fields: readonly SettingFieldView[]): ReadonlySet<string> {
  const keys = useSettingsStore((s) => hiddenFieldKeys(fields, s.snapshot?.values ?? {}).join(" "));
  return useMemo(() => new Set(keys.split(" ")), [keys]);
}
