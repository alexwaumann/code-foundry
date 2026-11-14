import { describe, expect, it } from "vitest";
import { HOME, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, sidebarWidthAt, viewNames, useUiStore, type FocusRegion } from "./ui";

describe("ui persistence", () => {
  it("migrating drops the old global panelWidth, the tree's collapsed rows and the sidebar width saved before v4, and keeps the rest", async () => {
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
    ["a width saved under the old 220 minimum is raised", { sidebarWidth: 220 }, SIDEBAR_MIN],
    ["a width above the maximum is lowered", { sidebarWidth: 900 }, SIDEBAR_MAX],
    ["a width inside the bounds is kept, rounded", { sidebarWidth: 300.4 }, 300],
    ["the old default 260, at least the new minimum, is kept", { sidebarWidth: 260 }, 260],
    ["no saved width keeps the default", { fontSize: 14 }, SIDEBAR_DEFAULT],
    ["nothing saved keeps the default", undefined, SIDEBAR_DEFAULT],
  ];
  it.each(widths)("loading: %s", (_name, persisted, want) => {
    const merge = useUiStore.persist.getOptions().merge;
    const current = { ...useUiStore.getState(), sidebarWidth: SIDEBAR_DEFAULT };
    expect(merge?.(persisted, current).sidebarWidth).toBe(want);
  });

  it("the minimum and default line the sidebar up with the top bar's toggle: 80 + 12 + 108 + 12 + 28", () => {
    expect(SIDEBAR_MIN).toBe(240);
    expect(SIDEBAR_DEFAULT).toBe(SIDEBAR_MIN);
  });

  it.each<[string, number, number, number]>([
    ["at the minimum, at 100%: the toggle's edge", SIDEBAR_MIN, 100, 240],
    ["at the minimum, zoomed in: the toggle's edge (the lights' gutter narrows in layout px)", SIDEBAR_MIN, 125, 64 + 160],
    ["at the minimum, zoomed out", SIDEBAR_MIN, 90, 89 + 160],
    ["wider than the minimum: kept", 300, 90, 300],
    ["wider at 100% but under the toggle's edge zoomed out: the toggle's edge", 245, 80, 100 + 160],
  ])("drawn: %s", (_name, stored, zoom, want) => {
    expect(sidebarWidthAt(stored, zoom)).toBe(want);
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

  it("ignores what older builds saved for the classic window: the last Projects page, collapsedWorkspaces", () => {
    const opts = useUiStore.persist.getOptions();
    const current = useUiStore.getState();
    expect(opts.partialize?.(current)).not.toHaveProperty("collapsedWorkspaces");
    expect(opts.partialize?.(current)).not.toHaveProperty("projectsLast");
    const merged = opts.merge?.({ collapsedWorkspaces: ["b"], projectsLast: "project:repo-cf" }, current);
    expect(merged).not.toHaveProperty("collapsedWorkspaces");
    expect(merged).not.toHaveProperty("projectsLast");
  });
});

describe("closePalette", () => {
  const seqs = (): Record<string, number> => {
    const s = useUiStore.getState();
    return { prompt: s.promptFocusSeq, sidebar: s.sidebarFocusSeq, content: s.contentFocusSeq };
  };
  const cases: [FocusRegion, string][] = [
    ["sidebar", "sidebar"],
    ["content", "content"],
  ];
  it.each(cases)("returns focus to %s", (returnTo, bumped) => {
    useUiStore.setState({ promptFocusSeq: 0, sidebarFocusSeq: 0, contentFocusSeq: 0, palette: { open: true, query: "", commandName: null, page: "commands", returnTo } });
    useUiStore.getState().closePalette();
    const want = { prompt: 0, sidebar: 0, content: 0, [bumped]: 1 };
    expect(seqs()).toEqual(want);
    expect(useUiStore.getState().palette.open).toBe(false);
  });
});

describe("viewNames", () => {
  it("has no dashboard: a ShowView of it is an unknown name, ignored", () => {
    expect(viewNames).toEqual(["pullrequests", "projects", "ember"]);
  });
});
