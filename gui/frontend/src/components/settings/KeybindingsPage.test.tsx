import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingFieldView, SettingsSchemaView } from "@/api/settings";

const save = vi.hoisted(() => ({ fn: vi.fn(() => Promise.resolve({ ok: true as const })) }));
vi.mock("@/stores/settings", async (orig) => ({ ...(await orig<typeof import("@/stores/settings")>()), saveSettings: save.fn }));

const { KeybindingsPage } = await import("./KeybindingsPage");
const { useSettingsStore } = await import("@/stores/settings");
const { setBoundOnly } = await import("@/stores/settingsPrefs");

// The daemon lists a keybindings.<command> field per bindable command, in its category's
// section, with the command's default chord (never one an override gave it: Go,
// TestKeybindingResetAfterPluginStart); dictation.toggle's title and its lack of a default
// chord are checked in Go (commands_dictation_test.go).
const base: Omit<SettingFieldView, "key" | "title" | "description" | "defaultValue" | "placeholder" | "section"> = {
  type: "keybinding",
  group: "keybindings",
  enumValues: [],
  enumLabels: [],
  enumDescriptions: [],
  enumExamples: [],
  restartRequired: false,
  min: 0,
  max: 0,
  page: "keybindings",
  unit: "",
  dependsOn: "",
  dependsOnValue: "",
  row: "",
};
const dictate: SettingFieldView = {
  ...base,
  key: "keybindings.dictation.toggle",
  title: "Dictate",
  description: "Start or stop dictating into the focused composer.",
  defaultValue: "",
  placeholder: "dictation.toggle",
  section: "dictation",
};
const newTerminal: SettingFieldView = {
  ...base,
  key: "keybindings.terminal.new",
  title: "New Terminal",
  description: "Open a terminal tab.",
  defaultValue: "cmd+t",
  placeholder: "terminal.new",
  section: "terminal",
};
const page = {
  id: "keybindings",
  title: "Keybindings",
  description: "",
  sections: [
    { id: "dictation", title: "Dictation", description: "" },
    { id: "terminal", title: "Terminal", description: "" },
  ],
};
const schema: SettingsSchemaView = { groups: [], fields: [dictate, newTerminal], pages: [page] };

function setValues(values: Record<string, string>): void {
  useSettingsStore.setState({ snapshot: { values, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
}

function row(container: HTMLElement, key: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-setting="${key}"]`);
  if (!el) throw new Error(`no row ${key}`);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  setBoundOnly(false);
  setValues({});
});
afterEach(cleanup);

describe("KeybindingsPage", () => {
  it("lists a command by its title with the chord a settings file gives it", () => {
    setValues({ "keybindings.dictation.toggle": "cmd+shift+m" });
    const { container } = render(<KeybindingsPage schema={schema} page={page} />);
    const r = row(container, "keybindings.dictation.toggle");
    expect(r.textContent).toContain("Dictate");
    expect(within(r).getByRole("button", { name: /shortcut/ }).textContent).toBe("⇧⌘M");
  });

  it.each([
    { name: "unbound", value: "none", shows: "Add shortcut" },
    { name: "on another chord", value: "cmd+y", shows: "⌘Y" },
  ])("resetting a command $name removes its override and shows its default chord", async ({ value, shows }) => {
    setValues({ "keybindings.terminal.new": value, "keybindings.dictation.toggle": "" });
    const { container, rerender } = render(<KeybindingsPage schema={schema} page={page} />);
    const r = row(container, "keybindings.terminal.new");
    expect(within(r).getByRole("button", { name: "New Terminal shortcut" }).textContent).toBe(shows);
    expect(r.dataset.modified).toBe("true");

    fireEvent.click(within(r).getByRole("button", { name: "Reset New Terminal" }));
    // "" removes the key from the file; the daemon then reports the default as the value.
    expect(save.fn).toHaveBeenCalledExactlyOnceWith({ "keybindings.terminal.new": "" });
    await vi.waitFor(() => {
      expect(within(r).getByRole("button", { name: "New Terminal shortcut" })).not.toHaveProperty("disabled", true);
    });

    setValues({ "keybindings.terminal.new": "cmd+t", "keybindings.dictation.toggle": "" });
    rerender(<KeybindingsPage schema={schema} page={page} />);
    const after = row(container, "keybindings.terminal.new");
    expect(within(after).getByRole("button", { name: "New Terminal shortcut" }).textContent).toBe("⌘T");
    expect(after.dataset.modified).toBeUndefined();
    expect(within(after).getByRole("button", { name: "Reset New Terminal" })).toHaveProperty("disabled", true);
  });

  it("a command on its default chord has nothing to reset", () => {
    setValues({ "keybindings.terminal.new": "cmd+t", "keybindings.dictation.toggle": "" });
    const { container } = render(<KeybindingsPage schema={schema} page={page} />);
    const r = row(container, "keybindings.terminal.new");
    expect(r.dataset.modified).toBeUndefined();
    expect(within(r).getByRole("button", { name: "Reset New Terminal" })).toHaveProperty("disabled", true);
  });
});
