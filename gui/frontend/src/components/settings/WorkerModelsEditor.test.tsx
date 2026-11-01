import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingFieldView, SettingsSchemaView } from "@/api/settings";

// A save lands in the snapshot at once, as the daemon's events stream brings it back.
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
const { useViewsStore } = await import("@/stores/views");

/** Settings › Ember (docs/notes/ember-3-gui.md): the flame in the nav, ember.worker_models as chips. */

const KEY = "ember.worker_models";
const field: SettingFieldView = {
  key: KEY,
  title: "Worker models",
  description: "",
  group: "ember",
  type: "string",
  enumValues: [],
  enumLabels: [],
  defaultValue: "claude-opus-4-7[1m],claude-opus-4-8[1m]",
  restartRequired: false,
  min: 0,
  max: 0,
  placeholder: "",
  page: "ember",
  section: "",
  unit: "",
  dependsOn: "",
  row: "",
};
const schema: SettingsSchemaView = { groups: [], fields: [field], pages: [{ id: "ember", title: "Ember", description: "", sections: [{ id: "", title: "", description: "" }] }] };
const choices = [
  { value: "claude-opus-4-7[1m]", label: "Opus 4.7" },
  { value: "claude-opus-4-8[1m]", label: "Opus 4.8" },
  { value: "claude-sonnet-5[1m]", label: "Sonnet 5" },
];

beforeEach(() => {
  // jsdom has no scrolling; the page scrolls to its top on a page change.
  Element.prototype.scrollTo = () => undefined;
  save.fn.mockClear();
  useSettingsStore.setState({
    schema,
    modelChoices: choices,
    snapshot: { values: { [KEY]: "claude-opus-4-7[1m],claude-opus-4-8[1m]" }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] },
  });
  useViewsStore.setState({ settingsPage: "ember" });
});
afterEach(cleanup);

/** The page as its sheet holds it (its title is the sheet's). */
const open = () => render(<Dialog open><SettingsPage /></Dialog>);

const chip = (model: string) => {
  const el = within(screen.getByTestId("ember-worker-models")).getAllByRole("button").find((b) => b.dataset.model === model);
  if (!el) throw new Error(`no chip ${model}`);
  return el;
};
const pressed = (model: string) => chip(model).getAttribute("aria-pressed");
const value = () => useSettingsStore.getState().snapshot?.values[KEY];
/** Clicks a chip and lets its save land (the chips wait while one is in flight). */
async function click(model: string): Promise<void> {
  await act(async () => {
    fireEvent.click(chip(model));
    await Promise.resolve();
  });
}

describe("Settings › Ember", () => {
  it("the nav item carries the flame", () => {
    open();
    expect(within(screen.getByTestId("settings-nav-ember")).getByTestId("ember-flame")).toBeTruthy();
  });

  it("a chip per model, pressed while it is in the list; a click adds it at the end or takes it out; the last one stays", async () => {
    open();
    expect(pressed("claude-opus-4-7[1m]")).toBe("true");
    expect(pressed("claude-opus-4-8[1m]")).toBe("true");
    expect(pressed("claude-sonnet-5[1m]")).toBe("false");
    expect(chip("claude-sonnet-5[1m]").textContent).toBe("Sonnet 5");
    await click("claude-sonnet-5[1m]");
    expect(pressed("claude-sonnet-5[1m]")).toBe("true");
    expect(value()).toBe("claude-opus-4-7[1m],claude-opus-4-8[1m],claude-sonnet-5[1m]");
    await click("claude-opus-4-7[1m]");
    await click("claude-opus-4-8[1m]");
    expect(value()).toBe("claude-sonnet-5[1m]");
    // The last one cannot be released.
    expect(chip("claude-sonnet-5[1m]").getAttribute("aria-disabled")).toBe("true");
    save.fn.mockClear();
    await click("claude-sonnet-5[1m]");
    expect(pressed("claude-sonnet-5[1m]")).toBe("true");
    expect(save.fn).not.toHaveBeenCalled();
    expect(value()).toBe("claude-sonnet-5[1m]");
  });
});
