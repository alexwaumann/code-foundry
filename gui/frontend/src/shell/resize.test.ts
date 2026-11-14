import { describe, expect, it } from "vitest";
import { shellFrame } from "./geometry/rails";
import { frameRects, tilingErrors } from "./geometry/rects";
import type { GeoNode, GeoPane } from "./geometry/types";
import { dragSizes, evenSizes, GUTTER_STEP, gutterCursor, gutterKeyDelta, gutterReach, sizesArg, startDrag, withSizes, type GutterDrag } from "./resize";

const p = (id: string, kind = "diff"): GeoNode => ({ t: "pane", id, tabs: [{ id: `t-${id}`, kind }], active: `t-${id}` });
const tree: GeoNode = {
  t: "split",
  id: "s-r",
  dir: "row",
  kids: [p("a", "thread"), { t: "split", id: "s-c", dir: "col", kids: [p("b"), p("c")], sizes: [0.5, 0.5] }, p("d")],
  sizes: [0.5, 0.25, 0.25],
};

describe("dragging a gutter", () => {
  const frame = frameRects(tree, 1600, 900);

  it("starts from the two kids' drawn lengths and minimums", () => {
    const d = startDrag(tree, frame, "s-r", 0);
    expect(d?.row).toBe(true);
    expect(d?.lens[0]).toBe(frame.rects.a?.w);
    expect(d?.lens[1]).toBe(frame.rects.b?.w);
    // A thread pane's minimum is 360 wide; a diff's 260.
    expect(d?.mins).toEqual([360, 260]);
  });

  it("trades length between the two kids only, keeping the tree tiled", () => {
    const d = startDrag(tree, frame, "s-r", 0);
    if (!d) throw new Error("no drag");
    const sizes = dragSizes(d, 100);
    expect(sizes[2]).toBe(0.25);
    expect((sizes[0] ?? 0) + (sizes[1] ?? 0)).toBeCloseTo(0.75, 9);
    const moved = frameRects(withSizes(tree, "s-r", sizes), 1600, 900);
    expect(tilingErrors(moved)).toEqual([]);
    expect(moved.rects.a?.w).toBe((frame.rects.a?.w ?? 0) + 100);
    expect(moved.rects.d?.w).toBe(frame.rects.d?.w);
  });

  it("stops each kid at its minimum", () => {
    const d = startDrag(tree, frame, "s-r", 0);
    if (!d) throw new Error("no drag");
    const far = frameRects(withSizes(tree, "s-r", dragSizes(d, 5000)), 1600, 900);
    expect(far.rects.b?.w).toBe(260);
    const back = frameRects(withSizes(tree, "s-r", dragSizes(d, -5000)), 1600, 900);
    expect(back.rects.a?.w).toBe(360);
  });

  it("works down a column", () => {
    const d = startDrag(tree, frame, "s-c", 0);
    if (!d) throw new Error("no drag");
    expect(d.row).toBe(false);
    const moved = frameRects(withSizes(tree, "s-c", dragSizes(d, -50)), 1600, 900);
    expect(moved.rects.b?.h).toBe((frame.rects.b?.h ?? 0) - 50);
    expect(tilingErrors(moved)).toEqual([]);
  });

  it("knows no drag for a split or gutter that is not there", () => {
    expect(startDrag(tree, frame, "s-x", 0)).toBeNull();
    expect(startDrag(tree, frame, "s-c", 1)).toBeNull();
    expect(withSizes(tree, "s-x", [1])).toBe(tree);
  });

  it("sends sizes with enough digits and no more", () => {
    expect(sizesArg([1 / 3, 2 / 3])).toBe("0.333333,0.666667");
  });
});

describe("a gutter's keys and double click", () => {
  const frame = frameRects(tree, 1600, 900);

  it.each([
    ["ArrowLeft", false, -GUTTER_STEP],
    ["ArrowUp", false, -GUTTER_STEP],
    ["ArrowRight", false, GUTTER_STEP],
    ["ArrowDown", true, 4 * GUTTER_STEP],
    ["ArrowLeft", true, -4 * GUTTER_STEP],
    ["Home", false, -Infinity],
    ["End", false, Infinity],
    ["Enter", false, null],
    ["a", false, null],
  ])("%s (shift %s) moves it %s", (key, shift, want) => {
    expect(gutterKeyDelta(key, shift)).toBe(want);
  });

  it("Home and End go to the bounds: each kid at its minimum", () => {
    const d = startDrag(tree, frame, "s-r", 0);
    if (!d) throw new Error("no drag");
    expect(frameRects(withSizes(tree, "s-r", dragSizes(d, -Infinity)), 1600, 900).rects.a?.w).toBe(360);
    expect(frameRects(withSizes(tree, "s-r", dragSizes(d, Infinity)), 1600, 900).rects.b?.w).toBe(260);
  });

  it("a double click evens the two kids beside it, the others keep theirs", () => {
    const d = startDrag(tree, frame, "s-r", 0);
    if (!d) throw new Error("no drag");
    const even = frameRects(withSizes(tree, "s-r", evenSizes(d)), 1600, 900);
    expect(Math.abs((even.rects.a?.w ?? 0) - (even.rects.b?.w ?? 0))).toBeLessThanOrEqual(1);
    expect(even.rects.d?.w).toBe(frame.rects.d?.w);
    expect(tilingErrors(even)).toEqual([]);
  });
});

/**
 * The divider's rule (docs/notes/shell-model.md, "Dividers"; docs/notes/shell-25d-collapse.md): it
 * stops at the minimums as drawn (a folded or collapsed pane at a rail's thickness), a drag starts
 * from what is drawn so the divider does not jump, and the cursor says which ways it can still go.
 */
describe("a divider beside rails and held panes", () => {
  const collapsed = (n: GeoNode): GeoNode => ({ ...(n as GeoPane), collapsed: true });

  it("reads a side's minimum with its rails folded: a column with a collapsed pane needs only its open pane's width", () => {
    const t: GeoNode = { t: "split", id: "s-r", dir: "row", sizes: [0.5, 0.5], kids: [p("a", "thread"), { t: "split", id: "s-c", dir: "col", sizes: [0.5, 0.5], kids: [collapsed(p("b")), p("c", "terminal")] }] };
    const f = shellFrame({ root: t, w: 1200, h: 800, focus: "a" });
    // A diff's 260 would count without the rail; the terminal's 240 is what the column needs.
    expect(startDrag(t, f, "s-r", 0)?.mins).toEqual([360, 240]);
    const far = frameRects(withSizes(t, "s-r", dragSizes(startDrag(t, f, "s-r", 0) as GutterDrag, 5000)), 1200, 800);
    expect(far.rects.c?.w).toBe(240);
  });

  // a thread held at its 360 minimum (its share is 10%), two diffs sharing the rest.
  const held: GeoNode = { t: "split", id: "s-r", dir: "row", sizes: [0.1, 0.45, 0.45], kids: [p("a", "thread"), p("b"), p("c")] };

  it("starts from what is drawn: grabbing it beside a pane held at its minimum moves nothing", () => {
    const f = frameRects(held, 1000, 800);
    expect(f.rects.a?.w).toBe(360);
    const d = startDrag(held, f, "s-r", 0);
    if (!d) throw new Error("no drag");
    // From the stored sizes (as before this rule) the diff beside it jumped from 308 to 260 px (its own minimum).
    expect(f.rects.b?.w).toBe(308);
    expect(frameRects(withSizes(held, "s-r", dragSizes({ ...d, sizes: [0.1, 0.45, 0.45] }, 0)), 1000, 800).rects.b?.w).toBe(260);
    const still = frameRects(withSizes(held, "s-r", dragSizes(d, 0)), 1000, 800);
    for (const id of ["a", "b", "c"]) expect(Math.abs((still.rects[id]?.w ?? 0) - (f.rects[id]?.w ?? 0)), id).toBeLessThanOrEqual(1);
    const moved = frameRects(withSizes(held, "s-r", dragSizes(d, 40)), 1000, 800);
    expect(Math.abs((moved.rects.a?.w ?? 0) - 400)).toBeLessThanOrEqual(1);
    expect(Math.abs((moved.rects.c?.w ?? 0) - (f.rects.c?.w ?? 0))).toBeLessThanOrEqual(1);
  });

  it("keeps the stored sizes when the split is drawn at them, and a folded side's stored size always", () => {
    const f = frameRects(tree, 1600, 900);
    expect(startDrag(tree, f, "s-r", 0)?.sizes).toBe((tree as { sizes: readonly number[] }).sizes);
    const t: GeoNode = { t: "split", id: "s-r", dir: "row", sizes: [0.1, 0.3, 0.3, 0.3], kids: [p("a", "thread"), p("b"), collapsed(p("x")), p("c")] };
    const g = shellFrame({ root: t, w: 1000, h: 800, focus: "a" });
    expect(g.rects.a?.w).toBe(360);
    expect(startDrag(t, g, "s-r", 0)?.sizes[2]).toBe(0.3);
  });

  it.each<[string, GutterDrag, number, { back: boolean; forward: boolean }, string, string]>([
    ["room both ways", { split: "s", i: 0, row: true, sizes: [0.5, 0.5], lens: [500, 500], mins: [300, 300] }, 0, { back: true, forward: true }, "col-resize", "row-resize"],
    ["the first side at its minimum", { split: "s", i: 0, row: true, sizes: [0.5, 0.5], lens: [300, 700], mins: [300, 300] }, 0, { back: false, forward: true }, "e-resize", "s-resize"],
    ["the second side at its minimum", { split: "s", i: 0, row: true, sizes: [0.5, 0.5], lens: [700, 300], mins: [300, 300] }, 0, { back: true, forward: false }, "w-resize", "n-resize"],
    ["dragged to the second side's minimum", { split: "s", i: 0, row: true, sizes: [0.5, 0.5], lens: [500, 500], mins: [300, 300] }, 900, { back: true, forward: false }, "w-resize", "n-resize"],
    ["both sides at their minimums", { split: "s", i: 0, row: true, sizes: [0.5, 0.5], lens: [300, 300], mins: [300, 300] }, 0, { back: false, forward: false }, "not-allowed", "not-allowed"],
    ["minimums that do not fit", { split: "s", i: 0, row: true, sizes: [0.5, 0.5], lens: [250, 250], mins: [300, 300] }, 0, { back: false, forward: false }, "not-allowed", "not-allowed"],
  ])("%s: it can go %j, its cursor in a row %s, in a column %s", (_name, d, delta, reach, rowCursor, colCursor) => {
    expect(gutterReach(d, delta)).toEqual(reach);
    expect(gutterCursor(true, reach)).toBe(rowCursor);
    expect(gutterCursor(false, reach)).toBe(colCursor);
  });

  it("a gutter with no drag (beside a side that is all rails) is not-allowed", () => {
    expect(gutterCursor(true, null)).toBe("not-allowed");
  });
});
