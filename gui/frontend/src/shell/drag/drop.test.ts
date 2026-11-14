import { describe, expect, it } from "vitest";
import drops from "../../../../../internal/layout/testdata/drops.json?raw";
import { shellFrame } from "@/shell/geometry/rails";
import { frameRects, plainRects, tilingErrors } from "@/shell/geometry/rects";
import { panesOf, type GeoNode } from "@/shell/geometry/types";
import { col, pane, randomTree, rng, row } from "@/test/shellTrees";
import { dropCommand, dropPreview, shellDropLayout, treeAfterDrop } from "./drop";
import type { DragSource, DropTarget, Edge } from "./targets";

const tab = (t: string, p: string): DragSource => ({ kind: "tab", tab: t, pane: p });
const whole = (p: string): DragSource => ({ kind: "pane", pane: p });

describe("dropCommand", () => {
  const own = ["t-a", "t-b", "t-c"];
  it.each<[string, DragSource, DropTarget, ReturnType<typeof dropCommand>]>([
    ["a tab into another strip", tab("t-a", "p-1"), { kind: "strip", pane: "p-2", index: 1 }, { name: "tab.move", args: { tab: "t-a", pane: "p-2", index: "1" } }],
    ["a tab onto another pane", tab("t-a", "p-1"), { kind: "pane", pane: "p-2" }, { name: "tab.move", args: { tab: "t-a", pane: "p-2" } }],
    ["a tab onto a pane's edge", tab("t-a", "p-1"), { kind: "edge", pane: "p-2", edge: "bottom" }, { name: "tab.move", args: { tab: "t-a", split: "p-2", edge: "bottom" } }],
    ["a tab onto its own pane's edge", tab("t-a", "p-1"), { kind: "edge", pane: "p-1", edge: "right" }, { name: "tab.move", args: { tab: "t-a", split: "p-1", edge: "right" } }],
    ["a tab onto the outer edge", tab("t-a", "p-1"), { kind: "outer", edge: "left" }, { name: "tab.move", args: { tab: "t-a", outer: "left" } }],
    ["a reorder later in its strip", tab("t-a", "p-1"), { kind: "strip", pane: "p-1", index: 3 }, { name: "tab.move", args: { tab: "t-a", pane: "p-1", index: "3" } }],
    ["a reorder earlier in its strip", tab("t-c", "p-1"), { kind: "strip", pane: "p-1", index: 0 }, { name: "tab.move", args: { tab: "t-c", pane: "p-1", index: "0" } }],
    ["a tab put back before itself", tab("t-b", "p-1"), { kind: "strip", pane: "p-1", index: 1 }, null],
    ["a tab put back after itself", tab("t-b", "p-1"), { kind: "strip", pane: "p-1", index: 2 }, null],
    ["a pane into a strip", whole("p-1"), { kind: "strip", pane: "p-2", index: 0 }, { name: "pane.move", args: { pane: "p-1", into: "p-2", index: "0" } }],
    ["a pane onto another pane", whole("p-1"), { kind: "pane", pane: "p-2" }, { name: "pane.move", args: { pane: "p-1", into: "p-2" } }],
    ["a pane onto an edge", whole("p-1"), { kind: "edge", pane: "p-2", edge: "top" }, { name: "pane.move", args: { pane: "p-1", beside: "p-2", edge: "top" } }],
    ["a pane onto the outer edge", whole("p-1"), { kind: "outer", edge: "bottom" }, { name: "pane.move", args: { pane: "p-1", outer: "bottom" } }],
  ])("%s", (_name, source, target, want) => {
    expect(dropCommand(source, target, own)).toEqual(want);
  });
});

/** A tree's shape without node ids: what the daemon and the preview must agree on. */
function shape(n: GeoNode | null): unknown {
  if (!n) return null;
  if (n.t === "pane") return (n.tabs ?? []).map((t) => t.id);
  return { dir: n.dir, sizes: n.sizes.map((s) => Number(s.toFixed(9))), kids: n.kids.map(shape) };
}

interface Case {
  doc: string;
  state: { spaces: { id: string; root: GeoNode | null }[]; current_space: string };
  op: { op: string; tab?: string; pane?: string; target?: string; edge?: Edge; frac?: number; space?: string; w?: number; h?: number };
  want?: { spaces: { id: string; root: GeoNode | null }[] };
}

function findTabPane(root: GeoNode | null, tabId: string): string | null {
  return panesOf(root).find((p) => (p.tabs ?? []).some((t) => t.id === tabId))?.id ?? null;
}

/** The fixture's op as a drag and drop, when it is one (an edge or the outer edge, in one space). */
function asDrop(c: Case): { space: string; source: DragSource; target: DropTarget; frac?: number; area: { w: number; h: number } } | null {
  const o = c.op;
  if (!o.edge || o.space) return null;
  const sp = c.state.spaces.find((s) => (o.op === "move_pane" ? panesOf(s.root).some((p) => p.id === o.pane) : findTabPane(s.root, o.tab ?? "")));
  if (!sp) return null;
  const { frac } = o;
  const area = { w: o.w ?? 0, h: o.h ?? 0 };
  if (o.op === "move_pane") return { space: sp.id, source: whole(o.pane ?? ""), target: o.target ? { kind: "edge", pane: o.target, edge: o.edge } : { kind: "outer", edge: o.edge }, frac, area };
  if (o.op === "move_tab") {
    const from = findTabPane(sp.root, o.tab ?? "") ?? "";
    return { space: sp.id, source: tab(o.tab ?? "", from), target: o.pane ? { kind: "edge", pane: o.pane, edge: o.edge } : { kind: "outer", edge: o.edge }, frac, area };
  }
  return null;
}

describe("treeAfterDrop matches the daemon's ops (internal/layout/testdata/ops)", () => {
  const files = import.meta.glob<string>("../../../../../internal/layout/testdata/ops/{move_tab,move_pane}-*.json", { query: "?raw", import: "default", eager: true });
  const cases = Object.entries(files)
    .map(([path, raw]) => [path.slice(path.lastIndexOf("/") + 1), JSON.parse(raw) as Case] as const)
    .flatMap(([f, c]) => {
      const d = asDrop(c);
      return d && c.want ? [[f, c, d] as const] : [];
    });

  it("finds the edge and outer cases", () => {
    expect(cases.map(([f]) => f)).toEqual(expect.arrayContaining(["move_pane-beside.json", "move_pane-beside-half.json", "move_pane-outer.json", "move_pane-outer-floor.json", "move_pane-outer-floor-no-room.json", "move_tab-to-edge.json", "move_tab-outer-edge.json", "move_tab-outer-kind-size.json", "move_tab-own-edge-only-tab.json"]));
  });

  it.each(cases)("%s", (_f, c, d) => {
    const root = c.state.spaces.find((s) => s.id === d.space)?.root ?? null;
    const want = c.want?.spaces.find((s) => s.id === d.space)?.root ?? null;
    if (!root) throw new Error("no root");
    const after = treeAfterDrop(root, d.source, d.target, d.area, d.frac);
    // A drop the daemon leaves as it is (a pane's only tab on its own edge) is no drop here.
    expect(shape(after ? after.root : root)).toEqual(shape(want));
  });
});

describe("dropPreview", () => {
  // 1600x900: p-1 (thread, file) left half; p-2 over p-3 on the right.
  const TREE = row("s-r", [0.5, 0.5], pane("p-1", "thread", "file"), col("s-c", [0.5, 0.5], pane("p-2", "diff"), pane("p-3", "prs")));
  const FRAME = frameRects(TREE, 1600, 900);

  it("is the right half of a pane a tab splits off to the right", () => {
    // The row is now [p-1 .25, new .25, column .5] of 1600 less two gutters.
    expect(dropPreview(TREE, FRAME, tab("p-1/1", "p-1"), { kind: "edge", pane: "p-1", edge: "right" })).toEqual({ x: 406, y: 0, w: 394, h: 900 });
  });

  it("is where a pane goes after leaving its place", () => {
    // p-3 beside p-1 on its left: p-3 leaves the column, so p-2 is the whole right side.
    expect(dropPreview(TREE, FRAME, whole("p-3"), { kind: "edge", pane: "p-1", edge: "left" })).toEqual({ x: 0, y: 0, w: 394, h: 900 });
  });

  it("is a full-height column or full-width row of its kind's size on an outer edge", () => {
    // p-3 (Pull Requests, half) on the left: the row is [p-3, p-1, column], 1600 less two gutters.
    const left = dropPreview(TREE, FRAME, whole("p-3"), { kind: "outer", edge: "left" });
    expect(left).toMatchObject({ x: 0, y: 0, h: 900 });
    expect(left?.w).toBeCloseTo((1600 - 24) / 2, 0);
    // A file tab (0.35) on the bottom: 0.35 of 900 less one gutter.
    const bottom = dropPreview(TREE, FRAME, tab("p-1/1", "p-1"), { kind: "outer", edge: "bottom" });
    expect(bottom).toMatchObject({ x: 0, w: 1600, y: 589, h: 311 });
    // A diff pane on the right is raised to its 480px floor: 0.45 of 1576 is 709, so no; on the
    // bottom of a 1600x1100 grid, 0.45 of 1088 is 490, so no; at 1600x1000, 0.45 of 988 is 445,
    // raised to 480 as the rest keeps 508.
    const tall = frameRects(TREE, 1600, 1000);
    expect(dropPreview(TREE, tall, whole("p-2"), { kind: "outer", edge: "bottom" })).toMatchObject({ x: 0, w: 1600, h: 480 });
  });

  it("splits a pane in half whatever the kind dropped beside it", () => {
    // A file tab beside p-2 (diff), under it: the column [p-2, new, p-3] of 900 less two gutters.
    expect(dropPreview(TREE, FRAME, tab("p-1/1", "p-1"), { kind: "edge", pane: "p-2", edge: "bottom" })).toMatchObject({ x: 806, w: 794, h: 219 });
  });

  it("is the whole pane for its middle, and nothing for a strip (the bar shows it)", () => {
    expect(dropPreview(TREE, FRAME, tab("p-1/1", "p-1"), { kind: "pane", pane: "p-2" })).toEqual({ x: 806, y: 0, w: 794, h: 444 });
    expect(dropPreview(TREE, FRAME, tab("p-1/1", "p-1"), { kind: "strip", pane: "p-2", index: 0 })).toBeNull();
  });

  it("is the pane as drawn after the drop for its middle: its new active tab's minimum, the pane a drop empties gone, a rail open", () => {
    // 900 wide: p-a (diff, file) | p-b (prs) | p-c (thread), p-c focused. The diff's 260px and
    // Pull Requests' 300 do not both fit beside the thread's 360 with two gutters (944 > 900):
    // p-b, the later of the two never focused, folds.
    const root = row("s", [0.3, 0.3, 0.4], pane("p-a", "diff", "file"), pane("p-b", "prs"), pane("p-c", "thread:A"));
    const lay = shellDropLayout([]);
    const frame = shellFrame({ root, w: 900, h: 600, focus: "p-c" });
    expect(frame.rects["p-b"]?.rail).toBe(true);
    // The diff tab onto the rail: the rail takes the focus and opens (and p-a, whose file is
    // left, folds in its place).
    const onRail = dropPreview(root, frame, tab("p-a/0", "p-a"), { kind: "pane", pane: "p-b" }, lay);
    const landed = treeAfterDrop(root, tab("p-a/0", "p-a"), { kind: "pane", pane: "p-b" }, frame)?.root ?? root;
    expect(onRail).toEqual(rectOf(shellFrame({ root: landed, w: 900, h: 600, focus: "p-b" }), "p-b"));
    expect(onRail?.w).toBeGreaterThan(36);
    // Merging p-a into p-c: p-a leaves the row and its room goes to p-b, which opens, so p-c is
    // not where it is drawn now.
    const merged = dropPreview(root, frame, whole("p-a"), { kind: "pane", pane: "p-c" }, lay);
    const after = treeAfterDrop(root, whole("p-a"), { kind: "pane", pane: "p-c" }, frame)?.root ?? root;
    expect(merged).toEqual(rectOf(shellFrame({ root: after, w: 900, h: 600, focus: "p-c" }), "p-c"));
    expect(merged).not.toEqual(rectOf(frame, "p-c"));
  });

  it("leaves the tab after a moved active tab active in its old pane, as the daemon's detach does", () => {
    const root = row("s", [0.5, 0.5], { ...pane("p-a", "diff", "file", "thread:A"), active: "p-a/1" }, pane("p-b", "prs"));
    const after = treeAfterDrop(root, tab("p-a/1", "p-a"), { kind: "edge", pane: "p-b", edge: "right" }, { w: 1200, h: 800 });
    expect(panesOf(after?.root ?? null).find((p) => p.id === "p-a")?.active).toBe("p-a/2");
    const last = row("s", [0.5, 0.5], { ...pane("p-a", "diff", "file"), active: "p-a/1" }, pane("p-b", "prs"));
    const after2 = treeAfterDrop(last, tab("p-a/1", "p-a"), { kind: "edge", pane: "p-b", edge: "right" }, { w: 1200, h: 800 });
    expect(panesOf(after2?.root ?? null).find((p) => p.id === "p-a")?.active).toBe("p-a/0");
  });

  it("is a new pane beside the target for a sidebar thread, which leaves nothing behind; no single command opens it", () => {
    const thread: DragSource = { kind: "thread", thread: "s-9" };
    // p-1 splits in two: the thread's pane takes the right half of p-1's room.
    expect(dropPreview(TREE, FRAME, thread, { kind: "edge", pane: "p-1", edge: "right" })).toEqual({ x: 406, y: 0, w: 394, h: 900 });
    expect(dropPreview(TREE, FRAME, thread, { kind: "pane", pane: "p-2" })).toEqual({ x: 806, y: 0, w: 794, h: 444 });
    expect(dropCommand(thread, { kind: "pane", pane: "p-2" }, [])).toBeNull();
  });

  it("is nothing for a tab the tree does not hold", () => {
    expect(dropPreview(TREE, FRAME, tab("t-gone", "p-1"), { kind: "outer", edge: "left" })).toBeNull();
    expect(dropPreview(null, FRAME, tab("p-1/1", "p-1"), { kind: "outer", edge: "left" })).toBeNull();
  });

  it("leaves a tree that tiles, with the dropped thing inside the area, for random trees and drops", () => {
    const rand = rng(14);
    const edges: Edge[] = ["left", "right", "top", "bottom"];
    for (let n = 0; n < 300; n++) {
      const root = randomTree(rand, 3);
      const panes = panesOf(root);
      const from = panes[Math.floor(rand() * panes.length)];
      const to = panes[Math.floor(rand() * panes.length)];
      const firstTab = from?.tabs?.[0];
      if (!from || !to || !firstTab) continue;
      const source = rand() < 0.5 ? whole(from.id) : tab(firstTab.id, from.id);
      const edge = edges[Math.floor(rand() * 4)] ?? "left";
      const pick = rand();
      const target: DropTarget = pick < 0.3 ? { kind: "outer", edge } : pick < 0.5 ? { kind: "pane", pane: to.id } : { kind: "edge", pane: to.id, edge };
      if (source.kind === "pane" && target.kind !== "outer" && target.pane === from.id) continue;
      const after = treeAfterDrop(root, source, target, { w: 2400, h: 1600 });
      if (!after) continue;
      const frame = plainRects(after.root, 2400, 1600);
      expect(tilingErrors(frame), JSON.stringify({ root, source, target })).toEqual([]);
      expect(frame.rects[after.pane]).toBeDefined();
      // Every tab is still in the tree exactly once.
      const before = panesOf(root).flatMap((p) => (p.tabs ?? []).map((t) => t.id)).sort();
      const now = panesOf(after.root).flatMap((p) => (p.tabs ?? []).map((t) => t.id)).sort();
      expect(now).toEqual(before);
    }
  });
});

const rectOf = (f: { rects: Record<string, { x: number; y: number; w: number; h: number }> }, id: string) => {
  const r = f.rects[id];
  return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
};

/** One case of internal/layout/testdata/drops.json (Go's TestDropCases): a space, and drags with the space each op leaves. */
interface DropCase {
  root: GeoNode;
  w: number;
  h: number;
  focus: string;
  mru: string[] | null;
  drops: { source: DragSource; target: DropTarget; after: { root: GeoNode; focus: string; mru: string[] | null; pane: string } }[];
}

/**
 * The highlight is the rectangle the dropped tab's or pane's pane is drawn at after the drop: the
 * daemon's own op applied (the shared cases), laid out as the grid draws it (minimums held, rails
 * folded for the focus and mru the op leaves). Random trees in areas from roomy to folding, every
 * kind of drag and target; the preview is laid out as the drag layer lays it (shellDropLayout).
 */
describe("dropPreview is where the daemon's op puts it, as drawn", () => {
  const cases = JSON.parse(drops) as DropCase[];
  const all = cases.flatMap((c, ci) => c.drops.map((d, di) => [`case ${String(ci)} drop ${String(di)}: ${d.source.kind} onto ${d.target.kind}`, c, d] as const));

  it("reads the shared cases: every kind of drag onto every kind of target, many with rails", () => {
    const kinds = new Set(all.map(([, , d]) => `${d.source.kind}>${d.target.kind}`));
    expect([...kinds].sort()).toEqual(["pane>edge", "pane>outer", "pane>pane", "tab>edge", "tab>outer", "tab>pane", "thread>edge", "thread>outer", "thread>pane"]);
    const withRails = all.filter(([, c]) => Object.values(shellFrame({ root: c.root, w: c.w, h: c.h, focus: c.focus, mru: c.mru ?? [] }).rects).some((r) => r.rail));
    expect(withRails.length).toBeGreaterThan(30);
    // Panes the user collapsed (docs/notes/shell-25d-collapse.md): drops onto one (it opens) and tabs dragged out of one.
    const collapsedIds = (c: DropCase) => new Set(panesOf(c.root).flatMap((p) => (p.collapsed ? [p.id] : [])));
    const onto = all.filter(([, c, d]) => d.target.kind === "pane" && collapsedIds(c).has(d.target.pane));
    expect(onto.length).toBeGreaterThanOrEqual(5);
    expect(onto.every(([, , d]) => !panesOf(d.after.root).find((p) => p.id === d.after.pane)?.collapsed)).toBe(true);
    expect(all.filter(([, c, d]) => d.source.kind === "tab" && collapsedIds(c).has(d.source.pane)).length).toBeGreaterThanOrEqual(5);
  });

  it.each(all)("%s", (_name, c, d) => {
    const mru = c.mru ?? [];
    const frame = shellFrame({ root: c.root, w: c.w, h: c.h, focus: c.focus, mru });
    const want = shellFrame({ root: d.after.root, w: c.w, h: c.h, focus: d.after.focus, mru: d.after.mru ?? [] });
    expect(dropPreview(c.root, frame, d.source, d.target, shellDropLayout(mru))).toEqual(rectOf(want, d.after.pane));
  });
});
