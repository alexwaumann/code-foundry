import { beforeEach, describe, expect, it } from "vitest";
import {
  activateTab,
  closeTab,
  emptyEntry,
  expandPanel,
  getPanel,
  keyOf,
  makeTab,
  openSurface,
  openTab,
  resetPanelWidth,
  setExpanded,
  setPanelWidth,
  setWidth,
  tabId,
  toggle,
  togglePanel,
  usePanelStore,
  type PanelEntry,
} from "./panel";
import { PANEL_MIN, panelMax, useUiStore, type Selection } from "./ui";

const files = makeTab("files", "Files");
const diff = makeTab("diff", "Diff");
const pr = makeTab("pullrequest", "#12", { number: "12" });

function entry(open: boolean, tabs: PanelEntry["tabs"], activeTabId: string | null): PanelEntry {
  return { open, tabs, activeTabId };
}

describe("keyOf", () => {
  const cases: [string, Selection, string | null][] = [
    ["none has no panel", { kind: "none" }, null],
    ["session", { kind: "session", id: "s-1" }, "session:s-1"],
    ["terminal", { kind: "terminal", id: "t-1" }, "terminal:t-1"],
    ["repo", { kind: "repo", repoId: "r-1" }, "repo:r-1"],
    ["worktree", { kind: "worktree", repoId: "r-1", path: "/src/app-wt" }, "worktree:r-1:/src/app-wt"],
    ["view", { kind: "view", name: "pullrequests" }, "view:pullrequests"],
  ];
  it.each(cases)("%s", (_name, sel, want) => {
    expect(keyOf(sel)).toBe(want);
  });
});

describe("tabId", () => {
  const cases: [string, Parameters<typeof tabId>, string][] = [
    ["kind alone", ["files", {}], "files"],
    ["params default", ["diff"], "diff"],
    ["one param", ["pullrequest", { number: "12" }], "pullrequest?number=12"],
    ["params sorted", ["pullrequest", { repo: "a/b", number: "1" }], "pullrequest?number=1&repo=a%2Fb"],
  ];
  it.each(cases)("%s", (_name, args, want) => {
    expect(tabId(...args)).toBe(want);
  });

  it("is the same for equal params in any order", () => {
    expect(tabId("pullrequest", { a: "1", b: "2" })).toBe(tabId("pullrequest", { b: "2", a: "1" }));
  });
});

describe("openTab", () => {
  const cases: [string, PanelEntry, PanelEntry["tabs"][number], PanelEntry][] = [
    ["first tab opens the panel", emptyEntry, files, entry(true, [files], files.id)],
    ["appends and activates", entry(true, [files], files.id), diff, entry(true, [files, diff], diff.id)],
    ["existing tab is activated, not duplicated", entry(true, [files, diff], diff.id), makeTab("files", "Files"), entry(true, [files, diff], files.id)],
    ["reopens a hidden panel with its tabs", entry(false, [files, diff], diff.id), files, entry(true, [files, diff], files.id)],
    ["refreshes the title of an existing tab", entry(true, [pr], pr.id), makeTab("pullrequest", "#12 Fix", { number: "12" }), entry(true, [{ ...pr, title: "#12 Fix" }], pr.id)],
  ];
  it.each(cases)("%s", (_name, before, tab, want) => {
    expect(openTab(before, tab)).toEqual(want);
  });
});

describe("closeTab", () => {
  const three = [files, diff, pr];
  const cases: [string, PanelEntry, string, PanelEntry][] = [
    ["last tab hides the panel", entry(true, [files], files.id), files.id, entry(false, [], null)],
    ["active middle tab activates the right neighbour", entry(true, three, diff.id), diff.id, entry(true, [files, pr], pr.id)],
    ["active last tab activates the left neighbour", entry(true, three, pr.id), pr.id, entry(true, [files, diff], diff.id)],
    ["active first tab activates the right neighbour", entry(true, three, files.id), files.id, entry(true, [diff, pr], diff.id)],
    ["inactive tab keeps the active one", entry(true, three, files.id), pr.id, entry(true, [files, diff], files.id)],
    ["unknown id changes nothing", entry(true, [files], files.id), "nope", entry(true, [files], files.id)],
  ];
  it.each(cases)("%s", (_name, before, id, want) => {
    expect(closeTab(before, id)).toEqual(want);
  });

  it("returns the same entry for an unknown id", () => {
    const e = entry(true, [files], files.id);
    expect(closeTab(e, "nope")).toBe(e);
  });
});

describe("activateTab", () => {
  const cases: [string, PanelEntry, string, PanelEntry][] = [
    ["switches the active tab", entry(true, [files, diff], files.id), diff.id, entry(true, [files, diff], diff.id)],
    ["unknown id changes nothing", entry(true, [files], files.id), "nope", entry(true, [files], files.id)],
    ["already active changes nothing", entry(true, [files], files.id), files.id, entry(true, [files], files.id)],
  ];
  it.each(cases)("%s", (_name, before, id, want) => {
    expect(activateTab(before, id)).toEqual(want);
  });
});

describe("toggle", () => {
  const cases: [string, PanelEntry, boolean | undefined, boolean][] = [
    ["flips closed to open", emptyEntry, undefined, true],
    ["flips open to closed", entry(true, [], null), undefined, false],
    ["forces open", entry(true, [], null), true, true],
    ["forces closed", emptyEntry, false, false],
  ];
  it.each(cases)("%s", (_name, before, open, want) => {
    expect(toggle(before, open).open).toBe(want);
  });

  it("keeps tabs when hiding", () => {
    expect(toggle(entry(true, [files], files.id))).toEqual(entry(false, [files], files.id));
  });
});

describe("width", () => {
  const sized: PanelEntry = { ...entry(true, [files], files.id), width: 500 };
  const cases: [string, PanelEntry, number | undefined, PanelEntry][] = [
    ["sets a width", entry(true, [files], files.id), 500, sized],
    ["changes it", sized, 600, { ...sized, width: 600 }],
    ["undefined drops it (back to the default)", sized, undefined, entry(true, [files], files.id)],
  ];
  it.each(cases)("setWidth %s", (_name, before, w, want) => {
    expect(setWidth(before, w)).toEqual(want);
  });

  it("setWidth returns the same entry when nothing changes", () => {
    expect(setWidth(sized, 500)).toBe(sized);
    expect(setWidth(emptyEntry, undefined)).toBe(emptyEntry);
  });

  it("survives the other reducers, including closing the last tab and reopening", () => {
    const closed = closeTab(sized, files.id);
    expect(closed).toEqual({ ...entry(false, [], null), width: 500 });
    expect(openTab(closed, diff).width).toBe(500);
    expect(toggle(sized).width).toBe(500);
    expect(activateTab({ ...sized, tabs: [files, diff] }, diff.id).width).toBe(500);
  });
});

describe("expanded", () => {
  const open = entry(true, [files], files.id);
  const expanded: PanelEntry = { ...open, expanded: true };
  const cases: [string, PanelEntry, boolean | undefined, PanelEntry][] = [
    ["flips a split panel to expanded", open, undefined, expanded],
    ["flips an expanded panel back (the key is dropped)", expanded, undefined, open],
    ["forces expanded", open, true, expanded],
    ["forces the split", expanded, false, open],
    ["leaves the open state alone", emptyEntry, true, { ...emptyEntry, expanded: true }],
  ];
  it.each(cases)("setExpanded %s", (_name, before, x, want) => {
    expect(setExpanded(before, x)).toEqual(want);
  });

  it("setExpanded returns the same entry when nothing changes", () => {
    expect(setExpanded(expanded, true)).toBe(expanded);
    expect(setExpanded(open, false)).toBe(open);
  });

  it("survives the other reducers: hiding, closing the last tab, reopening, resizing", () => {
    expect(toggle(expanded)).toEqual({ ...entry(false, [files], files.id), expanded: true });
    const closed = closeTab(expanded, files.id);
    expect(closed).toEqual({ ...entry(false, [], null), expanded: true });
    expect(openTab(closed, diff).expanded).toBe(true);
    expect(activateTab({ ...expanded, tabs: [files, diff] }, diff.id).expanded).toBe(true);
    expect(setWidth(expanded, 500)).toEqual({ ...expanded, width: 500 });
    expect(setWidth({ ...expanded, width: 500 }, undefined)).toEqual(expanded);
  });
});

describe("panel store", () => {
  beforeEach(() => {
    usePanelStore.setState({ byKey: {} });
    useUiStore.setState({ selection: { kind: "session", id: "a" }, focus: "content", panelFocusSeq: 0, windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260 });
  });

  it("setPanelWidth sizes one panel, clamped to the current window and sidebar", () => {
    setPanelWidth("current", 500);
    expect(getPanel("session:a").width).toBe(500);
    expect(getPanel("session:b")).not.toHaveProperty("width");
    setPanelWidth("session:b", 2000);
    expect(getPanel("session:b").width).toBe(panelMax(1400, 260));
    useUiStore.setState({ sidebarVisible: false });
    setPanelWidth("session:b", 2000);
    expect(getPanel("session:b").width).toBe(840);
    setPanelWidth("session:b", 10);
    expect(getPanel("session:b").width).toBe(PANEL_MIN);
    expect(getPanel("session:a").width).toBe(500);
    // Sizing does not open the panel.
    expect(getPanel("session:b").open).toBe(false);
  });

  it("resetPanelWidth drops one panel's width", () => {
    setPanelWidth("session:a", 500);
    setPanelWidth("session:b", 600);
    resetPanelWidth("session:a");
    expect(getPanel("session:a")).not.toHaveProperty("width");
    expect(getPanel("session:b").width).toBe(600);
  });

  it("a window resize does not change stored widths", () => {
    setPanelWidth("current", 700);
    useUiStore.getState().setWindowWidth(1000);
    expect(getPanel().width).toBe(700);
  });

  it("is persisted whole and comes back on rehydrate", async () => {
    expect(usePanelStore.persist.getOptions().name).toBe("code-foundry.panel");
    openSurface("current", pr);
    setPanelWidth("current", 500);
    expandPanel("current", true);
    const saved = localStorage.getItem("code-foundry.panel");
    expect(saved).not.toBeNull();
    usePanelStore.setState({ byKey: {} });
    localStorage.setItem("code-foundry.panel", saved ?? "");
    await usePanelStore.persist.rehydrate();
    expect(getPanel("session:a")).toEqual({ ...entry(true, [pr], pr.id), width: 500, expanded: true });
  });

  it("keeps state per selection", () => {
    expect(togglePanel()).toBe(true);
    useUiStore.getState().select({ kind: "session", id: "b" });
    expect(getPanel().open).toBe(false);
    expect(getPanel("session:a").open).toBe(true);
  });

  it("does nothing with nothing selected", () => {
    useUiStore.getState().select({ kind: "none" });
    expect(togglePanel()).toBe(false);
    expect(openSurface("current", files)).toBe(false);
    expect(usePanelStore.getState().byKey).toEqual({});
  });

  it("openSurface opens another selection's panel by key, without a focus request", () => {
    expect(openSurface("worktree:r:/p", diff)).toBe(true);
    expect(getPanel("worktree:r:/p")).toEqual(entry(true, [diff], diff.id));
    expect(getPanel().open).toBe(false);
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
  });

  it("expandPanel shows a hidden panel expanded, flips per key, and keeps it when hidden", () => {
    expect(expandPanel("current", true)).toBe(true);
    expect(getPanel("session:a")).toEqual({ ...emptyEntry, open: true, expanded: true });
    expect(getPanel("session:b")).toEqual(emptyEntry);
    // Hiding keeps it; showing brings the panel back expanded.
    togglePanel("current", false);
    expect(getPanel()).toEqual({ ...emptyEntry, expanded: true });
    togglePanel("current", true);
    expect(getPanel()).toEqual({ ...emptyEntry, open: true, expanded: true });
    // Flipping restores the split without hiding.
    expect(expandPanel()).toBe(false);
    expect(getPanel()).toEqual({ ...emptyEntry, open: true });
    // Restoring a hidden panel does not show it.
    expect(expandPanel("session:b", false)).toBe(false);
    expect(getPanel("session:b")).toEqual(emptyEntry);
  });

  it("expandPanel asks for focus only when told to and only when it expands", () => {
    expandPanel("current", true);
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
    expandPanel("current", false, { focus: true });
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
    expandPanel("current", true, { focus: true });
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
  });

  it("expandPanel does nothing with nothing selected", () => {
    useUiStore.getState().select({ kind: "none" });
    expect(expandPanel("current", true, { focus: true })).toBe(false);
    expect(usePanelStore.getState().byKey).toEqual({});
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
  });

  it("showing asks for focus unless told not to; hiding never does", () => {
    togglePanel();
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
    togglePanel();
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
    togglePanel("current", true, { focus: false });
    expect(getPanel().open).toBe(true);
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
  });
});
