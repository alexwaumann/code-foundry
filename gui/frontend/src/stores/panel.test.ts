import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateTab,
  closePanelTab,
  closeTab,
  emptyEntry,
  emptyGroup,
  expandPanel,
  getPanel,
  isPicking,
  keyOf,
  makeTab,
  migratePanelV1,
  migratePanelV2,
  migratePanelV3,
  movePanelTab,
  moveTab,
  openSurface,
  openTab,
  resetPanelWidth,
  sanitizePanelState,
  setExpanded,
  setPanelWidth,
  setWidth,
  startPanelPicking,
  startPicking,
  stopPanelPicking,
  stopPicking,
  tabId,
  toggle,
  togglePanel,
  usePanelStore,
  type PanelEntry,
  type PanelEntryV2,
  type Tab,
} from "./panel";
import { KEYS, useSettingsStore } from "./settings";
import { PANEL_MIN, panelMax, useUiStore, type Selection } from "./ui";

const files = makeTab("files", "Files");
const diff = makeTab("diff", "Diff");
const pr = makeTab("pullrequest", "#12", { number: "12" });

/** An unsplit panel. */
function entry(open: boolean, tabs: readonly Tab[], activeTabId: string | null): PanelEntry {
  return { open, groups: [{ tabs, activeTabId }] };
}

/** An unsplit panel picking (activeTabId null) that came from `pickFrom`. */
function picking(tabs: readonly Tab[], pickFrom: string): PanelEntry {
  return { open: true, groups: [{ tabs, activeTabId: null, pickFrom }] };
}

/** A stored entry of versions 1 and 2 (one flat tab list). */
function legacy(open: boolean, tabs: readonly Tab[], activeTabId: string | null, pickFrom?: string): PanelEntryV2 {
  return { open, tabs, activeTabId, ...(pickFrom === undefined ? {} : { pickFrom }) };
}

describe("keyOf", () => {
  const cases: [string, Selection, string | null][] = [
    ["none has no panel", { kind: "none" }, null],
    ["HOME (the No project composer)", { kind: "compose", projectId: "", noProject: true }, "compose:home:"],
    ["thread", { kind: "thread", id: "s-1" }, "thread:s-1"],
    ["composer", { kind: "compose", projectId: "r-1" }, "compose:r-1"],
    ["workspace composer", { kind: "compose", projectId: "r-1", workspaceId: "w-1" }, "compose:ws:w-1"],
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

describe("migratePanelV1", () => {
  const old = { id: "worktree?path=%2Fsrc%2Fweb&repo=web", kind: "worktree", title: "web", params: { repo: "web", path: "/src/web" } };
  const renamed = makeTab("worktree", "web", { project: "web", path: "/src/web" });

  it("renames a tab's repo param to project and moves the ids that pointed at it", () => {
    const got = migratePanelV1({
      "thread:s-1": legacy(true, [files, old], old.id),
      "view:projects": legacy(true, [old, diff], null, old.id),
      "thread:s-2": legacy(false, [files, pr], pr.id),
    });
    expect(renamed.id).toBe("worktree?path=%2Fsrc%2Fweb&project=web");
    expect(got["thread:s-1"]).toEqual(legacy(true, [files, renamed], renamed.id));
    expect(got["view:projects"]).toEqual(legacy(true, [renamed, diff], null, renamed.id));
    expect(got["thread:s-2"]).toEqual(legacy(false, [files, pr], pr.id));
  });

  it("rehydrates a version 1 store through it (and on: its Worktree tab is a Changes tab now)", async () => {
    localStorage.setItem("code-foundry.panel", JSON.stringify({ version: 1, state: { byKey: { "thread:s-1": legacy(true, [old], old.id) } } }));
    await usePanelStore.persist.rehydrate();
    const changes = makeTab("changes", "Changes · web", { project: "web", path: "/src/web" });
    expect(getPanel("thread:s-1")).toEqual(entry(true, [changes], changes.id));
    localStorage.clear();
    usePanelStore.setState({ byKey: {} });
  });
});

describe("migratePanelV2", () => {
  const cases: [string, PanelEntryV2, PanelEntry][] = [
    ["an open panel with an active tab", legacy(true, [files, diff], diff.id), entry(true, [files, diff], diff.id)],
    ["a picking panel keeps pickFrom in its group", legacy(true, [files, diff], null, diff.id), picking([files, diff], diff.id)],
    ["a panel without tabs is the empty one", legacy(false, [], null), emptyEntry],
    ["a kept-open panel without tabs", legacy(true, [], null), { ...emptyEntry, open: true }],
    ["width and expanded stay on the entry", { ...legacy(false, [pr], pr.id), width: 500, expanded: true }, { ...entry(false, [pr], pr.id), width: 500, expanded: true }],
  ];
  it.each(cases)("%s", (_name, before, want) => {
    expect(migratePanelV2({ k: before })).toEqual({ k: want });
  });

  it("migrates every key", () => {
    expect(migratePanelV2({ a: legacy(true, [files], files.id), b: legacy(false, [], null) })).toEqual({ a: entry(true, [files], files.id), b: emptyEntry });
  });

  it("rehydrates a version 2 store through it and saves it as version 4", async () => {
    localStorage.setItem("code-foundry.panel", JSON.stringify({ version: 2, state: { byKey: { "thread:s-1": { ...legacy(true, [files, diff], null, files.id), width: 500 } } } }));
    await usePanelStore.persist.rehydrate();
    expect(getPanel("thread:s-1")).toEqual({ ...picking([files, diff], files.id), width: 500 });
    expect(JSON.parse(localStorage.getItem("code-foundry.panel") ?? "{}")).toMatchObject({ version: 4, state: { byKey: { "thread:s-1": { groups: [{ pickFrom: files.id }] } } } });
    localStorage.clear();
    usePanelStore.setState({ byKey: {} });
  });
});

describe("migratePanelV3 (docs/notes/thread-header-crumb.md)", () => {
  const wt = makeTab("worktree", "web · cf/x", { project: "web", path: "/wt/web/cf-x" });
  const changes = makeTab("changes", "Changes · web · cf/x", { project: "web", path: "/wt/web/cf-x" });
  const folder = makeTab("worktree", "platform", { workspace: "w-1", path: "/ws/platform" });
  const usage = makeTab("usage", "Usage");
  const linked = makeTab("linkedprs", "Linked PRs");
  const threads = makeTab("threads", "Threads");
  const agents = makeTab("agents", "Agents");

  const cases: [string, PanelEntry, PanelEntry][] = [
    ["a worktree tab is its worktree's Changes tab, active still", entry(true, [files, wt], wt.id), entry(true, [files, changes], changes.id)],
    ["the removed surfaces' tabs go; the active one's place goes to the first left", entry(true, [usage, files, linked, threads, agents], agents.id), entry(true, [files], files.id)],
    ["a workspace folder's Worktree tab goes", entry(true, [folder, diff], diff.id), entry(true, [diff], diff.id)],
    ["nothing left: an empty group", entry(false, [usage, folder], usage.id), entry(false, [], null)],
    ["picking from a worktree tab picks from its Changes tab", picking([wt, files], wt.id), picking([changes, files], changes.id)],
    ["picking from a removed tab shows the first tab left", picking([usage, files], usage.id), entry(true, [files], files.id)],
    ["other tabs and the entry's fields stay", { ...entry(true, [pr, files], pr.id), width: 480, expanded: true }, { ...entry(true, [pr, files], pr.id), width: 480, expanded: true }],
    [
      "a split keeps both groups while each has a tab, its ratio and focus too",
      { open: true, groups: [{ tabs: [wt], activeTabId: wt.id }, { tabs: [files, usage], activeTabId: usage.id }], ratio: 0.4, focused: 1 },
      { open: true, groups: [{ tabs: [changes], activeTabId: changes.id }, { tabs: [files], activeTabId: files.id }], ratio: 0.4, focused: 1 },
    ],
    [
      "a split whose group emptied is one group, no ratio or focus",
      { open: true, groups: [{ tabs: [files], activeTabId: files.id }, { tabs: [threads, agents], activeTabId: threads.id }], ratio: 0.4, focused: 1 },
      entry(true, [files], files.id),
    ],
  ];
  it.each(cases)("%s", (_name, before, want) => {
    expect(migratePanelV3({ k: before })).toEqual({ k: want });
  });

  it("rehydrates a version 3 store through it and saves it as version 4", async () => {
    localStorage.setItem("code-foundry.panel", JSON.stringify({ version: 3, state: { byKey: { "thread:s-1": entry(true, [usage, wt], usage.id), "view:projects": entry(true, [wt], wt.id) } } }));
    await usePanelStore.persist.rehydrate();
    expect(getPanel("thread:s-1")).toEqual(entry(true, [changes], changes.id));
    expect(getPanel("view:projects")).toEqual(entry(true, [changes], changes.id));
    expect(JSON.parse(localStorage.getItem("code-foundry.panel") ?? "{}")).toMatchObject({ version: 4 });
    localStorage.clear();
    usePanelStore.setState({ byKey: {} });
  });
});

describe("sanitizePanelState", () => {
  it("repairs groups without a tabs array (a version 3 store rewritten by an older build)", () => {
    expect(sanitizePanelState({ "view:projects": { open: true, width: 420, groups: [{}] }, "thread:s-1": { open: true, groups: [{}], width: 765, focused: 1 } })).toEqual({
      "view:projects": { open: true, width: 420, groups: [emptyGroup] },
      "thread:s-1": { open: true, groups: [emptyGroup], width: 765 },
    });
  });

  it("keeps a sound entry as it is, split and picking included", () => {
    const split: PanelEntry = { open: true, groups: [{ tabs: [files], activeTabId: files.id }, { tabs: [diff, pr], activeTabId: null, pickFrom: pr.id }], ratio: 0.3, focused: 1, width: 600, expanded: true };
    expect(sanitizePanelState({ k: split })).toEqual({ k: split });
  });

  it("takes a version 2 shape that still carries groups from the groups, else from the flat list", () => {
    expect(sanitizePanelState({ a: { ...legacy(true, [], null), groups: [{ tabs: [files], activeTabId: files.id }] }, b: legacy(true, [files, diff], null, diff.id) })).toEqual({
      a: entry(true, [files], files.id),
      b: picking([files, diff], diff.id),
    });
  });

  it("drops what it cannot use: junk entries, malformed tabs, an active tab that is not there, a pickFrom with an active tab, a bad ratio or focus", () => {
    expect(
      sanitizePanelState({
        junk: 7,
        list: [],
        k: { open: "yes", groups: [{ tabs: [files, { id: 1 }, { id: "x", kind: "y", title: "t", params: { a: 1, b: "c" } }], activeTabId: "gone", pickFrom: files.id }], ratio: 3, focused: 1, width: "wide" },
        extra: { open: true, groups: [{ tabs: [files], activeTabId: files.id }, { tabs: [diff], activeTabId: diff.id }, { tabs: [pr], activeTabId: pr.id }] },
      }),
    ).toEqual({
      k: { open: false, groups: [{ tabs: [files, { id: "x", kind: "y", title: "t", params: { b: "c" } }], activeTabId: null, pickFrom: files.id }] },
      extra: { open: true, groups: [{ tabs: [files], activeTabId: files.id }, { tabs: [diff], activeTabId: diff.id }] },
    });
    expect(sanitizePanelState(null)).toEqual({});
  });

  it("rehydrates a broken version 3 store without throwing, and a store from a newer version through the repair", async () => {
    localStorage.setItem("code-foundry.panel", JSON.stringify({ version: 3, state: { byKey: { "view:projects": { open: true, groups: [{}] } } } }));
    await usePanelStore.persist.rehydrate();
    expect(getPanel("view:projects")).toEqual({ open: true, groups: [emptyGroup] });
    localStorage.setItem("code-foundry.panel", JSON.stringify({ version: 9, state: { byKey: { "thread:s-2": { open: true, groups: [{ tabs: [files], activeTabId: files.id, future: 1 }], future: true } } } }));
    await usePanelStore.persist.rehydrate();
    expect(getPanel("thread:s-2")).toEqual(entry(true, [files], files.id));
    localStorage.clear();
    usePanelStore.setState({ byKey: {} });
  });
});

describe("openTab", () => {
  const cases: [string, PanelEntry, Tab, PanelEntry][] = [
    ["first tab opens the panel", emptyEntry, files, entry(true, [files], files.id)],
    ["appends and activates", entry(true, [files], files.id), diff, entry(true, [files, diff], diff.id)],
    ["existing tab is activated, not duplicated", entry(true, [files, diff], diff.id), makeTab("files", "Files"), entry(true, [files, diff], files.id)],
    ["reopens a hidden panel with its tabs", entry(false, [files, diff], diff.id), files, entry(true, [files, diff], files.id)],
    ["refreshes the title of an existing tab", entry(true, [pr], pr.id), makeTab("pullrequest", "#12 Fix", { number: "12" }), entry(true, [{ ...pr, title: "#12 Fix" }], pr.id)],
    [
      "refreshes params its id leaves out",
      entry(true, [files, { ...files, id: "files?path=a", params: { path: "a", line: "3" } }], files.id),
      { ...files, id: "files?path=a", params: { path: "a", line: "9" } },
      entry(true, [files, { ...files, id: "files?path=a", params: { path: "a", line: "9" } }], "files?path=a"),
    ],
    ["picking a new surface appends it and ends picking", picking([files], files.id), diff, entry(true, [files, diff], diff.id)],
    ["picking an open surface activates it and ends picking", picking([files, diff], diff.id), makeTab("files", "Files"), entry(true, [files, diff], files.id)],
  ];
  it.each(cases)("%s", (_name, before, tab, want) => {
    expect(openTab(before, tab)).toEqual(want);
  });
});

describe("closeTab", () => {
  const three = [files, diff, pr];
  // Closing with keepOpen off (the default); keepOpenCases below has the same entries with it on.
  const cases: [string, PanelEntry, string, PanelEntry][] = [
    ["last tab hides the panel", entry(true, [files], files.id), files.id, entry(false, [], null)],
    ["active middle tab activates the right neighbour", entry(true, three, diff.id), diff.id, entry(true, [files, pr], pr.id)],
    ["active last tab activates the left neighbour", entry(true, three, pr.id), pr.id, entry(true, [files, diff], diff.id)],
    ["active first tab activates the right neighbour", entry(true, three, files.id), files.id, entry(true, [diff, pr], diff.id)],
    ["inactive tab keeps the active one", entry(true, three, files.id), pr.id, entry(true, [files, diff], files.id)],
    ["unknown id changes nothing", entry(true, [files], files.id), "nope", entry(true, [files], files.id)],
    ["picking: another tab keeps picking and pickFrom", picking(three, files.id), pr.id, picking([files, diff], files.id)],
    ["picking: the pickFrom tab moves pickFrom to its right neighbour", picking(three, diff.id), diff.id, picking([files, pr], pr.id)],
    ["picking: the last pickFrom tab moves pickFrom to its left neighbour", picking(three, pr.id), pr.id, picking([files, diff], diff.id)],
    ["picking: the last tab hides the panel and ends picking", picking([files], files.id), files.id, entry(false, [], null)],
  ];
  it.each(cases)("%s", (_name, before, id, want) => {
    expect(closeTab(before, id)).toEqual(want);
    expect(closeTab(before, id, false)).toEqual(want);
  });

  // appearance.panel_keep_open: only closing the last tab differs.
  const keepOpenCases: [string, PanelEntry, string, PanelEntry][] = [
    ["last tab leaves the panel open with no tabs (the surface list)", entry(true, [files], files.id), files.id, entry(true, [], null)],
    ["last tab keeps width and expanded", { ...entry(true, [files], files.id), width: 500, expanded: true }, files.id, { ...entry(true, [], null), width: 500, expanded: true }],
    ["last tab of a hidden panel leaves it hidden", entry(false, [files], files.id), files.id, entry(false, [], null)],
    ["active middle tab activates the right neighbour", entry(true, three, diff.id), diff.id, entry(true, [files, pr], pr.id)],
    ["inactive tab keeps the active one", entry(true, three, files.id), pr.id, entry(true, [files, diff], files.id)],
    ["unknown id changes nothing", entry(true, [files], files.id), "nope", entry(true, [files], files.id)],
    ["picking: another tab keeps picking and pickFrom", picking(three, files.id), pr.id, picking([files, diff], files.id)],
    ["picking: the pickFrom tab moves pickFrom to its right neighbour", picking(three, diff.id), diff.id, picking([files, pr], pr.id)],
    ["picking: the last tab ends picking and leaves the panel open with no tabs", picking([files], files.id), files.id, entry(true, [], null)],
  ];
  it.each(keepOpenCases)("keepOpen: %s", (_name, before, id, want) => {
    expect(closeTab(before, id, true)).toEqual(want);
  });

  it.each([false, true])("returns the same entry for an unknown id (keepOpen %s)", (keepOpen) => {
    const e = entry(true, [files], files.id);
    expect(closeTab(e, "nope", keepOpen)).toBe(e);
  });
});

describe("moveTab", () => {
  const three = [files, diff, pr];
  const cases: [string, PanelEntry, string, number, PanelEntry][] = [
    ["first to last", entry(true, three, files.id), files.id, 2, entry(true, [diff, pr, files], files.id)],
    ["last to first", entry(true, three, files.id), pr.id, 0, entry(true, [pr, files, diff], files.id)],
    ["one slot right", entry(true, three, diff.id), files.id, 1, entry(true, [diff, files, pr], diff.id)],
    ["one slot left", entry(true, three, diff.id), pr.id, 1, entry(true, [files, pr, diff], diff.id)],
    ["past the end clamps to last", entry(true, three, files.id), files.id, 9, entry(true, [diff, pr, files], files.id)],
    ["Infinity clamps to last", entry(true, three, files.id), diff.id, Infinity, entry(true, [files, pr, diff], files.id)],
    ["before the start clamps to first", entry(true, three, files.id), pr.id, -3, entry(true, [pr, files, diff], files.id)],
    ["a fraction truncates", entry(true, three, files.id), files.id, 1.7, entry(true, [diff, files, pr], files.id)],
    ["same index changes nothing", entry(true, three, files.id), diff.id, 1, entry(true, three, files.id)],
    ["clamped to the same index changes nothing", entry(true, three, files.id), pr.id, 5, entry(true, three, files.id)],
    ["unknown id changes nothing", entry(true, three, files.id), "nope", 0, entry(true, three, files.id)],
    ["NaN changes nothing", entry(true, three, files.id), files.id, NaN, entry(true, three, files.id)],
    ["a single tab cannot move", entry(true, [files], files.id), files.id, 1, entry(true, [files], files.id)],
    ["a hidden panel keeps hidden", entry(false, three, pr.id), pr.id, 0, entry(false, [pr, files, diff], pr.id)],
    ["picking keeps picking and pickFrom", picking(three, diff.id), diff.id, 0, picking([diff, files, pr], diff.id)],
    ["width and expanded are kept", { ...entry(true, three, files.id), width: 500, expanded: true }, files.id, 2, { ...entry(true, [diff, pr, files], files.id), width: 500, expanded: true }],
  ];
  it.each(cases)("%s", (_name, before, id, to, want) => {
    expect(moveTab(before, id, to)).toEqual(want);
  });

  it.each<[string, string, number]>([
    ["unknown id", "nope", 0],
    ["same index", diff.id, 1],
    ["clamped to the same index", files.id, -1],
  ])("returns the same entry for %s", (_name, id, to) => {
    const e = entry(true, three, files.id);
    expect(moveTab(e, id, to)).toBe(e);
  });

  it("does not mutate the entry's tabs", () => {
    const tabs = [...three];
    const e = entry(true, tabs, files.id);
    moveTab(e, files.id, 2);
    expect(tabs).toEqual(three);
  });
});

describe("activateTab", () => {
  const cases: [string, PanelEntry, string, PanelEntry][] = [
    ["switches the active tab", entry(true, [files, diff], files.id), diff.id, entry(true, [files, diff], diff.id)],
    ["unknown id changes nothing", entry(true, [files], files.id), "nope", entry(true, [files], files.id)],
    ["already active changes nothing", entry(true, [files], files.id), files.id, entry(true, [files], files.id)],
    ["picking: any tab ends picking", picking([files, diff], files.id), diff.id, entry(true, [files, diff], diff.id)],
    ["picking: the pickFrom tab ends picking", picking([files, diff], files.id), files.id, entry(true, [files, diff], files.id)],
    ["picking: unknown id keeps picking", picking([files], files.id), "nope", picking([files], files.id)],
  ];
  it.each(cases)("%s", (_name, before, id, want) => {
    expect(activateTab(before, id)).toEqual(want);
  });
});

describe("picking", () => {
  const two = [files, diff];
  it.each<[string, PanelEntry, boolean]>([
    ["no tabs is not picking (the list shows anyway)", { ...emptyEntry, open: true }, false],
    ["an active tab is not picking", entry(true, two, diff.id), false],
    ["tabs and no active tab is picking", picking(two, diff.id), true],
    ["without pickFrom (an old entry) too", entry(true, two, null), true],
  ])("isPicking: %s", (_name, e, want) => {
    expect(isPicking(e)).toBe(want);
  });

  const startCases: [string, PanelEntry, PanelEntry][] = [
    ["remembers the active tab", entry(true, two, diff.id), picking(two, diff.id)],
    ["works on a hidden panel (the caller shows it)", entry(false, two, files.id), { ...picking(two, files.id), open: false }],
    ["keeps width and expanded", { ...entry(true, two, diff.id), width: 500, expanded: true }, { ...picking(two, diff.id), width: 500, expanded: true }],
  ];
  it.each(startCases)("startPicking %s", (_name, before, want) => {
    expect(startPicking(before)).toEqual(want);
  });

  it.each<[string, PanelEntry]>([
    ["no tabs", { ...emptyEntry, open: true }],
    ["already picking", picking(two, diff.id)],
  ])("startPicking returns the same entry with %s", (_name, e) => {
    expect(startPicking(e)).toBe(e);
  });

  const stopCases: [string, PanelEntry, PanelEntry][] = [
    ["goes back to pickFrom", picking(two, diff.id), entry(true, two, diff.id)],
    ["a missing pickFrom goes to the first tab", picking(two, "gone"), entry(true, two, files.id)],
    ["no pickFrom goes to the first tab", entry(true, two, null), entry(true, two, files.id)],
    ["keeps width and expanded", { ...picking(two, diff.id), width: 500, expanded: true }, { ...entry(true, two, diff.id), width: 500, expanded: true }],
  ];
  it.each(stopCases)("stopPicking %s", (_name, before, want) => {
    expect(stopPicking(before)).toEqual(want);
  });

  it.each<[string, PanelEntry]>([
    ["no tabs", { ...emptyEntry, open: true }],
    ["an active tab", entry(true, two, diff.id)],
  ])("stopPicking returns the same entry with %s", (_name, e) => {
    expect(stopPicking(e)).toBe(e);
  });

  it("round-trips: start then stop is where it began", () => {
    const e = entry(true, two, diff.id);
    expect(stopPicking(startPicking(e))).toEqual(e);
  });

  it("survives hiding and resizing", () => {
    const p = picking(two, diff.id);
    expect(toggle(p)).toEqual({ ...p, open: false });
    expect(setWidth(p, 500)).toEqual({ ...p, width: 500 });
    expect(setExpanded(p, true)).toEqual({ ...p, expanded: true });
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
    expect(activateTab({ ...sized, groups: [{ tabs: [files, diff], activeTabId: files.id }] }, diff.id).width).toBe(500);
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
    expect(activateTab({ ...expanded, groups: [{ tabs: [files, diff], activeTabId: files.id }] }, diff.id).expanded).toBe(true);
    expect(setWidth(expanded, 500)).toEqual({ ...expanded, width: 500 });
    expect(setWidth({ ...expanded, width: 500 }, undefined)).toEqual(expanded);
  });
});

describe("panel store", () => {
  beforeEach(() => {
    usePanelStore.setState({ byKey: {} });
    useUiStore.setState({ selection: { kind: "thread", id: "a" }, focus: "content", panelFocusSeq: 0, windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260 });
  });

  it("setPanelWidth sizes one panel, clamped to the current window and sidebar", () => {
    setPanelWidth("current", 500);
    expect(getPanel("thread:a").width).toBe(500);
    expect(getPanel("thread:b")).not.toHaveProperty("width");
    setPanelWidth("thread:b", 2000);
    expect(getPanel("thread:b").width).toBe(panelMax(1400, 260));
    useUiStore.setState({ sidebarVisible: false });
    setPanelWidth("thread:b", 2000);
    expect(getPanel("thread:b").width).toBe(840);
    setPanelWidth("thread:b", 10);
    expect(getPanel("thread:b").width).toBe(PANEL_MIN);
    expect(getPanel("thread:a").width).toBe(500);
    // Sizing does not open the panel.
    expect(getPanel("thread:b").open).toBe(false);
  });

  it("resetPanelWidth drops one panel's width", () => {
    setPanelWidth("thread:a", 500);
    setPanelWidth("thread:b", 600);
    resetPanelWidth("thread:a");
    expect(getPanel("thread:a")).not.toHaveProperty("width");
    expect(getPanel("thread:b").width).toBe(600);
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
    expect(getPanel("thread:a")).toEqual({ ...entry(true, [pr], pr.id), width: 500, expanded: true });
  });

  it("movePanelTab reorders one panel's tabs, and the order is persisted", async () => {
    openSurface("current", files);
    openSurface("current", diff);
    openSurface("current", pr);
    openSurface("thread:b", files);
    openSurface("thread:b", diff);
    movePanelTab("current", pr.id, 0);
    expect(getPanel()).toEqual(entry(true, [pr, files, diff], pr.id));
    expect(getPanel("thread:b").groups[0]?.tabs).toEqual([files, diff]);
    movePanelTab("thread:b", files.id, 1);
    expect(getPanel("thread:b").groups[0]?.tabs).toEqual([diff, files]);
    // No change, no new state (and no write).
    const before = usePanelStore.getState();
    movePanelTab("current", pr.id, 0);
    movePanelTab("current", "nope", 2);
    expect(usePanelStore.getState()).toBe(before);
    const saved = localStorage.getItem("code-foundry.panel") ?? "";
    usePanelStore.setState({ byKey: {} });
    localStorage.setItem("code-foundry.panel", saved);
    await usePanelStore.persist.rehydrate();
    expect(getPanel("thread:a").groups[0]?.tabs).toEqual([pr, files, diff]);
    expect(getPanel("thread:b").groups[0]?.tabs).toEqual([diff, files]);
  });

  it("movePanelTab does nothing with nothing selected", () => {
    useUiStore.getState().select({ kind: "none" });
    movePanelTab("current", files.id, 0);
    expect(usePanelStore.getState().byKey).toEqual({});
  });

  it("keeps state per selection", () => {
    expect(togglePanel()).toBe(true);
    useUiStore.getState().select({ kind: "thread", id: "b" });
    expect(getPanel().open).toBe(false);
    expect(getPanel("thread:a").open).toBe(true);
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
    expect(getPanel("thread:a")).toEqual({ ...emptyEntry, open: true, expanded: true });
    expect(getPanel("thread:b")).toEqual(emptyEntry);
    // Hiding keeps it; showing brings the panel back expanded.
    togglePanel("current", false);
    expect(getPanel()).toEqual({ ...emptyEntry, expanded: true });
    togglePanel("current", true);
    expect(getPanel()).toEqual({ ...emptyEntry, open: true, expanded: true });
    // Flipping restores the split without hiding.
    expect(expandPanel()).toBe(false);
    expect(getPanel()).toEqual({ ...emptyEntry, open: true });
    // Restoring a hidden panel does not show it.
    expect(expandPanel("thread:b", false)).toBe(false);
    expect(getPanel("thread:b")).toEqual(emptyEntry);
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

  it("startPanelPicking shows a hidden panel picking and asks for focus; stopPanelPicking goes back", () => {
    openSurface("current", files);
    openSurface("current", diff);
    togglePanel("current", false);
    expect(startPanelPicking()).toBe(true);
    expect(getPanel()).toEqual(picking([files, diff], diff.id));
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
    // Already picking: unchanged.
    expect(startPanelPicking("current", { focus: false })).toBe(true);
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
    stopPanelPicking();
    expect(getPanel()).toEqual(entry(true, [files, diff], diff.id));
    // Persisted like the rest (a reload keeps the picker).
    startPanelPicking("current", { focus: false });
    expect(JSON.parse(localStorage.getItem("code-foundry.panel") ?? "{}")).toMatchObject({ state: { byKey: { "thread:a": { groups: [{ activeTabId: null, pickFrom: diff.id }] } } } });
  });

  it("startPanelPicking without tabs only shows the panel; with nothing selected it does nothing", () => {
    expect(startPanelPicking()).toBe(true);
    expect(getPanel()).toEqual({ ...emptyEntry, open: true });
    useUiStore.getState().select({ kind: "none" });
    expect(startPanelPicking()).toBe(false);
  });

  describe("closePanelTab and appearance.panel_keep_open", () => {
    afterEach(() => {
      useSettingsStore.setState({ snapshot: null });
    });

    function withSetting(value: string | undefined): void {
      const values: Record<string, string> = value === undefined ? {} : { [KEYS.panelKeepOpen]: value };
      useSettingsStore.setState({ snapshot: { values, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
    }

    const cases: [string, string | undefined | null, boolean | undefined, boolean][] = [
      ["no snapshot yet hides", null, undefined, false],
      ["a snapshot without the key hides", undefined, undefined, false],
      ["the setting off hides", "false", undefined, false],
      ["the setting on keeps it open", "true", undefined, true],
      ["an explicit keepOpen wins over the setting off", "false", true, true],
      ["an explicit keepOpen false wins over the setting on", "true", false, false],
    ];
    it.each(cases)("closing the last tab: %s", (_name, setting, keepOpen, wantOpen) => {
      if (setting !== null) withSetting(setting);
      openSurface("current", files);
      closePanelTab("current", files.id, keepOpen === undefined ? {} : { keepOpen });
      expect(getPanel()).toEqual(entry(wantOpen, [], null));
    });

    it("is read when the tab closes, so a change applies at once", () => {
      openSurface("current", files);
      openSurface("current", diff);
      withSetting("true");
      closePanelTab("current", files.id);
      closePanelTab("current", diff.id);
      expect(getPanel()).toEqual(entry(true, [], null));
      withSetting("false");
      openSurface("current", files);
      closePanelTab("current", files.id);
      expect(getPanel()).toEqual(entry(false, [], null));
    });

    it("a kept panel still hides with togglePanel (cmd+w on no tabs)", () => {
      withSetting("true");
      openSurface("current", files);
      closePanelTab("current", files.id);
      expect(togglePanel("current", false)).toBe(false);
      expect(getPanel()).toEqual(entry(false, [], null));
    });
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
