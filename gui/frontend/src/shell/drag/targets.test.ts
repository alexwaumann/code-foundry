import { describe, expect, it } from "vitest";
import { plainRects } from "@/shell/geometry/rects";
import type { Frame } from "@/shell/geometry/types";
import { col, pane, row } from "@/test/shellTrees";
import { dropTarget, EDGE_MIN, insertionBar, OUTER_IN, OUTER_OUT, sameTarget, stripIndex, type DragScene, type DragSource, type DropTarget, type StripTab } from "./targets";

/*
 * A 1000x600 grid: p-1 on the left (two tabs), p-2 over p-3 on the right (one tab each).
 *   p-1: x 0..494, y 0..600     p-2: x 506..1000, y 0..294     p-3: x 506..1000, y 306..600
 * Strips are 44px high; tabs are 100px wide from 6px into the strip with a 2px gap.
 */
const TREE = row("s-r", [0.5, 0.5], pane("p-1", "thread", "diff"), col("s-c", [0.5, 0.5], pane("p-2", "file"), pane("p-3", "prs")));
const STRIP = 44;

function strip(frame: Frame, id: string, ids: string[]): StripTab[] {
  const x0 = (frame.rects[id]?.x ?? 0) + 6;
  return ids.map((t, i) => ({ id: t, x: x0 + i * 102, w: 100, title: t }));
}

function sceneOf(frame: Frame, strips: Record<string, string[]>): DragScene {
  return { frame, stripHeight: STRIP, strips: Object.fromEntries(Object.entries(strips).map(([id, tabs]) => [id, strip(frame, id, tabs)])) };
}

const FRAME = plainRects(TREE, 1000, 600);
const SCENE = sceneOf(FRAME, { "p-1": ["t-a", "t-b"], "p-2": ["t-c"], "p-3": ["t-d"] });

const tabA: DragSource = { kind: "tab", tab: "t-a", pane: "p-1" };
const tabC: DragSource = { kind: "tab", tab: "t-c", pane: "p-2" };
const paneP2: DragSource = { kind: "pane", pane: "p-2" };
/** A tab from a pane that is not in the frame: every zone is open to it. */
const stranger: DragSource = { kind: "tab", tab: "t-z", pane: "p-z" };

describe("the frame the tests use", () => {
  it("is the layout the comment draws", () => {
    expect(FRAME.rects["p-1"]).toMatchObject({ x: 0, y: 0, w: 494, h: 600 });
    expect(FRAME.rects["p-2"]).toMatchObject({ x: 506, y: 0, w: 494, h: 294 });
    expect(FRAME.rects["p-3"]).toMatchObject({ x: 506, y: 306, w: 494, h: 294 });
  });
});

describe("dropTarget: zones", () => {
  it.each<[string, { x: number; y: number }, DropTarget | null]>([
    // The grid's outer edges, inside the band and outside the grid.
    ["left, inside", { x: 3, y: 300 }, { kind: "outer", edge: "left" }],
    ["left, outside", { x: -20, y: 300 }, { kind: "outer", edge: "left" }],
    ["right, inside", { x: 995, y: 450 }, { kind: "outer", edge: "right" }],
    ["right, outside", { x: 1010, y: 450 }, { kind: "outer", edge: "right" }],
    ["top, over p-2's strip", { x: 800, y: 4 }, { kind: "outer", edge: "top" }],
    ["top, above the grid", { x: 800, y: -12 }, { kind: "outer", edge: "top" }],
    ["bottom", { x: 200, y: 596 }, { kind: "outer", edge: "bottom" }],
    ["too far outside", { x: -OUTER_OUT - 1, y: 300 }, null],
    ["a corner: the nearer side", { x: 2, y: 6 }, { kind: "outer", edge: "left" }],
    ["a corner: the nearer side, the other way", { x: 7, y: 1 }, { kind: "outer", edge: "top" }],
    ["a corner tie: left first", { x: 4, y: 4 }, { kind: "outer", edge: "left" }],
    // Strips.
    ["p-2's strip, before its tab", { x: 520, y: 20 }, { kind: "strip", pane: "p-2", index: 0 }],
    ["p-2's strip, after its tab", { x: 570, y: 20 }, { kind: "strip", pane: "p-2", index: 1 }],
    ["p-2's strip, in its free space", { x: 900, y: 30 }, { kind: "strip", pane: "p-2", index: 1 }],
    ["p-1's strip, between its tabs", { x: 150, y: 20 }, { kind: "strip", pane: "p-1", index: 1 }],
    ["p-3's strip", { x: 600, y: 320 }, { kind: "strip", pane: "p-3", index: 1 }],
    // Pane edges (p-1's body is x 0..494, y 44..600).
    ["p-1's left edge", { x: 40, y: 300 }, { kind: "edge", pane: "p-1", edge: "left" }],
    ["p-1's right edge", { x: 470, y: 300 }, { kind: "edge", pane: "p-1", edge: "right" }],
    ["p-1's top edge, below the strip", { x: 250, y: 60 }, { kind: "edge", pane: "p-1", edge: "top" }],
    ["p-1's bottom edge", { x: 250, y: 560 }, { kind: "edge", pane: "p-1", edge: "bottom" }],
    ["p-3's top edge", { x: 750, y: 370 }, { kind: "edge", pane: "p-3", edge: "top" }],
    ["p-2's bottom edge", { x: 750, y: 280 }, { kind: "edge", pane: "p-2", edge: "bottom" }],
    // A pane's middle.
    ["p-1's middle", { x: 250, y: 320 }, { kind: "pane", pane: "p-1" }],
    ["p-2's middle", { x: 750, y: 170 }, { kind: "pane", pane: "p-2" }],
    // Gutters.
    ["the column gutter", { x: 500, y: 300 }, null],
    ["the row gutter", { x: 750, y: 300 }, null],
  ])("%s", (_name, p, want) => {
    expect(dropTarget(SCENE, stranger, p)).toEqual(want);
  });

  it("gives the outer band precedence over a strip and a pane's edge, and the strip precedence over the body's top edge", () => {
    // Inside p-1's strip and inside the left band: the band.
    expect(dropTarget(SCENE, stranger, { x: OUTER_IN - 1, y: 20 })).toEqual({ kind: "outer", edge: "left" });
    // Just past the band: the strip.
    expect(dropTarget(SCENE, stranger, { x: OUTER_IN + 1, y: 20 })).toEqual({ kind: "strip", pane: "p-1", index: 0 });
    // Just past the band in the body: p-1's left edge.
    expect(dropTarget(SCENE, stranger, { x: OUTER_IN + 1, y: 300 })).toEqual({ kind: "edge", pane: "p-1", edge: "left" });
    // The last row of the strip is the strip, the first of the body its top edge.
    expect(dropTarget(SCENE, stranger, { x: 250, y: STRIP - 0.5 })).toEqual({ kind: "strip", pane: "p-1", index: 2 });
    expect(dropTarget(SCENE, stranger, { x: 250, y: STRIP })).toEqual({ kind: "edge", pane: "p-1", edge: "top" });
  });

  it("caps an edge zone at 320px across and 260px down in a big pane", () => {
    const big = sceneOf(plainRects(pane("p-x", "thread"), 1600, 1000), { "p-x": ["t-x"] });
    const src = stranger;
    expect(dropTarget(big, src, { x: 319, y: 500 })).toEqual({ kind: "edge", pane: "p-x", edge: "left" });
    expect(dropTarget(big, src, { x: 321, y: 500 })).toEqual({ kind: "pane", pane: "p-x" });
    expect(dropTarget(big, src, { x: 1600 - 319, y: 500 })).toEqual({ kind: "edge", pane: "p-x", edge: "right" });
    expect(dropTarget(big, src, { x: 800, y: 44 + 259 })).toEqual({ kind: "edge", pane: "p-x", edge: "top" });
    expect(dropTarget(big, src, { x: 800, y: 44 + 261 })).toEqual({ kind: "pane", pane: "p-x" });
    expect(dropTarget(big, src, { x: 800, y: 1000 - 259 })).toEqual({ kind: "edge", pane: "p-x", edge: "bottom" });
  });

  it("makes each edge a third of a pane's body below the caps, the middle third the pane", () => {
    // p-1's body: 494 x 556 from y 44, so a third is 164.7 across and 185.3 down.
    expect(dropTarget(SCENE, stranger, { x: 164, y: 320 })).toEqual({ kind: "edge", pane: "p-1", edge: "left" });
    expect(dropTarget(SCENE, stranger, { x: 166, y: 320 })).toEqual({ kind: "pane", pane: "p-1" });
    expect(dropTarget(SCENE, stranger, { x: 494 - 164, y: 320 })).toEqual({ kind: "edge", pane: "p-1", edge: "right" });
    expect(dropTarget(SCENE, stranger, { x: 250, y: 44 + 185 })).toEqual({ kind: "edge", pane: "p-1", edge: "top" });
    expect(dropTarget(SCENE, stranger, { x: 250, y: 44 + 187 })).toEqual({ kind: "pane", pane: "p-1" });
  });

  it("gives a pane too small for a split no edge zones on that axis", () => {
    // p-a is 200 wide (under EDGE_MIN.w) and its body 456 high; p-b's body is 120 high (under EDGE_MIN.h).
    const tree = row("s", [0.2, 0.8], pane("p-a", "file"), col("c", [0.27, 0.73], pane("p-b", "file"), pane("p-c", "file")));
    const frame = plainRects(tree, 1012, 600);
    const scene = sceneOf(frame, { "p-a": ["a"], "p-b": ["b"], "p-c": ["c"] });
    const a = frame.rects["p-a"];
    const b = frame.rects["p-b"];
    if (!a || !b) throw new Error("no rects");
    expect(a.w).toBeLessThan(EDGE_MIN.w);
    expect(b.h - STRIP).toBeLessThan(EDGE_MIN.h);
    const src: DragSource = { kind: "tab", tab: "c", pane: "p-c" };
    // p-a: near its left and right sides is its middle; its top and bottom are edges.
    expect(dropTarget(scene, src, { x: a.x + 20, y: 300 })).toEqual({ kind: "pane", pane: "p-a" });
    expect(dropTarget(scene, src, { x: a.x + a.w - 20, y: 300 })).toEqual({ kind: "pane", pane: "p-a" });
    expect(dropTarget(scene, src, { x: a.x + 100, y: 60 })).toEqual({ kind: "edge", pane: "p-a", edge: "top" });
    // p-b: left and right edges only.
    expect(dropTarget(scene, src, { x: b.x + b.w / 2, y: b.y + STRIP + 5 })).toEqual({ kind: "pane", pane: "p-b" });
    expect(dropTarget(scene, src, { x: b.x + 30, y: b.y + STRIP + 5 })).toEqual({ kind: "edge", pane: "p-b", edge: "left" });
  });

  it("places a strip index by the tabs' centres", () => {
    const tabs = strip(FRAME, "p-1", ["a", "b", "c"]); // centres 56, 158, 260
    expect([0, 56, 57, 158, 159, 260, 261, 480].map((x) => stripIndex(tabs, x))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(stripIndex([], 100)).toBe(0);
  });
});

describe("dropTarget: what a drop could do", () => {
  it("never drops a pane onto itself, and lets it reach every other place", () => {
    expect(dropTarget(SCENE, paneP2, { x: 600, y: 20 })).toBeNull();
    expect(dropTarget(SCENE, paneP2, { x: 750, y: 170 })).toBeNull();
    expect(dropTarget(SCENE, paneP2, { x: 970, y: 170 })).toBeNull();
    expect(dropTarget(SCENE, paneP2, { x: 150, y: 20 })).toEqual({ kind: "strip", pane: "p-1", index: 1 });
    expect(dropTarget(SCENE, paneP2, { x: 250, y: 320 })).toEqual({ kind: "pane", pane: "p-1" });
    expect(dropTarget(SCENE, paneP2, { x: 750, y: 560 })).toEqual({ kind: "edge", pane: "p-3", edge: "bottom" });
    expect(dropTarget(SCENE, paneP2, { x: 995, y: 300 })).toEqual({ kind: "outer", edge: "right" });
  });

  it("lets a tab reorder in its own strip and split off its own pane, but not join its own pane's end", () => {
    expect(dropTarget(SCENE, tabA, { x: 150, y: 20 })).toEqual({ kind: "strip", pane: "p-1", index: 1 });
    expect(dropTarget(SCENE, tabA, { x: 40, y: 300 })).toEqual({ kind: "edge", pane: "p-1", edge: "left" });
    expect(dropTarget(SCENE, tabA, { x: 250, y: 320 })).toBeNull();
  });

  it("does not split a pane's only tab off its own pane", () => {
    expect(dropTarget(SCENE, tabC, { x: 970, y: 170 })).toBeNull();
    expect(dropTarget(SCENE, tabC, { x: 750, y: 170 })).toBeNull();
    // Its own strip stays a target (putting it back where it is moves nothing: drop.ts).
    expect(dropTarget(SCENE, tabC, { x: 520, y: 20 })).toEqual({ kind: "strip", pane: "p-2", index: 0 });
  });

  it("has no outer edge for the grid's only pane, or for its only tab", () => {
    const one = sceneOf(plainRects(pane("p-o", "thread", "diff"), 800, 600), { "p-o": ["t-1", "t-2"] });
    const lone = sceneOf(plainRects(pane("p-o", "thread"), 800, 600), { "p-o": ["t-1"] });
    expect(dropTarget(one, { kind: "pane", pane: "p-o" }, { x: 3, y: 300 })).toBeNull();
    expect(dropTarget(one, { kind: "tab", tab: "t-1", pane: "p-o" }, { x: 3, y: 300 })).toEqual({ kind: "outer", edge: "left" });
    expect(dropTarget(lone, { kind: "tab", tab: "t-1", pane: "p-o" }, { x: 3, y: 300 })).toBeNull();
    expect(dropTarget(lone, { kind: "tab", tab: "t-1", pane: "p-o" }, { x: 40, y: 300 })).toBeNull();
  });

  it("takes a sidebar thread anywhere: a strip, a middle, an edge, the outer edge of a lone pane", () => {
    const thread: DragSource = { kind: "thread", thread: "s-1" };
    const lone = sceneOf(plainRects(pane("p-o", "thread"), 800, 600), { "p-o": ["t-1"] });
    expect(dropTarget(lone, thread, { x: 3, y: 300 })).toEqual({ kind: "outer", edge: "left" });
    expect(dropTarget(lone, thread, { x: 400, y: 300 })).toEqual({ kind: "pane", pane: "p-o" });
    expect(dropTarget(lone, thread, { x: 780, y: 300 })).toEqual({ kind: "edge", pane: "p-o", edge: "right" });
    expect(dropTarget(SCENE, thread, { x: 520, y: 20 })).toEqual({ kind: "strip", pane: "p-2", index: 0 });
  });

  it("finds nothing in an empty frame", () => {
    const empty = sceneOf(plainRects(null, 800, 600), {});
    expect(dropTarget(empty, tabA, { x: 400, y: 300 })).toBeNull();
  });
});

describe("insertionBar", () => {
  it("sits before the tab at the index, after the last tab, or at an empty strip's start", () => {
    expect(insertionBar(SCENE, "p-1", 0)).toEqual({ x: 4, y: 8, h: 28 });
    expect(insertionBar(SCENE, "p-1", 1)).toEqual({ x: 106, y: 8, h: 28 });
    expect(insertionBar(SCENE, "p-1", 2)).toEqual({ x: 209, y: 8, h: 28 });
    expect(insertionBar(SCENE, "p-3", 1)).toEqual({ x: 613, y: 314, h: 28 });
    expect(insertionBar({ ...SCENE, strips: {} }, "p-2", 0)).toEqual({ x: 514, y: 8, h: 28 });
    expect(insertionBar(SCENE, "p-9", 0)).toBeNull();
  });
});

describe("sameTarget", () => {
  it("compares by kind and fields", () => {
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget({ kind: "outer", edge: "left" }, { kind: "outer", edge: "left" })).toBe(true);
    expect(sameTarget({ kind: "outer", edge: "left" }, { kind: "outer", edge: "top" })).toBe(false);
    expect(sameTarget({ kind: "strip", pane: "p", index: 1 }, { kind: "strip", pane: "p", index: 2 })).toBe(false);
    expect(sameTarget({ kind: "edge", pane: "p", edge: "left" }, { kind: "edge", pane: "q", edge: "left" })).toBe(false);
    expect(sameTarget({ kind: "pane", pane: "p" }, { kind: "pane", pane: "p" })).toBe(true);
    expect(sameTarget({ kind: "pane", pane: "p" }, null)).toBe(false);
  });
});

describe("dropTarget: a rail", () => {
  // p-2 folded to a rail: the frame of a small window (shell/geometry/rails.ts).
  const railed: Frame = { ...FRAME, rects: { ...FRAME.rects, "p-2": { ...(FRAME.rects["p-2"] ?? { x: 0, y: 0, w: 0, h: 0 }), rail: true } } };
  const scene = sceneOf(railed, { "p-1": ["t-a", "t-b"], "p-2": ["t-c"], "p-3": ["t-d"] });

  it.each<[string, { x: number; y: number }]>([
    ["where its strip would be", { x: 520, y: 20 }],
    ["near its edge", { x: 520, y: 200 }],
    ["in its middle", { x: 750, y: 150 }],
  ])("is one target as a whole: a tab joins it (%s)", (_name, p) => {
    expect(dropTarget(scene, tabA, p)).toEqual({ kind: "pane", pane: "p-2" });
  });

  it("takes a sidebar thread as a whole: its tab opens there", () => {
    expect(dropTarget(scene, { kind: "thread", thread: "s-1" }, { x: 520, y: 200 })).toEqual({ kind: "pane", pane: "p-2" });
  });

  it("takes no tab of its own, and not itself", () => {
    expect(dropTarget(scene, tabC, { x: 750, y: 150 })).toBeNull();
    expect(dropTarget(scene, paneP2, { x: 750, y: 150 })).toBeNull();
  });
});
