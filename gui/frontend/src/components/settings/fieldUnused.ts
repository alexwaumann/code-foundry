import type { SettingFieldView } from "@/api/settings";
import { useSettingValue } from "@/stores/settings";
import { enumLabel } from "./model";

/**
 * Whether a field does nothing now because of the one it depends on (`parent`): that bool is
 * off, or that enum has another value than dependsOnValue. `reason` says so, for a row
 * away from its parent.
 */
export function useFieldUnused(field: SettingFieldView, parent: SettingFieldView | undefined): { unused: boolean; reason: string | undefined } {
  const parentValue = useSettingValue(field.dependsOn) ?? parent?.defaultValue;
  const unused = field.dependsOn !== "" && (field.dependsOnValue === "" ? parentValue === "false" : parentValue !== field.dependsOnValue);
  if (!unused || !parent) return { unused, reason: undefined };
  const state = field.dependsOnValue === "" ? "off" : enumLabel(parent, parentValue ?? "");
  return { unused, reason: `Not used while ${parent.title} is ${state}.` };
}
