import { beforeEach, describe, expect, it } from "vitest";
import { useAddProjectStore } from "./addProject";
import { getBottom, useBottomStore } from "./bottomPanel";
import { getPanel, makeTab, usePanelStore } from "./panel";
import { useUiStore, type FocusRegion } from "./ui";
import { closeUsage, expandPanelCommand, newPanelTabCommand, setSettingsPage, showView, startViewSync, toggleBottomCommand, togglePanelCommand, toggleView, useViewsStore } from "./views";

const closedPalette = { open: false, query: "", commandName: null, page: "commands" as const, returnTo: "content" as FocusRegion };

describe("togglePanelCommand", () => {
  beforeEach(() => {
    usePanelStore.setState({ byKey: {} });
    useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
    useUiStore.setState({
      selection: { kind: "thread", id: "a" },
      focus: "content",
      panelFocusSeq: 0,
      contentFocusSeq: 0,
      promptFocusSeq: 0,
      sidebarFocusSeq: 0,
      palette: closedPalette,
    });
  });

  it("showing focuses the panel; hiding it from the panel focuses the content pane", () => {
    expect(togglePanelCommand()).toBe(true);
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
    useUiStore.setState({ focus: "panel" });
    expect(togglePanelCommand()).toBe(false);
    expect(useUiStore.getState().contentFocusSeq).toBe(1);
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
  });

  it("hiding it from elsewhere leaves focus alone", () => {
    togglePanelCommand();
    useUiStore.setState({ focus: "sidebar" });
    togglePanelCommand();
    expect(useUiStore.getState().contentFocusSeq).toBe(0);
  });

  it.each(["settingsOpen", "themesOpen", "usageOpen"] as const)("still toggles under a sheet (%s): the panel stays laid out under it", (flag) => {
    useViewsStore.setState({ [flag]: true });
    expect(togglePanelCommand()).toBe(true);
    expect(getPanel().open).toBe(true);
    expect(useViewsStore.getState()[flag]).toBe(true);
  });

  describe("from the palette", () => {
    const cases: [string, boolean, FocusRegion, FocusRegion][] = [
      ["showing returns focus to the panel", false, "content", "panel"],
      ["hiding the panel the palette came from returns to the content pane", true, "panel", "content"],
      ["hiding keeps another return target", true, "sidebar", "sidebar"],
    ];
    it.each(cases)("%s", (_name, wasOpen, returnTo, want) => {
      if (wasOpen) usePanelStore.setState({ byKey: { "thread:a": { open: true, groups: [{ tabs: [], activeTabId: null }] } } });
      useUiStore.setState({ focus: "palette", palette: { ...closedPalette, open: true, returnTo } });
      expect(togglePanelCommand()).toBe(!wasOpen);
      const ui = useUiStore.getState();
      expect(ui.palette.returnTo).toBe(want);
      // The palette has focus: nothing moves until it closes.
      expect([ui.panelFocusSeq, ui.contentFocusSeq]).toEqual([0, 0]);
      ui.closePalette();
      const after = useUiStore.getState();
      expect(want === "panel" ? after.panelFocusSeq : want === "content" ? after.contentFocusSeq : after.sidebarFocusSeq).toBe(1);
    });
  });
});

describe("expandPanelCommand", () => {
  beforeEach(() => {
    usePanelStore.setState({ byKey: {} });
    useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
    useUiStore.setState({
      selection: { kind: "thread", id: "a" },
      focus: "content",
      panelFocusSeq: 0,
      contentFocusSeq: 0,
      promptFocusSeq: 0,
      sidebarFocusSeq: 0,
      palette: closedPalette,
    });
  });

  const seqs = () => {
    const ui = useUiStore.getState();
    return [ui.panelFocusSeq, ui.contentFocusSeq, ui.promptFocusSeq, ui.sidebarFocusSeq];
  };

  it("shows a hidden panel expanded, then flips it back to the split", () => {
    expect(expandPanelCommand()).toBe(true);
    expect(getPanel()).toMatchObject({ open: true, expanded: true });
    useUiStore.setState({ focus: "panel" });
    expect(expandPanelCommand()).toBe(false);
    expect(getPanel().open).toBe(true);
    expect(getPanel()).not.toHaveProperty("expanded");
    expect(expandPanelCommand()).toBe(true);
    expect(getPanel()).toMatchObject({ open: true, expanded: true });
  });

  it("a hidden expanded panel comes back expanded, not flipped", () => {
    usePanelStore.setState({ byKey: { "thread:a": { open: false, groups: [{ tabs: [], activeTabId: null }], expanded: true } } });
    expect(expandPanelCommand()).toBe(true);
    expect(getPanel()).toMatchObject({ open: true, expanded: true });
  });

  const focusCases: [string, FocusRegion, boolean, number[]][] = [
    ["from a page's content moves focus to the panel", "content", false, [1, 0, 0, 0]],
    ["from the sidebar leaves focus there", "sidebar", false, [0, 0, 0, 0]],
    ["from the panel leaves focus there", "panel", true, [0, 0, 0, 0]],
  ];
  it.each(focusCases)("expanding %s", (_name, focus, wasOpen, want) => {
    if (wasOpen) usePanelStore.setState({ byKey: { "thread:a": { open: true, groups: [{ tabs: [], activeTabId: null }] } } });
    useUiStore.setState({ focus });
    expect(expandPanelCommand()).toBe(true);
    expect(seqs()).toEqual(want);
  });

  it("restoring the split leaves focus where it is", () => {
    usePanelStore.setState({ byKey: { "thread:a": { open: true, groups: [{ tabs: [], activeTabId: null }], expanded: true } } });
    useUiStore.setState({ focus: "panel" });
    expect(expandPanelCommand()).toBe(false);
    expect(seqs()).toEqual([0, 0, 0, 0]);
  });

  it("is a no-op with nothing selected", () => {
    useUiStore.getState().select({ kind: "none" });
    expect(expandPanelCommand()).toBe(false);
    expect(usePanelStore.getState().byKey).toEqual({});
    expect(seqs()).toEqual([0, 0, 0, 0]);
  });

  it("from the palette moves its return target to the panel instead of focusing", () => {
    useUiStore.setState({ focus: "palette", palette: { ...closedPalette, open: true, returnTo: "content" } });
    expect(expandPanelCommand()).toBe(true);
    expect(useUiStore.getState().palette.returnTo).toBe("panel");
    expect(seqs()).toEqual([0, 0, 0, 0]);
    // Restoring from the palette keeps its target.
    expect(expandPanelCommand()).toBe(false);
    expect(useUiStore.getState().palette.returnTo).toBe("panel");
  });

  it("is what ShowView \"panel.expand\" runs", () => {
    expect(showView("panel.expand")).toBe(true);
    expect(getPanel()).toMatchObject({ open: true, expanded: true });
  });
});

describe("newPanelTabCommand", () => {
  const files = makeTab("files", "Files");
  const diff = makeTab("diff", "Diff");
  beforeEach(() => {
    usePanelStore.setState({ byKey: {} });
    useViewsStore.setState({ settingsOpen: false, usageOpen: false, helpOpen: false });
    useUiStore.setState({ selection: { kind: "thread", id: "a" }, focus: "content", panelFocusSeq: 0, palette: closedPalette });
  });

  it("starts picking in a hidden panel with tabs, shows it, and focuses it", () => {
    usePanelStore.setState({ byKey: { "thread:a": { open: false, groups: [{ tabs: [files, diff], activeTabId: diff.id }] } } });
    expect(newPanelTabCommand()).toBe(true);
    expect(getPanel()).toEqual({ open: true, groups: [{ tabs: [files, diff], activeTabId: null, pickFrom: diff.id }] });
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
  });

  it("without tabs only shows the panel (its list shows anyway)", () => {
    expect(newPanelTabCommand()).toBe(true);
    expect(getPanel()).toEqual({ open: true, groups: [{ tabs: [], activeTabId: null }] });
  });

  it("is a no-op with nothing selected", () => {
    useUiStore.getState().select({ kind: "none" });
    expect(newPanelTabCommand()).toBe(false);
    expect(usePanelStore.getState().byKey).toEqual({});
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
  });

  it("from the palette moves its return target to the panel instead of focusing", () => {
    useUiStore.setState({ focus: "palette", palette: { ...closedPalette, open: true, returnTo: "content" } });
    expect(newPanelTabCommand()).toBe(true);
    expect(useUiStore.getState().palette.returnTo).toBe("panel");
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
  });

  it("is what ShowView \"panel.new-tab\" runs", () => {
    usePanelStore.setState({ byKey: { "thread:a": { open: true, groups: [{ tabs: [files], activeTabId: files.id }] } } });
    expect(showView("panel.new-tab")).toBe(true);
    expect(getPanel()).toMatchObject({ groups: [{ activeTabId: null, pickFrom: files.id }] });
  });
});

describe("showView", () => {
  it("\"dashboard\" selects the dashboard and closes settings", () => {
    useUiStore.setState({ selection: { kind: "thread", id: "a" } });
    useViewsStore.setState({ settingsOpen: true, helpOpen: false });
    expect(showView("dashboard")).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "dashboard" });
    expect(useViewsStore.getState().settingsOpen).toBe(false);
  });

  it("\"settings.<page>\" opens settings on that page, and moves an open one there (view.settings --page)", () => {
    useViewsStore.setState({ settingsOpen: false, usageOpen: true, themesOpen: false, helpOpen: false });
    expect(showView("settings.memory")).toBe(true);
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "memory", usageOpen: false });
    expect(showView("settings.skills")).toBe(true);
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "skills" });
  });

  it("\"project.add\" opens the Add Project dialog on Local folder", async () => {
    useAddProjectStore.setState({ open: false, tab: "github" });
    expect(showView("project.add")).toBe(true);
    await Promise.resolve();
    expect(useAddProjectStore.getState()).toMatchObject({ open: true, tab: "local" });
  });
});

describe("the usage page", () => {
  beforeEach(() => {
    usePanelStore.setState({ byKey: {} });
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
    ["a top-level page closes usage", { usageOpen: true }, "pullrequests", { settingsOpen: false, usageOpen: false, helpOpen: false }],
  ])("%s", (_name, before, view, want) => {
    useViewsStore.setState(before);
    showView(view);
    expect(views()).toEqual(want);
  });

  it("closeUsage closes it and refocuses the selection's terminal", () => {
    useViewsStore.setState({ usageOpen: true });
    closeUsage();
    expect(views().usageOpen).toBe(false);
    expect(useUiStore.getState().promptFocusSeq).toBe(1);
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

  it("the panel commands act on the panel under it, and it stays up", () => {
    useViewsStore.setState({ usageOpen: true });
    expect(togglePanelCommand()).toBe(true);
    expect(expandPanelCommand()).toBe(true);
    expect(getPanel()).toMatchObject({ open: true, expanded: true });
    expect(views().usageOpen).toBe(true);
  });
});

describe("toggleBottomCommand", () => {
  beforeEach(() => {
    useBottomStore.setState({ byKey: {}, pendingFocus: null });
    usePanelStore.setState({ byKey: {} });
    useViewsStore.setState({ settingsOpen: false, usageOpen: false, helpOpen: false });
    useUiStore.setState({
      selection: { kind: "thread", id: "a" },
      focus: "content",
      bottomFocusSeq: 0,
      contentFocusSeq: 0,
      palette: closedPalette,
    });
  });

  it("showing focuses the panel; hiding it from the panel focuses the content pane", () => {
    expect(toggleBottomCommand()).toBe(true);
    expect(getBottom("thread:a").open).toBe(true);
    expect(useUiStore.getState().bottomFocusSeq).toBe(1);
    useUiStore.setState({ focus: "bottom" });
    expect(toggleBottomCommand()).toBe(false);
    expect(useUiStore.getState().contentFocusSeq).toBe(1);
  });

  it("hiding it from elsewhere leaves focus alone", () => {
    toggleBottomCommand();
    useUiStore.setState({ focus: "sidebar" });
    toggleBottomCommand();
    expect(useUiStore.getState().contentFocusSeq).toBe(0);
  });

  const noops: [string, () => void][] = [
    ["a selection without a bottom panel (the dashboard)", () => useUiStore.setState({ selection: { kind: "view", name: "dashboard" } })],
    ["the Pull Requests page", () => useUiStore.setState({ selection: { kind: "view", name: "pullrequests" } })],
    ["the side panel expanded", () => usePanelStore.setState({ byKey: { "thread:a": { open: true, groups: [{ tabs: [], activeTabId: null }], expanded: true } } })],
  ];
  it.each(noops)("is a no-op with %s", (_name, arrange) => {
    arrange();
    expect(toggleBottomCommand()).toBe(false);
    expect(useBottomStore.getState().byKey).toEqual({});
    expect(useUiStore.getState().bottomFocusSeq).toBe(0);
  });

  it.each(["settingsOpen", "usageOpen"] as const)("still toggles under a sheet (%s): the panel stays laid out under it", (flag) => {
    useViewsStore.setState({ [flag]: true });
    expect(toggleBottomCommand()).toBe(true);
    expect(getBottom("thread:a").open).toBe(true);
    expect(useViewsStore.getState()[flag]).toBe(true);
  });

  it("works on the Projects page's own panel", () => {
    useUiStore.setState({ selection: { kind: "view", name: "projects" } });
    expect(toggleBottomCommand()).toBe(true);
    expect(getBottom("view:projects").open).toBe(true);
    expect(getBottom("thread:a").open).toBe(false);
  });

  describe("from the palette", () => {
    const cases: [string, boolean, FocusRegion, FocusRegion][] = [
      ["showing returns focus to the bottom panel", false, "content", "bottom"],
      ["hiding the panel the palette came from returns to the content pane", true, "bottom", "content"],
      ["hiding keeps another return target", true, "panel", "panel"],
    ];
    it.each(cases)("%s", (_name, wasOpen, returnTo, want) => {
      if (wasOpen) useBottomStore.setState({ byKey: { "thread:a": { open: true } } });
      useUiStore.setState({ focus: "palette", palette: { ...closedPalette, open: true, returnTo } });
      expect(toggleBottomCommand()).toBe(!wasOpen);
      expect(useUiStore.getState().palette.returnTo).toBe(want);
      // The palette has focus: nothing moves until it closes.
      expect(useUiStore.getState().bottomFocusSeq).toBe(0);
    });
  });

  it("is what ShowView bottom.toggle does", () => {
    expect(showView("bottom.toggle")).toBe(true);
    expect(getBottom("thread:a").open).toBe(true);
  });
});

describe("expandPanelCommand from the bottom panel", () => {
  beforeEach(() => {
    usePanelStore.setState({ byKey: {} });
    useViewsStore.setState({ settingsOpen: false, usageOpen: false, helpOpen: false });
    useUiStore.setState({ selection: { kind: "thread", id: "a" }, focus: "bottom", panelFocusSeq: 0, palette: closedPalette });
  });

  it("moves focus to the panel: expanding hides the bottom panel with the content column", () => {
    expect(expandPanelCommand()).toBe(true);
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
  });

  it("from the palette, its return target moves to the panel", () => {
    useUiStore.setState({ focus: "palette", palette: { ...closedPalette, open: true, returnTo: "bottom" } });
    expandPanelCommand();
    expect(useUiStore.getState().palette.returnTo).toBe("panel");
  });
});
