import { describe, expect, it } from "vitest";
import { BOTTOM_MIN, bottomMax, clampBottomHeight, CONTENT_MIN, DASHBOARD, PANE_GAPS, PANEL_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampPanelWidth, isDashboard, panelMax, useUiStore, type FocusRegion, type Selection } from "./ui";

describe("panelMax", () => {
  const cases: [string, number, number, number][] = [
    ["60% of a wide window", 2000, 260, 1200],
    ["room beside the sidebar when that is less", 1400, 520, 1400 - 520 - PANE_GAPS - CONTENT_MIN],
    ["sidebar hidden", 1000, 0, 600],
    ["no room: below the minimum", 1000, 520, 1000 - 520 - PANE_GAPS - CONTENT_MIN],
    ["900px minimum window, default sidebar", 900, SIDEBAR_DEFAULT, 900 - SIDEBAR_DEFAULT - PANE_GAPS - CONTENT_MIN],
  ];
  it.each(cases)("%s", (_name, windowWidth, sidebar, want) => {
    expect(panelMax(windowWidth, sidebar)).toBe(want);
  });

  it("leaves the content pane its minimum whenever the panel fits", () => {
    for (const windowWidth of [900, 1000, 1280, 1600]) {
      for (const sidebar of [0, SIDEBAR_MIN, 260, SIDEBAR_MAX]) {
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

describe("window width", () => {
  it("setWindowWidth only records the width (panel widths live in stores/panel.ts)", () => {
    useUiStore.getState().setWindowWidth(1100);
    expect(useUiStore.getState().windowWidth).toBe(1100);
    expect(useUiStore.getState()).not.toHaveProperty("panelWidth");
  });
});

describe("ui persistence", () => {
  it("migrating drops the old global panelWidth and the tree's collapsed rows, and keeps the rest", async () => {
    const migrate = useUiStore.persist.getOptions().migrate;
    expect(useUiStore.persist.getOptions().version).toBe(3);
    const v1 = { sidebarVisible: false, sidebarWidth: 300, panelWidth: 600, fontSize: 14, collapsed: { a: true } };
    expect(await migrate?.(v1, 1)).toEqual({ sidebarVisible: false, sidebarWidth: 300, fontSize: 14 });
    expect(await migrate?.({ sidebarWidth: 280, collapsed: {} }, 2)).toEqual({ sidebarWidth: 280 });
  });

  const widths: [string, unknown, number][] = [
    ["a width saved under the old 180 minimum is raised", { sidebarWidth: 180 }, SIDEBAR_MIN],
    ["a width above the maximum is lowered", { sidebarWidth: 900 }, SIDEBAR_MAX],
    ["a width inside the bounds is kept, rounded", { sidebarWidth: 300.4 }, 300],
    ["no saved width keeps the default", { fontSize: 14 }, SIDEBAR_DEFAULT],
    ["nothing saved keeps the default", undefined, SIDEBAR_DEFAULT],
  ];
  it.each(widths)("loading: %s", (_name, persisted, want) => {
    const merge = useUiStore.persist.getOptions().merge;
    const current = { ...useUiStore.getState(), sidebarWidth: SIDEBAR_DEFAULT };
    expect(merge?.(persisted, current).sidebarWidth).toBe(want);
  });

  it("loading keeps the other saved fields", () => {
    const merged = useUiStore.persist.getOptions().merge?.({ sidebarVisible: false, sidebarWidth: 180, fontSize: 15 }, useUiStore.getState());
    expect(merged).toMatchObject({ sidebarVisible: false, sidebarWidth: SIDEBAR_MIN, fontSize: 15 });
  });

  it("does not save the selection: the window always starts on the dashboard", () => {
    const saved = useUiStore.persist.getOptions().partialize?.(useUiStore.getState());
    expect(saved).not.toHaveProperty("selection");
    expect(useUiStore.getInitialState().selection).toEqual({ kind: "view", name: "dashboard" });
  });

  it("does not save a panel width", () => {
    const saved = useUiStore.persist.getOptions().partialize?.(useUiStore.getState());
    expect(saved).not.toHaveProperty("panelWidth");
    expect(saved).toHaveProperty("sidebarWidth");
  });

  it("saves and loads the Working section's collapsed state; expanded by default and for a bad value", () => {
    expect(useUiStore.getInitialState().workingCollapsed).toBe(false);
    const opts = useUiStore.persist.getOptions();
    const current = useUiStore.getState();
    useUiStore.setState({ workingCollapsed: false });
    useUiStore.getState().toggleWorkingCollapsed();
    expect(useUiStore.getState().workingCollapsed).toBe(true);
    expect(opts.partialize?.(useUiStore.getState())).toMatchObject({ workingCollapsed: true });
    expect(opts.merge?.({ workingCollapsed: true }, current).workingCollapsed).toBe(true);
    expect(opts.merge?.({}, { ...current, workingCollapsed: false }).workingCollapsed).toBe(false);
    expect(opts.merge?.({ workingCollapsed: "yes" }, { ...current, workingCollapsed: false }).workingCollapsed).toBe(false);
    useUiStore.getState().toggleWorkingCollapsed();
    expect(useUiStore.getState().workingCollapsed).toBe(false);
  });

  it("saves and loads the Projects page's collapsed projects and workspaces; none by default and for a bad value", () => {
    expect(useUiStore.getInitialState().collapsedProjects).toEqual([]);
    expect(useUiStore.getInitialState().collapsedWorkspaces).toEqual([]);
    const opts = useUiStore.persist.getOptions();
    const current = useUiStore.getState();
    useUiStore.setState({ collapsedProjects: [], collapsedWorkspaces: [] });
    const ui = () => useUiStore.getState();
    expect(ui().setProjectCollapsed("repo-cf", true)).toBe(true);
    expect(ui().setProjectCollapsed("repo-cf", true)).toBe(false);
    expect(ui().setWorkspaceCollapsed("w-1", true)).toBe(true);
    expect(ui().setWorkspaceCollapsed("w-2", false)).toBe(false);
    expect(opts.partialize?.(ui())).toMatchObject({ collapsedProjects: ["repo-cf"], collapsedWorkspaces: ["w-1"] });
    expect(opts.merge?.({ collapsedProjects: ["a"], collapsedWorkspaces: ["b"] }, current)).toMatchObject({ collapsedProjects: ["a"], collapsedWorkspaces: ["b"] });
    expect(opts.merge?.({}, { ...current, collapsedProjects: [] }).collapsedProjects).toEqual([]);
    expect(opts.merge?.({ collapsedProjects: "a", collapsedWorkspaces: [1] }, { ...current, collapsedProjects: [], collapsedWorkspaces: [] })).toMatchObject({ collapsedProjects: [], collapsedWorkspaces: [] });
    expect(ui().setProjectCollapsed("repo-cf", false)).toBe(true);
    expect(ui().collapsedProjects).toEqual([]);
    useUiStore.setState({ collapsedWorkspaces: [] });
  });
});

describe("bottomMax and clampBottomHeight", () => {
  const cases: [string, number, number][] = [
    ["70% of the column", 1000, 700],
    ["floored", 784, 548],
    ["a short column keeps 160 for the content pane (plus the 8px gap)", 500, 500 - 160 - 8],
    ["never below the minimum", 250, BOTTOM_MIN],
    ["an unmeasured column", 0, BOTTOM_MIN],
  ];
  it.each(cases)("bottomMax: %s", (_name, column, want) => {
    expect(bottomMax(column)).toBe(want);
  });
  const clamps: [string, number, number, number][] = [
    ["within bounds, rounded", 300.4, 1000, 300],
    ["below the minimum", 40, 1000, BOTTOM_MIN],
    ["above the maximum", 900, 1000, 700],
  ];
  it.each(clamps)("clampBottomHeight: %s", (_name, h, column, want) => {
    expect(clampBottomHeight(h, column)).toBe(want);
  });
});

describe("closePalette", () => {
  const seqs = (): Record<string, number> => {
    const s = useUiStore.getState();
    return { terminal: s.terminalFocusSeq, sidebar: s.sidebarFocusSeq, panel: s.panelFocusSeq, bottom: s.bottomFocusSeq, content: s.contentFocusSeq };
  };
  const cases: [FocusRegion, string][] = [
    ["terminal", "terminal"],
    ["sidebar", "sidebar"],
    ["panel", "panel"],
    ["bottom", "bottom"],
    ["content", "content"],
  ];
  it.each(cases)("returns focus to %s", (returnTo, bumped) => {
    useUiStore.setState({ terminalFocusSeq: 0, sidebarFocusSeq: 0, panelFocusSeq: 0, bottomFocusSeq: 0, contentFocusSeq: 0, palette: { open: true, query: "", commandName: null, page: "commands", returnTo } });
    useUiStore.getState().closePalette();
    const want = { terminal: 0, sidebar: 0, panel: 0, bottom: 0, content: 0, [bumped]: 1 };
    expect(seqs()).toEqual(want);
    expect(useUiStore.getState().palette.open).toBe(false);
  });
});

describe("isDashboard", () => {
  const cases: [string, Selection, boolean][] = [
    ["the dashboard view", DASHBOARD, true],
    ["nothing selected (renders the dashboard too)", { kind: "none" }, true],
    ["another page", { kind: "view", name: "projects" }, false],
    ["a thread", { kind: "session", id: "s-1" }, false],
  ];
  it.each(cases)("%s", (_name, sel, want) => {
    expect(isDashboard(sel)).toBe(want);
  });
});
