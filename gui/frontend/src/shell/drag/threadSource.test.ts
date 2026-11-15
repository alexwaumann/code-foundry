import { describe, expect, it } from "vitest";
import type { LayoutState, PaneEntry, TabEntry } from "@/stores/layout";
import { sourceOf } from "./draggable";
import { dropPlan } from "./dropPlan";
import type { DragSource, DropTarget } from "./targets";
import { openThreadTab, rowDragSource, threadDropsInGrid } from "./threadSource";

/**
 * A sidebar row's drag in every section (docs/notes/preview-tabs-2-row-drag.md). Two spaces; the
 * window is in sp-a, and the default space (where a thread without a record lives) is sp-b, so an
 * archived thread's fallback space is not the current one.
 *   s-act    active, lives in sp-a, not open
 *   s-snz    snoozed, lives in sp-a, not open
 *   s-arch   archived, no record, not open
 *   s-gone   archived, opened in sp-b and closed there (its record stays), not open
 *   s-here   archived, open in sp-a (t-here in p-1)
 *   s-far    archived, open in sp-b (t-far in p-2)
 *   s-live   active, open in sp-a (t-live in p-1)
 */
type Layout = Pick<LayoutState, "panes" | "tabs" | "threads" | "defaultSpaceId">;
const rec = (threadId: string, spaceId: string) => ({ threadId, spaceId, quick: null, remembered: [], rememberedPaneId: "", info: null });
function layout(): Layout {
  const panes: Record<string, PaneEntry> = {
    "p-1": { id: "p-1", spaceId: "sp-a", tabIds: ["t-live", "t-here"], active: "t-live" },
    "p-2": { id: "p-2", spaceId: "sp-b", tabIds: ["t-far"], active: "t-far" },
  };
  const tab = (id: string, thread: string, paneId: string): TabEntry => ({ id, kind: "thread", thread, key: `thread:${thread}`, params: {}, title: "", name: "", paneId });
  const tabs = { "t-live": tab("t-live", "s-live", "p-1"), "t-here": tab("t-here", "s-here", "p-1"), "t-far": tab("t-far", "s-far", "p-2") };
  const threads = { "s-act": rec("s-act", "sp-a"), "s-snz": rec("s-snz", "sp-a"), "s-gone": rec("s-gone", "sp-b"), "s-here": rec("s-here", "sp-a"), "s-far": rec("s-far", "sp-b"), "s-live": rec("s-live", "sp-a") };
  return { panes, tabs, threads, defaultSpaceId: "sp-b" };
}
const s = layout();
const row = (thread: string, archived = false): DragSource => (archived ? { kind: "thread", thread, archived } : { kind: "thread", thread });
/** What a row's drag in sp-a would run: the source at the drag's start, gated as ShellDnd gates the grid, then the plan. */
function rowDrop(src: DragSource, target: DropTarget | null, space = "") {
  const lifted = rowDragSource(src, s, "sp-a");
  if (!lifted) return null;
  const grid = lifted.kind !== "thread" || threadDropsInGrid(lifted, s, "sp-a");
  return dropPlan(lifted, grid ? target : null, space, s);
}

describe("a row's drag source", () => {
  it("carries the archived flag through dnd-kit's data", () => {
    expect(sourceOf({ kind: "thread", thread: "s-arch", archived: true })).toEqual({ kind: "thread", thread: "s-arch", archived: true });
    expect(sourceOf({ kind: "thread", thread: "s-snz" })).toEqual({ kind: "thread", thread: "s-snz" });
    expect(sourceOf({ kind: "thread", thread: "s-snz", archived: "yes" })).toEqual({ kind: "thread", thread: "s-snz" });
  });

  it("finds a thread's tab in whichever space it is open", () => {
    expect(openThreadTab(s, "s-here")?.id).toBe("t-here");
    expect(openThreadTab(s, "s-far")?.id).toBe("t-far");
    expect(openThreadTab(s, "s-arch")).toBeUndefined();
  });

  it.each([
    ["an active thread open here drags as its tab", row("s-live"), { kind: "tab", tab: "t-live", pane: "p-1" }],
    ["an archived thread open here drags as its tab", row("s-here", true), { kind: "tab", tab: "t-here", pane: "p-1" }],
    ["an archived thread open in another space stays a thread", row("s-far", true), row("s-far", true)],
    ["an archived thread not open stays a thread", row("s-arch", true), row("s-arch", true)],
    ["a snoozed thread not open stays a thread", row("s-snz"), row("s-snz")],
  ] as const)("%s", (_, src, want) => {
    expect(rowDragSource(src, s, "sp-a")).toEqual(want);
  });

  it.each([
    ["an active thread of this space", row("s-act"), true],
    ["a snoozed thread of this space", row("s-snz"), true],
    ["an archived thread with no record (the default space is another)", row("s-arch", true), true],
    ["an archived thread whose record names another space, not open", row("s-gone", true), true],
    ["an archived thread open in another space", row("s-far", true), false],
    ["a thread of another space", row("s-gone"), false],
  ] as const)("the grid takes %s: %s", (_, src, want) => {
    expect(threadDropsInGrid(src as Extract<DragSource, { kind: "thread" }>, s, "sp-a")).toBe(want);
  });
});

describe("what an Archived or Snoozed row's drop runs", () => {
  const open = (args: Record<string, string>) => ({ space: "", commands: [{ name: "thread.open", args: { focus: "true", ...args } }] });

  it.each([
    ["a pane's middle", { kind: "pane", pane: "p-1" }, { pane: "p-1" }],
    ["a place in a strip", { kind: "strip", pane: "p-1", index: 1 }, { pane: "p-1", index: "1" }],
    ["a pane's edge", { kind: "edge", pane: "p-1", edge: "right" }, { split: "p-1", edge: "right" }],
    ["the grid's outer edge", { kind: "outer", edge: "bottom" }, { outer: "bottom" }],
  ] as const)("on %s: one thread.open with the place, archived or snoozed (no unarchive, no unsnooze)", (_, target, args) => {
    for (const [id, archived] of [["s-arch", true], ["s-gone", true], ["s-snz", false]] as const) {
      const plan = rowDrop(row(id, archived), target);
      expect(plan).toEqual(open({ id, ...args }));
      expect(plan?.commands.map((c) => c.name)).not.toContain("thread.unarchive");
    }
  });

  it("a rail is a pane as a whole: thread.open into it", () => {
    expect(rowDrop(row("s-arch", true), { kind: "pane", pane: "p-1" })).toEqual(open({ id: "s-arch", pane: "p-1" }));
  });

  it("an archived thread whose tab is open here moves that tab, as an active row's does", () => {
    expect(rowDrop(row("s-here", true), { kind: "edge", pane: "p-1", edge: "left" })).toEqual({ space: "", commands: [{ name: "tab.move", args: { tab: "t-here", split: "p-1", edge: "left" } }] });
    expect(rowDrop(row("s-live"), { kind: "edge", pane: "p-1", edge: "left" })).toEqual({ space: "", commands: [{ name: "tab.move", args: { tab: "t-live", split: "p-1", edge: "left" } }] });
  });

  it("an archived thread open in another space does not drop in this grid", () => {
    expect(rowDrop(row("s-far", true), { kind: "pane", pane: "p-1" })).toBeNull();
  });

  describe("on a space tab", () => {
    it("a snoozed row moves its thread there, as an active row does; not to its own space", () => {
      expect(rowDrop(row("s-snz"), null, "sp-b")).toEqual({ space: "sp-b", commands: [{ name: "thread.space.move", args: { id: "s-snz", space: "sp-b" } }] });
      expect(rowDrop(row("s-act"), null, "sp-b")).toEqual({ space: "sp-b", commands: [{ name: "thread.space.move", args: { id: "s-act", space: "sp-b" } }] });
      expect(rowDrop(row("s-snz"), null, "sp-a")).toBeNull();
    });

    it("an archived row with no tab open is not taken: it belongs to no space", () => {
      for (const sp of ["sp-a", "sp-b", "sp-c"]) {
        expect(rowDrop(row("s-arch", true), null, sp)).toBeNull();
        expect(rowDrop(row("s-gone", true), null, sp)).toBeNull();
      }
    });

    it("an archived row with its tab open moves that tab to the space; not to the space it is open in", () => {
      expect(rowDrop(row("s-here", true), null, "sp-b")).toEqual({ space: "sp-b", commands: [{ name: "thread.space.move", args: { id: "s-here", space: "sp-b" } }] });
      expect(rowDrop(row("s-far", true), null, "sp-a")).toEqual({ space: "sp-a", commands: [{ name: "thread.space.move", args: { id: "s-far", space: "sp-a" } }] });
      expect(rowDrop(row("s-far", true), null, "sp-b")).toBeNull();
    });
  });
});

describe("dropPlan for tabs and panes (unchanged)", () => {
  it("moves a tab or a pane; a source closed mid-drag moves nothing", () => {
    expect(dropPlan({ kind: "tab", tab: "t-live", pane: "p-1" }, { kind: "pane", pane: "p-2" }, "", s)).toEqual({ space: "", commands: [{ name: "tab.move", args: { tab: "t-live", pane: "p-2" } }] });
    expect(dropPlan({ kind: "pane", pane: "p-2" }, { kind: "outer", edge: "left" }, "", s)).toEqual({ space: "", commands: [{ name: "pane.move", args: { pane: "p-2", outer: "left" } }] });
    expect(dropPlan({ kind: "tab", tab: "t-gone", pane: "p-1" }, { kind: "pane", pane: "p-2" }, "", s)).toBeNull();
    // Put back in its own place.
    expect(dropPlan({ kind: "tab", tab: "t-live", pane: "p-1" }, { kind: "strip", pane: "p-1", index: 0 }, "", s)).toBeNull();
    expect(dropPlan({ kind: "tab", tab: "t-live", pane: "p-1" }, null, "", s)).toBeNull();
  });
});
