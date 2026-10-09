import { beforeEach, describe, expect, it } from "vitest";
import { getPanel, usePanelStore } from "./panel";
import { useUiStore, type FocusRegion } from "./ui";
import { expandPanelCommand, showView, togglePanelCommand, useViewsStore } from "./views";

const closedPalette = { open: false, query: "", commandName: null, page: "commands" as const, returnTo: "content" as FocusRegion };

describe("togglePanelCommand", () => {
  beforeEach(() => {
    usePanelStore.setState({ byKey: {} });
    useViewsStore.setState({ settingsOpen: false, helpOpen: false });
    useUiStore.setState({
      selection: { kind: "session", id: "a" },
      focus: "terminal",
      panelFocusSeq: 0,
      contentFocusSeq: 0,
      terminalFocusSeq: 0,
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

  it("is a no-op while the settings page is up", () => {
    useViewsStore.setState({ settingsOpen: true });
    expect(togglePanelCommand()).toBe(false);
    expect(getPanel().open).toBe(false);
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
  });

  describe("from the palette", () => {
    const cases: [string, boolean, FocusRegion, FocusRegion][] = [
      ["showing returns focus to the panel", false, "terminal", "panel"],
      ["hiding the panel the palette came from returns to the content pane", true, "panel", "content"],
      ["hiding keeps another return target", true, "sidebar", "sidebar"],
    ];
    it.each(cases)("%s", (_name, wasOpen, returnTo, want) => {
      if (wasOpen) usePanelStore.setState({ byKey: { "session:a": { open: true, tabs: [], activeTabId: null } } });
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
    useViewsStore.setState({ settingsOpen: false, helpOpen: false });
    useUiStore.setState({
      selection: { kind: "session", id: "a" },
      focus: "terminal",
      panelFocusSeq: 0,
      contentFocusSeq: 0,
      terminalFocusSeq: 0,
      sidebarFocusSeq: 0,
      palette: closedPalette,
    });
  });

  const seqs = () => {
    const ui = useUiStore.getState();
    return [ui.panelFocusSeq, ui.contentFocusSeq, ui.terminalFocusSeq, ui.sidebarFocusSeq];
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
    usePanelStore.setState({ byKey: { "session:a": { open: false, tabs: [], activeTabId: null, expanded: true } } });
    expect(expandPanelCommand()).toBe(true);
    expect(getPanel()).toMatchObject({ open: true, expanded: true });
  });

  const focusCases: [string, FocusRegion, boolean, number[]][] = [
    ["from the terminal (hidden by expanding) moves focus to the panel", "terminal", false, [1, 0, 0, 0]],
    ["from a page's content moves focus to the panel", "content", false, [1, 0, 0, 0]],
    ["from the sidebar leaves focus there", "sidebar", false, [0, 0, 0, 0]],
    ["from the panel leaves focus there", "panel", true, [0, 0, 0, 0]],
  ];
  it.each(focusCases)("expanding %s", (_name, focus, wasOpen, want) => {
    if (wasOpen) usePanelStore.setState({ byKey: { "session:a": { open: true, tabs: [], activeTabId: null } } });
    useUiStore.setState({ focus });
    expect(expandPanelCommand()).toBe(true);
    expect(seqs()).toEqual(want);
  });

  it("restoring the split leaves focus where it is", () => {
    usePanelStore.setState({ byKey: { "session:a": { open: true, tabs: [], activeTabId: null, expanded: true } } });
    useUiStore.setState({ focus: "panel" });
    expect(expandPanelCommand()).toBe(false);
    expect(seqs()).toEqual([0, 0, 0, 0]);
  });

  it("is a no-op while the settings page is up or with nothing selected", () => {
    useViewsStore.setState({ settingsOpen: true });
    expect(expandPanelCommand()).toBe(false);
    expect(usePanelStore.getState().byKey).toEqual({});
    useViewsStore.setState({ settingsOpen: false });
    useUiStore.getState().select({ kind: "none" });
    expect(expandPanelCommand()).toBe(false);
    expect(usePanelStore.getState().byKey).toEqual({});
    expect(seqs()).toEqual([0, 0, 0, 0]);
  });

  it("from the palette moves its return target to the panel instead of focusing", () => {
    useUiStore.setState({ focus: "palette", palette: { ...closedPalette, open: true, returnTo: "terminal" } });
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
