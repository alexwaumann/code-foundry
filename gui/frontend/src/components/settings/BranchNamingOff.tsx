import type { SettingFieldView } from "@/api/settings";
import { useSettingValue } from "@/stores/settings";

/**
 * After projects.branch_naming's words, only while automatic naming is off: no model call
 * names the branch then. An old daemon's description (no option sentences) says this itself.
 */
export function BranchNamingOff({ field }: { field: SettingFieldView }) {
  const autoName = useSettingValue("threads.auto_name");
  const mode = useSettingValue("projects.branch_naming");
  if (autoName !== "false" || field.enumDescriptions.length === 0) return null;
  return mode === "prefix" ? " With automatic naming off, the slug comes from the thread's name." : " With automatic naming off, branches are named cf/<thread id>.";
}
