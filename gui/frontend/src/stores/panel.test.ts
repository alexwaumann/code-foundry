import { beforeEach, describe, expect, it } from "vitest";
import {
  activateTab,
  closeTab,
  emptyEntry,
  getPanel,
  keyOf,
  makeTab,
  openSurface,
  openTab,
  tabId,
  toggle,
  togglePanel,
  togglePanelCommand,
  usePanelStore,
  type PanelEntry,
} from "./panel";
import { panelMax, PANEL_MIN, useUiStore, type Selection } from "./ui";

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

describe("panel store", () => {
  beforeEach(() => {
    usePanelStore.setState({ byKey: {}, focusSeq: 0 });
    useUiStore.setState({ selection: { kind: "session", id: "a" }, focus: "content", terminalFocusSeq: 0 });
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

  it("openSurface opens another selection's panel by key", () => {
    expect(openSurface("worktree:r:/p", diff)).toBe(true);
    expect(getPanel("worktree:r:/p")).toEqual(entry(true, [diff], diff.id));
    expect(getPanel().open).toBe(false);
  });

  it("toggling on asks for focus; hiding from the panel returns it to the terminal", () => {
    togglePanelCommand();
    expect(usePanelStore.getState().focusSeq).toBe(1);
    useUiStore.setState({ focus: "panel" });
    expect(togglePanelCommand()).toBe(false);
    expect(useUiStore.getState().terminalFocusSeq).toBe(1);
    expect(usePanelStore.getState().focusSeq).toBe(1);
  });
});

describe("panel width", () => {
  const cases: [string, number, number, number][] = [
    ["below the minimum", 100, 1400, PANEL_MIN],
    ["inside the bounds", 500.4, 1400, 500],
    ["above 60% of the window", 1000, 1400, 840],
    ["narrow window keeps the minimum", 400, 300, PANEL_MIN],
  ];
  it.each(cases)("%s", (_name, w, windowWidth, want) => {
    useUiStore.getState().setPanelWidth(w, windowWidth);
    expect(useUiStore.getState().panelWidth).toBe(want);
  });

  it("panelMax is 60% of the window", () => {
    expect(panelMax(1000)).toBe(600);
  });
});
