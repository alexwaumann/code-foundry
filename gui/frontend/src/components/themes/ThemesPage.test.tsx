import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeFileIssueView } from "@/api/theme";
import type { ThemeBase, UserThemeFile } from "@/themes";

// The Themes page and its editor in the settings sheet, against a fake daemon for the
// theme commands (set a slot, duplicate, delete, save, edit, ask): the page's rows, list,
// keyboard, editor filters, save modal and confirms are the GUI's. What the real daemon
// refuses or says is tested in Go (internal/theme, internal/command).
type Call = [string, Record<string, string>, { ctx?: { activeView?: string } } | undefined];
const runCommandForResult = vi.hoisted(() => vi.fn<(name: string, args: Record<string, string>, opts?: { ctx?: { activeView?: string } }) => Promise<{ message: string; resultJson: string } | null>>());
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult, runCommand: vi.fn(() => Promise.resolve(true)) }));
// The editor deletes an unsaved Customise copy straight through the client (confirmed, no question).
vi.mock("@/api/command", async (orig) => ({
  ...(await orig<typeof import("@/api/command")>()),
  invokeCommand: (name: string, _ctx: unknown, args: Record<string, string>) => {
    runCommandForResult.mock.calls.push([name, args]);
    return fakeDaemonRef.current(name, args);
  },
}));
const fakeDaemonRef = vi.hoisted(() => ({ current: (() => Promise.resolve(null)) as (name: string, args: Record<string, string>) => Promise<unknown> }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
// The gallery is a picture of the app inside the theme's scope: these tests read the scope only.
vi.mock("./ThemeGallery", () => ({ ThemeGallery: () => <div data-testid="gallery-thread" /> }));
// Wide enough for the full list beside the editor (jsdom has no layout; narrower widths fold it: e2e).
vi.mock("@/lib/useWidth", () => ({ useWidth: () => [{ current: null }, 1600] }));
vi.mock("@/api/settings", async (orig) => ({ ...(await orig<typeof import("@/api/settings")>()), getSettingsSchema: vi.fn(() => Promise.resolve({ groups: [], pages: [], fields: [] })), updateSettings: vi.fn(() => Promise.resolve(null)) }));

const { SettingsSheet } = await import("@/components/settings/SettingsSheet");
const { ConfirmDialog } = await import("@/components/confirm/ConfirmDialog");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { setThemePreference, setThemeSlots, themeSlots } = await import("@/lib/theme");
const { themeById, themesFor, setUserThemes } = await import("@/themes");
const { applyThemeEvent } = await import("@/stores/themes");
const { useThemePickerStore } = await import("@/stores/themePicker");
const { stopEditing } = await import("@/stores/themeEditor");
const { closeSheet, openThemes, showView, startViewSync, useViewsStore } = await import("@/stores/views");
const { useConfirmStore } = await import("@/stores/confirm");
const { HOME, useUiStore } = await import("@/stores/ui");
const { useSettingsStore } = await import("@/stores/settings");
const { getSettingsSchema, updateSettings } = await import("@/api/settings");

function baseOf(id: string, edit: Partial<Omit<ThemeBase, "terminal">>): ThemeBase {
  const t = themeById.get(id);
  if (!t) throw new Error(`no curated theme ${id}`);
  return { ...t.base, ...edit, terminal: { ...t.base.terminal, ansi: [...t.base.terminal.ansi] } };
}

// The mock daemon's seed (mock/userThemes.ts).
function seed(): UserThemeFile[] {
  return [
    {
      id: "mocha-warmer",
      name: "Mocha, warmer",
      scheme: "dark",
      source: "",
      from: "catppuccin-mocha",
      createdBy: "",
      path: "",
      base: baseOf("catppuccin-mocha", { canvas: "#1a1614", surface: "#221d1b", text: "#e8dccb", accent: "#d9a066" }),
      overrides: { "--cf-accent-foreground": "#1a1614", "--cf-sidebar-row-selected": "#2c2522", "--syn-kw": "#e0a370" },
    },
    {
      id: "ocean-dusk",
      name: "Ocean Dusk",
      scheme: "dark",
      source: "",
      from: "catppuccin-mocha",
      createdBy: "s-1",
      path: "",
      base: baseOf("catppuccin-mocha", { canvas: "#0b141c", surface: "#16232f", text: "#d7e3ea", accent: "#5fb3b3", success: "#8fc79a", warning: "#e8c07d", error: "#ec7f8a", info: "#7fb4e0", highlight: "#c3a6e8" }),
      overrides: { "--cf-sidebar-row-selected": "#1e2e3c" },
    },
    {
      id: "latte-softer",
      name: "Latte, softer",
      scheme: "light",
      source: "",
      from: "catppuccin-latte",
      createdBy: "s-3",
      path: "",
      base: baseOf("catppuccin-latte", { canvas: "#e9e4dc", surface: "#f6f1ea", accent: "#8c6bb1" }),
    },
  ];
}
const SEED_ISSUES: ThemeFileIssueView[] = [{ file: "draft.json", message: 'base.accent: "#5fb3" is not #rrggbb' }];

// The fake daemon's themes directory.
const disk = { user: [] as UserThemeFile[], issues: [] as ThemeFileIssueView[] };
function publish(): void {
  act(() => {
    applyThemeEvent({ user: disk.user.map((t) => ({ ...t, version: JSON.stringify([t.base, t.overrides ?? {}]) })), issues: disk.issues, history: {}, dir: "/h/themes", version: 1 });
  });
}
function setSlot(scheme: "dark" | "light", id: string): void {
  setThemeSlots({ ...themeSlots(), [scheme]: id });
  useSettingsStore.setState((s) => ({ snapshot: { values: { ...s.snapshot?.values, [`appearance.theme_${scheme}`]: id }, path: "", revision: (s.snapshot?.revision ?? 0) + 1, loadError: "", issues: [], restartPending: [] } }));
}
const ok = (resultJson = "{}") => Promise.resolve({ message: "", resultJson });
function fakeDaemon(name: string, args: Record<string, string>): Promise<{ message: string; resultJson: string } | null> {
  switch (name) {
    case "theme.set-dark":
    case "theme.set-light":
      act(() => {
        setSlot(name === "theme.set-dark" ? "dark" : "light", args.theme ?? "");
      });
      return ok();
    case "theme.duplicate": {
      const src = themeById.get(args.theme ?? "");
      if (!src) return Promise.resolve(null);
      let id = `${src.id}-copy`;
      let label = `${src.name} copy`;
      for (let n = 2; disk.user.some((t) => t.id === id); n++) {
        id = `${src.id}-copy-${String(n)}`;
        label = `${src.name} copy ${String(n)}`;
      }
      disk.user = [...disk.user, { id, name: label, scheme: src.scheme, source: "", base: src.base, overrides: { ...src.overrides }, from: src.id, createdBy: "", path: "" }].sort((a, b) => a.name.localeCompare(b.name));
      setTimeout(publish, 1);
      return ok(JSON.stringify({ id, scheme: src.scheme }));
    }
    case "theme.delete":
      if (args.file) disk.issues = disk.issues.filter((i) => i.file !== args.file);
      else disk.user = disk.user.filter((t) => t.id !== args.theme);
      publish();
      return ok(JSON.stringify({ id: args.theme ?? "" }));
    case "theme.save": {
      const file = JSON.parse(args.data ?? "{}") as UserThemeFile;
      disk.user = disk.user.map((t) => (t.id === file.id ? { ...t, ...file } : t));
      publish();
      if (args.apply === "true") act(() => { setSlot(file.scheme, file.id); });
      return ok(JSON.stringify({ id: file.id }));
    }
    case "theme.edit":
      act(() => {
        showView(`themes.edit.${args.theme ?? ""}`);
      });
      return ok();
    default:
      return ok();
  }
}
fakeDaemonRef.current = fakeDaemon;
const calls = (name?: string) => (runCommandForResult.mock.calls as unknown as Call[]).filter((c) => !name || c[0] === name);
const themeCalls = () => calls().map(([n, a]) => `${n} ${a.theme ?? a.file ?? ""}`.trim()).filter((c) => /^theme\.(duplicate|delete)/.test(c));

function open(slot: "dark" | "light" = "dark", from?: "settings") {
  act(() => {
    openThemes(slot, from);
  });
  return render(
    <TooltipProvider>
      <SettingsSheet />
      <ConfirmDialog />
    </TooltipProvider>,
  );
}

const option = (name: string) => within(screen.getByTestId("themes-list")).getByRole("option", { name });
const names = (testId: string) => within(screen.getByTestId(testId)).getAllByTestId("theme-name").map((n) => n.textContent);
const scope = () => screen.getAllByTestId("theme-scope").at(-1) as HTMLElement;
const scopeVar = (name: string) => scope().style.getPropertyValue(name);
const searchbox = () => screen.getByRole<HTMLInputElement>("searchbox", { name: "Search themes" });
const inspector = () => screen.getByTestId("theme-inspector");
const hex = () => screen.getByTestId<HTMLInputElement>("colour-hex");

function typeHex(value: string): void {
  fireEvent.change(hex(), { target: { value } });
  fireEvent.keyDown(hex(), { key: "Enter" });
}
/** Opens a base colour's view, types a hex into it and goes back to the lists. */
function setBase(key: string, value: string): void {
  fireEvent.click(within(inspector()).getByTestId(`editor-base-${key}`));
  expect(screen.getByTestId("base-view").dataset.base).toBe(key);
  typeHex(value);
  fireEvent.click(screen.getByTestId("editor-back"));
  expect(screen.getByTestId("editor-slots")).toBeTruthy();
}
async function editOceanDusk(): Promise<void> {
  open();
  fireEvent.click(within(option("Ocean Dusk")).getByRole("button", { name: "Edit Ocean Dusk" }));
  await screen.findByTestId("theme-inspector");
}
async function confirmShows(text: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("confirm-dialog").textContent).toContain(text);
  });
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
});
beforeEach(() => {
  runCommandForResult.mockReset();
  runCommandForResult.mockImplementation(fakeDaemon);
  disk.user = seed();
  disk.issues = [...SEED_ISSUES];
  setThemePreference("dark");
  setThemeSlots({ dark: "github-dark", light: "github-light" });
  useSettingsStore.setState({ snapshot: { values: {}, path: "", revision: 1, loadError: "", issues: [], restartPending: [] }, schema: null });
  useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
  useThemePickerStore.setState({ preview: null, query: "", hint: null });
  useConfirmStore.setState({ pending: null });
  useUiStore.setState({ selection: HOME });
  stopEditing({ keepCopy: true });
  publish();
});
afterEach(() => {
  cleanup();
  stopEditing({ keepCopy: true });
  setUserThemes([], false);
});

describe("the list", { timeout: 30_000 }, () => {
  it("Choose… opens on its slot: that scheme's themes, the slot's theme current, the slot in use badged", () => {
    open("light", "settings");
    expect(screen.getByTestId("themes-slot-light").getAttribute("aria-pressed")).toBe("true");
    expect(names("themes-curated")).toEqual(themesFor("light").filter((t) => !t.user).map((t) => t.name));
    expect(option("GitHub Light").dataset.current).toBe("true");
    fireEvent.click(screen.getByTestId("themes-slot-dark"));
    expect(names("themes-curated")).toEqual(themesFor("dark").filter((t) => !t.user).map((t) => t.name));
    expect(screen.getByTestId("themes-slot-dark").textContent).toContain("in use");
    expect(screen.getByTestId("themes-slot-light").textContent).not.toContain("in use");
    expect(screen.getByTestId("themes-scheme-note").textContent).toBe("Follows macOS: dark now, showing GitHub Dark");
    // The close button goes back to Settings, where it came from.
    fireEvent.click(screen.getByRole("button", { name: "Close themes" }));
    expect(useViewsStore.getState()).toMatchObject({ themesOpen: false, settingsOpen: true });
  });

  it("Yours lists the scheme's own themes above the curated ones, with where each came from", () => {
    open();
    expect(names("themes-yours")).toEqual(["Mocha, warmer", "Ocean Dusk"]);
    expect(screen.getByTestId("themes-yours").textContent).toContain("Yours · 2");
    expect(screen.getByTestId("themes-curated").textContent).toContain("Curated · 15");
    expect(within(option("Ocean Dusk")).getByTestId("theme-origin").textContent).toBe("from Catppuccin Mocha · by a thread");
    expect(within(option("Mocha, warmer")).getByTestId("theme-origin").textContent).toBe("from Catppuccin Mocha");
    expect(within(screen.getByTestId("themes-curated")).queryAllByTestId("theme-origin")).toHaveLength(0);
    expect(screen.getByTestId("themes-issues").textContent).toContain('draft.json did not load: base.accent: "#5fb3" is not #rrggbb');
    expect(searchbox().placeholder).toBe("Search 17 dark themes");
    // A curated row has Customise but no Delete.
    expect(within(option("Dracula")).getByRole("button", { name: "Customise Dracula" })).toBeTruthy();
    expect(within(option("Dracula")).queryByRole("button", { name: "Delete Dracula" })).toBeNull();
    // The light slot has its own.
    fireEvent.click(screen.getByTestId("themes-slot-light"));
    expect(names("themes-yours")).toEqual(["Latte, softer"]);
    // A search none of yours match hides the section.
    fireEvent.click(screen.getByTestId("themes-slot-dark"));
    fireEvent.change(searchbox(), { target: { value: "nord" } });
    expect(screen.queryByTestId("themes-yours")).toBeNull();
    fireEvent.change(searchbox(), { target: { value: "ocean" } });
    expect(names("themes-list")).toEqual(["Ocean Dusk"]);
  });

  it("the search keeps the files that did not load that it matches", () => {
    open();
    fireEvent.change(searchbox(), { target: { value: "draft" } });
    expect(screen.getByTestId("themes-issues").textContent).toContain("draft.json did not load");
    expect(screen.getByTestId("themes-list").textContent).not.toContain("No dark themes match");
  });

  it("a file that did not load has Delete (theme.delete --file), and its line goes", async () => {
    open();
    expect(screen.getAllByTestId("themes-issue")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("themes-issue-delete"));
    await waitFor(() => {
      expect(screen.queryByTestId("themes-issues")).toBeNull();
    });
    expect(calls("theme.delete").map((c) => c[1])).toEqual([{ file: "draft.json" }]);
  });

  it("with none of yours, Yours says how to make one; a theme written by hand arrives live", () => {
    disk.user = [];
    disk.issues = [];
    publish();
    open();
    expect(screen.getByTestId("themes-yours").textContent).toContain("Yours · 0");
    expect(screen.getByTestId("themes-yours").textContent).toContain("Customise a theme to make one of your own.");
    disk.user = seed();
    publish();
    expect(names("themes-yours")).toEqual(["Mocha, warmer", "Ocean Dusk"]);
  });

  it("a new or renamed theme reloads the settings schema (the slot selects list them); a colour edit does not", () => {
    vi.mocked(getSettingsSchema).mockClear();
    disk.user = [...seed(), { ...seed()[0], id: "mine", name: "Mine" } as UserThemeFile];
    publish();
    expect(getSettingsSchema).toHaveBeenCalledTimes(1);
    disk.user = disk.user.map((t) => (t.id === "mine" ? { ...t, base: { ...t.base, accent: "#123456" } } : t));
    publish();
    expect(getSettingsSchema).toHaveBeenCalledTimes(1);
  });

  it("previewing paints the gallery's scope; Back to current and Apply; a companion is suggested, accepted or dismissed", async () => {
    open();
    expect(screen.getByTestId<HTMLButtonElement>("themes-apply").disabled).toBe(true);
    fireEvent.click(option("Gruvbox Dark"));
    expect(scope().dataset.theme).toBe("gruvbox-dark");
    expect(screen.getByTestId("themes-previewed-name").textContent).toBe("Gruvbox Dark");
    expect(themeSlots().dark).toBe("github-dark");
    fireEvent.click(screen.getByTestId("themes-reset"));
    expect(scope().dataset.theme).toBe("github-dark");
    expect(screen.getByTestId<HTMLButtonElement>("themes-apply").disabled).toBe(true);

    fireEvent.click(option("Gruvbox Dark"));
    fireEvent.click(screen.getByTestId("themes-apply"));
    await waitFor(() => {
      expect(option("Gruvbox Dark").dataset.current).toBe("true");
    });
    expect(calls("theme.set-dark").map((c) => c[1])).toEqual([{ theme: "gruvbox-dark" }]);
    expect(screen.getByTestId<HTMLButtonElement>("themes-apply").disabled).toBe(true);
    const hint = await screen.findByTestId("themes-pair-hint");
    expect(hint.textContent).toContain("Gruvbox Light is this theme’s light companion. Use it for light?");
    expect(themeSlots().light).toBe("github-light");
    fireEvent.click(screen.getByTestId("themes-pair-accept"));
    await waitFor(() => {
      expect(screen.queryByTestId("themes-pair-hint")).toBeNull();
    });
    expect(themeSlots()).toEqual({ dark: "gruvbox-dark", light: "gruvbox-light" });

    // Back on GitHub Dark: GitHub Light is suggested; dismissed, it goes and nothing changes.
    fireEvent.click(option("GitHub Dark"));
    fireEvent.click(screen.getByTestId("themes-apply"));
    expect((await screen.findByTestId("themes-pair-hint")).textContent).toContain("GitHub Light");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(screen.queryByTestId("themes-pair-hint")).toBeNull();
    expect(themeSlots().light).toBe("gruvbox-light");

    // Dracula has no light companion: no suggestion.
    fireEvent.click(option("Dracula"));
    fireEvent.click(screen.getByTestId("themes-apply"));
    await waitFor(() => {
      expect(option("Dracula").dataset.current).toBe("true");
    });
    expect(screen.queryByTestId("themes-pair-hint")).toBeNull();
  });

  it("a user theme previews and applies like a curated one; the slot then names it", async () => {
    open();
    fireEvent.click(option("Ocean Dusk"));
    expect(scope().dataset.theme).toBe("ocean-dusk");
    expect(themeSlots().dark).toBe("github-dark");
    fireEvent.click(screen.getByTestId("themes-apply"));
    await waitFor(() => {
      expect(option("Ocean Dusk").dataset.current).toBe("true");
    });
    expect(calls("theme.set-dark").map((c) => c[1])).toEqual([{ theme: "ocean-dusk" }]);
    expect(themeSlots().dark).toBe("ocean-dusk");
    expect(screen.getByTestId("themes-slot-dark").textContent).toContain("Ocean Dusk");
  });

  it("the keyboard: the list has it on open; arrows preview, Enter applies, / searches, Escape clears then closes", async () => {
    open();
    const list = screen.getByTestId("themes-list");
    await waitFor(() => {
      expect(document.activeElement).toBe(list);
    });
    // From the slot's theme, the first curated one, down the curated list.
    const dark = themesFor("dark").filter((t) => !t.user);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(scope().dataset.theme).toBe(dark[1]?.id);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(scope().dataset.theme).toBe(dark[2]?.id);
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(scope().dataset.theme).toBe(dark[1]?.id);
    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => {
      expect(themeSlots().dark).toBe(dark[1]?.id);
    });

    fireEvent.keyDown(list, { key: "/" });
    expect(document.activeElement).toBe(searchbox());
    fireEvent.change(searchbox(), { target: { value: "nord" } });
    expect(names("themes-list")).toEqual(["Nord"]);
    fireEvent.keyDown(searchbox(), { key: "ArrowDown" });
    expect(scope().dataset.theme).toBe("nord");
    fireEvent.keyDown(searchbox(), { key: "Escape" });
    expect(searchbox().value).toBe("");
    expect(useViewsStore.getState().themesOpen).toBe(true);
    fireEvent.keyDown(searchbox(), { key: "Escape" });
    expect(useViewsStore.getState().themesOpen).toBe(false);
    // Not applied: the slot keeps what Enter applied.
    expect(themeSlots().dark).toBe(dark[1]?.id);
  });

  it("Escape drops the preview and goes back to Settings; the next visit starts from the applied theme", () => {
    open("dark", "settings");
    fireEvent.click(option("Gruvbox Dark"));
    expect(scope().dataset.theme).toBe("gruvbox-dark");
    fireEvent.keyDown(screen.getByTestId("themes-list"), { key: "Escape" });
    expect(useViewsStore.getState()).toMatchObject({ themesOpen: false, settingsOpen: true });
    expect(themeSlots().dark).toBe("github-dark");
    act(() => {
      openThemes("dark", "settings");
    });
    expect(scope().dataset.theme).toBe("github-dark");
  });

  it("in the settings sheet: one dialog; the ×, the Settings crumb and Escape go back to Appearance; the backdrop's close shuts both", () => {
    useViewsStore.setState({ settingsPage: "appearance" });
    open("dark", "settings");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("settings-sheet").dataset.body).toBe("themes");
    expect(screen.queryByTestId("settings-page")).toBeNull();
    const back = { themesOpen: false, settingsOpen: true, settingsPage: "appearance" };
    fireEvent.click(screen.getByRole("button", { name: "Close themes" }));
    expect(useViewsStore.getState()).toMatchObject(back);
    act(() => {
      openThemes("light", "settings");
    });
    expect(screen.getByTestId("themes-crumbs").textContent).toMatch(/Settings.*Themes/);
    fireEvent.click(screen.getByTestId("themes-crumb-settings"));
    expect(useViewsStore.getState()).toMatchObject(back);
    act(() => {
      openThemes("dark", "settings");
    });
    fireEvent.keyDown(screen.getByTestId("themes-list"), { key: "Escape" });
    expect(useViewsStore.getState()).toMatchObject(back);
    act(() => {
      openThemes("dark", "settings");
      closeSheet();
    });
    expect(useViewsStore.getState()).toMatchObject({ themesOpen: false, settingsOpen: false });
  });

  it("theme.pick from outside Settings: Escape closes the sheet; its Settings crumb leads to Settings → Appearance", () => {
    useViewsStore.setState({ settingsPage: "general" });
    act(() => {
      showView("themes");
    });
    render(
      <TooltipProvider>
        <SettingsSheet />
      </TooltipProvider>,
    );
    fireEvent.keyDown(screen.getByTestId("themes-list"), { key: "Escape" });
    expect(useViewsStore.getState()).toMatchObject({ themesOpen: false, settingsOpen: false });
    act(() => {
      showView("themes");
    });
    fireEvent.click(screen.getByTestId("themes-crumb-settings"));
    expect(useViewsStore.getState()).toMatchObject({ themesOpen: false, settingsOpen: true, settingsPage: "appearance" });
  });

  it("the scheme control saves appearance.theme", async () => {
    open();
    fireEvent.click(within(screen.getByTestId("themes-scheme")).getByRole("radio", { name: "Light" }));
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({ "appearance.theme": "light" });
    });
    // The saved preference arrives back as a snapshot: the slot in use follows.
    act(() => {
      setThemePreference("light");
      useSettingsStore.setState((st) => ({ snapshot: { values: { ...st.snapshot?.values, "appearance.theme": "light" }, path: "", revision: (st.snapshot?.revision ?? 0) + 1, loadError: "", issues: [], restartPending: [] } }));
    });
    expect(screen.getByTestId("themes-slot-light").textContent).toContain("in use");
    expect(screen.getByTestId("themes-slot-dark").textContent).not.toContain("in use");
    expect(screen.getByTestId("themes-scheme-note").textContent).toBe("Always light, showing GitHub Light");
  });
});

describe("Customise and Delete", { timeout: 30_000 }, () => {
  it("Customise copies into Yours, previews the copy and opens the editor on it; again, the unsaved copy goes first", async () => {
    open();
    // A curated theme has no Delete.
    expect(within(option("Dracula")).queryByRole("button", { name: "Delete Dracula" })).toBeNull();
    fireEvent.click(within(option("Dracula")).getByRole("button", { name: "Customise Dracula" }));
    await waitFor(() => {
      expect(names("themes-yours")).toEqual(["Dracula copy", "Mocha, warmer", "Ocean Dusk"]);
    });
    await screen.findByTestId("theme-inspector");
    expect(option("Dracula copy").getAttribute("aria-selected")).toBe("true");
    expect(within(option("Dracula copy")).getByTestId("theme-origin").textContent).toBe("editing · 0 pinned");
    expect(screen.getByTestId("themes-edit-bar").textContent).toContain("Editing Dracula copy · from Dracula");
    expect(screen.getByTestId("themes-editing-name").textContent).toBe("Dracula copy");
    expect(scope().dataset.theme).toBe("dracula-copy");
    // Previewed, not applied.
    expect(themeSlots().dark).toBe("github-dark");

    // Customise again: the first copy was never saved, so it goes before the next is made, which takes its id.
    fireEvent.click(within(option("Dracula")).getByRole("button", { name: "Customise Dracula" }));
    await waitFor(() => {
      expect(themeCalls()).toEqual(["theme.duplicate dracula", "theme.delete dracula-copy", "theme.duplicate dracula"]);
    });
    await waitFor(() => {
      expect(scope().dataset.theme).toBe("dracula-copy");
    });
    expect(names("themes-yours")).toEqual(["Dracula copy", "Mocha, warmer", "Ocean Dusk"]);

    // Saved once, a copy stays: the next Customise numbers past it.
    fireEvent.click(screen.getByTestId("themes-save"));
    fireEvent.click(await screen.findByTestId("theme-save-submit"));
    await waitFor(() => {
      expect(screen.queryByTestId("theme-save-dialog")).toBeNull();
    });
    fireEvent.click(within(option("Dracula")).getByRole("button", { name: "Customise Dracula" }));
    await waitFor(() => {
      expect(scope().dataset.theme).toBe("dracula-copy-2");
    });
    expect(names("themes-yours")).toEqual(["Dracula copy", "Dracula copy 2", "Mocha, warmer", "Ocean Dusk"]);
  });

  it("a double-click on Customise makes one copy; closing it unsaved deletes it and the preview goes back to the slot's", async () => {
    open();
    const btn = within(option("Nord")).getByRole("button", { name: "Customise Nord" });
    fireEvent.click(btn, { detail: 1 });
    fireEvent.click(btn, { detail: 2 });
    fireEvent.doubleClick(btn);
    await screen.findByTestId("theme-inspector");
    expect(screen.getByTestId("themes-editing-name").textContent).toBe("Nord copy");
    expect(calls("theme.duplicate")).toHaveLength(1);
    expect(disk.user.map((t) => t.id).filter((id) => id.startsWith("nord"))).toEqual(["nord-copy"]);
    fireEvent.click(screen.getByTestId("themes-edit-done"));
    await waitFor(() => {
      expect(screen.queryByTestId("theme-inspector")).toBeNull();
    });
    await waitFor(() => {
      expect(disk.user.some((t) => t.id === "nord-copy")).toBe(false);
    });
    expect(within(screen.getByTestId("themes-list")).queryByRole("option", { name: "Nord copy" })).toBeNull();
    expect(screen.getByTestId("themes-previewed-name").textContent).toBe("GitHub Dark");
  });

  it("Delete runs theme.delete for the row's theme", async () => {
    open();
    fireEvent.click(within(option("Ocean Dusk")).getByRole("button", { name: "Delete Ocean Dusk" }));
    await waitFor(() => {
      expect(within(screen.getByTestId("themes-list")).queryByRole("option", { name: "Ocean Dusk" })).toBeNull();
    });
    expect(calls("theme.delete").map((c) => c[1])).toEqual([{ theme: "ocean-dusk" }]);
    expect(names("themes-yours")).toEqual(["Mocha, warmer"]);
  });
});

// These tests click through many views; under load they outlast the 5 s default.
describe("the editor", { timeout: 30_000 }, () => {
  it("leaving with changes asks: another row, then closing the page; Discard leaves and the unsaved Customise copy goes", async () => {
    open();
    fireEvent.click(within(option("Dracula")).getByRole("button", { name: "Customise Dracula" }));
    await screen.findByTestId("theme-inspector");
    expect(scope().dataset.theme).toBe("dracula-copy");
    setBase("accent", "#ff79c6");
    fireEvent.click(option("Nord"));
    await confirmShows("Dracula copy has changes that are not saved.");
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(inspector()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close themes" }));
    await screen.findByTestId("confirm-dialog");
    fireEvent.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => {
      expect(useViewsStore.getState().themesOpen).toBe(false);
    });
    await waitFor(() => {
      expect(disk.user.some((t) => t.id === "dracula-copy")).toBe(false);
    });
    expect(calls("theme.save")).toHaveLength(0);
  });

  it("Escape with edits asks, and Escape on the question cancels only it; clean, Escape leaves the editor, then the page", async () => {
    await editOceanDusk();
    setBase("accent", "#ff00ff");
    const list = screen.getByTestId("themes-list");
    fireEvent.keyDown(list, { key: "Escape" });
    await confirmShows("Ocean Dusk has changes that are not saved.");
    // The question stays (the Escape that asked does not also dismiss it); Cancel keeps the editor.
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.getByTestId("confirm-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    });
    expect(inspector()).toBeTruthy();
    fireEvent.keyDown(list, { key: "Escape" });
    await confirmShows("Ocean Dusk has changes that are not saved.");
    fireEvent.keyDown(screen.getByTestId("confirm-ok"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    });
    expect(inspector()).toBeTruthy();
    fireEvent.click(screen.getByTestId("themes-revert"));
    fireEvent.keyDown(list, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("theme-inspector")).toBeNull();
    });
    expect(screen.getByTestId("themes-preview-bar")).toBeTruthy();
    // The list has the keyboard again.
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: "Escape" });
    expect(useViewsStore.getState().themesOpen).toBe(false);
  });

  it("focus follows the views: the first row on open, arrows walk the rows, Enter opens the hex field, Escape comes back; ↓ from the filter", async () => {
    await editOceanDusk();
    const focused = () => document.activeElement?.getAttribute("data-testid");
    await waitFor(() => {
      expect(focused()).toBe("editor-base-canvas");
    });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(focused()).toBe("editor-base-surface");
    // Enter on the row button is its click (the browser's activation; jsdom does not make it).
    fireEvent.click(document.activeElement as HTMLElement);
    await waitFor(() => {
      expect(screen.getByTestId("base-view").dataset.base).toBe("surface");
    });
    await waitFor(() => {
      expect(focused()).toBe("colour-hex");
    });
    fireEvent.keyDown(hex(), { key: "Escape" });
    await waitFor(() => {
      expect(focused()).toBe("editor-base-surface");
    });
    expect(screen.getByTestId("editor-slots")).toBeTruthy();
    const filter = screen.getByTestId("editor-filter");
    fireEvent.change(filter, { target: { value: "sidebar-row" } });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(focused()).toMatch(/^editor-slot-sidebar-row/);
  });

  it("in the editor the list's arrows stay put, and its footer says what Escape does", async () => {
    await editOceanDusk();
    expect(screen.getByTestId("themes-keys").textContent).toBe("esc close the editor");
    fireEvent.keyDown(screen.getByTestId("themes-list"), { key: "ArrowDown" });
    expect(inspector()).toBeTruthy();
    expect(scope().dataset.theme).toBe("ocean-dusk");
  });

  it("Pinned only, the filter, and their empty lines; a group header changes nothing while filtered", async () => {
    await editOceanDusk();
    expect(screen.getByTestId<HTMLInputElement>("editor-filter").placeholder).toMatch(/^Filter \d+ slots$/);
    expect(screen.getByTestId("editor-slots-summary").textContent).toBe("1 pinned");
    expect(screen.getByTestId("editor-slot-sidebar-row-selected").dataset.pinned).toBe("true");
    const slotRows = () => screen.getByTestId("editor-slots").querySelectorAll("[data-testid^=editor-slot-]:not([data-testid=editor-slots-summary])");
    fireEvent.click(screen.getByTestId("editor-pinned-only"));
    expect([...slotRows()].map((r) => r.getAttribute("data-testid"))).toEqual(["editor-slot-sidebar-row-selected"]);
    fireEvent.change(screen.getByTestId("editor-filter"), { target: { value: "zzz" } });
    expect(screen.getByTestId("editor-slots").textContent).toContain("No pinned slot matches “zzz”.");
    fireEvent.click(screen.getByTestId("editor-pinned-only"));
    expect(screen.getByTestId("editor-slots").textContent).toContain("No slot matches “zzz”.");

    // Terminal starts folded; a filter opens every group it matches, and its header does nothing then.
    fireEvent.change(screen.getByTestId("editor-filter"), { target: { value: "" } });
    const terminal = screen.getByTestId("editor-group-terminal");
    expect(within(terminal).queryByTestId("editor-slot-terminal-fg")).toBeNull();
    fireEvent.change(screen.getByTestId("editor-filter"), { target: { value: "chrome" } });
    const surfaces = screen.getByTestId("editor-group-surfaces");
    expect(within(surfaces).getByTestId("editor-slot-chrome")).toBeTruthy();
    fireEvent.click(within(surfaces).getAllByRole("button")[0] as HTMLElement);
    expect(within(surfaces).getByTestId("editor-slot-chrome")).toBeTruthy();
    fireEvent.change(screen.getByTestId("editor-filter"), { target: { value: "" } });
    expect(within(screen.getByTestId("editor-group-surfaces")).getByTestId("editor-slot-canvas")).toBeTruthy();
  });

  it("a base colour repaints the scope; a pin derived from it goes stale; touching a slot pins it; Reset to derived", async () => {
    await editOceanDusk();
    expect(screen.getByTestId("themes-edit-bar").textContent).toContain("Editing Ocean Dusk · from Catppuccin Mocha");
    expect(within(option("Ocean Dusk")).getByTestId("theme-origin").textContent).toBe("editing · 1 pinned");
    expect(screen.getByTestId("editor-slots-summary").textContent).toBe("1 pinned");
    // Every slot, Terminal and Syntax collapsed; the seed's pin marked.
    expect(screen.getByTestId("editor-filter").getAttribute("placeholder")).toBe("Filter 103 slots");
    expect(within(screen.getByTestId("editor-group-terminal")).queryByTestId("editor-slot-terminal-fg")).toBeNull();
    expect(screen.getByTestId("editor-slot-sidebar-row-selected").dataset.pinned).toBe("true");
    setBase("canvas", "#202830");
    expect(scopeVar("--cf-canvas")).toBe("#202830");
    expect(themeSlots().dark).toBe("github-dark");
    expect(screen.getByTestId("editor-slot-sidebar-row-selected").dataset.stale).toBe("true");
    expect(screen.getByTestId("editor-slots-summary").textContent).toContain("1 pinned · 1 stale");
    expect(screen.getByTestId("themes-edit-bar").textContent).toContain("unsaved");

    fireEvent.click(screen.getByTestId("editor-slot-sidebar-row-hover"));
    expect(screen.getByTestId("slot-view").dataset.slot).toBe("--cf-sidebar-row-hover");
    expect(screen.getByTestId("slot-view").textContent).toContain("Change the colour below to pin it.");
    typeHex("#334455");
    expect(screen.getByTestId("slot-view-yours").textContent).toContain("#334455");
    expect(screen.getByTestId("slot-view-derived")).toBeTruthy();
    expect(scopeVar("--cf-sidebar-row-hover")).toBe("#334455");
    // Escape goes back to the list; the page stays open.
    fireEvent.keyDown(screen.getByTestId("colour-plane"), { key: "Escape" });
    expect(screen.getByTestId("editor-slots")).toBeTruthy();
    expect(useViewsStore.getState().themesOpen).toBe(true);
    expect(screen.getByTestId("editor-slot-sidebar-row-hover").dataset.pinned).toBe("true");
    expect(screen.getByTestId("editor-slot-sidebar-row-hover").dataset.stale).toBeUndefined();

    setBase("canvas", "#2a3440");
    expect(screen.getByTestId("editor-slots-summary").textContent).toContain("2 pinned · 2 stale");
    expect(screen.getByTestId("editor-slot-sidebar-row-hover").textContent).toContain("pinned · would now derive #");
    fireEvent.click(screen.getByTestId("editor-slot-sidebar-row-hover"));
    expect(screen.getByTestId("slot-view-stale").textContent).toContain("it would now derive #");
    expect(screen.getByTestId("editor-pairs").textContent).toContain("sidebar-muted-foreground on it");
    fireEvent.click(screen.getByTestId("slot-reset"));
    expect(screen.queryByTestId("slot-view-stale")).toBeNull();
    fireEvent.click(screen.getByTestId("editor-back"));
    expect(screen.getByTestId("editor-slots-summary").textContent).toContain("2 pinned · 1 stale");

    // Save: the stale pin listed, Re-derive unpins it; "use now" checked (dark is in use); the file written; Revert.
    fireEvent.click(screen.getByTestId("themes-save"));
    const dialog = await screen.findByTestId("theme-save-dialog");
    expect(dialog.textContent).toContain("From Catppuccin Mocha · dark · 2 slots pinned");
    expect(within(dialog).getByTestId("theme-save-stale").textContent).toContain("sidebar-row-selected pinned before the base changed");
    fireEvent.click(within(dialog).getByTestId("theme-save-rederive"));
    expect(dialog.textContent).toContain("1 slot pinned");
    expect(within(dialog).getByTestId("theme-save-apply").getAttribute("aria-checked")).toBe("true");
    fireEvent.change(within(dialog).getByTestId("theme-save-name"), { target: { value: "Ocean Dusk, deeper" } });
    expect(within(dialog).getByTestId("theme-save-submit").textContent).toBe("Save and apply");
    fireEvent.click(within(dialog).getByTestId("theme-save-submit"));
    await waitFor(() => {
      expect(screen.queryByTestId("theme-save-dialog")).toBeNull();
    });
    expect(themeSlots().dark).toBe("ocean-dusk");
    const saved = disk.user.find((t) => t.id === "ocean-dusk");
    expect(saved?.name).toBe("Ocean Dusk, deeper");
    expect(saved?.base.canvas).toBe("#2a3440");
    expect(Object.keys(saved?.overrides ?? {})).toEqual(["--cf-sidebar-row-hover"]);
    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>("themes-revert").disabled).toBe(true);
    });

    setBase("canvas", "#101418");
    expect(screen.getByTestId("themes-edit-bar").textContent).toContain("unsaved");
    fireEvent.click(screen.getByTestId("themes-revert"));
    expect(scopeVar("--cf-canvas")).toBe("#2a3440");
    expect(screen.getByTestId<HTMLButtonElement>("themes-revert").disabled).toBe(true);
  });

  it("a contrast failure shows its ratio and Fix pins a value that reads", async () => {
    await editOceanDusk();
    fireEvent.change(screen.getByTestId("editor-filter"), { target: { value: "message-surface" } });
    fireEvent.click(screen.getByTestId("editor-slot-message-surface"));
    typeHex("#d7e3eaff");
    expect(screen.getByTestId("editor-pairs").querySelector("[data-pass=false]")).not.toBeNull();
    fireEvent.click(screen.getByTestId("editor-back"));
    fireEvent.change(screen.getByTestId("editor-filter"), { target: { value: "message" } });
    expect(within(screen.getByTestId("editor-slot-message-foreground")).getByTestId("slot-contrast").textContent).toMatch(/^1\.\d+:1$/);
    expect(screen.getByTestId("editor-group-thread").textContent).toContain("1 contrast");
    fireEvent.click(screen.getByTestId("themes-save"));
    const dialog = await screen.findByTestId("theme-save-dialog");
    expect(within(dialog).getByTestId("theme-save-contrast").textContent).toContain("message-foreground on message-surface");
    fireEvent.click(within(dialog).getByTestId("theme-save-fix"));
    expect(within(dialog).queryByTestId("theme-save-contrast")).toBeNull();
    expect(screen.getByTestId("editor-slot-message-foreground").dataset.pinned).toBe("true");
  });

  it("Fix on a pair no colour can mend leaves the slot alone and says why; every Fix offered mends its row", async () => {
    await editOceanDusk();
    fireEvent.change(screen.getByTestId("editor-filter"), { target: { value: "control-hover" } });
    fireEvent.click(screen.getByTestId("editor-slot-control-hover"));
    typeHex("#8a8a8a");
    fireEvent.click(screen.getByTestId("editor-back"));
    fireEvent.click(screen.getByTestId("themes-save"));
    const dialog = await screen.findByTestId("theme-save-dialog");
    const rows = () => within(dialog).getAllByTestId("theme-save-contrast");
    const unfixable = rows().filter((r) => r.textContent.includes("No colour on control-hover reaches 4.5:1; change the surface or the base colour."));
    expect(unfixable.length).toBeGreaterThan(0);
    for (const r of unfixable) expect(within(r).queryByTestId("theme-save-fix")).toBeNull();
    const before = rows().length;
    const fix = within(dialog).queryAllByTestId("theme-save-fix")[0];
    if (fix) {
      fireEvent.click(fix);
      expect(within(dialog).queryAllByTestId("theme-save-contrast")).toHaveLength(before - 1);
    }
  });

  it("a light surface on a dark theme is refused in the editor and holds Save; a refused name, a taken one and a long one", async () => {
    await editOceanDusk();
    setBase("surface", "#f0f0f0");
    expect(within(inspector()).getByTestId("editor-refusal").textContent).toContain("A dark theme needs a dark surface (OKLab lightness at most 0.45); #f0f0f0 is 0.9");
    expect(within(inspector()).getByTestId("editor-base-surface").dataset.problem).toBe("true");
    fireEvent.click(screen.getByTestId("themes-save"));
    let dialog = await screen.findByTestId("theme-save-dialog");
    expect(within(dialog).getByTestId("theme-save-refusal").textContent).toContain("A dark theme needs a dark surface");
    expect(dialog.textContent).not.toContain("You can save anyway");
    expect(within(dialog).queryByTestId("theme-save-contrast")).toBeNull();
    expect(within(dialog).getByTestId<HTMLButtonElement>("theme-save-submit").disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByTestId("theme-save-dialog")).toBeNull();
    });
    // Closing the modal hands the keyboard back to Save….
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("themes-save"));
    });

    setBase("surface", "#16232f");
    fireEvent.click(screen.getByTestId("themes-save"));
    dialog = await screen.findByTestId("theme-save-dialog");
    const name = within(dialog).getByTestId("theme-save-name");
    const submit = () => within(dialog).getByTestId<HTMLButtonElement>("theme-save-submit");
    fireEvent.change(name, { target: { value: "Ocean\tDusk" } });
    expect(within(dialog).getByTestId("theme-save-refusal").textContent).toBe("Cannot save: name: no control or format characters");
    expect(submit().disabled).toBe(true);
    fireEvent.change(name, { target: { value: "Mocha, warmer" } });
    expect(within(dialog).getByTestId("theme-save-name-hint").textContent).toBe("Another of your themes is called this.");
    expect(submit().disabled).toBe(false);
    fireEvent.change(name, { target: { value: "x".repeat(90) } });
    expect(within(dialog).getByTestId("theme-save-name-hint").textContent).toBe("90/80");
    expect(submit().disabled).toBe(true);
  });

  it("the save modal's Also make a light pair asks the model for the pair after saving", async () => {
    await editOceanDusk();
    fireEvent.click(screen.getByTestId("themes-save"));
    const dialog = await screen.findByTestId("theme-save-dialog");
    expect(dialog.textContent).toContain("Also make a light pair");
    fireEvent.click(within(dialog).getByTestId("theme-save-pair"));
    fireEvent.click(within(dialog).getByTestId("theme-save-submit"));
    await waitFor(() => {
      expect(calls("theme.ask").map((c) => c[1])).toEqual([{ pair: "ocean-dusk" }]);
    });
    expect(calls("theme.save")).toHaveLength(1);
  });

  it("the hex field takes #rgb, marks what it cannot take, and an emptied hex or L reverts; the hue wraps", async () => {
    await editOceanDusk();
    fireEvent.click(within(inspector()).getByTestId("editor-base-accent"));
    typeHex("#abc");
    expect(hex().value).toBe("#aabbcc");
    typeHex("rgb(1, 2, 3)");
    expect(hex().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("colour-hex-invalid").textContent).toBe("Use #rrggbb (or #rgb).");
    typeHex("");
    expect(hex().value).toBe("#aabbcc");
    expect(screen.queryByTestId("colour-hex-invalid")).toBeNull();
    const l = screen.getByRole<HTMLInputElement>("textbox", { name: "Accent lightness" });
    fireEvent.change(l, { target: { value: "" } });
    fireEvent.keyDown(l, { key: "Enter" });
    expect(hex().value).toBe("#aabbcc");
    const h = screen.getByRole<HTMLInputElement>("textbox", { name: "Accent hue" });
    fireEvent.change(h, { target: { value: "-50" } });
    fireEvent.keyDown(h, { key: "Enter" });
    expect(h.value).toBe("310");
  });

  it("a save from outside reaches the open editor; over unsaved edits it asks Reload or Keep mine", async () => {
    await editOceanDusk();
    const outside = (canvas: string) => {
      disk.user = disk.user.map((t) => (t.id === "ocean-dusk" ? { ...t, base: { ...t.base, canvas } } : t));
      publish();
    };
    // Clean: it reloads by itself.
    outside("#330000");
    expect(scopeVar("--cf-canvas")).toBe("#330000");
    expect(within(inspector()).getByTestId("editor-base-canvas").textContent).toContain("#330000");
    expect(screen.getByTestId("themes-edit-bar").textContent).not.toContain("unsaved");
    // theme edit on the theme already open: nothing to ask.
    act(() => {
      showView("themes.edit.ocean-dusk");
    });
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(within(inspector()).getByTestId("editor-base-canvas").textContent).toContain("#330000");

    // Unsaved edits: kept, with a notice; Reload takes the newer file.
    setBase("accent", "#ff00ff");
    outside("#440000");
    expect(screen.getByTestId("editor-disk-notice").textContent).toContain("Changed on disk");
    expect(scopeVar("--cf-canvas")).toBe("#330000");
    fireEvent.click(screen.getByTestId("editor-disk-reload"));
    expect(screen.queryByTestId("editor-disk-notice")).toBeNull();
    expect(scopeVar("--cf-canvas")).toBe("#440000");
    expect(screen.getByTestId<HTMLButtonElement>("themes-revert").disabled).toBe(true);

    // Keep mine: the draft stays, and Save writes it over the newer file.
    setBase("accent", "#ff00ff");
    outside("#550000");
    fireEvent.click(screen.getByTestId("editor-disk-keep"));
    expect(screen.queryByTestId("editor-disk-notice")).toBeNull();
    fireEvent.click(screen.getByTestId("themes-save"));
    const dialog = await screen.findByTestId("theme-save-dialog");
    fireEvent.click(within(dialog).getByTestId("theme-save-apply"));
    fireEvent.click(within(dialog).getByTestId("theme-save-submit"));
    await waitFor(() => {
      expect(screen.queryByTestId("theme-save-dialog")).toBeNull();
    });
    expect(disk.user.find((t) => t.id === "ocean-dusk")?.base).toMatchObject({ canvas: "#440000", accent: "#ff00ff" });
  });

  it("Cancel on leaving through a selection change puts the selection back; Discard on close goes back to Settings", async () => {
    const stop = startViewSync();
    try {
      open("dark", "settings");
      fireEvent.click(within(option("Ocean Dusk")).getByRole("button", { name: "Edit Ocean Dusk" }));
      await screen.findByTestId("theme-inspector");
      setBase("accent", "#ff00ff");
      act(() => {
        useUiStore.getState().select({ kind: "thread", id: "s-1" });
      });
      await screen.findByTestId("confirm-dialog");
      fireEvent.click(screen.getByTestId("confirm-cancel"));
      await waitFor(() => {
        expect(useUiStore.getState().selection).toEqual(HOME);
      });
      expect(inspector()).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close themes" }));
      await screen.findByTestId("confirm-dialog");
      fireEvent.click(screen.getByTestId("confirm-ok"));
      await waitFor(() => {
        expect(useViewsStore.getState()).toMatchObject({ themesOpen: false, settingsOpen: true });
      });
      expect(useUiStore.getState().selection).toEqual(HOME);
    } finally {
      stop();
      act(() => {
        closeSheet();
      });
    }
  });
});

describe("Ask the model", { timeout: 30_000 }, () => {
  it("starts a thread with the description from the Themes page and closes the page", async () => {
    open();
    fireEvent.click(screen.getByTestId("themes-ask"));
    const pop = await screen.findByTestId("themes-ask-popover");
    const input = within(pop).getByTestId<HTMLInputElement>("themes-ask-input");
    // The field's focus on open is e2e (theme-model-flow.spec.ts): jsdom's popover does not move it.
    expect(input.placeholder).toBe("Describe a theme… warm dark, teal accent, quieter sidebar");
    expect(within(pop).getByTestId<HTMLButtonElement>("themes-ask-send").disabled).toBe(true);
    // The daemon opens the thread it starts: a selection, which closes the page.
    const stop = startViewSync();
    runCommandForResult.mockImplementation((name, args) => {
      if (name === "theme.ask") act(() => { useUiStore.getState().select({ kind: "thread", id: "s-new" }); });
      return fakeDaemon(name, args);
    });
    try {
      const text = "a dark theme that feels like a tide pool at night, teal accent, quieter sidebar than Mocha";
      fireEvent.change(input, { target: { value: text } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      await waitFor(() => {
        expect(screen.queryByTestId("themes-ask-popover")).toBeNull();
      });
      expect(useViewsStore.getState().themesOpen).toBe(false);
      const [ask] = calls("theme.ask");
      expect(ask?.[1]).toEqual({ description: text });
      expect(ask?.[2]?.ctx?.activeView).toBe("themes");
    } finally {
      stop();
    }
  });

  it("with unsaved edits it asks first; Cancel starts nothing and keeps the text", async () => {
    await editOceanDusk();
    setBase("accent", "#ff00ff");
    fireEvent.click(screen.getByTestId("themes-ask"));
    const input = await screen.findByTestId("themes-ask-input");
    fireEvent.change(input, { target: { value: "warmer" } });
    fireEvent.click(screen.getByTestId("themes-ask-send"));
    await confirmShows("The model does not see them: asking starts a thread and leaves the editor.");
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    });
    expect(inspector()).toBeTruthy();
    expect(calls("theme.ask")).toHaveLength(0);
    if (!screen.queryByTestId("themes-ask-input")) fireEvent.click(screen.getByTestId("themes-ask"));
    expect((await screen.findByTestId<HTMLInputElement>("themes-ask-input")).value).toBe("warmer");
    fireEvent.click(screen.getByTestId("themes-ask-send"));
    await screen.findByTestId("confirm-dialog");
    fireEvent.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => {
      expect(calls("theme.ask")).toHaveLength(1);
    });
  });
});
