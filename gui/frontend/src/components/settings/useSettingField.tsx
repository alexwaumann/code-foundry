import { useState } from "react";
import { toast } from "sonner";
import type { SettingFieldView } from "@/api/settings";
import { validateSetting } from "@/settings/validate";
import { saveSettings, useSettingsStore, useSettingValue } from "@/stores/settings";
import type { SettingEditor } from "./editor";
import { BoolEditor, EnumEditor, KeybindingEditor, TextEditor } from "./editors";
import { keyEditors } from "./keyEditors";
import { displayValue } from "./model";

const editors: Record<SettingFieldView["type"], SettingEditor> = {
  bool: BoolEditor,
  enum: EnumEditor,
  int: TextEditor,
  string: TextEditor,
  path: TextEditor,
  keybinding: KeybindingEditor,
};

/** A field's value, its editor, and saving: what every kind of row (full, paired, keybinding) shares. */
export function useSettingField(field: SettingFieldView) {
  const value = useSettingValue(field.key) ?? field.defaultValue;
  const restartPending = useSettingsStore((s) => s.snapshot?.restartPending.includes(field.key) ?? false);
  const fileIssue = useSettingsStore((s) => s.snapshot?.issues.find((i) => i.key === field.key)?.message);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const commit = (raw: string) => {
    const v = validateSetting(field, raw);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setError(null);
    setPending(true);
    void saveSettings({ [field.key]: v.value }).then((res) => {
      setPending(false);
      if (!res.ok) {
        setError(res.issues[field.key] ?? res.error);
        return;
      }
      const shown = displayValue(field, useSettingsStore.getState().snapshot?.values[field.key] ?? v.value);
      toast.success(`Saved ${field.title}`, {
        description: `${shown}${field.restartRequired ? " · applies after a daemon restart" : ""}`,
      });
    });
  };

  const Editor = keyEditors[field.key] ?? editors[field.type];
  const modified = value !== field.defaultValue && !(field.type === "keybinding" && value === "" && field.defaultValue === "");
  const message = error ?? (fileIssue ? `In the file: ${fileIssue}` : null);
  const editor = <Editor field={field} value={value} pending={pending} invalid={message !== null} commit={commit} setError={setError} />;
  return { value, restartPending, pending, commit, modified, message, editor };
}
