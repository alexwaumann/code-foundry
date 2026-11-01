import { describe, expect, it } from "vitest";
import { SHELL_GAP } from "@/design/tokens";
import { BOTTOM_GAP, BOTTOM_MIN, bottomMax, clampBottomHeight, CONTENT_MIN, HOME, PANE_GAPS, PANEL_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampPanelWidth, expandedPanelWidth, panelMax, viewNames, useUiStore, type FocusRegion } from "./ui";

describe("shell gaps", () => {
  it("the panes' horizontal gaps are three shell gaps (sidebar | gap | content | gap | panel | gap), 36px", () => {
    expect(PANE_GAPS).toBe(3 * SHELL_GAP);
    expect(PANE_GAPS).toBe(36);
  });
  it("the bottom panel sits one shell gap under the content pane", () => {
    expect(BOTTOM_GAP).toBe(SHELL_GAP);
  });
});

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

describe("expandedPanelWidth", () => {
  const cases: [string, number, number, number][] = [
    ["the row beside the sidebar less the panel's two margins", 1400, SIDEBAR_DEFAULT, 1400 - SIDEBAR_DEFAULT - 2 * SHELL_GAP],
    ["sidebar hidden", 900, 0, 876],
    ["900px window, default sidebar: stacks a split", 900, SIDEBAR_DEFAULT, 656],
    ["800px window, default sidebar", 800, SIDEBAR_DEFAULT, 556],
    ["never negative", 200, SIDEBAR_MAX, 0],
  ];
  it.each(cases)("%s", (_name, windowWidth, sidebar, want) => {
    expect(expandedPanelWidth(windowWidth, sidebar)).toBe(want);
  });
});

describe("clampPanelWidth", () => {
  const cases: [string, number, number, number, number][] = [
    ["below the minimum", 100, 1400, 260, PANEL_MIN],
    ["inside the bounds, rounded", 500.4, 1400, 260, 500],
    ["above 60% of the window", 1000, 1400, 0, 840],
    ["above the room beside a wide sidebar", 700, 1400, 520, 484],
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
  it("migrating drops the old global panelWidth, the tree's collapsed rows and the pre-220 sidebar width, and keeps the rest", async () => {
    const migrate = useUiStore.persist.getOptions().migrate;
    expect(useUiStore.persist.getOptions().version).toBe(4);
    const v1 = { sidebarVisible: false, sidebarWidth: 300, panelWidth: 600, fontSize: 14, collapsed: { a: true } };
    expect(await migrate?.(v1, 1)).toEqual({ sidebarVisible: false, fontSize: 14 });
    expect(await migrate?.({ sidebarWidth: 280, collapsed: {} }, 2)).toEqual({});
    expect(await migrate?.({ sidebarWidth: 360, fontSize: 15 }, 3)).toEqual({ fontSize: 15 });
    expect(await migrate?.(null, 3)).toEqual({});
  });

  it("a v3 store loads at the new default width; a width saved after that is kept", async () => {
    localStorage.setItem("code-foundry.ui", JSON.stringify({ state: { sidebarWidth: 360, fontSize: 15 }, version: 3 }));
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState()).toMatchObject({ sidebarWidth: SIDEBAR_DEFAULT, fontSize: 15 });
    useUiStore.getState().setSidebarWidth(410);
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().sidebarWidth).toBe(410);
    localStorage.clear();
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

  it("does not save the selection: the window always starts on HOME, the No project composer", () => {
    const saved = useUiStore.persist.getOptions().partialize?.(useUiStore.getState());
    expect(saved).not.toHaveProperty("selection");
    expect(HOME).toEqual({ kind: "compose", projectId: "", noProject: true });
    expect(useUiStore.getInitialState().selection).toEqual(HOME);
    expect(useUiStore.getInitialState().history).toEqual([HOME]);
    expect(useUiStore.getInitialState().historyIndex).toBe(0);
  });

  it("landing on HOME leaves the project picker closed", () => {
    expect(useUiStore.getInitialState().palette).toMatchObject({ open: false, page: "commands" });
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

  it("saves and loads the Archived section's collapsed state; collapsed by default and for a bad value", () => {
    expect(useUiStore.getInitialState().archivedCollapsed).toBe(true);
    const opts = useUiStore.persist.getOptions();
    const current = useUiStore.getState();
    useUiStore.setState({ archivedCollapsed: true });
    useUiStore.getState().toggleArchivedCollapsed();
    expect(useUiStore.getState().archivedCollapsed).toBe(false);
    expect(opts.partialize?.(useUiStore.getState())).toMatchObject({ archivedCollapsed: false });
    expect(opts.merge?.({ archivedCollapsed: false }, current).archivedCollapsed).toBe(false);
    expect(opts.merge?.({}, { ...current, archivedCollapsed: true }).archivedCollapsed).toBe(true);
    expect(opts.merge?.({ archivedCollapsed: 0 }, { ...current, archivedCollapsed: true }).archivedCollapsed).toBe(true);
    // Independent of Working.
    expect(opts.merge?.({ workingCollapsed: true }, { ...current, archivedCollapsed: true })).toMatchObject({ workingCollapsed: true, archivedCollapsed: true });
    useUiStore.getState().toggleArchivedCollapsed();
    expect(useUiStore.getState().archivedCollapsed).toBe(true);
  });

  it("saves and loads the Snoozed section's collapsed state; collapsed by default and for a bad value", () => {
    expect(useUiStore.getInitialState().snoozedCollapsed).toBe(true);
    const opts = useUiStore.persist.getOptions();
    const current = useUiStore.getState();
    useUiStore.setState({ snoozedCollapsed: true });
    useUiStore.getState().toggleSnoozedCollapsed();
    expect(useUiStore.getState().snoozedCollapsed).toBe(false);
    expect(opts.partialize?.(useUiStore.getState())).toMatchObject({ snoozedCollapsed: false });
    expect(opts.merge?.({ snoozedCollapsed: false }, current).snoozedCollapsed).toBe(false);
    expect(opts.merge?.({}, { ...current, snoozedCollapsed: true }).snoozedCollapsed).toBe(true);
    expect(opts.merge?.({ snoozedCollapsed: "no" }, { ...current, snoozedCollapsed: true }).snoozedCollapsed).toBe(true);
    // Independent of Working and Archived.
    expect(opts.merge?.({ archivedCollapsed: false, workingCollapsed: true }, { ...current, snoozedCollapsed: true })).toMatchObject({
      workingCollapsed: true,
      archivedCollapsed: false,
      snoozedCollapsed: true,
    });
    useUiStore.getState().toggleSnoozedCollapsed();
    expect(useUiStore.getState().snoozedCollapsed).toBe(true);
  });

  it("saves and loads the last Projects page; ignores a saved collapsedWorkspaces; defaults for a bad value", () => {
    expect(useUiStore.getInitialState().projectsLast).toBe("");
    const opts = useUiStore.persist.getOptions();
    const current = useUiStore.getState();
    expect(opts.partialize?.(current)).not.toHaveProperty("collapsedWorkspaces");
    const merged = opts.merge?.({ collapsedWorkspaces: ["b"], projectsLast: "project:repo-cf" }, current);
    expect(merged).toMatchObject({ projectsLast: "project:repo-cf" });
    expect(merged).not.toHaveProperty("collapsedWorkspaces");
    expect(opts.merge?.({ projectsLast: 3 }, { ...current, projectsLast: "" })).toMatchObject({ projectsLast: "" });
  });
});

describe("bottomMax and clampBottomHeight", () => {
  const cases: [string, number, number][] = [
    ["70% of the column", 1000, 700],
    ["floored", 784, 548],
    ["a short column keeps 160 for the content pane (plus the 12px gap)", 500, 500 - 160 - 12],
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
    return { prompt: s.promptFocusSeq, sidebar: s.sidebarFocusSeq, panel: s.panelFocusSeq, bottom: s.bottomFocusSeq, content: s.contentFocusSeq };
  };
  const cases: [FocusRegion, string][] = [
    ["sidebar", "sidebar"],
    ["panel", "panel"],
    ["bottom", "bottom"],
    ["content", "content"],
  ];
  it.each(cases)("returns focus to %s", (returnTo, bumped) => {
    useUiStore.setState({ promptFocusSeq: 0, sidebarFocusSeq: 0, panelFocusSeq: 0, bottomFocusSeq: 0, contentFocusSeq: 0, palette: { open: true, query: "", commandName: null, page: "commands", returnTo } });
    useUiStore.getState().closePalette();
    const want = { prompt: 0, sidebar: 0, panel: 0, bottom: 0, content: 0, [bumped]: 1 };
    expect(seqs()).toEqual(want);
    expect(useUiStore.getState().palette.open).toBe(false);
  });
});

describe("viewNames", () => {
  it("has no dashboard: a ShowView of it is an unknown name, ignored", () => {
    expect(viewNames).toEqual(["pullrequests", "projects", "ember"]);
  });
});
