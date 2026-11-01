import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingFieldView, SettingPageView, SettingsSchemaView } from "@/api/settings";

// The settings sheet over a small schema shaped like the daemon's: the page logic (nav,
// sections, pairs, dependents, keybinding buckets, search, Escape) is the GUI's; the real
// schema's pages and fields are internal/store/settings's (tested in Go).
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const save = vi.hoisted(() => ({ fn: vi.fn<(v: Record<string, string>) => Promise<{ ok: true }>>() }));
const runCommand = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommand }));
const schemaRef = vi.hoisted(() => ({ current: null as SettingsSchemaView | null }));
vi.mock("@/api/settings", async (orig) => ({ ...(await orig<typeof import("@/api/settings")>()), getSettingsSchema: () => Promise.resolve(schemaRef.current) }));
vi.mock("@/api/memory", async (orig) => ({
  ...(await orig<typeof import("@/api/memory")>()),
  getMemory: () => Promise.resolve({ entries: [], injected: 0, injectedBytes: 0, maxEntries: 40, maxBytes: 4096, maxEntryChars: 500, dir: "/m", error: "", version: 1 }),
}));
vi.mock("@/stores/settings", async (orig) => ({ ...(await orig<typeof import("@/stores/settings")>()), saveSettings: save.fn }));

const { SettingsSheet } = await import("./SettingsSheet");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { useSettingsStore } = await import("@/stores/settings");
const { useSettingsPrefsStore } = await import("@/stores/settingsPrefs");
const { useViewsStore } = await import("@/stores/views");

const base: Omit<SettingFieldView, "key" | "title" | "type" | "page" | "section"> = {
  description: "",
  group: "g",
  enumValues: [],
  enumLabels: [],
  defaultValue: "",
  restartRequired: false,
  min: 0,
  max: 0,
  placeholder: "",
  unit: "",
  dependsOn: "",
  row: "",
};
const f = (key: string, title: string, type: SettingFieldView["type"], page: string, section: string, extra: Partial<SettingFieldView> = {}): SettingFieldView => ({ ...base, key, title, type, page, section, ...extra });
const sec = (id: string, title: string) => ({ id, title, description: "" });
const pages: SettingPageView[] = [
  { id: "general", title: "General", description: "", sections: [sec("threads", "Threads"), sec("textgen", "Text generation"), sec("lifecycle", "Lifecycle")] },
  { id: "appearance", title: "Appearance", description: "", sections: [sec("terminal", "Terminal"), sec("window", "Window")] },
  { id: "notifications", title: "Notifications", description: "", sections: [sec("alerts", "Alerts")] },
  { id: "source", title: "Source control", description: "", sections: [sec("github", "GitHub"), sec("projects", "Projects")] },
  { id: "keybindings", title: "Keybindings", description: "", sections: [sec("thread", "Thread"), sec("terminal", "Terminal"), sec("project", "Project")] },
  { id: "advanced", title: "Advanced", description: "", sections: [sec("logging", "Logging")] },
];
const models = { enumValues: ["claude-opus-5-5[1m]", "claude-sonnet-5[1m]"], enumLabels: ["Opus 5.5", "Sonnet 5"] };
const fields: SettingFieldView[] = [
  f("threads.default_model", "Model", "enum", "general", "threads", { ...models, defaultValue: "claude-sonnet-5[1m]", row: "model", description: "The default for new threads." }),
  f("threads.default_effort", "Effort", "enum", "general", "threads", { enumValues: ["low", "medium", "high"], defaultValue: "medium", row: "model", description: "The default effort for new threads." }),
  f("threads.default_worktree", "New threads work in", "enum", "general", "threads", { enumValues: ["worktree", "current"], enumLabels: ["A fresh copy of the project", "The project folder itself"], defaultValue: "current" }),
  f("threads.auto_name", "Name threads automatically", "bool", "general", "threads", { defaultValue: "true" }),
  f("threads.naming_model", "Naming model", "enum", "general", "textgen", { ...models, defaultValue: "claude-sonnet-5[1m]", dependsOn: "threads.auto_name" }),
  f("threads.cache_ttl_seconds", "Prompt cache lifetime", "int", "general", "lifecycle", { defaultValue: "3600", unit: "s", min: 60, max: 86400 }),
  f("appearance.font_family", "Terminal font", "string", "appearance", "terminal", { defaultValue: "" }),
  f("appearance.font_size", "Terminal font size", "int", "appearance", "terminal", { defaultValue: "13", unit: "pt", min: 9, max: 28 }),
  f("threads.scrollback_lines", "Scrollback", "int", "appearance", "terminal", { defaultValue: "10000", min: 100, max: 100000, restartRequired: true }),
  f("appearance.backdrop", "Backdrop", "enum", "appearance", "window", { enumValues: ["forest", "none", "custom"], defaultValue: "forest" }),
  f("appearance.backdrop_file", "Backdrop file", "string", "appearance", "window"),
  f("notifications.sound", "Alert sound", "bool", "notifications", "alerts", { defaultValue: "false" }),
  f("notifications.sound_volume", "Volume", "int", "notifications", "alerts", { defaultValue: "50", min: 0, max: 100, dependsOn: "notifications.sound" }),
  f("github.poll_interval_seconds", "Poll interval", "int", "source", "github", { defaultValue: "60", min: 30, max: 3600 }),
  f("projects.fetch_interval_seconds", "Fetch interval", "int", "source", "projects", { defaultValue: "300", min: 60, max: 3600 }),
  f("logging.level", "Log level", "enum", "advanced", "logging", { enumValues: ["info", "debug"], defaultValue: "info" }),
  f("keybindings.thread.new", "New Thread", "keybinding", "keybindings", "thread", { defaultValue: "cmd+n", description: "Start a thread." }),
  f("keybindings.thread.archive", "Archive Thread", "keybinding", "keybindings", "thread"),
  f("keybindings.thread.fork", "Fork Thread", "keybinding", "keybindings", "thread"),
  f("keybindings.terminal.new", "New Terminal", "keybinding", "keybindings", "terminal", { defaultValue: "cmd+t" }),
  f("keybindings.project.add", "Add Project", "keybinding", "keybindings", "project"),
  f("keybindings.project.remove", "Remove Project", "keybinding", "keybindings", "project"),
];
const schema: SettingsSchemaView = { groups: [], pages, fields };

function setValues(values: Record<string, string>, extra: { loadError?: string; restartPending?: string[] } = {}): void {
  useSettingsStore.setState((s) => ({
    snapshot: { values, path: "/Users/me/.code-foundry/settings.toml", revision: (s.snapshot?.revision ?? 0) + 1, loadError: extra.loadError ?? "", issues: [], restartPending: extra.restartPending ?? [] },
  }));
}

function open(page = "general") {
  useViewsStore.setState({ settingsOpen: true, settingsPage: page, themesOpen: false, usageOpen: false, helpOpen: false });
  return render(
    <TooltipProvider>
      <SettingsSheet />
    </TooltipProvider>,
  );
}

const row = (key: string) => {
  const el = document.querySelector<HTMLElement>(`[data-setting="${CSS.escape(key)}"]`);
  if (!el) throw new Error(`no row ${key}`);
  return el;
};
const has = (key: string) => document.querySelector(`[data-setting="${CSS.escape(key)}"]`) !== null;
const trigger = (key: string) => {
  const el = row(key).querySelector<HTMLElement>('[data-slot="select-trigger"]');
  if (!el) throw new Error(`no select ${key}`);
  return el;
};
const options = (key: string) => {
  fireEvent.keyDown(trigger(key), { key: "Enter" });
  const out = screen.getAllByRole("option").map((o) => o.textContent);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  return out;
};
const nav = (id: string) => screen.getByTestId(`settings-nav-${id}`);
const body = () => screen.getByTestId("settings-body");
const search = () => screen.getByRole<HTMLInputElement>("searchbox", { name: "Search settings" });
const spin = (key: string) => within(row(key)).getByRole<HTMLInputElement>("spinbutton");
const press = (el: Element, key: string) => {
  fireEvent.keyDown(el, { key });
};

beforeAll(() => {
  // Radix Select scrolls the selected item into view; jsdom has no layout.
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollTo = () => undefined;
});
beforeEach(() => {
  vi.clearAllMocks();
  schemaRef.current = schema;
  save.fn.mockImplementation((v) => {
    act(() => {
      setValues({ ...useSettingsStore.getState().snapshot?.values, ...v });
    });
    return Promise.resolve({ ok: true as const });
  });
  useSettingsStore.setState({ schema, schemaError: null, snapshot: null });
  setValues({});
  useSettingsPrefsStore.setState({ boundOnly: true });
});
afterEach(cleanup);

describe("the settings page", () => {
  it("lists the schema's pages, then the app's own; General first, one page's sections at a time", async () => {
    open();
    const navEl = screen.getByRole("navigation", { name: "Settings pages" });
    expect(within(navEl).getAllByRole("button").map((b) => b.textContent)).toEqual(["General", "Appearance", "Notifications", "Source control", "Keybindings", "Advanced", "Plugins", "Skills", "Memory"]);
    expect(nav("general").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "General", level: 2 })).toBeTruthy();
    expect(within(body()).getAllByTestId("settings-section").map((s) => s.querySelector("h3")?.textContent)).toEqual(["Threads", "Text generation", "Lifecycle"]);
    expect(has("appearance.font_size")).toBe(false);
    // The raw key is not shown under a row (only in search results).
    expect(within(row("threads.auto_name")).queryByTestId("setting-key")).toBeNull();
    expect(row("threads.auto_name").textContent).not.toContain("threads.auto_name");
    expect(screen.getByTestId("settings-path").textContent).toBe("~/.code-foundry/settings.toml");
    // The search has the keyboard on open.
    await waitFor(() => {
      expect(document.activeElement).toBe(search());
    });

    fireEvent.click(nav("appearance"));
    expect(nav("appearance").getAttribute("aria-current")).toBe("page");
    expect(nav("general").getAttribute("aria-current")).toBeNull();
    expect(body().dataset.page).toBe("appearance");
    expect(screen.getByRole("heading", { name: "Appearance", level: 2 })).toBeTruthy();
    expect(has("threads.auto_name")).toBe(false);
    // A field another field's editor owns (the backdrop's file) has no row of its own.
    expect(has("appearance.backdrop")).toBe(true);
    expect(has("appearance.backdrop_file")).toBe(false);

    // The app's own pages: Memory's description.
    fireEvent.click(nav("memory"));
    expect(screen.getByTestId("settings-page-description").textContent).toBe("What threads have been told to remember about this app and how they work in it.");
  });

  it("an enum's trigger names the value alone; its list marks the setting's default", () => {
    open();
    expect(trigger("threads.default_model").dataset.value).toBe("claude-sonnet-5[1m]");
    // The trigger hides the list's " (default)" with CSS: e2e (settings.spec.ts).
    expect(trigger("threads.default_effort").dataset.value).toBe("medium");
    expect(options("threads.default_model")).toEqual(["Opus 5.5", "Sonnet 5 (default)"]);
    expect(row("threads.default_worktree").textContent).toContain("New threads work in");
    expect(trigger("threads.default_worktree").dataset.value).toBe("current");
    expect(options("threads.default_worktree")).toEqual(["A fresh copy of the project", "The project folder itself (default)"]);
    // Escape in the open list closes the list, not the page.
    expect(screen.getByTestId("settings-page")).toBeTruthy();
  });

  it("model and effort share a row, with the model's description under them", () => {
    open();
    const pair = document.querySelector<HTMLElement>('[data-setting-row="model"]');
    if (!pair) throw new Error("no pair");
    expect([...pair.querySelectorAll("[data-setting]")].map((e) => e.getAttribute("data-setting"))).toEqual(["threads.default_model", "threads.default_effort"]);
    expect(pair.textContent).toContain("The default for new threads.");
    expect(pair.textContent).not.toContain("The default effort for new threads");
  });

  it("a number shows its unit inside the box; restart-required fields say so, live ones do not", () => {
    open();
    expect(within(row("threads.cache_ttl_seconds")).getByTestId("setting-unit").textContent).toBe("s");
    expect(spin("threads.cache_ttl_seconds").value).toBe("3600");
    expect(within(row("threads.naming_model")).queryByTestId("restart-hint")).toBeNull();
    fireEvent.click(nav("appearance"));
    expect(spin("appearance.font_size").value).toBe("13");
    expect(within(row("appearance.font_size")).getByTestId("setting-unit").textContent).toBe("pt");
    expect(within(row("appearance.font_size")).queryByTestId("restart-hint")).toBeNull();
    const terminal = document.querySelector('[data-section="terminal"]');
    expect(terminal?.querySelector('[data-setting="threads.scrollback_lines"] [data-testid="restart-hint"]')).not.toBeNull();
  });

  it("a dependent row dims while its toggle is off (its editor still works); across sections it says why", () => {
    open();
    const naming = () => row("threads.naming_model");
    expect(naming().dataset.dimmed).toBeUndefined();
    fireEvent.click(within(row("threads.auto_name")).getByRole("switch"));
    expect(save.fn).toHaveBeenCalledWith({ "threads.auto_name": "false" });
    expect(naming().dataset.dimmed).toBe("true");
    expect(naming().textContent).toContain("Not used while Name threads automatically is off.");
    expect((trigger("threads.naming_model") as HTMLButtonElement).disabled).toBe(false);

    // Right under its toggle: dimmed, no sentence; on again, not dimmed.
    fireEvent.click(nav("notifications"));
    expect(row("notifications.sound_volume").dataset.dimmed).toBe("true");
    expect(row("notifications.sound_volume").textContent).not.toContain("Not used while");
    fireEvent.click(within(row("notifications.sound")).getByRole("switch"));
    expect(row("notifications.sound_volume").dataset.dimmed).toBeUndefined();
  });

  it("a bool saves and says so; a number out of range is refused inline; the restart badge shows once changed", async () => {
    open();
    const sw = within(row("threads.auto_name")).getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Saved Name threads automatically", expect.anything());
    });
    expect(sw.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(nav("appearance"));
    spin("appearance.font_size").focus();
    fireEvent.change(spin("appearance.font_size"), { target: { value: "99" } });
    press(spin("appearance.font_size"), "Enter");
    expect(within(row("appearance.font_size")).getByTestId("setting-error").textContent).toBe("Want 9 to 28");
    expect(save.fn.mock.calls.some(([v]) => "appearance.font_size" in v)).toBe(false);

    spin("threads.scrollback_lines").focus();
    fireEvent.change(spin("threads.scrollback_lines"), { target: { value: "20000" } });
    press(spin("threads.scrollback_lines"), "Enter");
    expect(save.fn).toHaveBeenLastCalledWith({ "threads.scrollback_lines": "20000" });
    act(() => {
      setValues({ ...useSettingsStore.getState().snapshot?.values }, { restartPending: ["threads.scrollback_lines"] });
    });
    expect(within(row("threads.scrollback_lines")).getByTestId("restart-pending")).toBeTruthy();
  });

  it("a number reverts on Escape, which leaves the page open, and commits on Enter", () => {
    open("appearance");
    const size = spin("appearance.font_size");
    size.focus();
    fireEvent.change(size, { target: { value: "15" } });
    press(size, "Escape");
    expect(size.value).toBe("13");
    expect(useViewsStore.getState().settingsOpen).toBe(true);
    expect(save.fn).not.toHaveBeenCalled();
    size.focus();
    fireEvent.change(size, { target: { value: "15" } });
    press(size, "Enter");
    expect(save.fn).toHaveBeenCalledExactlyOnceWith({ "appearance.font_size": "15" });
  });

  it("hand edits to the file show on the open page; a file that does not parse says so until fixed", () => {
    open("appearance");
    act(() => {
      setValues({ "appearance.font_size": "18" });
    });
    expect(spin("appearance.font_size").value).toBe("18");
    act(() => {
      setValues({ "appearance.font_size": "18" }, { loadError: "toml: line 2: expected ']'" });
    });
    expect(screen.getByTestId("settings-load-error").textContent).toContain("expected ']'");
    act(() => {
      setValues({});
    });
    expect(screen.queryByTestId("settings-load-error")).toBeNull();
    expect(spin("appearance.font_size").value).toBe("13");
  });

  it("Open settings file in Finder runs settings.reveal", () => {
    open();
    fireEvent.click(screen.getByTestId("reveal-settings"));
    expect(runCommand).toHaveBeenCalledWith("settings.reveal");
  });

  it("Escape outside a field closes the page", () => {
    open();
    press(screen.getByRole("heading", { name: "Settings", exact: true } as never), "Escape");
    expect(useViewsStore.getState().settingsOpen).toBe(false);
  });
});

describe("Keybindings", () => {
  it("Bound only folds unbound commands behind a count; categories with none share one card; off shows every command", () => {
    open("keybindings");
    const bound = screen.getByTestId("settings-bound-only");
    expect(bound.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("settings-page-description").textContent).toContain("2 of 6 commands have a shortcut.");
    expect(within(body()).getAllByTestId("settings-section").flatMap((s) => [...s.querySelectorAll("[data-setting]")])).toHaveLength(2);
    expect(within(row("keybindings.thread.new")).getByRole("button", { name: /shortcut/ }).textContent).toBe("⌘N");

    // Thread: its bound commands, then "N more unbound", which opens the rest in place.
    const thread = () => {
      const el = document.querySelector<HTMLElement>('[data-testid="settings-section"][data-section="thread"]');
      if (!el) throw new Error("no thread section");
      return el;
    };
    expect(thread().querySelector('[data-setting="keybindings.thread.archive"]')).toBeNull();
    const more = screen.getByTestId("keybindings-more-thread");
    expect(more.textContent).toBe("2 more unbound");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(within(row("keybindings.thread.archive")).getByRole("button", { name: /shortcut/ }).textContent).toBe("Add shortcut");

    // Project has nothing bound: it is in the shared card, collapsed.
    const empty = screen.getByTestId("keybindings-unbound-card");
    expect(screen.getByRole("heading", { name: "No shortcuts yet" })).toBeTruthy();
    const project = screen.getByTestId("keybindings-category-project");
    expect(project.textContent).toContain("Project");
    expect(project.textContent).toContain("2 unbound");
    expect(empty.querySelectorAll("[data-setting]")).toHaveLength(0);
    fireEvent.click(project);
    expect(empty.querySelectorAll("[data-setting]")).toHaveLength(2);

    // Off: every command, every category its own card; the choice is the persisted pref.
    fireEvent.click(bound);
    expect(bound.getAttribute("aria-checked")).toBe("false");
    expect(useSettingsPrefsStore.getState().boundOnly).toBe(false);
    expect(document.querySelectorAll("[data-setting]")).toHaveLength(6);
    expect(screen.queryByTestId("keybindings-unbound-card")).toBeNull();
  });

  it("Bound only survives a reload (localStorage)", async () => {
    localStorage.clear();
    open("keybindings");
    fireEvent.click(screen.getByTestId("settings-bound-only"));
    expect(JSON.parse(localStorage.getItem("code-foundry.settingsPrefs") ?? "{}")).toMatchObject({ state: { boundOnly: false } });
    useSettingsPrefsStore.setState({ boundOnly: true }, false);
    localStorage.setItem("code-foundry.settingsPrefs", JSON.stringify({ state: { boundOnly: false }, version: 1 }));
    await act(async () => {
      await useSettingsPrefsStore.persist.rehydrate();
    });
    expect(screen.getByTestId("settings-bound-only").getAttribute("aria-checked")).toBe("false");
    localStorage.clear();
  });

  it("a command's title has its description and command name in a tooltip", async () => {
    open("keybindings");
    const title = row("keybindings.thread.new").querySelector("span.truncate");
    if (!title) throw new Error("no title");
    fireEvent.pointerMove(title, { pointerType: "mouse" });
    fireEvent.focus(title);
    await waitFor(() => {
      expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain("thread.new");
    });
  });
});

describe("search", () => {
  it("lists matches from every page under page and section, keys marked, the nav counting per page", () => {
    open();
    fireEvent.change(search(), { target: { value: "interval" } });
    const results = screen.getByTestId("settings-results");
    expect(screen.getByTestId("settings-result-count").textContent).toBe("2 results for “interval” in every page");
    expect(results.querySelectorAll("[data-setting]")).toHaveLength(2);
    expect(within(results).getAllByTestId("setting-crumb").map((c) => c.textContent)).toEqual(["Source control › GitHub", "Source control › Projects"]);
    const key = within(row("github.poll_interval_seconds")).getByTestId("setting-key");
    expect(key.textContent).toBe("github.poll_interval_seconds");
    expect([...key.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["interval"]);
    expect(within(nav("source")).getByTestId("settings-nav-count").textContent).toBe("2");
    expect(within(nav("general")).getByTestId("settings-nav-count").textContent).toBe("0");
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
    // A result saves like its row on its page.
    spin("github.poll_interval_seconds").focus();
    fireEvent.change(spin("github.poll_interval_seconds"), { target: { value: "120" } });
    press(spin("github.poll_interval_seconds"), "Enter");
    expect(save.fn).toHaveBeenCalledWith({ "github.poll_interval_seconds": "120" });

    fireEvent.change(search(), { target: { value: "font" } });
    expect(has("appearance.font_size")).toBe(true);
    expect(has("appearance.font_family")).toBe(true);
    expect(has("threads.auto_name")).toBe(false);
    fireEvent.change(search(), { target: { value: "new terminal" } });
    expect(within(row("keybindings.terminal.new")).getByTestId("setting-crumb").textContent).toBe("Keybindings › Terminal");
    fireEvent.change(search(), { target: { value: "zzzz" } });
    expect(screen.getByTestId("settings-results").textContent).toContain("No settings match “zzzz”.");
  });

  it("Escape clears the search and goes back to the page; Escape on the empty search closes", () => {
    open();
    fireEvent.change(search(), { target: { value: "interval" } });
    press(search(), "Escape");
    expect(search().value).toBe("");
    expect(screen.getByRole("heading", { name: "General", level: 2 })).toBeTruthy();
    expect(useViewsStore.getState().settingsOpen).toBe(true);
    press(search(), "Escape");
    expect(useViewsStore.getState().settingsOpen).toBe(false);
  });

  it("a nav item while searching clears the search and shows that page", () => {
    open();
    fireEvent.change(search(), { target: { value: "interval" } });
    fireEvent.click(nav("advanced"));
    expect(search().value).toBe("");
    expect(body().dataset.page).toBe("advanced");
  });

  it("“skills registries” finds Skills › Registries, counted on the nav, which opens the page", () => {
    open();
    fireEvent.change(search(), { target: { value: "skills registries" } });
    expect(screen.getAllByTestId("settings-section-hit").map((h) => h.textContent)).toEqual(["Skills › RegistriesThe marketplaces Claude Code knows about, and refreshing them."]);
    expect(within(nav("skills")).getByTestId("settings-nav-count").textContent).toBe("1");
    fireEvent.click(screen.getByTestId("settings-section-hit"));
    expect(body().dataset.page).toBe("skills");
    expect(document.querySelector('[data-section="registries"]')).not.toBeNull();
  });

  it.each(["remembered", "forget", "preferences", "standing"])("“%s” finds Memory › Remembered, which opens the page", (word) => {
    open();
    fireEvent.change(search(), { target: { value: word } });
    const hits = screen.getAllByTestId("settings-section-hit").filter((h) => h.textContent.includes("Memory › Remembered"));
    expect(hits).toHaveLength(1);
    if (word === "remembered") expect(screen.getAllByTestId("settings-section-hit").map((h) => h.textContent)).toEqual(["Memory › RememberedEvery thread in every project reads these before its first action."]);
    fireEvent.click(hits[0] as HTMLElement);
    expect(body().dataset.page).toBe("memory");
  });
});
