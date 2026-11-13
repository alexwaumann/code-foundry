import { describe, expect, it } from "vitest";
import type { GeoNode } from "@/shell/geometry/types";
import type { LayoutState, PaneEntry, TabEntry } from "@/stores/layout";
import { defaultRemoveTarget, GLYPH, removeSpaceArgs, reorderIndex, spaceAtIndex, spaceDropCommands, spaceGlyph, threadsOfSpace } from "./spaces";

const p = (id: string): GeoNode => ({ t: "pane", id, tabs: [] });

describe("spaceGlyph", () => {
  it("draws a space with no pane as one rectangle filling the box", () => {
    expect(spaceGlyph(null)).toEqual([{ x: 0, y: 0, w: GLYPH.w, h: GLYPH.h }]);
  });

  it("draws one pane as the whole box", () => {
    expect(spaceGlyph(p("a"))).toEqual([{ x: 0, y: 0, w: 16, h: 12 }]);
  });

  it("draws two panes side by side with the gutter scaled to a 1.5px gap, by their sizes", () => {
    const rects = spaceGlyph({ t: "split", id: "s", dir: "row", kids: [p("a"), p("b")], sizes: [0.5, 0.5] });
    expect(rects).toEqual([
      { x: 0, y: 0, w: 7.25, h: 12 },
      { x: 8.75, y: 0, w: 7.25, h: 12 },
    ]);
  });

  it("follows the real tree: a column inside a row, uneven sizes", () => {
    const tree: GeoNode = {
      t: "split",
      id: "s",
      dir: "row",
      kids: [p("a"), { t: "split", id: "c", dir: "col", kids: [p("b"), p("c")], sizes: [0.5, 0.5] }],
      sizes: [0.6, 0.4],
    };
    const rects = spaceGlyph(tree);
    expect(rects).toHaveLength(3);
    const [a, b, c] = rects;
    // The left pane is the wider one, full height; the right column holds two stacked panes.
    expect(a?.h).toBe(12);
    expect(a && b && a.w > b.w).toBe(true);
    expect(b?.x).toBe(c?.x);
    expect(b && c && c.y > b.y + b.h).toBe(true);
    // Everything stays inside the glyph's box.
    for (const r of rects) {
      expect(r.x + r.w).toBeLessThanOrEqual(GLYPH.w);
      expect(r.y + r.h).toBeLessThanOrEqual(GLYPH.h);
    }
  });
});

/** A layout slice of panes and tabs in two spaces. */
function slice(panes: [string, string, [string, string, string][]][]): Pick<LayoutState, "panes" | "tabs" | "threads" | "defaultSpaceId"> {
  // s-7 lives in sp-b; every other thread in the default space, sp-a.
  const threads = { "s-7": { threadId: "s-7", spaceId: "sp-b", quick: null, remembered: [], rememberedPaneId: "", info: null } };
  const out: { panes: Record<string, PaneEntry>; tabs: Record<string, TabEntry>; threads: typeof threads; defaultSpaceId: string } = { panes: {}, tabs: {}, threads, defaultSpaceId: "sp-a" };
  for (const [id, spaceId, tabs] of panes) {
    out.panes[id] = { id, spaceId, tabIds: tabs.map((t) => t[0]), active: tabs[0]?.[0] ?? "" };
    for (const [tid, kind, thread] of tabs) out.tabs[tid] = { id: tid, kind, thread, key: `${kind}:${tid}`, params: {}, title: "", name: "", paneId: id };
  }
  return out;
}

describe("spaceDropCommands", () => {
  const s = slice([
    [
      "p-1",
      "sp-a",
      [
        ["t-th", "thread", "s-1"],
        ["t-d", "diff", "s-1"],
        ["t-other", "diff", "s-9"],
        ["t-prs", "prs", ""],
      ],
    ],
    ["p-2", "sp-a", [["t-d2", "diff", "s-2"]]],
    [
      "p-3",
      "sp-a",
      [
        ["t-th3", "thread", "s-3"],
        ["t-d3", "diff", "s-3"],
      ],
    ],
  ]);

  it("moves a thread's tab as the thread, which takes its linked tabs along", () => {
    expect(spaceDropCommands({ kind: "tab", tab: "t-th", pane: "p-1" }, "sp-b", s)).toEqual([{ name: "thread.space.move", args: { id: "s-1", space: "sp-b" } }]);
  });

  it("moves a linked tab by itself (it waits there, dormant) and an unlinked one with tab.move", () => {
    expect(spaceDropCommands({ kind: "tab", tab: "t-d", pane: "p-1" }, "sp-b", s)).toEqual([{ name: "tab.move", args: { tab: "t-d", space: "sp-b" } }]);
    expect(spaceDropCommands({ kind: "tab", tab: "t-prs", pane: "p-1" }, "sp-b", s)).toEqual([{ name: "tab.move", args: { tab: "t-prs", space: "sp-b" } }]);
  });

  // One command whatever the pane holds: the daemon moves its threads with it (their linked tabs
  // go along), so a drop never ends half moved.
  it.each([
    ["no thread's own tab", "p-2"],
    ["a thread's tab, its linked tab and others", "p-1"],
    ["only a thread and its linked tab", "p-3"],
  ])("moves a pane holding %s whole with one pane.move", (_what, pane) => {
    expect(spaceDropCommands({ kind: "pane", pane }, "sp-b", s)).toEqual([{ name: "pane.move", args: { pane, space: "sp-b" } }]);
  });

  it("moves a sidebar row's thread, open or not, to the space it is dropped on; not to its own", () => {
    expect(spaceDropCommands({ kind: "thread", thread: "s-5" }, "sp-b", s)).toEqual([{ name: "thread.space.move", args: { id: "s-5", space: "sp-b" } }]);
    expect(spaceDropCommands({ kind: "thread", thread: "s-7" }, "sp-a", s)).toEqual([{ name: "thread.space.move", args: { id: "s-7", space: "sp-a" } }]);
    expect(spaceDropCommands({ kind: "thread", thread: "s-5" }, "sp-a", s)).toBeNull();
    expect(spaceDropCommands({ kind: "thread", thread: "s-7" }, "sp-b", s)).toBeNull();
  });

  it("does nothing on its own space, or for a source that went", () => {
    expect(spaceDropCommands({ kind: "tab", tab: "t-d", pane: "p-1" }, "sp-a", s)).toBeNull();
    expect(spaceDropCommands({ kind: "pane", pane: "p-1" }, "sp-a", s)).toBeNull();
    expect(spaceDropCommands({ kind: "tab", tab: "t-gone", pane: "p-1" }, "sp-b", s)).toBeNull();
    expect(spaceDropCommands({ kind: "pane", pane: "p-gone" }, "sp-b", s)).toBeNull();
  });
});

describe("removing a space", () => {
  it("moves its threads to the chosen space, or archives them all", () => {
    expect(removeSpaceArgs("sp-b", { kind: "move", to: "sp-a" })).toEqual({ space: "sp-b", to: "sp-a" });
    expect(removeSpaceArgs("sp-b", { kind: "archive" })).toEqual({ space: "sp-b", archive: "true" });
  });

  it("offers the space on its left first, else the one on its right; none for the last space", () => {
    expect(defaultRemoveTarget(["sp-a", "sp-b", "sp-c"], "sp-b")).toBe("sp-a");
    expect(defaultRemoveTarget(["sp-a", "sp-b", "sp-c"], "sp-a")).toBe("sp-b");
    expect(defaultRemoveTarget(["sp-a"], "sp-a")).toBe("");
  });

  it("counts the user's own threads that live in it", () => {
    const s = { defaultSpaceId: "sp-a", threads: { "s-2": { threadId: "s-2", spaceId: "sp-b", quick: null, remembered: [], rememberedPaneId: "", info: null } } };
    expect(threadsOfSpace(["s-1", "s-2"], "sp-b", s)).toEqual(["s-2"]);
    expect(threadsOfSpace(["s-1", "s-2"], "sp-a", s)).toEqual(["s-1"]);
  });
});

describe("the top bar's order", () => {
  it("ctrl+cmd+n is the nth space, nothing past the last", () => {
    expect(spaceAtIndex(["sp-a", "sp-b"], 2)).toBe("sp-b");
    expect(spaceAtIndex(["sp-a", "sp-b"], 3)).toBe("");
  });

  it("a tab dragged onto another's place takes that place", () => {
    expect(reorderIndex(["a", "b", "c"], "a", "c")).toBe(3);
    expect(reorderIndex(["a", "b", "c"], "c", "a")).toBe(1);
    expect(reorderIndex(["a", "b", "c"], "b", "b")).toBeNull();
  });
});
