import { describe, expect, it } from "vitest";
import { plainRects } from "@/shell/geometry/rects";
import { col, pane, row } from "@/test/shellTrees";
import { modeDrop, modeDropDone, modeDropLabel, modeDropOver } from "./modeDrop";
import { dropTarget, type DragScene, type DragSource, type DropTarget, type SceneModes } from "./targets";
import { droppedText, overText } from "./announce";

/*
 * Threads open as (docs/notes/threads-open-as-2-gui.md) on a 1000x600 grid: p-1 on the left and
 * p-2 at the top right are thread panes (one thread each), p-3 under p-2 holds a diff.
 *   p-1: x 0..494     p-2: x 506..1000, y 0..294     p-3: x 506..1000, y 306..600
 */
const TREE = row("s-r", [0.5, 0.5], pane("p-1", "thread"), col("s-c", [0.5, 0.5], pane("p-2", "thread"), pane("p-3", "diff")));
const FRAME = plainRects(TREE, 1000, 600);

function sceneOf(mode?: SceneModes["mode"]): DragScene {
  const strips = { "p-1": [{ id: "t-a", x: 6, w: 100, title: "Fix login" }], "p-2": [{ id: "t-c", x: 512, w: 100, title: "Port renderer" }], "p-3": [{ id: "t-d", x: 512, w: 100, title: "Diff" }] };
  const modes: SceneModes | undefined = mode && { mode, threadPanes: { "p-1": "Fix login", "p-2": "Port renderer" }, threadTabs: new Set(["t-a", "t-c"]), target: "p-2" };
  return { frame: FRAME, stripHeight: 44, strips, ...(modes && { modes }) };
}

const row_: DragSource = { kind: "thread", thread: "s-9" };
const threadTab: DragSource = { kind: "tab", tab: "t-a", pane: "p-1" };
const diffTab: DragSource = { kind: "tab", tab: "t-d", pane: "p-3" };
const diffPane: DragSource = { kind: "pane", pane: "p-3" };
const threadPane: DragSource = { kind: "pane", pane: "p-1" };

const P2_MIDDLE = { x: 750, y: 170 };
const P2_ROW = { x: 750, y: 20 };
const P2_RIGHT = { x: 985, y: 170 };
const P3_MIDDLE = { x: 750, y: 470 };
const OUTER_LEFT = { x: 3, y: 300 };

describe("drop targets by mode", () => {
  it.each<[string, SceneModes["mode"] | undefined, DragSource, { x: number; y: number }, DropTarget | null]>([
    // Tabs: as always.
    ["tabs: a row on a thread pane's strip is a place in it", undefined, row_, P2_ROW, { kind: "strip", pane: "p-2", index: 1 }],
    ["tabs: a diff joins a thread's pane", undefined, diffTab, P2_MIDDLE, { kind: "pane", pane: "p-2" }],
    // Panes: a thread pane's row and middle are the pane; edges split.
    ["panes: a row on a thread pane's row replaces", "panes", row_, P2_ROW, { kind: "pane", pane: "p-2" }],
    ["panes: a row on a thread pane's middle replaces", "panes", row_, P2_MIDDLE, { kind: "pane", pane: "p-2" }],
    ["panes: a row on a thread pane's edge splits", "panes", row_, P2_RIGHT, { kind: "edge", pane: "p-2", edge: "right" }],
    ["panes: a row on the outer edge", "panes", row_, OUTER_LEFT, { kind: "outer", edge: "left" }],
    ["panes: a row on a pane of other tabs", "panes", row_, P3_MIDDLE, { kind: "pane", pane: "p-3" }],
    ["panes: a thread's tab on another thread pane replaces", "panes", threadTab, P2_MIDDLE, { kind: "pane", pane: "p-2" }],
    ["panes: a thread pane on another replaces", "panes", threadPane, P2_MIDDLE, { kind: "pane", pane: "p-2" }],
    ["panes: a diff is not offered a thread pane", "panes", diffTab, P2_MIDDLE, null],
    ["panes: nor its pane", "panes", diffPane, P2_ROW, null],
    ["panes: a diff still splits a thread pane", "panes", diffTab, P2_RIGHT, { kind: "edge", pane: "p-2", edge: "right" }],
    // Single: no edges for a thread, the whole pane replaces.
    ["single: a thread pane's edge is its middle", "single", row_, P2_RIGHT, { kind: "pane", pane: "p-2" }],
    ["single: no outer edge for a thread", "single", row_, OUTER_LEFT, { kind: "pane", pane: "p-1" }],
    ["single: a thread's tab has no edge either", "single", threadTab, P2_RIGHT, { kind: "pane", pane: "p-2" }],
    ["single: a diff keeps its edges", "single", diffTab, P2_RIGHT, { kind: "edge", pane: "p-2", edge: "right" }],
    ["single: a pane keeps its outer edge", "single", diffPane, OUTER_LEFT, { kind: "outer", edge: "left" }],
  ])("%s", (_name, mode, source, p, want) => {
    expect(dropTarget(sceneOf(mode), source, p)).toEqual(want);
  });

  it("a thread pane's one tab has no other place in its own row", () => {
    expect(dropTarget(sceneOf("panes"), threadTab, { x: 200, y: 20 })).toBeNull();
    expect(dropTarget(sceneOf(), threadTab, { x: 200, y: 20 })).toEqual({ kind: "strip", pane: "p-1", index: 1 });
  });
});

describe("what a drop does, in words", () => {
  it.each<[string, SceneModes["mode"] | undefined, DragSource, DropTarget, string | null]>([
    ["tabs says nothing", undefined, row_, { kind: "pane", pane: "p-2" }, null],
    ["a pane says nothing", "panes", diffPane, { kind: "edge", pane: "p-2", edge: "left" }, null],
    ["a thread on a thread pane replaces its thread", "panes", row_, { kind: "pane", pane: "p-2" }, "Replace Port renderer"],
    ["an edge opens beside", "panes", row_, { kind: "edge", pane: "p-2", edge: "left" }, "Open beside"],
    ["the outer edge opens beside", "panes", threadTab, { kind: "outer", edge: "right" }, "Open beside"],
    ["panes: a pane of other tabs opens beside it", "panes", row_, { kind: "pane", pane: "p-3" }, "Open beside"],
    ["single: a pane of other tabs replaces the space's thread", "single", row_, { kind: "pane", pane: "p-3" }, "Replace Port renderer"],
  ])("%s", (_name, mode, source, target, want) => {
    const d = modeDrop(sceneOf(mode), source, target);
    expect(d ? modeDropLabel(d) : null).toBe(want);
  });

  it("the announcements say it after the place", () => {
    const names = { tab: () => "Fix login", pane: () => "Port renderer", tabCount: () => 1, thread: () => "Tidy zshrc" };
    const t: DropTarget = { kind: "pane", pane: "p-2" };
    const d = modeDrop(sceneOf("panes"), row_, t);
    if (!d) throw new Error("effect");
    expect(overText(row_, t, names, modeDropOver(d))).toBe("Thread Tidy zshrc is over the pane of Port renderer; dropping replaces Port renderer.");
    expect(droppedText(row_, t, names, modeDropDone(d))).toBe("Thread Tidy zshrc was dropped on the pane of Port renderer; it replaced Port renderer.");
  });
});
