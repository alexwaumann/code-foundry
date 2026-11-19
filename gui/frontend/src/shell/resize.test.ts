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
  const frame = frameRects(tree, 2400, 1000);

  it("starts from the two kids' drawn lengths and minimums", () => {
    const d = startDrag(tree, frame, "s-r", 0);
    expect(d?.row).toBe(true);
    expect(d?.lens[0]).toBe(frame.rects.a?.w);
    expect(d?.lens[1]).toBe(frame.rects.b?.w);
    // Every pane's minimum is 480 wide (the column's too: its widest pane's).
    expect(d?.mins).toEqual([480, 480]);
  });

  it("trades length between the two kids only, keeping the tree tiled", () => {
    const d = startDrag(tree, frame, "s-r", 0);
    if (!d) throw new Error("no drag");
    const sizes = dragSizes(d, 100);
    expect(sizes[2]).toBe(0.25);
    expect((sizes[0] ?? 0) + (sizes[1] ?? 0)).toBeCloseTo(0.75, 9);
    const moved = frameRects(withSizes(tree, "s-r", sizes), 2400, 1000);
    expect(tilingErrors(moved)).toEqual([]);
    expect(moved.rects.a?.w).toBe((frame.rects.a?.w ?? 0) + 100);
    expect(moved.rects.d?.w).toBe(frame.rects.d?.w);
  });

  it("stops each kid at its minimum", () => {
    const d = startDrag(tree, frame, "s-r", 0);
    if (!d) throw new Error("no drag");
    const far = frameRects(withSizes(tree, "s-r", dragSizes(d, 5000)), 2400, 1000);
    expect(far.rects.b?.w).toBe(480);
    const back = frameRects(withSizes(tree, "s-r", dragSizes(d, -5000)), 2400, 1000);
    expect(back.rects.a?.w).toBe(480);
  });

  it("works down a column", () => {
    const d = startDrag(tree, frame, "s-c", 0);
    if (!d) throw new Error("no drag");
    expect(d.row).toBe(false);
    const moved = frameRects(withSizes(tree, "s-c", dragSizes(d, -50)), 2400, 1000);
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
  const frame = frameRects(tree, 2400, 1000);

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
    expect(frameRects(withSizes(tree, "s-r", dragSizes(d, -Infinity)), 2400, 1000).rects.a?.w).toBe(480);
    expect(frameRects(withSizes(tree, "s-r", dragSizes(d, Infinity)), 2400, 1000).rects.b?.w).toBe(480);
  });

  it("a double click evens the two kids beside it, the others keep theirs", () => {
    const d = startDrag(tree, frame, "s-r", 0);
    if (!d) throw new Error("no drag");
    const even = frameRects(withSizes(tree, "s-r", evenSizes(d)), 2400, 1000);
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
    // A diff's 480 would count without the rail; the terminal's 300 is what the column needs.
    expect(startDrag(t, f, "s-r", 0)?.mins).toEqual([480, 300]);
    const far = frameRects(withSizes(t, "s-r", dragSizes(startDrag(t, f, "s-r", 0) as GutterDrag, 5000)), 1200, 800);
    expect(far.rects.c?.w).toBe(300);
  });

  // a thread held at its 480 minimum (its share is 10%), two diffs sharing the rest.
  const held: GeoNode = { t: "split", id: "s-r", dir: "row", sizes: [0.1, 0.45, 0.45], kids: [p("a", "thread"), p("b"), p("c")] };

  it("starts from what is drawn: grabbing it beside a pane held at its minimum moves nothing", () => {
    const f = frameRects(held, 1600, 800);
    expect(f.rects.a?.w).toBe(480);
    const d = startDrag(held, f, "s-r", 0);
    if (!d) throw new Error("no drag");
    // From the stored sizes (as before this rule) the diff beside it jumped from 548 to 480 px (its own minimum).
    expect(f.rects.b?.w).toBe(548);
    expect(frameRects(withSizes(held, "s-r", dragSizes({ ...d, sizes: [0.1, 0.45, 0.45] }, 0)), 1600, 800).rects.b?.w).toBe(480);
    const still = frameRects(withSizes(held, "s-r", dragSizes(d, 0)), 1600, 800);
    for (const id of ["a", "b", "c"]) expect(Math.abs((still.rects[id]?.w ?? 0) - (f.rects[id]?.w ?? 0)), id).toBeLessThanOrEqual(1);
    const moved = frameRects(withSizes(held, "s-r", dragSizes(d, 40)), 1600, 800);
    expect(Math.abs((moved.rects.a?.w ?? 0) - 520)).toBeLessThanOrEqual(1);
    expect(Math.abs((moved.rects.c?.w ?? 0) - (f.rects.c?.w ?? 0))).toBeLessThanOrEqual(1);
  });

  it("keeps the stored sizes when the split is drawn at them, and a folded side's stored size always", () => {
    const f = frameRects(tree, 2400, 1000);
    expect(startDrag(tree, f, "s-r", 0)?.sizes).toBe((tree as { sizes: readonly number[] }).sizes);
    const t: GeoNode = { t: "split", id: "s-r", dir: "row", sizes: [0.1, 0.3, 0.3, 0.3], kids: [p("a", "thread"), p("b"), collapsed(p("x")), p("c")] };
    const g = shellFrame({ root: t, w: 2000, h: 800, focus: "a" });
    expect(g.rects.a?.w).toBe(480);
    expect(startDrag(t, g, "s-r", 0)?.sizes[2]).toBe(0.3);
  });

  it.each<[string, GutterDrag, number, { back: boolean; forward: boolean }, string, string]>([
    ["room both ways", { split: "s", i: 0, a: 0, b: 1, row: true, sizes: [0.5, 0.5], lens: [500, 500], mins: [300, 300] }, 0, { back: true, forward: true }, "col-resize", "row-resize"],
    ["the first side at its minimum", { split: "s", i: 0, a: 0, b: 1, row: true, sizes: [0.5, 0.5], lens: [300, 700], mins: [300, 300] }, 0, { back: false, forward: true }, "e-resize", "s-resize"],
    ["the second side at its minimum", { split: "s", i: 0, a: 0, b: 1, row: true, sizes: [0.5, 0.5], lens: [700, 300], mins: [300, 300] }, 0, { back: true, forward: false }, "w-resize", "n-resize"],
    ["dragged to the second side's minimum", { split: "s", i: 0, a: 0, b: 1, row: true, sizes: [0.5, 0.5], lens: [500, 500], mins: [300, 300] }, 900, { back: true, forward: false }, "w-resize", "n-resize"],
    ["both sides at their minimums", { split: "s", i: 0, a: 0, b: 1, row: true, sizes: [0.5, 0.5], lens: [300, 300], mins: [300, 300] }, 0, { back: false, forward: false }, "not-allowed", "not-allowed"],
    ["minimums that do not fit", { split: "s", i: 0, a: 0, b: 1, row: true, sizes: [0.5, 0.5], lens: [250, 250], mins: [300, 300] }, 0, { back: false, forward: false }, "not-allowed", "not-allowed"],
  ])("%s: it can go %j, its cursor in a row %s, in a column %s", (_name, d, delta, reach, rowCursor, colCursor) => {
    expect(gutterReach(d, delta)).toEqual(reach);
    expect(gutterCursor(true, reach)).toBe(rowCursor);
    expect(gutterCursor(false, reach)).toBe(colCursor);
  });

  it("a gutter with no drag (no open kid on a side) is not-allowed", () => {
    expect(gutterCursor(true, null)).toBe("not-allowed");
  });
});

/**
 * A run of rails between two open panes acts as one divider (docs/notes/shell-model.md,
 * "Dividers"; docs/notes/fix-resize-across-collapsed.md): every gutter in it trades length between
 * the nearest open kid on each side, the rails keep their stored sizes and ride along.
 */
describe("a divider across rails", () => {
  const collapsed = (n: GeoNode): GeoNode => ({ ...(n as GeoPane), collapsed: true });
  const split = (dir: "row" | "col", sizes: number[], kids: GeoNode[]): GeoNode => ({ t: "split", id: "s", dir, sizes, kids });
  const along = (dir: "row" | "col") => (r: { w: number; h: number } | undefined) => (dir === "row" ? r?.w : r?.h) ?? 0;
  const at = (dir: "row" | "col") => (r: { x: number; y: number } | undefined) => (dir === "row" ? r?.x : r?.y) ?? 0;

  it.each<[string, "row" | "col", number[], GeoNode[], number, number, number]>([
    ["one collapsed pane in a row", "row", [0.4, 0.2, 0.4], [p("a", "thread"), collapsed(p("x")), p("b")], 1600, 1000, 2],
    ["two collapsed panes in a row", "row", [0.3, 0.2, 0.2, 0.3], [p("a", "thread"), collapsed(p("x")), collapsed(p("y")), p("b")], 1600, 1000, 3],
    ["one collapsed pane in a column", "col", [0.4, 0.2, 0.4], [p("a", "terminal"), collapsed(p("x")), p("b", "terminal")], 1000, 1200, 2],
    [
      "a column of collapsed panes in a row",
      "row",
      [0.4, 0.2, 0.4],
      [p("a", "thread"), { t: "split", id: "c", dir: "col", sizes: [0.5, 0.5], kids: [collapsed(p("x")), collapsed(p("y"))] }, p("b")],
      1600,
      1000,
      2,
    ],
  ])("%s: every gutter pairs the open panes, which trade length while the rails ride along", (_name, dir, sizes, kids, w, h, b) => {
    const t = split(dir, sizes, kids);
    const f = frameRects(t, w, h);
    const len = along(dir);
    const pos = at(dir);
    const before = (id: string) => f.rects[id];
    const results = kids.slice(1).map((_, i) => {
      const d = startDrag(t, f, "s", i);
      if (!d) throw new Error(`no drag at ${String(i)}`);
      expect([d.i, d.a, d.b]).toEqual([i, 0, b]);
      expect(d.lens).toEqual([len(before("a")), len(before("b"))]);
      return dragSizes(d, 60);
    });
    // Every gutter in the run moves the same two kids the same way.
    for (const r of results) expect(r).toEqual(results[0]);
    const moved = results[0] ?? [];
    // The rails' stored sizes are untouched; the pair's total is kept.
    for (let j = 1; j < b; j++) expect(moved[j]).toBe(sizes[j]);
    expect((moved[0] ?? 0) + (moved[b] ?? 0)).toBeCloseTo((sizes[0] ?? 0) + (sizes[b] ?? 0), 9);
    const g = frameRects(withSizes(t, "s", moved), w, h);
    expect(tilingErrors(g)).toEqual([]);
    expect(len(g.rects.a)).toBe(len(before("a")) + 60);
    expect(len(g.rects.b)).toBe(len(before("b")) - 60);
    for (const id of ["x", "y"].filter((id) => f.rects[id])) {
      expect(g.rects[id]?.rail, id).toBe(true);
      expect(len(g.rects[id]), id).toBe(len(before(id)));
      expect(pos(g.rects[id]), id).toBe(pos(before(id)) + 60);
    }
  });

  const t = split("row", [0.4, 0.2, 0.4], [p("a", "thread"), collapsed(p("x")), p("b")]);
  const f = frameRects(t, 1600, 1000);

  it("stops each open pane at its minimum, from either gutter, keys and Home/End alike", () => {
    for (const i of [0, 1]) {
      const d = startDrag(t, f, "s", i);
      if (!d) throw new Error("no drag");
      expect(d.mins).toEqual([480, 480]);
      expect(gutterReach(d)).toEqual({ back: true, forward: true });
      expect(frameRects(withSizes(t, "s", dragSizes(d, Infinity)), 1600, 1000).rects.b?.w).toBe(480);
      expect(frameRects(withSizes(t, "s", dragSizes(d, -Infinity)), 1600, 1000).rects.a?.w).toBe(480);
      expect(gutterReach(d, 5000)).toEqual({ back: true, forward: false });
    }
  });

  it("a double click on either gutter evens the open panes, the rail between keeps its size", () => {
    for (const i of [0, 1]) {
      const d = startDrag(withSizes(t, "s", [0.6, 0.2, 0.2]), frameRects(withSizes(t, "s", [0.6, 0.2, 0.2]), 1600, 1000), "s", i);
      if (!d) throw new Error("no drag");
      const sizes = evenSizes(d);
      expect(sizes[1]).toBe(0.2);
      const even = frameRects(withSizes(t, "s", sizes), 1600, 1000);
      expect(Math.abs((even.rects.a?.w ?? 0) - (even.rects.b?.w ?? 0))).toBeLessThanOrEqual(1);
    }
  });

  it("a collapsed pane opened after the drag takes its stored share", () => {
    const d = startDrag(t, f, "s", 0);
    if (!d) throw new Error("no drag");
    const sizes = dragSizes(d, 200);
    const reopened = split("row", sizes, [p("a", "thread"), p("x"), p("b")]);
    // 1576 px to share: x's fifth is under its minimum, so it opens at 480, every pane at least its
    // minimum, the one dragged larger still the larger.
    const here = frameRects(reopened, 1600, 1000);
    expect(here.rects.x?.w).toBe(480);
    expect(here.rects.b?.w).toBe(480);
    expect(here.rects.a?.w).toBe(1576 - 960);
    // With room, it opens at its stored fifth.
    const wide = frameRects(reopened, 3000, 1000);
    expect(Math.abs((wide.rects.x?.w ?? 0) - 0.2 * 2976)).toBeLessThanOrEqual(1);
  });

  it("no drag where a side has no open pane: a collapsed pane at the edge, or a run of them", () => {
    const edge = split("row", [0.2, 0.4, 0.4], [collapsed(p("x")), p("a", "thread"), p("b")]);
    expect(startDrag(edge, frameRects(edge, 1600, 1000), "s", 0)).toBeNull();
    expect(startDrag(edge, frameRects(edge, 1600, 1000), "s", 1)?.a).toBe(1);
    const run = split("row", [0.4, 0.2, 0.2, 0.2], [p("a", "thread"), p("b"), collapsed(p("x")), collapsed(p("y"))]);
    const g = frameRects(run, 1600, 1000);
    expect([0, 1, 2].map((i) => startDrag(run, g, "s", i) !== null)).toEqual([true, false, false]);
  });

  it("pairs across a pane the window folded too", () => {
    // Three diffs in 1300px: the middle one folds (the focused a and the last b stay).
    const three = split("row", [0.4, 0.2, 0.4], [p("a", "thread"), p("x"), p("b")]);
    const g = shellFrame({ root: three, w: 1300, h: 800, focus: "a", mru: ["t-a", "t-b"] });
    expect(g.rects.x?.rail).toBe(true);
    expect(g.gutters.map((gu) => gu.fixed)).toEqual([false, false]);
    const d = startDrag(three, g, "s", 1);
    expect([d?.a, d?.b]).toEqual([0, 2]);
  });
});
