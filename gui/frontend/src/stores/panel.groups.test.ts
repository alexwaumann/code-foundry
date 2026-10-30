/** Tab groups (a split panel): the pure reducers, the store API and the selectors. See docs/notes/panel-split-1-store.md. */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activatePanelTab,
  activateTab,
  activeTab,
  allTabs,
  closePanelTab,
  closeTab,
  emptyEntry,
  emptyGroup,
  focusedGroup,
  focusGroup,
  focusPanelGroup,
  getPanel,
  groupOf,
  isPicking,
  isSplit,
  makeTab,
  movePanelTabToGroup,
  moveTab,
  moveTabToGroup,
  openSurface,
  openTab,
  retitlePanelTab,
  retitleTab,
  setExpanded,
  setPanelRatio,
  setRatio,
  setWidth,
  split,
  splitPanel,
  startPanelPicking,
  startPicking,
  stopPanelPicking,
  stopPicking,
  toggle,
  togglePanel,
  unsplit,
  unsplitPanel,
  usePanelFocusedGroup,
  usePanelGroup,
  usePanelPicking,
  usePanelRatio,
  usePanelSplit,
  usePanelStore,
  type GroupIndex,
  type PanelEntry,
  type PanelGroup,
  type Tab,
} from "./panel";
import { useUiStore } from "./ui";

const files = makeTab("files", "Files");
const diff = makeTab("diff", "Diff");
const pr = makeTab("pullrequest", "#12", { number: "12" });
const usage = makeTab("usage", "Usage");

function grp(tabs: readonly Tab[], activeTabId: string | null, pickFrom?: string): PanelGroup {
  return { tabs, activeTabId, ...(pickFrom === undefined ? {} : { pickFrom }) };
}

/** An open unsplit panel. */
function one(tabs: readonly Tab[], activeTabId: string | null, extra: Partial<PanelEntry> = {}): PanelEntry {
  return { open: true, groups: [grp(tabs, activeTabId)], ...extra };
}

/** An open split panel. */
function two(g0: PanelGroup, g1: PanelGroup, extra: Partial<PanelEntry> = {}): PanelEntry {
  return { open: true, groups: [g0, g1], ...extra };
}

describe("helpers", () => {
  const e = two(grp([files, diff], diff.id), grp([pr], pr.id), { focused: 1 });

  it("isSplit", () => {
    expect(isSplit(e)).toBe(true);
    expect(isSplit(one([files], files.id))).toBe(false);
    expect(isSplit(emptyEntry)).toBe(false);
  });

  it.each<[string, PanelEntry, GroupIndex]>([
    ["absent is 0", two(grp([files], files.id), grp([pr], pr.id)), 0],
    ["1 on a split panel", e, 1],
    ["1 on an unsplit panel reads 0", one([files], files.id, { focused: 1 }), 0],
  ])("focusedGroup: %s", (_name, x, want) => {
    expect(focusedGroup(x)).toBe(want);
  });

  it("groupOf finds the group holding a tab", () => {
    expect(groupOf(e, diff.id)).toBe(0);
    expect(groupOf(e, pr.id)).toBe(1);
    expect(groupOf(e, "nope")).toBeNull();
  });

  it("allTabs lists the first group's tabs, then the second's", () => {
    expect(allTabs(e)).toEqual([files, diff, pr]);
    expect(allTabs(emptyEntry)).toEqual([]);
  });

  it("activeTab is the focused group's by default, null while picking or empty", () => {
    expect(activeTab(e)).toEqual(pr);
    expect(activeTab(e, 0)).toEqual(diff);
    expect(activeTab(two(grp([files], files.id), emptyGroup, { focused: 1 }))).toBeNull();
    expect(activeTab(two(grp([files], null, files.id), grp([pr], pr.id)), 0)).toBeNull();
  });
});

describe("isPicking with groups", () => {
  it.each<[string, PanelEntry, GroupIndex | undefined, boolean]>([
    ["an empty second group is picking", two(grp([files], files.id), emptyGroup), 1, true],
    ["a group with an active tab is not", two(grp([files], files.id), emptyGroup), 0, false],
    ["the default is the focused group: the empty one", two(grp([files], files.id), emptyGroup, { focused: 1 }), undefined, true],
    ["the default is the focused group: the first", two(grp([files], files.id), emptyGroup), undefined, false],
    ["a second group with tabs and none active", two(grp([files], files.id), grp([pr, diff], null, pr.id)), 1, true],
    ["a group the panel does not have", one([files], files.id), 1, false],
    ["an unsplit panel without tabs is not", { ...emptyEntry, open: true }, 0, false],
  ])("%s", (_name, e, g, want) => {
    expect(isPicking(e, g)).toBe(want);
  });
});

describe("openTab with groups", () => {
  const cases: [string, PanelEntry, Tab, GroupIndex | undefined, PanelEntry][] = [
    ["a new tab goes to the focused group", two(grp([files], files.id), grp([pr], pr.id), { focused: 1 }), diff, undefined, two(grp([files], files.id), grp([pr, diff], diff.id), { focused: 1 })],
    ["a new tab goes to the given group, which takes focus", two(grp([files], files.id), grp([pr], pr.id), { focused: 1 }), diff, 0, two(grp([files, diff], diff.id), grp([pr], pr.id))],
    ["group 1 on an unsplit panel is group 0", one([files], files.id), diff, 1, one([files, diff], diff.id)],
    [
      "a tab open in the other group is activated there, not duplicated, and that group takes focus",
      two(grp([files, diff], files.id), grp([pr, usage], usage.id)),
      makeTab("pullrequest", "#12", { number: "12" }),
      0,
      two(grp([files, diff], files.id), grp([pr, usage], pr.id), { focused: 1 }),
    ],
    [
      "a tab open in the other group gets its new title there",
      two(grp([files], files.id), grp([pr], pr.id), { focused: 1 }),
      makeTab("pullrequest", "#12 Fix", { number: "12" }),
      undefined,
      two(grp([files], files.id), grp([{ ...pr, title: "#12 Fix" }], pr.id), { focused: 1 }),
    ],
    ["picking in an empty second group: the tab fills it", two(grp([files], files.id), emptyGroup, { focused: 1 }), diff, undefined, two(grp([files], files.id), grp([diff], diff.id), { focused: 1 })],
    [
      "picking ends only in the tab's group",
      two(grp([files, diff], null, diff.id), grp([pr], null, pr.id), { focused: 1 }),
      usage,
      1,
      two(grp([files, diff], null, diff.id), grp([pr, usage], usage.id), { focused: 1 }),
    ],
    ["a hidden split panel opens", { ...two(grp([files], files.id), grp([pr], pr.id)), open: false }, diff, undefined, two(grp([files, diff], diff.id), grp([pr], pr.id))],
  ];
  it.each(cases)("%s", (_name, before, tab, g, want) => {
    expect(openTab(before, tab, g)).toEqual(want);
  });
});

describe("closeTab with groups", () => {
  const cases: [string, PanelEntry, string, PanelEntry][] = [
    [
      "the second group's active tab activates its neighbour; the first group and focus are kept",
      two(grp([files], files.id), grp([pr, diff, usage], diff.id)),
      diff.id,
      two(grp([files], files.id), grp([pr, usage], usage.id)),
    ],
    ["the second group's last tab collapses the split", two(grp([files, diff], files.id), grp([pr], pr.id), { focused: 1 }), pr.id, one([files, diff], files.id)],
    ["the first group's last tab collapses the split: the second group takes the panel", two(grp([files], files.id), grp([diff, pr], pr.id)), files.id, one([diff, pr], pr.id)],
    ["the first group's last tab while it is focused", two(grp([files], files.id), grp([diff], diff.id)), files.id, one([diff], diff.id)],
    [
      "a picking group keeps picking",
      two(grp([files], files.id), grp([pr, diff, usage], null, diff.id), { focused: 1 }),
      diff.id,
      two(grp([files], files.id), grp([pr, usage], null, usage.id), { focused: 1 }),
    ],
    ["a picking group's last tab collapses the split", two(grp([files], files.id), grp([pr], null, pr.id), { focused: 1 }), pr.id, one([files], files.id)],
    ["width, expanded and the ratio are kept when it collapses", two(grp([files], files.id), grp([pr], pr.id), { width: 500, expanded: true, ratio: 0.3 }), pr.id, one([files], files.id, { width: 500, expanded: true, ratio: 0.3 })],
    ["the last tab of the panel (beside an empty picking group) hides it", two(grp([files], files.id), emptyGroup, { focused: 1 }), files.id, { ...emptyEntry }],
  ];
  it.each(cases)("%s", (_name, before, id, want) => {
    expect(closeTab(before, id)).toEqual(want);
  });

  const keepOpenCases: [string, PanelEntry, string, PanelEntry][] = [
    ["a group's last tab still collapses into the other", two(grp([files], files.id), grp([pr], pr.id)), pr.id, one([files], files.id)],
    ["the panel's last tab leaves it open with no tabs", two(grp([files], files.id), emptyGroup, { focused: 1, ratio: 0.3 }), files.id, { open: true, groups: [emptyGroup], ratio: 0.3 }],
    ["the panel's last tab of a hidden panel leaves it hidden", { ...two(grp([files], files.id), emptyGroup), open: false }, files.id, { ...emptyEntry }],
  ];
  it.each(keepOpenCases)("keepOpen: %s", (_name, before, id, want) => {
    expect(closeTab(before, id, true)).toEqual(want);
  });

  it("returns the same entry for an unknown id", () => {
    const e = two(grp([files], files.id), grp([pr], pr.id));
    expect(closeTab(e, "nope")).toBe(e);
  });
});

describe("retitleTab with groups", () => {
  const e = two(grp([files], files.id), grp([pr, usage], pr.id));
  it("renames a tab of the second group", () => {
    expect(retitleTab(e, usage.id, "Cost")).toEqual(two(grp([files], files.id), grp([pr, { ...usage, title: "Cost" }], pr.id)));
  });
  it.each<[string, string, string]>([
    ["the same title", usage.id, "Usage"],
    ["an empty title", usage.id, ""],
    ["an unknown id", "nope", "X"],
  ])("returns the same entry for %s", (_name, id, title) => {
    expect(retitleTab(e, id, title)).toBe(e);
  });
});

describe("activateTab with groups", () => {
  const cases: [string, PanelEntry, string, PanelEntry][] = [
    ["activates in the second group and focuses it", two(grp([files], files.id), grp([pr, usage], pr.id)), usage.id, two(grp([files], files.id), grp([pr, usage], usage.id), { focused: 1 })],
    ["an already active tab of the other group only moves focus", two(grp([files], files.id), grp([pr], pr.id)), pr.id, two(grp([files], files.id), grp([pr], pr.id), { focused: 1 })],
    ["focus back to the first group drops it", two(grp([files, diff], files.id), grp([pr], pr.id), { focused: 1 }), diff.id, two(grp([files, diff], diff.id), grp([pr], pr.id))],
    [
      "ends picking only in its group",
      two(grp([files, diff], null, files.id), grp([pr, usage], null, pr.id)),
      usage.id,
      two(grp([files, diff], null, files.id), grp([pr, usage], usage.id), { focused: 1 }),
    ],
  ];
  it.each(cases)("%s", (_name, before, id, want) => {
    expect(activateTab(before, id)).toEqual(want);
  });

  it("returns the same entry for the focused group's active tab", () => {
    const e = two(grp([files], files.id), grp([pr], pr.id), { focused: 1 });
    expect(activateTab(e, pr.id)).toBe(e);
  });
});

describe("moveTab with groups", () => {
  it("reorders within the tab's group; the other group and focus are kept", () => {
    const e = two(grp([files], files.id), grp([pr, diff, usage], diff.id), { focused: 1 });
    expect(moveTab(e, usage.id, 0)).toEqual(two(grp([files], files.id), grp([usage, pr, diff], diff.id), { focused: 1 }));
  });

  it("never moves a tab across groups", () => {
    const e = two(grp([files, diff], files.id), grp([pr], pr.id));
    expect(moveTab(e, pr.id, 0)).toBe(e);
  });
});

describe("moveTabToGroup", () => {
  const three = [files, diff, pr];
  const cases: [string, PanelEntry, string, GroupIndex, number | undefined, PanelEntry][] = [
    ["the active tab of an unsplit panel splits it; its neighbour stays active", one(three, diff.id), diff.id, 1, undefined, two(grp([files, pr], pr.id), grp([diff], diff.id), { focused: 1 })],
    ["an inactive tab of an unsplit panel splits it; the active tab stays", one(three, files.id), pr.id, 1, undefined, two(grp([files, diff], files.id), grp([pr], pr.id), { focused: 1 })],
    ["to the second group at an index", two(grp(three, files.id), grp([usage], usage.id)), diff.id, 1, 0, two(grp([files, pr], files.id), grp([diff, usage], diff.id), { focused: 1 })],
    ["the index is clamped past the end", two(grp(three, files.id), grp([usage], usage.id)), diff.id, 1, 9, two(grp([files, pr], files.id), grp([usage, diff], diff.id), { focused: 1 })],
    ["the index is clamped before the start", two(grp(three, files.id), grp([usage], usage.id)), diff.id, 1, -2, two(grp([files, pr], files.id), grp([diff, usage], diff.id), { focused: 1 })],
    ["NaN goes last", two(grp(three, files.id), grp([usage], usage.id)), diff.id, 1, NaN, two(grp([files, pr], files.id), grp([usage, diff], diff.id), { focused: 1 })],
    ["to the first group, which takes focus", two(grp([files], files.id), grp([diff, pr], pr.id), { focused: 1 }), pr.id, 0, undefined, two(grp([files, pr], pr.id), grp([diff], diff.id))],
    ["the first group's last tab collapses into the second", two(grp([files], files.id), grp([diff], diff.id)), files.id, 1, undefined, one([diff, files], files.id)],
    ["the second group's last tab collapses into the first", two(grp([files], files.id), grp([diff], diff.id), { focused: 1 }), diff.id, 0, 0, one([diff, files], diff.id)],
    ["into an empty picking group", two(grp(three, files.id), emptyGroup, { focused: 1 }), pr.id, 1, undefined, two(grp([files, diff], files.id), grp([pr], pr.id), { focused: 1 })],
    ["the target group's picking ends", two(grp([files, diff], files.id), grp([pr, usage], null, pr.id)), diff.id, 1, undefined, two(grp([files], files.id), grp([pr, usage, diff], diff.id), { focused: 1 })],
    [
      "a picking source keeps picking; moving its pickFrom tab moves pickFrom",
      two(grp(three, null, diff.id), grp([usage], usage.id)),
      diff.id,
      1,
      undefined,
      two(grp([files, pr], null, pr.id), grp([usage, diff], diff.id), { focused: 1 }),
    ],
    ["width, expanded and the ratio are kept", one(three, files.id, { width: 500, expanded: true, ratio: 0.3 }), pr.id, 1, undefined, two(grp([files, diff], files.id), grp([pr], pr.id), { width: 500, expanded: true, ratio: 0.3, focused: 1 })],
    ["its own group with an index is moveTab", two(grp(three, files.id), grp([usage], usage.id)), pr.id, 0, 0, two(grp([pr, files, diff], files.id), grp([usage], usage.id))],
  ];
  it.each(cases)("%s", (_name, before, id, g, to, want) => {
    expect(moveTabToGroup(before, id, g, to)).toEqual(want);
  });

  it.each<[string, PanelEntry, string, GroupIndex]>([
    ["the only tab of an unsplit panel", one([files], files.id), files.id, 1],
    ["an unknown id", two(grp([files], files.id), grp([pr], pr.id)), "nope", 1],
    ["its own group without an index", two(grp([files], files.id), grp([pr], pr.id)), pr.id, 1],
  ])("returns the same entry for %s", (_name, e, id, g) => {
    expect(moveTabToGroup(e, id, g)).toBe(e);
  });
});

describe("split", () => {
  const cases: [string, PanelEntry, PanelEntry][] = [
    ["a single tab stays, and the new group starts empty and picking, focused", one([files], files.id), two(grp([files], files.id), emptyGroup, { focused: 1 })],
    ["the active tab moves into the new group, focused", one([files, diff, pr], diff.id), two(grp([files, pr], pr.id), grp([diff], diff.id), { focused: 1 })],
    ["the last tab active: its left neighbour takes over", one([files, diff, pr], pr.id), two(grp([files, diff], diff.id), grp([pr], pr.id), { focused: 1 })],
    ["picking ends first: back to pickFrom, which moves", { open: true, groups: [grp([files, diff], null, files.id)] }, two(grp([diff], diff.id), grp([files], files.id), { focused: 1 })],
    ["picking with a single tab ends, and the new group is empty", { open: true, groups: [grp([files], null, files.id)] }, two(grp([files], files.id), emptyGroup, { focused: 1 })],
    ["a hidden panel stays hidden (splitPanel shows it)", { ...one([files, diff], files.id), open: false }, { ...two(grp([diff], diff.id), grp([files], files.id), { focused: 1 }), open: false }],
    ["width, expanded and the ratio are kept", one([files], files.id, { width: 500, expanded: true, ratio: 0.3 }), two(grp([files], files.id), emptyGroup, { width: 500, expanded: true, ratio: 0.3, focused: 1 })],
  ];
  it.each(cases)("%s", (_name, before, want) => {
    const got = split(before);
    expect(got).toEqual(want);
    expect(isPicking(got, 1)).toBe(got.groups[1]?.tabs.length === 0);
  });

  it.each<[string, PanelEntry]>([
    ["a panel without tabs", { ...emptyEntry, open: true }],
    ["a split panel", two(grp([files], files.id), grp([pr], pr.id))],
  ])("returns the same entry for %s", (_name, e) => {
    expect(split(e)).toBe(e);
  });
});

describe("unsplit", () => {
  const cases: [string, PanelEntry, PanelEntry][] = [
    ["the second group's tabs follow the first's; the focused second group's active tab stays", two(grp([files, diff], files.id), grp([pr], pr.id), { focused: 1 }), one([files, diff, pr], pr.id)],
    ["the focused first group's active tab stays", two(grp([files, diff], diff.id), grp([pr], pr.id)), one([files, diff, pr], diff.id)],
    ["an empty focused group: the other group's active tab", two(grp([files, diff], diff.id), emptyGroup, { focused: 1 }), one([files, diff], diff.id)],
    ["a focused group picking: its pickFrom, and picking ends", two(grp([files], files.id), grp([pr, usage], null, usage.id), { focused: 1 }), one([files, pr, usage], usage.id)],
    ["an empty focused group beside a picking one: that one's pickFrom", two(grp([files, diff], null, diff.id), emptyGroup, { focused: 1 }), one([files, diff], diff.id)],
    ["width, expanded and the ratio are kept; focus goes", two(grp([files], files.id), grp([pr], pr.id), { width: 500, expanded: true, ratio: 0.3, focused: 1 }), one([files, pr], pr.id, { width: 500, expanded: true, ratio: 0.3 })],
    ["a hidden panel stays hidden", { ...two(grp([files], files.id), grp([pr], pr.id)), open: false }, { ...one([files, pr], files.id), open: false }],
  ];
  it.each(cases)("%s", (_name, before, want) => {
    expect(unsplit(before)).toEqual(want);
  });

  it("returns the same entry for an unsplit panel", () => {
    const e = one([files], files.id);
    expect(unsplit(e)).toBe(e);
  });

  it("after a split, keeps the tab that moved active, at the end of the strip", () => {
    expect(unsplit(split(one([files, diff, pr], diff.id)))).toEqual(one([files, pr, diff], diff.id));
  });
});

describe("startPicking and stopPicking with groups", () => {
  const startCases: [string, PanelEntry, GroupIndex | undefined, PanelEntry][] = [
    ["the second group remembers its active tab and takes focus", two(grp([files], files.id), grp([pr], pr.id)), 1, two(grp([files], files.id), grp([pr], null, pr.id), { focused: 1 })],
    ["the default is the focused group", two(grp([files], files.id), grp([pr], pr.id), { focused: 1 }), undefined, two(grp([files], files.id), grp([pr], null, pr.id), { focused: 1 })],
    ["the first group of a panel focused on the second", two(grp([files], files.id), grp([pr], pr.id), { focused: 1 }), 0, two(grp([files], null, files.id), grp([pr], pr.id))],
    ["group 1 of an unsplit panel is group 0", one([files], files.id), 1, { open: true, groups: [grp([files], null, files.id)] }],
    ["an empty picking group already picks: it only takes focus", two(grp([files], files.id), emptyGroup), 1, two(grp([files], files.id), emptyGroup, { focused: 1 })],
  ];
  it.each(startCases)("startPicking: %s", (_name, before, g, want) => {
    expect(startPicking(before, g)).toEqual(want);
  });

  const stopCases: [string, PanelEntry, GroupIndex | undefined, PanelEntry][] = [
    ["the empty second group collapses the split, and focus goes to the first", two(grp([files], files.id), emptyGroup, { focused: 1 }), undefined, one([files], files.id)],
    ["the empty second group by index, focus elsewhere", two(grp([files], files.id), emptyGroup), 1, one([files], files.id)],
    ["the second group goes back to its pickFrom and takes focus", two(grp([files], files.id), grp([pr, usage], null, usage.id)), 1, two(grp([files], files.id), grp([pr, usage], usage.id), { focused: 1 })],
    ["the ratio is kept when it collapses", two(grp([files], files.id), emptyGroup, { focused: 1, ratio: 0.7 }), undefined, one([files], files.id, { ratio: 0.7 })],
  ];
  it.each(stopCases)("stopPicking: %s", (_name, before, g, want) => {
    expect(stopPicking(before, g)).toEqual(want);
  });

  it("stopPicking returns the same entry for a group that is not picking", () => {
    const e = two(grp([files], files.id), emptyGroup, { focused: 1 });
    expect(stopPicking(e, 0)).toBe(e);
  });

  it("a split from a single tab, then Escape, is where it began", () => {
    const e = one([files], files.id);
    expect(stopPicking(split(e))).toEqual(e);
  });
});

describe("focusGroup", () => {
  const split2 = two(grp([files], files.id), grp([pr], pr.id));
  it.each<[string, PanelEntry, GroupIndex, PanelEntry]>([
    ["the second group of a split panel", split2, 1, { ...split2, focused: 1 }],
    ["back to the first drops it", { ...split2, focused: 1 }, 0, split2],
  ])("%s", (_name, before, g, want) => {
    expect(focusGroup(before, g)).toEqual(want);
  });

  it.each<[string, PanelEntry, GroupIndex]>([
    ["the second group of an unsplit panel", one([files], files.id), 1],
    ["the group that has focus", { ...split2, focused: 1 }, 1],
    ["the first group with focus absent", split2, 0],
  ])("returns the same entry for %s", (_name, e, g) => {
    expect(focusGroup(e, g)).toBe(e);
  });
});

describe("setRatio", () => {
  const base = two(grp([files], files.id), grp([pr], pr.id));
  const cases: [string, PanelEntry, number | undefined, PanelEntry][] = [
    ["sets it", base, 0.3, { ...base, ratio: 0.3 }],
    ["clamps below 0.2", base, 0.05, { ...base, ratio: 0.2 }],
    ["clamps above 0.8", base, 0.95, { ...base, ratio: 0.8 }],
    ["0.5 drops it", { ...base, ratio: 0.3 }, 0.5, base],
    ["undefined drops it", { ...base, ratio: 0.3 }, undefined, base],
    ["an unsplit panel stores it for the next split", one([files], files.id), 0.7, one([files], files.id, { ratio: 0.7 })],
  ];
  it.each(cases)("%s", (_name, before, r, want) => {
    expect(setRatio(before, r)).toEqual(want);
  });

  it.each<[string, PanelEntry, number | undefined]>([
    ["NaN", { ...base, ratio: 0.3 }, NaN],
    ["the same ratio", { ...base, ratio: 0.3 }, 0.3],
    ["the same after clamping", { ...base, ratio: 0.8 }, 2],
    ["the default without one", base, 0.5],
  ])("returns the same entry for %s", (_name, e, r) => {
    expect(setRatio(e, r)).toBe(e);
  });

  it("survives the other reducers: hiding, resizing, expanding, unsplit, a collapse", () => {
    const e = { ...base, ratio: 0.3 };
    expect(toggle(e).ratio).toBe(0.3);
    expect(setWidth(e, 500).ratio).toBe(0.3);
    expect(setExpanded(e, true).ratio).toBe(0.3);
    expect(unsplit(e).ratio).toBe(0.3);
    expect(closeTab(e, pr.id).ratio).toBe(0.3);
    expect(split(unsplit(e)).ratio).toBe(0.3);
  });
});

describe("panel store with groups", () => {
  beforeEach(() => {
    usePanelStore.setState({ byKey: {} });
    useUiStore.setState({ selection: { kind: "thread", id: "a" }, focus: "content", panelFocusSeq: 0, windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260 });
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("openSurface opens in the focused group by default, or the given one", () => {
    openSurface("current", files);
    openSurface("current", diff);
    expect(splitPanel("current", { focus: false })).toBe(true);
    openSurface("current", pr);
    expect(getPanel()).toEqual(two(grp([files], files.id), grp([diff, pr], pr.id), { focused: 1 }));
    openSurface("current", usage, { group: 0 });
    expect(getPanel()).toEqual(two(grp([files, usage], usage.id), grp([diff, pr], pr.id)));
    // Open in the other group: activated there, not duplicated.
    openSurface("current", diff, { group: 0 });
    expect(getPanel()).toEqual(two(grp([files, usage], usage.id), grp([diff, pr], diff.id), { focused: 1 }));
  });

  it("splitPanel shows a hidden panel split and asks for focus; unsplitPanel joins it", () => {
    openSurface("current", files);
    togglePanel("current", false, { focus: false });
    expect(splitPanel()).toBe(true);
    expect(getPanel()).toEqual(two(grp([files], files.id), emptyGroup, { focused: 1 }));
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
    // Already split: unchanged, still true.
    expect(splitPanel("current", { focus: false })).toBe(true);
    unsplitPanel();
    expect(getPanel()).toEqual(one([files], files.id));
  });

  it("splitPanel without tabs only shows the panel; with nothing selected it does nothing", () => {
    expect(splitPanel("current", { focus: false })).toBe(false);
    expect(getPanel()).toEqual({ ...emptyEntry, open: true });
    useUiStore.getState().select({ kind: "none" });
    expect(splitPanel()).toBe(false);
    unsplitPanel();
    expect(Object.keys(usePanelStore.getState().byKey)).toEqual(["thread:a"]);
  });

  it("closePanelTab, activatePanelTab, retitlePanelTab and stopPanelPicking find the tab's group", () => {
    openSurface("current", files);
    openSurface("current", diff);
    openSurface("current", pr);
    movePanelTabToGroup("current", pr.id, 1);
    movePanelTabToGroup("current", diff.id, 1, 0);
    expect(getPanel()).toEqual(two(grp([files], files.id), grp([diff, pr], diff.id), { focused: 1 }));
    activatePanelTab("current", files.id);
    expect(getPanel()).toEqual(two(grp([files], files.id), grp([diff, pr], diff.id)));
    retitlePanelTab("current", pr.id, "#12 Fix");
    expect(getPanel().groups[1]?.tabs[1]?.title).toBe("#12 Fix");
    closePanelTab("current", diff.id, { keepOpen: false });
    expect(getPanel().groups[1]?.activeTabId).toBe(pr.id);
    startPanelPicking("current", { focus: false, group: 1 });
    expect(isPicking(getPanel(), 1)).toBe(true);
    stopPanelPicking("current", 1);
    expect(getPanel().groups[1]?.activeTabId).toBe(pr.id);
    // The second group's last tab collapses the split.
    closePanelTab("current", pr.id, { keepOpen: false });
    expect(getPanel()).toEqual(one([files], files.id));
  });

  it("stopPanelPicking on the empty group of a split collapses it", () => {
    openSurface("current", files);
    splitPanel("current", { focus: false });
    stopPanelPicking();
    expect(getPanel()).toEqual(one([files], files.id));
  });

  it("setPanelRatio and focusPanelGroup write one panel's entry", () => {
    openSurface("current", files);
    openSurface("current", diff);
    splitPanel("current", { focus: false });
    focusPanelGroup("current", 0);
    setPanelRatio("current", 0.95);
    expect(getPanel()).toEqual(two(grp([files], files.id), grp([diff], diff.id), { ratio: 0.8 }));
    setPanelRatio("current", undefined);
    expect(getPanel()).not.toHaveProperty("ratio");
    expect(getPanel("thread:b")).toEqual(emptyEntry);
  });

  it("is persisted with its groups, ratio and focus", async () => {
    openSurface("current", files);
    openSurface("current", diff);
    splitPanel("current", { focus: false });
    setPanelRatio("current", 0.3);
    const want = two(grp([files], files.id), grp([diff], diff.id), { ratio: 0.3, focused: 1 });
    expect(getPanel()).toEqual(want);
    const saved = localStorage.getItem("code-foundry.panel") ?? "";
    expect(JSON.parse(saved)).toMatchObject({ version: 4 });
    usePanelStore.setState({ byKey: {} });
    localStorage.setItem("code-foundry.panel", saved);
    await usePanelStore.persist.rehydrate();
    expect(getPanel("thread:a")).toEqual(want);
  });

  it("the selectors follow one panel's groups, split, ratio, focus and picking", () => {
    const key = "thread:a";
    const group0 = renderHook(() => usePanelGroup(key, 0));
    const group1 = renderHook(() => usePanelGroup(key, 1));
    const isSplitNow = renderHook(() => usePanelSplit(key));
    const ratio = renderHook(() => usePanelRatio(key));
    const focused = renderHook(() => usePanelFocusedGroup(key));
    const picking1 = renderHook(() => usePanelPicking(key, 1));
    const pickingFocused = renderHook(() => usePanelPicking(key));
    expect(group0.result.current).toBe(emptyGroup);
    expect(group1.result.current).toBeUndefined();
    expect([isSplitNow.result.current, ratio.result.current, focused.result.current, picking1.result.current]).toEqual([false, 0.5, 0, false]);
    act(() => {
      openSurface(key, files);
      splitPanel(key, { focus: false });
      setPanelRatio(key, 0.25);
    });
    expect(group0.result.current).toEqual(grp([files], files.id));
    expect(group1.result.current).toEqual(emptyGroup);
    expect([isSplitNow.result.current, ratio.result.current, focused.result.current, picking1.result.current, pickingFocused.result.current]).toEqual([true, 0.25, 1, true, true]);
    act(() => {
      focusPanelGroup(key, 0);
    });
    expect([focused.result.current, pickingFocused.result.current]).toEqual([0, false]);
  });
});
