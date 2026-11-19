import { describe, expect, it } from "vitest";
import type { LayoutState, PaneEntry, TabEntry } from "@/stores/layout";
import { groupDropPlan } from "./dropPlan";
import { groupDropsInGrid, groupGridSteps, groupSpaceCommands, headerDropIds, resolveStep, rowDragGroup, type HeaderThreadFacts } from "./groupDrop";
import type { DropTarget } from "./targets";

/**
 * Dragging the sidebar's selection (docs/notes/sidebar-bulk-select.md). The window is in sp-a;
 * the default space is sp-b.
 *   p-1 (sp-a): t-live (s-live), t-x (a diff)      p-2 (sp-a): t-two (s-two)      p-3 (sp-b): t-far (s-far)
 *   s-act, s-snz live in sp-a, not open; s-other lives in sp-b, not open; s-arch is archived, no record.
 */
type Layout = Pick<LayoutState, "panes" | "tabs" | "threads" | "defaultSpaceId">;
const rec = (threadId: string, spaceId: string) => ({ threadId, spaceId, quick: null, remembered: [], rememberedPaneId: "", info: null });
const tab = (id: string, thread: string, paneId: string, kind = "thread"): TabEntry => ({ id, kind, thread, key: `${kind}:${thread}`, params: {}, title: "", name: "", preview: false, paneId });
function layout(): Layout {
  const panes: Record<string, PaneEntry> = {
    "p-1": { id: "p-1", spaceId: "sp-a", tabIds: ["t-live", "t-x"], active: "t-live" },
    "p-2": { id: "p-2", spaceId: "sp-a", tabIds: ["t-two"], active: "t-two" },
    "p-3": { id: "p-3", spaceId: "sp-b", tabIds: ["t-far"], active: "t-far" },
  };
  const tabs = { "t-live": tab("t-live", "s-live", "p-1"), "t-x": tab("t-x", "s-live", "p-1", "diff"), "t-two": tab("t-two", "s-two", "p-2"), "t-far": tab("t-far", "s-far", "p-3") };
  const threads = { "s-act": rec("s-act", "sp-a"), "s-snz": rec("s-snz", "sp-a"), "s-live": rec("s-live", "sp-a"), "s-two": rec("s-two", "sp-a"), "s-far": rec("s-far", "sp-b"), "s-other": rec("s-other", "sp-b") };
  return { panes, tabs, threads, defaultSpaceId: "sp-b" };
}
const s = layout();
const archived = (id: string) => id === "s-arch";

describe("rowDragGroup", () => {
  it.each([
    { name: "a selected row with two or more selected lifts the selection in order", thread: "s-b", picked: ["s-c", "s-b"], want: { group: ["s-b", "s-c"], keep: true } },
    { name: "an unselected row lifts alone and drops the selection", thread: "s-a", picked: ["s-c", "s-b"], want: { group: [], keep: false } },
    { name: "the only selected row lifts alone", thread: "s-b", picked: ["s-b"], want: { group: [], keep: false } },
  ])("$name", ({ thread, picked, want }) => {
    expect(rowDragGroup(thread, picked, ["s-b", "s-c"])).toEqual(want);
  });
});

describe("headerDropIds", () => {
  const live: HeaderThreadFacts = { archivedAtMs: null, snoozedUntilMs: null, savedAtMs: null, setup: null };
  const byId: Record<string, HeaderThreadFacts> = {
    a: live,
    arch: { ...live, archivedAtMs: 1 },
    snz: { ...live, snoozedUntilMs: 9 },
    saved: { ...live, savedAtMs: 9 },
    setup: { ...live, setup: { phase: "running" } },
  };
  it.each([
    { name: "Archived takes what is not archived", section: "archived" as const, ids: ["a", "arch", "snz", "setup"], want: ["a", "snz", "setup"] },
    { name: "an archived row on Archived is no target", section: "archived" as const, ids: ["arch"], want: [] },
    { name: "Snoozed saves what is not snoozed or saved, nor being set up; an archived one too", section: "snoozed" as const, ids: ["a", "arch", "snz", "saved", "setup"], want: ["a", "arch"] },
    { name: "a snoozed row on Snoozed is no target", section: "snoozed" as const, ids: ["snz", "saved"], want: [] },
    { name: "a thread that went is left out", section: "archived" as const, ids: ["gone", "a"], want: ["a"] },
  ])("$name", ({ section, ids, want }) => {
    expect(headerDropIds(section, ids, byId)).toEqual(want);
  });
});

describe("groupDropsInGrid", () => {
  it.each([
    { name: "threads of this space, open or not", ids: ["s-act", "s-live", "s-two"], want: true },
    { name: "an archived thread with no tab open goes anywhere", ids: ["s-act", "s-arch"], want: true },
    { name: "one of another space keeps the group off the grid", ids: ["s-act", "s-other"], want: false },
    { name: "one open in another space too", ids: ["s-act", "s-far"], want: false },
  ])("$name", ({ ids, want }) => {
    expect(groupDropsInGrid(ids, s, "sp-a", archived)).toBe(want);
  });
});

describe("groupGridSteps", () => {
  const cases: { name: string; target: DropTarget; first: Record<string, string> }[] = [
    { name: "a pane's middle: the end of its strip", target: { kind: "pane", pane: "p-1" }, first: { pane: "p-1", index: "2" } },
    { name: "a place in a strip", target: { kind: "strip", pane: "p-1", index: 1 }, first: { pane: "p-1", index: "1" } },
    { name: "a pane's edge: one split, by the first", target: { kind: "edge", pane: "p-1", edge: "right" }, first: { split: "p-1", edge: "right" } },
    { name: "the outer edge: one new pane, by the first", target: { kind: "outer", edge: "bottom" }, first: { outer: "bottom" } },
  ];
  it.each(cases)("$name; each next one after the one before, in list order", ({ target, first }) => {
    expect(groupGridSteps(["s-act", "s-two", "s-snz"], target, s, "sp-a")).toEqual([
      { name: "thread.open", args: { id: "s-act", focus: "true", ...first } },
      // Open here: it moves as its tab.
      { name: "tab.move", args: { tab: "t-two" }, after: "s-act" },
      { name: "thread.open", args: { id: "s-snz", focus: "true" }, after: "s-two" },
    ]);
  });

  it("a first thread open here moves as its tab", () => {
    expect(groupGridSteps(["s-two", "s-act"], { kind: "edge", pane: "p-1", edge: "left" }, s, "sp-a")).toEqual([
      { name: "tab.move", args: { tab: "t-two", split: "p-1", edge: "left" } },
      { name: "thread.open", args: { id: "s-act", focus: "true" }, after: "s-two" },
    ]);
  });

  it("the plan: the steps in the grid; one thread.space.move on a space tab", () => {
    expect(groupDropPlan(["s-act", "s-snz"], { kind: "pane", pane: "p-2" }, "", s, "sp-a", archived)?.commands).toHaveLength(2);
    expect(groupDropPlan(["s-act", "s-snz"], null, "", s, "sp-a", archived)).toBeNull();
    expect(groupDropPlan(["s-act", "s-snz"], null, "sp-b", s, "sp-a", archived)).toEqual({ space: "sp-b", commands: [{ name: "thread.space.move", args: { ids: "s-act,s-snz", space: "sp-b" } }] });
  });
});

describe("resolveStep", () => {
  it("places a step right after the tab of the thread before, in that tab's pane", () => {
    expect(resolveStep({ name: "thread.open", args: { id: "s-act", focus: "true" }, after: "s-live" }, s, "sp-a")).toEqual({
      name: "thread.open",
      args: { id: "s-act", focus: "true", pane: "p-1", index: "1" },
    });
    expect(resolveStep({ name: "tab.move", args: { tab: "t-live" }, after: "s-two" }, s, "sp-a")).toEqual({ name: "tab.move", args: { tab: "t-live", pane: "p-2", index: "1" } });
  });

  it("a first step runs as it is", () => {
    expect(resolveStep({ name: "thread.open", args: { id: "s-act", outer: "left" } }, s, "sp-a")).toEqual({ name: "thread.open", args: { id: "s-act", outer: "left" } });
  });

  it("stops when the thread before did not land in this space", () => {
    expect(resolveStep({ name: "thread.open", args: { id: "s-act" }, after: "s-snz" }, s, "sp-a")).toBeNull();
    expect(resolveStep({ name: "thread.open", args: { id: "s-act" }, after: "s-far" }, s, "sp-a")).toBeNull();
  });
});

describe("groupSpaceCommands", () => {
  it.each([
    { name: "every one not there yet, in one move", ids: ["s-act", "s-live", "s-other"], space: "sp-b", want: [{ name: "thread.space.move", args: { ids: "s-act,s-live", space: "sp-b" } }] },
    { name: "none to move: no target", ids: ["s-other", "s-far"], space: "sp-b", want: null },
    { name: "an archived thread with no tab open goes to no space: no target", ids: ["s-act", "s-arch"], space: "sp-b", want: null },
  ])("$name", ({ ids, space, want }) => {
    expect(groupSpaceCommands(ids, space, s, archived)).toEqual(want);
  });
});
