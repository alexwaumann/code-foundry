import { beforeEach, describe, expect, it } from "vitest";
import { CONTENT_MIN, PANE_GAPS, PANEL_MIN, clampPanelWidth, panelMax, useUiStore, type FocusRegion } from "./ui";

describe("panelMax", () => {
  const cases: [string, number, number, number][] = [
    ["60% of a wide window", 2000, 260, 1200],
    ["room beside the sidebar when that is less", 1400, 520, 1400 - 520 - PANE_GAPS - CONTENT_MIN],
    ["sidebar hidden", 1000, 0, 600],
    ["no room: below the minimum", 1000, 520, 1000 - 520 - PANE_GAPS - CONTENT_MIN],
    ["900px minimum window, default sidebar", 900, 260, 900 - 260 - PANE_GAPS - CONTENT_MIN],
  ];
  it.each(cases)("%s", (_name, windowWidth, sidebar, want) => {
    expect(panelMax(windowWidth, sidebar)).toBe(want);
  });

  it("leaves the content pane its minimum whenever the panel fits", () => {
    for (const windowWidth of [900, 1000, 1280, 1600]) {
      for (const sidebar of [0, 180, 260, 520]) {
        const max = panelMax(windowWidth, sidebar);
        if (max < PANEL_MIN) continue;
        expect(windowWidth - sidebar - PANE_GAPS - max).toBeGreaterThanOrEqual(CONTENT_MIN);
      }
    }
  });
});

describe("clampPanelWidth", () => {
  const cases: [string, number, number, number, number][] = [
    ["below the minimum", 100, 1400, 260, PANEL_MIN],
    ["inside the bounds, rounded", 500.4, 1400, 260, 500],
    ["above 60% of the window", 1000, 1400, 0, 840],
    ["above the room beside a wide sidebar", 700, 1400, 520, 496],
    ["no room keeps the minimum", 400, 1000, 520, PANEL_MIN],
  ];
  it.each(cases)("%s", (_name, w, windowWidth, sidebar, want) => {
    expect(clampPanelWidth(w, windowWidth, sidebar)).toBe(want);
  });
});

describe("panel width in the store", () => {
  beforeEach(() => {
    useUiStore.setState({ windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260, panelWidth: 420 });
  });

  it("setPanelWidth clamps to the current window and sidebar", () => {
    useUiStore.getState().setPanelWidth(2000);
    expect(useUiStore.getState().panelWidth).toBe(panelMax(1400, 260));
    useUiStore.setState({ sidebarVisible: false });
    useUiStore.getState().setPanelWidth(2000);
    expect(useUiStore.getState().panelWidth).toBe(840);
    useUiStore.getState().setPanelWidth(10);
    expect(useUiStore.getState().panelWidth).toBe(PANEL_MIN);
  });

  it("setWindowWidth re-clamps the stored width to the smaller room", () => {
    useUiStore.getState().setPanelWidth(700);
    expect(useUiStore.getState().panelWidth).toBe(700);
    useUiStore.getState().setWindowWidth(1100);
    expect(useUiStore.getState().windowWidth).toBe(1100);
    expect(useUiStore.getState().panelWidth).toBe(panelMax(1100, 260));
    // Growing the window again does not grow the stored width.
    useUiStore.getState().setWindowWidth(1600);
    expect(useUiStore.getState().panelWidth).toBe(panelMax(1100, 260));
  });
});

describe("closePalette", () => {
  const seqs = (): Record<string, number> => {
    const s = useUiStore.getState();
    return { terminal: s.terminalFocusSeq, sidebar: s.sidebarFocusSeq, panel: s.panelFocusSeq, content: s.contentFocusSeq };
  };
  const cases: [FocusRegion, string][] = [
    ["terminal", "terminal"],
    ["sidebar", "sidebar"],
    ["panel", "panel"],
    ["content", "content"],
  ];
  it.each(cases)("returns focus to %s", (returnTo, bumped) => {
    useUiStore.setState({ terminalFocusSeq: 0, sidebarFocusSeq: 0, panelFocusSeq: 0, contentFocusSeq: 0, palette: { open: true, query: "", commandName: null, page: "commands", returnTo } });
    useUiStore.getState().closePalette();
    const want = { terminal: 0, sidebar: 0, panel: 0, content: 0, [bumped]: 1 };
    expect(seqs()).toEqual(want);
    expect(useUiStore.getState().palette.open).toBe(false);
  });
});
