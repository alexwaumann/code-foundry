import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SettingFieldView, SettingsSchemaView } from "@/api/settings";
import { useSettingsStore } from "@/stores/settings";
import { KeybindingsPage } from "./KeybindingsPage";

// The daemon lists a keybindings.<command> field per bindable command, in its category's
// section; dictation.toggle's title and chord are checked in Go (commands_dictation_test.go).
const dictate: SettingFieldView = {
  key: "keybindings.dictation.toggle",
  title: "Dictate",
  type: "keybinding",
  description: "Start or stop dictating into the focused composer.",
  group: "keybindings",
  enumValues: [],
  enumLabels: [],
  defaultValue: "cmd+shift+m",
  restartRequired: false,
  min: 0,
  max: 0,
  placeholder: "dictation.toggle",
  page: "keybindings",
  section: "dictation",
  unit: "",
  dependsOn: "",
  row: "",
};
const page = { id: "keybindings", title: "Keybindings", description: "", sections: [{ id: "dictation", title: "Dictation", description: "" }] };
const schema: SettingsSchemaView = { groups: [], fields: [dictate], pages: [page] };

beforeEach(() => {
  useSettingsStore.setState({ snapshot: { values: {}, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
});
afterEach(cleanup);

describe("KeybindingsPage", () => {
  it("lists a command by its title with its default chord", () => {
    const { container } = render(<KeybindingsPage schema={schema} page={page} />);
    const row = container.querySelector<HTMLElement>('[data-setting="keybindings.dictation.toggle"]');
    if (!row) throw new Error("no row");
    expect(row.textContent).toContain("Dictate");
    expect(within(row).getByRole("button", { name: /shortcut/ }).textContent).toBe("⇧⌘M");
  });
});
