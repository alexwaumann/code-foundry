import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingFieldView } from "@/api/settings";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const save = vi.hoisted(() => ({ fn: vi.fn(() => Promise.resolve({ ok: true as const })) }));
vi.mock("@/stores/settings", async (orig) => ({ ...(await orig<typeof import("@/stores/settings")>()), saveSettings: save.fn }));

const { SettingRow } = await import("./SettingRow");
const { BrowseThemesRow } = await import("./LinkRow");
const { useSettingsStore } = await import("@/stores/settings");
const { useViewsStore } = await import("@/stores/views");
const { useThemePickerStore } = await import("@/stores/themePicker");

const base: Omit<SettingFieldView, "key" | "title" | "type"> = {
  description: "",
  group: "g",
  enumValues: [],
  enumLabels: [],
  enumDescriptions: [],
  enumExamples: [],
  defaultValue: "",
  restartRequired: false,
  min: 0,
  max: 0,
  placeholder: "",
  page: "",
  section: "",
  unit: "",
  dependsOn: "",
  dependsOnValue: "",
  row: "",
};
const bool: SettingFieldView = { ...base, key: "threads.auto_name", title: "Auto name", type: "bool", defaultValue: "true" };
// "" (no preference) is a value of its own; Radix Select cannot hold it as an item.
const theme: SettingFieldView = { ...base, key: "appearance.theme", title: "Theme", type: "enum", enumValues: ["", "light", "dark"], defaultValue: "light" };
const text: SettingFieldView = { ...base, key: "threads.branch_prefix", title: "Branch prefix", type: "string", defaultValue: "cf/" };

function setValues(values: Record<string, string>): void {
  useSettingsStore.setState({ snapshot: { values, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
}

beforeAll(() => {
  // Radix Select scrolls the selected item into view; jsdom has no layout.
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
});
beforeEach(() => {
  vi.clearAllMocks();
  setValues({});
});
afterEach(cleanup);

describe("SettingRow editors", () => {
  it("a bool is the shadcn switch and commits the flipped value", () => {
    setValues({ [bool.key]: "true" });
    render(<SettingRow field={bool} />);
    const sw = screen.getByRole("switch", { name: "Auto name" });
    expect(sw.getAttribute("data-slot")).toBe("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(save.fn).toHaveBeenCalledExactlyOnceWith({ [bool.key]: "false" });
  });

  it("an enum is the shadcn select: its value, the (default) suffix, and Default for the empty value", () => {
    setValues({ [theme.key]: "dark" });
    render(<SettingRow field={theme} />);
    const trigger = screen.getByRole("combobox", { name: "Theme" });
    expect(trigger.getAttribute("data-slot")).toBe("select-trigger");
    expect(trigger.getAttribute("data-value")).toBe("dark");
    expect(trigger.textContent).toBe("dark");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Default", "light (default)", "dark"]);
    fireEvent.click(screen.getByRole("option", { name: "Default" }));
    expect(save.fn).toHaveBeenCalledExactlyOnceWith({ [theme.key]: "" });
  });

  it("an empty enum value shows as Default", () => {
    setValues({ [theme.key]: "" });
    render(<SettingRow field={theme} />);
    const trigger = screen.getByRole("combobox", { name: "Theme" });
    expect(trigger.getAttribute("data-value")).toBe("");
    expect(trigger.textContent).toBe("Default");
  });

  describe("an explained enum", () => {
    const naming: SettingFieldView = {
      ...base,
      key: "projects.branch_naming",
      title: "Branch names",
      description: "How a new worktree's branch is named.",
      type: "enum",
      enumValues: ["semantic", "prefix", "custom"],
      enumLabels: ["Semantic", "Prefix", "Custom instructions"],
      enumDescriptions: ["A type, then a slug.", "Your word, then a slug.", "You tell the model."],
      enumExamples: ["feat/add-filter", "cf/add-filter", ""],
      defaultValue: "semantic",
    };
    const words = () => document.querySelector('[data-setting="projects.branch_naming"] p')?.textContent;

    it("the list explains each option; the trigger shows the name alone, and a pick saves", () => {
      setValues({ [naming.key]: "semantic", "projects.branch_prefix": "cf" });
      render(<SettingRow field={naming} />);
      const trigger = screen.getByRole("combobox", { name: "Branch names" });
      fireEvent.keyDown(trigger, { key: "Enter" });
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Semantic (default)feat/add-filterA type, then a slug.", "Prefixcf/add-filterYour word, then a slug.", "Custom instructionsYou tell the model."]);
      fireEvent.click(screen.getByRole("option", { name: /^Prefix/ }));
      expect(save.fn).toHaveBeenCalledExactlyOnceWith({ [naming.key]: "prefix" });
    });

    it.each([
      ["semantic", "cf", "A type, then a slug. For example feat/add-filter."],
      ["prefix", "cf", "Your word, then a slug. For example cf/add-filter."],
      ["prefix", "wip/me/", "Your word, then a slug. For example wip/me/add-filter."],
      ["prefix", "none", "Your word, then a slug. For example add-filter."],
      ["custom", "cf", "You tell the model."],
    ])("the row says what %s does with prefix %s", (mode, prefix, want) => {
      setValues({ [naming.key]: mode, "projects.branch_prefix": prefix });
      render(<SettingRow field={naming} />);
      expect(words()).toBe(want);
    });

    it("the list's example follows the prefix too", () => {
      setValues({ [naming.key]: "semantic", "projects.branch_prefix": "wip" });
      render(<SettingRow field={naming} />);
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Branch names" }), { key: "Enter" });
      expect(screen.getByRole("option", { name: /^Prefix/ }).textContent).toContain("wip/add-filter");
    });

    it.each([
      ["semantic", "true", ""],
      ["semantic", "false", " With automatic naming off, branches are named cf/<thread id>."],
      ["prefix", "false", " With automatic naming off, the slug comes from the thread's name."],
    ])("%s with automatic naming %s", (mode, autoName, tail) => {
      setValues({ [naming.key]: mode, "projects.branch_prefix": "cf", "threads.auto_name": autoName });
      render(<SettingRow field={naming} />);
      expect(words()?.endsWith(`.${tail}`)).toBe(true);
    });

    it("an old daemon's field (no sentences) keeps its own description and its own caveat", () => {
      setValues({ [naming.key]: "semantic", "threads.auto_name": "false" });
      render(<SettingRow field={{ ...naming, description: "Old words.", enumDescriptions: [], enumExamples: [] }} />);
      expect(words()).toBe("Old words.");
    });

    it("a value outside the options keeps the field's description", () => {
      setValues({ [naming.key]: "gone", "projects.branch_prefix": "cf" });
      render(<SettingRow field={naming} />);
      expect(words()).toBe("How a new worktree's branch is named.");
    });

    it("in the search: the field's description and the option found, marked", () => {
      setValues({ [naming.key]: "semantic", "projects.branch_prefix": "cf" });
      render(<SettingRow field={naming} words={["prefix"]} />);
      expect(words()).toBe("How a new worktree's branch is named. Prefix: your word, then a slug.");
      expect(document.querySelector("mark")?.textContent).toBe("Prefix");
    });
  });

  it("a text input commits on Enter and Escape puts the saved value back", () => {
    setValues({ [text.key]: "cf/" });
    render(<SettingRow field={text} />);
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Branch prefix" });
    expect(input.getAttribute("data-slot")).toBe("input");
    input.focus();
    fireEvent.change(input, { target: { value: "wip/" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("cf/");
    expect(save.fn).not.toHaveBeenCalled();
    input.focus();
    fireEvent.change(input, { target: { value: "wip/" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(save.fn).toHaveBeenCalledExactlyOnceWith({ [text.key]: "wip/" });
  });

  // The options are the daemon's per-scheme list (internal/store/settings theme_test.go
  // TestThemeSlotFields); applying the saved slot to <html> is src/stores/settings.test.ts and
  // src/lib/theme.test.ts (syncDocumentScheme).
  it("a theme slot is a select of its field's themes without (default), saves the pick, and Choose… opens Themes on the slot", () => {
    const dark: SettingFieldView = { ...base, key: "appearance.theme_dark", title: "Dark theme", type: "enum", enumValues: ["github-dark", "dracula"], enumLabels: ["GitHub Dark", "Dracula"], defaultValue: "github-dark" };
    setValues({ [dark.key]: "github-dark" });
    useViewsStore.setState({ settingsOpen: true, themesOpen: false });
    render(<SettingRow field={dark} />);
    const trigger = screen.getByRole("combobox", { name: "Dark theme" });
    // The name whole: no " (default)" beside the Choose… button.
    expect(trigger.textContent).toBe("GitHub Dark");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["GitHub Dark", "Dracula"]);
    fireEvent.click(screen.getByRole("option", { name: "Dracula" }));
    expect(save.fn).toHaveBeenCalledExactlyOnceWith({ [dark.key]: "dracula" });
    fireEvent.click(screen.getByTestId("choose-theme-dark"));
    expect(useViewsStore.getState()).toMatchObject({ themesOpen: true, settingsOpen: false });
    expect(useThemePickerStore.getState().slot).toBe("dark");
    useViewsStore.setState({ themesOpen: false });
  });

  it("Browse themes opens the Themes page on the scheme in use, coming back to Settings", () => {
    useViewsStore.setState({ settingsOpen: true, themesOpen: false });
    render(<BrowseThemesRow />);
    fireEvent.click(screen.getByTestId("settings-themes-link"));
    expect(useViewsStore.getState()).toMatchObject({ themesOpen: true, settingsOpen: false });
    expect(useThemePickerStore.getState()).toMatchObject({ slot: "dark", returnTo: "settings" });
    useViewsStore.setState({ themesOpen: false });
  });
});
