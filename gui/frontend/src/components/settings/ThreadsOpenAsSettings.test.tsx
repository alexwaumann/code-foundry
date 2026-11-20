import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingFieldView } from "@/api/settings";

vi.mock("@/lib/notify", () => ({ notify: vi.fn(), notifyProgress: vi.fn(), dismissNotice: vi.fn() }));
const save = vi.hoisted(() => ({ fn: vi.fn(() => Promise.resolve({ ok: true as const })) }));
vi.mock("@/stores/settings", async (orig) => ({ ...(await orig<typeof import("@/stores/settings")>()), saveSettings: save.fn }));
// What layout.threads-open-as.preview answers.
const preview = vi.hoisted(() => ({ json: "{}", calls: [] as [string, Record<string, string>][] }));
vi.mock("@/stores/commands", async (orig) => ({
  ...(await orig<typeof import("@/stores/commands")>()),
  runCommandForResult: (name: string, args: Record<string, string>) => {
    preview.calls.push([name, args]);
    return Promise.resolve({ message: "", resultJson: preview.json });
  },
}));

const { SettingRow } = await import("./SettingRow");
const { useSettingsStore } = await import("@/stores/settings");
const { answerConfirm, useConfirmStore } = await import("@/stores/confirm");

const base: Omit<SettingFieldView, "key" | "title" | "type"> = {
  description: "",
  group: "layout",
  enumValues: [],
  enumLabels: [],
  enumDescriptions: [],
  enumExamples: [],
  defaultValue: "",
  restartRequired: false,
  min: 0,
  max: 0,
  placeholder: "",
  page: "layout",
  section: "panes",
  unit: "",
  dependsOn: "",
  dependsOnValue: "",
  row: "",
};
const openAs: SettingFieldView = {
  ...base,
  key: "layout.threads_open_as",
  title: "Threads open as",
  type: "enum",
  description: "With Panes or Single, linked panes always follow the focused thread (smart swap is on).",
  enumValues: ["tabs", "panes", "single"],
  enumLabels: ["Tabs", "Panes", "Single"],
  enumDescriptions: [
    "Each thread you open adds a tab. You close tabs yourself.",
    "A thread pane shows one thread. Opening another thread swaps it in, and the diff, files and terminals beside it switch with it. Split when you want two threads side by side.",
    "As Panes, with one thread pane per space. Every thread opens there.",
  ],
  enumExamples: ["", "", ""],
  defaultValue: "panes",
};
const swap: SettingFieldView = {
  ...base,
  key: "layout.smart_swap",
  title: "Smart swap",
  type: "bool",
  description: "When a thread's tab gains focus, linked panes switch.",
  defaultValue: "true",
};

function setValues(values: Record<string, string>): void {
  useSettingsStore.setState({ snapshot: { values, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
});
beforeEach(() => {
  vi.clearAllMocks();
  preview.json = "{}";
  preview.calls.length = 0;
  useConfirmStore.setState({ pending: null });
  setValues({ [openAs.key]: "tabs", [swap.key]: "false" });
});
afterEach(cleanup);

const words = (key: string) => document.querySelector(`[data-setting="${key}"] p`)?.textContent;

function pick(name: RegExp): void {
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Threads open as" }), { key: "Enter" });
  fireEvent.click(screen.getByRole("option", { name }));
}

describe("Threads open as", () => {
  it("lists the three options, each with its description; the trigger shows the title alone; the row says what Panes and Single share", () => {
    render(<SettingRow field={openAs} />);
    const trigger = screen.getByRole("combobox", { name: "Threads open as" });
    expect(trigger.textContent.startsWith("Tabs")).toBe(true);
    expect(words(openAs.key)).toBe(openAs.description);
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "TabsEach thread you open adds a tab. You close tabs yourself.",
      `Panes (default)${openAs.enumDescriptions[1] ?? ""}`,
      `Single${openAs.enumDescriptions[2] ?? ""}`,
    ]);
  });

  // The marker is the schema's default, whatever it is: Panes since part 3, Tabs before it.
  it.each(["panes", "tabs", "single"])("with %s as the schema's default, (default) marks that option alone", (defaultValue) => {
    render(<SettingRow field={{ ...openAs, defaultValue }} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Threads open as" }), { key: "Enter" });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(
      openAs.enumValues.map((v, i) => `${openAs.enumLabels[i] ?? ""}${v === defaultValue ? " (default)" : ""}${openAs.enumDescriptions[i] ?? ""}`),
    );
  });

  it("a switch that closes nothing is made at once, after asking the daemon", async () => {
    render(<SettingRow field={openAs} />);
    pick(/^Panes/);
    await waitFor(() => {
      expect(save.fn).toHaveBeenCalledExactlyOnceWith({ [openAs.key]: "panes" });
    });
    expect(preview.calls).toEqual([["layout.threads-open-as.preview", { to: "panes" }]]);
    expect(useConfirmStore.getState().pending).toBeNull();
  });

  it("a switch that closes tabs asks with the counts; Switch saves it", async () => {
    preview.json = JSON.stringify({ to: "panes", thread_tabs: 3, composers: 0, panes: 0, moved: 0, spaces: 2 });
    render(<SettingRow field={openAs} />);
    pick(/^Panes/);
    await waitFor(() => {
      expect(useConfirmStore.getState().pending?.title).toBe("Switch to Panes?");
    });
    expect(useConfirmStore.getState().pending?.message).toContain("3 other thread tabs in 2 spaces will close.");
    expect(save.fn).not.toHaveBeenCalled();
    act(() => {
      answerConfirm(true);
    });
    await waitFor(() => {
      expect(save.fn).toHaveBeenCalledExactlyOnceWith({ [openAs.key]: "panes" });
    });
  });

  it("Cancel saves nothing and the dropdown stays on its old value", async () => {
    preview.json = JSON.stringify({ thread_tabs: 0, composers: 0, panes: 2, moved: 0, spaces: 1 });
    render(<SettingRow field={openAs} />);
    pick(/^Single/);
    await waitFor(() => {
      expect(useConfirmStore.getState().pending?.title).toBe("Switch to Single?");
    });
    act(() => {
      answerConfirm(false);
    });
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Threads open as" }).hasAttribute("data-disabled")).toBe(false);
    });
    expect(save.fn).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Threads open as" }).getAttribute("data-value")).toBe("tabs");
  });

  it("toward Tabs neither asks nor previews", async () => {
    setValues({ [openAs.key]: "panes" });
    render(<SettingRow field={openAs} />);
    pick(/^Tabs/);
    await waitFor(() => {
      expect(save.fn).toHaveBeenCalledExactlyOnceWith({ [openAs.key]: "tabs" });
    });
    expect(preview.calls).toEqual([]);
  });
});

describe("Smart swap under Threads open as", () => {
  it("under Tabs shows and changes the stored value", () => {
    render(<SettingRow field={swap} />);
    const sw = screen.getByRole("switch", { name: "Smart swap" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(words(swap.key)).toBe(swap.description);
    fireEvent.click(sw);
    expect(save.fn).toHaveBeenCalledExactlyOnceWith({ [swap.key]: "true" });
  });

  it.each(["panes", "single"])("under %s is on and disabled with its reason, its stored value untouched and no reset", (mode) => {
    setValues({ [openAs.key]: mode, [swap.key]: "false" });
    render(<SettingRow field={swap} />);
    const sw = screen.getByRole("switch", { name: "Smart swap" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.hasAttribute("disabled")).toBe(true);
    expect(words(swap.key)).toBe(`${swap.description} Always on while threads open as Panes or Single.`);
    fireEvent.click(sw);
    expect(save.fn).not.toHaveBeenCalled();
    // The reset arrow would write the default over the user's own value: hidden while held.
    expect(screen.getByRole("button", { name: "Reset Smart swap" }).className).toContain("invisible");
  });
});
