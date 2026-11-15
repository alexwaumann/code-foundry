import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingFieldView, SettingsSchemaView } from "@/api/settings";

/**
 * Settings › General › Files: files.include_ignored as a pattern list
 * (docs/notes/file-search-2-includes-gui.md). A save lands in the snapshot at once, as the
 * events stream brings it back; a value with "../" is refused as the daemon refuses it.
 */
const KEY = "files.include_ignored";
const REFUSED = 'pattern "../x" has a ".." segment; patterns name paths inside the project';
const save = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/stores/settings", async (orig) => {
  const m = await orig<typeof import("@/stores/settings")>();
  save.fn.mockImplementation((values: Record<string, string>) => {
    if (values["files.include_ignored"]?.includes("../")) return Promise.resolve({ ok: false as const, error: "invalid settings", issues: { "files.include_ignored": REFUSED } });
    const cur = m.useSettingsStore.getState().snapshot;
    if (cur) m.useSettingsStore.setState({ snapshot: { ...cur, values: { ...cur.values, ...values }, revision: cur.revision + 1 } });
    return Promise.resolve({ ok: true as const });
  });
  return { ...m, saveSettings: save.fn, loadSettingsSchema: () => Promise.resolve() };
});

const { Dialog } = await import("@/components/ui/dialog");
const { SettingsPage } = await import("./SettingsPage");
const { useSettingsStore } = await import("@/stores/settings");
const { useViewsStore } = await import("@/stores/views");

const DEFAULT = ".env*, CLAUDE.local.md, .claude/settings.local.json";
const field: SettingFieldView = {
  key: KEY,
  title: "Ignored files to include",
  description: "Git-ignored files that Go to File and @ still find, in every project, as .gitignore-style patterns separated by commas. none for no patterns.",
  group: "files",
  type: "string",
  enumValues: [],
  enumLabels: [],
  enumDescriptions: [],
  enumExamples: [],
  defaultValue: DEFAULT,
  restartRequired: false,
  min: 0,
  max: 0,
  placeholder: ".env*, docs/scratch/",
  page: "general",
  section: "files",
  unit: "",
  dependsOn: "",
  dependsOnValue: "",
  row: "",
};
const schema: SettingsSchemaView = { groups: [], fields: [field], pages: [{ id: "general", title: "General", description: "", sections: [{ id: "files", title: "Files", description: "What Go to File and @ completion find." }] }] };

function setValue(v: string): void {
  useSettingsStore.setState({ schema, snapshot: { values: { [KEY]: v }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
}

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  save.fn.mockClear();
  setValue(DEFAULT);
  useViewsStore.setState({ settingsPage: "general" });
});
afterEach(cleanup);

const open = () => render(<Dialog open><SettingsPage /></Dialog>);
const section = () => screen.getByTestId("include-setting");
/** Each row as "pattern [badge]". */
const rows = () =>
  within(section())
    .queryAllByTestId("include-row")
    .map((r) => [r.dataset.pattern, r.querySelector('[data-testid="include-badge"]')?.textContent].filter(Boolean).join(" "));
const value = () => useSettingsStore.getState().snapshot?.values[KEY];
const addInput = () => within(section()).getByTestId("include-add-input");

async function settled(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function remove(pattern: string): Promise<void> {
  fireEvent.click(within(section()).getByRole("button", { name: `Remove ${pattern}` }));
  await settled();
}

async function add(text: string): Promise<void> {
  fireEvent.change(addInput(), { target: { value: text } });
  fireEvent.keyDown(addInput(), { key: "Enter" });
  await settled();
}

describe("Ignored files to include", () => {
  it("fresh: its own section headed by the setting, the three defaults badged, no restore link, the add field", () => {
    open();
    const card = screen.getByRole("region", { name: "Ignored files to include" });
    expect(card.textContent).toContain("Git-ignored files that match are found by Go to File and @ in the prompt, in every project. A project can add its own on its page.");
    expect(rows()).toEqual([".env* default", "CLAUDE.local.md default", ".claude/settings.local.json default"]);
    expect(screen.queryByTestId("include-restore")).toBeNull();
    expect(addInput().getAttribute("placeholder")).toBe("Add a pattern, like *.local.json or scratch/");
    // No raw text field for the value.
    expect(screen.queryByDisplayValue(DEFAULT)).toBeNull();
  });

  it("× removes a pattern: the rest is saved, and the missing default is offered back", async () => {
    open();
    await remove("CLAUDE.local.md");
    expect(save.fn).toHaveBeenCalledWith({ [KEY]: ".env*, .claude/settings.local.json" });
    expect(rows()).toEqual([".env* default", ".claude/settings.local.json default"]);
    expect(screen.getByTestId("include-restore").textContent).toBe("Restore 1 default");
  });

  it("Enter adds the typed pattern at the end (no badge) and clears the field", async () => {
    open();
    await add("  scratch/ ");
    expect(save.fn).toHaveBeenCalledWith({ [KEY]: `${DEFAULT}, scratch/` });
    expect(rows().at(-1)).toBe("scratch/");
    expect((addInput() as HTMLInputElement).value).toBe("");
  });

  it("adding a pattern already in the list saves nothing", async () => {
    open();
    await add("CLAUDE.local.md");
    expect(save.fn).not.toHaveBeenCalled();
  });

  it("Restore appends only the missing defaults and keeps the user's own patterns where they are", async () => {
    setValue(".env*, .claude/settings.local.json, *.local.json, scratch/");
    open();
    expect(rows()).toEqual([".env* default", ".claude/settings.local.json default", "*.local.json", "scratch/"]);
    fireEvent.click(screen.getByTestId("include-restore"));
    await settled();
    expect(save.fn).toHaveBeenCalledWith({ [KEY]: ".env*, .claude/settings.local.json, *.local.json, scratch/, CLAUDE.local.md" });
    expect(value()).toBe(".env*, .claude/settings.local.json, *.local.json, scratch/, CLAUDE.local.md");
    expect(screen.queryByTestId("include-restore")).toBeNull();
  });

  it("removing the last pattern stores none (an empty value would bring the defaults back); none lists nothing and offers all three", async () => {
    setValue("scratch/");
    open();
    expect(screen.getByTestId("include-restore").textContent).toBe("Restore 3 defaults");
    await remove("scratch/");
    expect(save.fn).toHaveBeenCalledWith({ [KEY]: "none" });
    expect(rows()).toEqual([]);
    expect(screen.getByTestId("include-restore").textContent).toBe("Restore 3 defaults");
    fireEvent.click(screen.getByTestId("include-restore"));
    await settled();
    expect(value()).toBe(DEFAULT);
  });

  it("a refused pattern shows the daemon's message and keeps the typed text; typing clears the message", async () => {
    open();
    await add("../x");
    expect(screen.getByTestId("include-error").textContent).toBe(REFUSED);
    expect((addInput() as HTMLInputElement).value).toBe("../x");
    expect(value()).toBe(DEFAULT);
    fireEvent.change(addInput(), { target: { value: "../" } });
    expect(screen.queryByTestId("include-error")).toBeNull();
  });

  it("Escape clears the field and lets go of the keyboard", () => {
    open();
    fireEvent.change(addInput(), { target: { value: "scr" } });
    addInput().focus();
    fireEvent.keyDown(addInput(), { key: "Escape" });
    expect((addInput() as HTMLInputElement).value).toBe("");
    expect(document.activeElement).not.toBe(addInput());
  });

  it("a comma is refused before saving: it would add several patterns", async () => {
    open();
    await add("a, b");
    expect(save.fn).not.toHaveBeenCalled();
    expect(screen.getByTestId("include-error").textContent).toBe('pattern "a, b" has a comma, which separates patterns');
  });

  it("the search finds the setting and edits it as the same list in its row", async () => {
    open();
    fireEvent.change(screen.getByPlaceholderText("Search settings"), { target: { value: "ignored" } });
    const results = screen.getByTestId("settings-results");
    const editor = within(results).getByTestId("include-setting");
    expect(within(editor).getAllByTestId("include-row").map((r) => r.dataset.pattern)).toEqual([".env*", "CLAUDE.local.md", ".claude/settings.local.json"]);
    fireEvent.click(within(editor).getByRole("button", { name: "Remove .env*" }));
    await settled();
    expect(save.fn).toHaveBeenCalledWith({ [KEY]: "CLAUDE.local.md, .claude/settings.local.json" });
    expect(within(results).getByTestId("include-restore").textContent).toBe("Restore 1 default");
  });
});
