import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginView } from "@/api/plugin";
import type { SettingFieldView, SettingsSchemaView } from "@/api/settings";

/**
 * Settings › General › Events in “Until event” (docs/notes/snooze-until-event.md):
 * threads.snooze_events as checkboxes. A save lands in the snapshot at once, as the events
 * stream brings it back.
 */
const KEY = "threads.snooze_events";
const save = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/stores/settings", async (orig) => {
  const m = await orig<typeof import("@/stores/settings")>();
  save.fn.mockImplementation((values: Record<string, string>) => {
    const cur = m.useSettingsStore.getState().snapshot;
    if (cur) m.useSettingsStore.setState({ snapshot: { ...cur, values: { ...cur.values, ...values }, revision: cur.revision + 1 } });
    return Promise.resolve({ ok: true as const });
  });
  return { ...m, saveSettings: save.fn, loadSettingsSchema: () => Promise.resolve() };
});

const { Dialog } = await import("@/components/ui/dialog");
const { SettingsPage } = await import("./SettingsPage");
const { useSettingsStore } = await import("@/stores/settings");
const { usePluginsStore } = await import("@/stores/plugins");
const { useViewsStore } = await import("@/stores/views");

const field: SettingFieldView = {
  key: KEY,
  title: "Events in Until event",
  description: "The events a snooze menu's Until event offers.",
  group: "threads",
  type: "string",
  enumValues: [],
  enumLabels: [],
  enumDescriptions: [],
  enumExamples: [],
  defaultValue: "checks_done review merged",
  restartRequired: false,
  min: 0,
  max: 0,
  placeholder: "",
  page: "general",
  section: "snooze",
  unit: "",
  dependsOn: "",
  dependsOnValue: "",
  row: "",
};
const schema: SettingsSchemaView = {
  groups: [],
  fields: [field],
  pages: [{ id: "general", title: "General", description: "", sections: [{ id: "snooze", title: "Events in “Until event”", description: "What a snooze menu's Until event offers." }] }],
};

function plugin(name: string, displayName: string, wakes: { name: string; title: string }[]): PluginView {
  return { name, displayName, wakes } as PluginView;
}

function setValue(v: string | undefined): void {
  useSettingsStore.setState({ schema, snapshot: { values: v === undefined ? {} : { [KEY]: v }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
}

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  save.fn.mockClear();
  setValue(undefined);
  usePluginsStore.setState({
    byName: { hello: plugin("hello", "Hello", [{ name: "tick", title: "Tick" }]), "doc-preview": plugin("doc-preview", "Doc Preview", [{ name: "deploy", title: "Preview deployed" }]), quiet: plugin("quiet", "Quiet", []) },
    order: ["doc-preview", "hello", "quiet"],
  });
  useViewsStore.setState({ settingsPage: "general" });
});
afterEach(cleanup);

/** Each row as "word on|off". */
const rows = () => screen.getAllByTestId("snooze-events-row").map((r) => `${r.dataset.event ?? ""} ${r.querySelector('[role="checkbox"]')?.getAttribute("aria-checked") === "true" ? "on" : "off"}`);

describe("Events in “Until event”", () => {
  it("lists the pull request events (three on by default), then each plugin's wake sources (off), with the plugin's name", () => {
    render(
      <Dialog open>
        <SettingsPage />
      </Dialog>,
    );
    expect(screen.getByRole("region", { name: "Events in “Until event”" })).toBeTruthy();
    expect(rows()).toEqual([
      "checks_done on",
      "review on",
      "merged on",
      "comment off",
      "head_pushed off",
      "closed off",
      "review_requested off",
      "plugin:doc-preview/deploy off",
      "plugin:hello/tick off",
    ]);
    expect(screen.getAllByTestId("snooze-events-row").at(-1)?.textContent).toBe("TickHello");
    // The section answers focusSetting for "Choose what shows here…".
    expect(document.querySelector(`[data-setting="${KEY}"]`)).toBeTruthy();
  });

  it("saves the whole list on each change, in menu order", async () => {
    render(
      <Dialog open>
        <SettingsPage />
      </Dialog>,
    );
    const check = (word: string) => screen.getAllByTestId("snooze-events-row").find((r) => r.dataset.event === word)?.querySelector('[role="checkbox"]') as HTMLElement;
    fireEvent.click(check("plugin:hello/tick"));
    await act(() => Promise.resolve());
    expect(save.fn).toHaveBeenLastCalledWith({ [KEY]: "checks_done review merged plugin:hello/tick" });
    fireEvent.click(check("review"));
    await act(() => Promise.resolve());
    fireEvent.click(check("closed"));
    await act(() => Promise.resolve());
    expect(save.fn).toHaveBeenLastCalledWith({ [KEY]: "checks_done merged closed plugin:hello/tick" });
    expect(rows().filter((r) => r.endsWith(" on"))).toEqual(["checks_done on", "merged on", "closed on", "plugin:hello/tick on"]);
  });

  it("stores none when the last one goes", async () => {
    setValue("merged");
    render(
      <Dialog open>
        <SettingsPage />
      </Dialog>,
    );
    fireEvent.click(screen.getAllByTestId("snooze-events-row").find((r) => r.dataset.event === "merged")?.querySelector('[role="checkbox"]') as HTMLElement);
    await act(() => Promise.resolve());
    expect(save.fn).toHaveBeenLastCalledWith({ [KEY]: "none" });
  });
});
