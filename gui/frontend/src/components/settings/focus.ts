/**
 * Brings a setting's row into view and puts the caret in its editor (the first input,
 * textarea, button or combobox in the row SettingRow marks with data-setting). False when
 * the page does not show that setting.
 */
export function focusSetting(key: string, root: ParentNode = document): boolean {
  const row = root.querySelector<HTMLElement>(`[data-setting="${CSS.escape(key)}"]`);
  if (!row) return false;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  const editor = row.querySelector<HTMLElement>("input, textarea, [role='combobox'], button");
  editor?.focus({ preventScroll: true });
  return true;
}
