import { describe, expect, it } from "vitest";
import { frameRects, tilingErrors } from "./geometry/rects";
import type { GeoNode } from "./geometry/types";
import { dragSizes, evenSizes, GUTTER_STEP, gutterKeyDelta, sizesArg, startDrag, withSizes } from "./resize";

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
