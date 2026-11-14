/**
 * Panes the user collapsed (pane.collapse) in the geometry: always rails, never in the fold order,
 * their room shared by the stored proportions, which stay as they were. docs/notes/shell-model.md
 * "Collapsing a pane"; docs/notes/shell-25d-collapse.md.
 */
import { describe, expect, it } from "vitest";
import { col, pane, randomTree, rng, row } from "@/test/shellTrees";
import { foldOrder, foldRails, shellFrame } from "./rails";
import { GUTTER, RAIL, frameRects, minimumOf, plainRects, tilingErrors } from "./rects";
import { collapsedOf, panesOf, type GeoNode, type GeoPane } from "./types";

/** Freezes a tree all the way down, so any write to the stored layout throws. */
function frozen<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(frozen);
    Object.freeze(v);
  }
  return v;
}

const collapsed = (p: GeoPane): GeoPane => ({ ...p, collapsed: true });

// a: thread, b: Pull Requests, collapsed, c: a diff; each 480 wide at least when open.
const three = frozen(row("s", [0.25, 0.25, 0.5], pane("a", "thread:A"), collapsed(pane("b", "prs")), pane("c", "diff:A")));

describe("a collapsed pane", () => {
  it("is a rail at any size, and its neighbours share its room by the stored proportions", () => {
    const f = shellFrame({ root: three, w: 2424, h: 800, focus: "a" });
    expect(f.rects.b).toEqual({ x: 800, y: 0, w: RAIL, h: 800, rail: true });
    // 2424 less two gutters and the rail: 2364, shared 1 : 2.
    expect(f.rects.a?.w).toBe(788);
    expect(f.rects.c?.w).toBe(1576);
    expect(tilingErrors(f)).toEqual([]);
    expect(three.sizes).toEqual([0.25, 0.25, 0.5]);
  });

  it("opened again, every pane is back at its old size", () => {
    const opened = row("s", [0.25, 0.25, 0.5], pane("a", "thread:A"), pane("b", "prs"), pane("c", "diff:A"));
    const f = shellFrame({ root: opened, w: 2424, h: 800, focus: "a" });
    expect([f.rects.a?.w, f.rects.b?.w, f.rects.c?.w]).toEqual([600, 600, 1200]);
  });

  it("is not in the fold order and never unfolds, with room or with the focus", () => {
    expect(foldOrder(three, "a")).toEqual(["c"]);
    expect([...foldRails({ root: three, w: 4000, h: 2000, focus: "b" })]).toEqual(["b"]);
    expect(shellFrame({ root: three, w: 4000, h: 2000, focus: "b" }).rects.b?.rail).toBe(true);
  });

  it("automatic folding goes on for the other panes", () => {
    // 480 + 36 + 480 and two gutters is 1020: below it the diff folds as it would beside an open pane.
    expect([...foldRails({ root: three, w: 1019, h: 800, focus: "a" })].sort()).toEqual(["b", "c"]);
    expect([...foldRails({ root: three, w: 1020, h: 800, focus: "a" })]).toEqual(["b"]);
  });

  it("in a column is a strip; a column narrows only when every pane in it is folded", () => {
    const tree = row("s", [0.5, 0.5], pane("a", "thread:A"), col("c", [0.5, 0.5], collapsed(pane("b", "prs")), pane("d", "diff")));
    const f = shellFrame({ root: tree, w: 1212, h: 800, focus: "a" });
    expect(f.rects.b).toMatchObject({ w: 600, h: RAIL, rail: true });
    expect(f.rects.d).toMatchObject({ y: RAIL + GUTTER, h: 800 - RAIL - GUTTER, rail: false });
    const both = row("s", [0.5, 0.5], pane("a", "thread:A"), col("c", [0.5, 0.5], collapsed(pane("b", "prs")), collapsed(pane("d", "diff"))));
    const g = shellFrame({ root: both, w: 1212, h: 800, focus: "a" });
    expect(g.rects.b?.w).toBe(RAIL);
    expect(g.rects.a?.w).toBe(1212 - RAIL - GUTTER);
  });

  it("counts as a rail in the minimum and in the plain layout (the daemon's Rects)", () => {
    expect(minimumOf(three).w).toBe(480 + RAIL + 480 + 2 * GUTTER);
    const p = plainRects(three, 1644, 800);
    expect([p.rects.a?.w, p.rects.b?.w, p.rects.c?.w]).toEqual([528, RAIL, 1056]);
  });

  it("is a rail in frameRects even when the caller's rails leave it out", () => {
    expect(frameRects(three, 1644, 800).rects.b?.rail).toBe(true);
  });
});

describe("collapsed panes in random trees", () => {
  /** A random tree with some of its panes collapsed, never all. */
  function withCollapsed(rand: () => number, root: GeoNode): GeoNode {
    const ids = panesOf(root).map((p) => p.id);
    const keep = ids[Math.floor(rand() * ids.length)];
    const mark = (n: GeoNode): GeoNode => (n.t === "pane" ? (n.id !== keep && rand() < 0.4 ? { ...n, collapsed: true } : n) : { ...n, kids: n.kids.map(mark) });
    return mark(root);
  }

  it("tile their area, draw every collapsed pane as a rail, and fold only the others", () => {
    const rand = rng(25);
    for (let i = 0; i < 300; i++) {
      const root = frozen(withCollapsed(rand, randomTree(rand)));
      const ids = panesOf(root).map((p) => p.id);
      // Never smaller than the tree with every pane a rail: a split shorter than its gutters cannot tile (shell-9-geometry.md).
      const floor = minimumOf(root, new Set(ids));
      const w = Math.max(floor.w, 300 + Math.floor(rand() * 2000));
      const h = Math.max(floor.h, 300 + Math.floor(rand() * 1200));
      const focus = ids[Math.floor(rand() * ids.length)];
      const rails = foldRails({ root, w, h, focus });
      const f = shellFrame({ root, w, h, focus });
      expect(tilingErrors(f), `tree ${String(i)}`).toEqual([]);
      for (const id of collapsedOf(root)) {
        expect(rails.has(id)).toBe(true);
        expect(f.rects[id]?.rail).toBe(true);
      }
      expect(foldOrder(root, focus).some((id) => collapsedOf(root).has(id))).toBe(false);
    }
  });
});
