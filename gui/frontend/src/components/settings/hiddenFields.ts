import { useMemo } from "react";
import type { SettingFieldView } from "@/api/settings";
import { useSettingsStore } from "@/stores/settings";

/**
 * Fields left out altogether while the bool they depend on is off, in the section and in
 * the search. The other dependsOn fields stay and dim (SectionCard's FieldRow).
 */
const HIDDEN_WHILE_OFF: ReadonlySet<string> = new Set(["dictation.hold_key", "dictation.sounds", "dictation.other_audio", "dictation.spoken_symbols", "dictation.spoken_formatting"]);

/** The keys of `fields` hidden now. */
export function hiddenFieldKeys(fields: readonly SettingFieldView[], values: Readonly<Record<string, string>>): string[] {
  return fields.filter((f) => HIDDEN_WHILE_OFF.has(f.key) && values[f.dependsOn] !== "true").map((f) => f.key);
}

/** hiddenFieldKeys over the daemon's values, changing only when the answer does. */
export function useHiddenFields(fields: readonly SettingFieldView[]): ReadonlySet<string> {
  const keys = useSettingsStore((s) => hiddenFieldKeys(fields, s.snapshot?.values ?? {}).join(" "));
  return useMemo(() => new Set(keys.split(" ")), [keys]);
}
