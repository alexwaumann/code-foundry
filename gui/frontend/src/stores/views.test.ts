import { beforeEach, describe, expect, it } from "vitest";
import { useAddProjectStore } from "./addProject";
import { useUiStore } from "./ui";
import { closeUsage, setSettingsPage, showView, startViewSync, toggleView, useViewsStore } from "./views";
import { requestPaneFocus, requestPaneFocusOverSheets } from "./shellView";

const closedPalette = { open: false, query: "", commandName: null, page: "commands" as const, returnTo: "content" as const };

describe("showView", () => {
  // view.pullrequests and view.projects open their tab in the layout and send no ShowView
  // (docs/notes/shell-22-retire-verbs.md); neither do the item verbs, whose old names were panel.*.
  it.each(["pullrequests", "projects", "panel.file", "panel.diff", "panel.pr", "panel.mcp", "panel.gallery"])("%s is no view: ignored", (name) => {
    useUiStore.setState({ selection: { kind: "thread", id: "a" } });
    useViewsStore.setState({ settingsOpen: true, helpOpen: false });
    expect(showView(name, { project: "r1" })).toBe(false);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "a" });
    expect(useViewsStore.getState().settingsOpen).toBe(true);
  });

  it("\"dashboard\" (removed, docs/notes/remove-dashboard.md) is an unknown name: ignored", () => {
    useUiStore.setState({ selection: { kind: "thread", id: "a" } });
    useViewsStore.setState({ settingsOpen: true, helpOpen: false });
    expect(showView("dashboard")).toBe(false);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "a" });
    expect(useViewsStore.getState().settingsOpen).toBe(true);
  });

  it("\"settings.<page>\" opens settings on that page, and moves an open one there (view.settings --page)", () => {
    useViewsStore.setState({ settingsOpen: false, usageOpen: true, themesOpen: false, helpOpen: false });
    expect(showView("settings.memory")).toBe(true);
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "memory", usageOpen: false });
    expect(showView("settings.skills")).toBe(true);
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "skills" });
  });

  it("\"project.add\" opens the Add Project dialog on Local folder, to stay where the window is", async () => {
    useAddProjectStore.setState({ open: false, tab: "github", stay: false });
    expect(showView("project.add")).toBe(true);
    await Promise.resolve();
    expect(useAddProjectStore.getState()).toMatchObject({ open: true, tab: "local", stay: true });
  });
});

describe("the usage page", () => {
  beforeEach(() => {
    useViewsStore.setState({ settingsOpen: false, usageOpen: false, helpOpen: false });
    useUiStore.setState({ selection: { kind: "thread", id: "a" }, promptFocusSeq: 0, palette: closedPalette });
  });
  const views = () => {
    const { settingsOpen, usageOpen, helpOpen } = useViewsStore.getState();
    return { settingsOpen, usageOpen, helpOpen };
  };

  it.each(["usage", "settings"] as const)("a ShowView of %s only shows: the page stays open when it is open already", (name) => {
    const key = name === "usage" ? "usageOpen" : "settingsOpen";
    expect(showView(name)).toBe(true);
    expect(views()[key]).toBe(true);
    expect(showView(name)).toBe(true);
    expect(views()[key]).toBe(true);
    expect(useUiStore.getState().promptFocusSeq).toBe(0);
  });

  it("a second ShowView of settings keeps the page it shows", () => {
    showView("settings");
    setSettingsPage("appearance");
    showView("settings");
    expect(useViewsStore.getState().settingsPage).toBe("appearance");
  });

  it.each(["usage", "settings"] as const)("the window's own %s key toggles: opens, then closes and hands focus back to the terminal", (name) => {
    const key = name === "usage" ? "usageOpen" : "settingsOpen";
    expect(toggleView(name)).toBe(true);
    expect(views()).toEqual({ settingsOpen: name === "settings", usageOpen: name === "usage", helpOpen: false });
    expect(useUiStore.getState().promptFocusSeq).toBe(0);
    expect(toggleView(name)).toBe(true);
    expect(views()[key]).toBe(false);
    expect(useUiStore.getState().promptFocusSeq).toBe(1);
  });

  it.each([
    ["settings over help", { helpOpen: true }, "settings", { settingsOpen: true, usageOpen: false, helpOpen: false }],
    ["usage over settings", { settingsOpen: true, helpOpen: true }, "usage", { settingsOpen: false, usageOpen: true, helpOpen: false }],
    ["settings over usage", { usageOpen: true }, "settings", { settingsOpen: true, usageOpen: false, helpOpen: false }],
  ])("%s", (_name, before, view, want) => {
    useViewsStore.setState(before);
    showView(view);
    expect(views()).toEqual(want);
  });

  it("themes (theme.pick, the Themes body of the settings sheet) over usage", () => {
    useViewsStore.setState({ usageOpen: true, themesOpen: false });
    showView("themes");
    expect(useViewsStore.getState()).toMatchObject({ themesOpen: true, settingsOpen: false, usageOpen: false });
    useViewsStore.setState({ themesOpen: false });
  });

  it("closeUsage closes it and refocuses the selection's terminal", () => {
    useViewsStore.setState({ usageOpen: true });
    closeUsage();
    expect(views().usageOpen).toBe(false);
    expect(useUiStore.getState().promptFocusSeq).toBe(1);
  });

  it("a terminal this window started under it asks for the keyboard: it closes, as the settings sheet; any other pane request leaves it", () => {
    const stop = startViewSync();
    try {
      useViewsStore.setState({ usageOpen: true });
      // A late request (a clicked row's tab drawn after the sheet opened) leaves it.
      requestPaneFocus("p-2");
      expect(views().usageOpen).toBe(true);
      requestPaneFocusOverSheets("p-2");
      expect(views().usageOpen).toBe(false);
      useViewsStore.setState({ settingsOpen: true });
      requestPaneFocusOverSheets("p-2");
      expect(views().settingsOpen).toBe(false);
    } finally {
      stop();
    }
  });

  it("a selection change closes it", () => {
    const stop = startViewSync();
    try {
      useViewsStore.setState({ usageOpen: true });
      useUiStore.getState().select({ kind: "thread", id: "a" }); // same selection: stays open
      expect(views().usageOpen).toBe(true);
      useUiStore.getState().select({ kind: "thread", id: "b" });
      expect(views().usageOpen).toBe(false);
    } finally {
      stop();
    }
  });

  it("the classic panels' verbs are gone: their names are no view, and it stays up", () => {
    useViewsStore.setState({ usageOpen: true });
    const before = useUiStore.getState().selection;
    for (const name of ["panel.toggle", "panel.expand", "panel.new-tab", "panel.split", "bottom.toggle"]) expect(showView(name)).toBe(false);
    expect(views().usageOpen).toBe(true);
    expect(useUiStore.getState().selection).toBe(before);
  });
});

