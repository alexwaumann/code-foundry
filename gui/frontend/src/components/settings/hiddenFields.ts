import { useMemo } from "react";
import type { SettingFieldView } from "@/api/settings";
import { useSettingsStore } from "@/stores/settings";

/**
 * Fields left out altogether while the bool they depend on is off, in the section and in
 * the search. The other bool dependents stay and dim (SectionCard's FieldRow). A field with
 * a dependsOnValue is left out of the section while its parent has another value; the
 * search still finds it, dimmed (SearchResults).
 */
const HIDDEN_WHILE_OFF: ReadonlySet<string> = new Set(["dictation.hold_key", "dictation.microphone", "dictation.sounds", "dictation.other_audio", "dictation.avoid_bluetooth", "dictation.spoken_symbols", "dictation.spoken_formatting"]);

/** Where the fields are hidden from: a section of a page, or the search. */
type HiddenFrom = "section" | "search";

/** The keys of `fields` hidden now. */
export function hiddenFieldKeys(fields: readonly SettingFieldView[], values: Readonly<Record<string, string>>, from: HiddenFrom = "section"): string[] {
  const hidden = (f: SettingFieldView) => (HIDDEN_WHILE_OFF.has(f.key) && values[f.dependsOn] !== "true") || (from === "section" && f.dependsOnValue !== "" && values[f.dependsOn] !== f.dependsOnValue);
  return fields.filter(hidden).map((f) => f.key);
}

/** hiddenFieldKeys over the daemon's values, changing only when the answer does. */
export function useHiddenFields(fields: readonly SettingFieldView[], from: HiddenFrom = "section"): ReadonlySet<string> {
  const keys = useSettingsStore((s) => hiddenFieldKeys(fields, s.snapshot?.values ?? {}, from).join(" "));
  return useMemo(() => new Set(keys.split(" ")), [keys]);
}
