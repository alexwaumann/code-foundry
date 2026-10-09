import { beforeEach, describe, expect, it } from "vitest";
import { getPanel, usePanelStore } from "./panel";
import { useUiStore, type FocusRegion } from "./ui";
import { togglePanelCommand, useViewsStore } from "./views";

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
