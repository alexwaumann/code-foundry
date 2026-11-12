import { describe, expect, it } from "vitest";
import { frameRects, plainRects, tilingErrors } from "@/shell/geometry/rects";
import { panesOf, type GeoNode } from "@/shell/geometry/types";
import { col, pane, randomTree, rng, row } from "@/test/shellTrees";
import { dropCommand, dropPreview, treeAfterDrop } from "./drop";
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
  op: { op: string; tab?: string; pane?: string; target?: string; edge?: Edge; frac?: number; space?: string };
  want?: { spaces: { id: string; root: GeoNode | null }[] };
}

function findTabPane(root: GeoNode | null, tabId: string): string | null {
  return panesOf(root).find((p) => (p.tabs ?? []).some((t) => t.id === tabId))?.id ?? null;
}

/** The fixture's op as a drag and drop, when it is one (an edge or the outer edge, in one space). */
function asDrop(c: Case): { space: string; source: DragSource; target: DropTarget; frac: number } | null {
  const o = c.op;
  if (!o.edge || o.space) return null;
  const sp = c.state.spaces.find((s) => (o.op === "move_pane" ? panesOf(s.root).some((p) => p.id === o.pane) : findTabPane(s.root, o.tab ?? "")));
  if (!sp) return null;
  const frac = o.frac ?? 0.5;
  if (o.op === "move_pane") return { space: sp.id, source: whole(o.pane ?? ""), target: o.target ? { kind: "edge", pane: o.target, edge: o.edge } : { kind: "outer", edge: o.edge }, frac };
  if (o.op === "move_tab") {
    const from = findTabPane(sp.root, o.tab ?? "") ?? "";
    return { space: sp.id, source: tab(o.tab ?? "", from), target: o.pane ? { kind: "edge", pane: o.pane, edge: o.edge } : { kind: "outer", edge: o.edge }, frac };
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
    expect(cases.map(([f]) => f)).toEqual(expect.arrayContaining(["move_pane-beside.json", "move_pane-outer.json", "move_tab-to-edge.json", "move_tab-outer-edge.json", "move_tab-own-edge-only-tab.json"]));
  });

  it.each(cases)("%s", (_f, c, d) => {
    const root = c.state.spaces.find((s) => s.id === d.space)?.root ?? null;
    const want = c.want?.spaces.find((s) => s.id === d.space)?.root ?? null;
    if (!root) throw new Error("no root");
    const after = treeAfterDrop(root, d.source, d.target, d.frac);
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

  it("is a full-height column or full-width row on an outer edge", () => {
    const left = dropPreview(TREE, FRAME, whole("p-3"), { kind: "outer", edge: "left" });
    expect(left).toMatchObject({ x: 0, y: 0, h: 900 });
    expect(left?.w).toBeCloseTo((1600 - 24) / 2, 0);
    const bottom = dropPreview(TREE, FRAME, tab("p-1/1", "p-1"), { kind: "outer", edge: "bottom" });
    expect(bottom).toMatchObject({ x: 0, w: 1600, y: 456, h: 444 });
  });

  it("is the whole pane for its middle, and nothing for a strip (the bar shows it)", () => {
    expect(dropPreview(TREE, FRAME, tab("p-1/1", "p-1"), { kind: "pane", pane: "p-2" })).toEqual(FRAME.rects["p-2"]);
    expect(dropPreview(TREE, FRAME, tab("p-1/1", "p-1"), { kind: "strip", pane: "p-2", index: 0 })).toBeNull();
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
      const target: DropTarget = rand() < 0.3 ? { kind: "outer", edge } : { kind: "edge", pane: to.id, edge };
      if (source.kind === "pane" && target.kind === "edge" && target.pane === from.id) continue;
      const after = treeAfterDrop(root, source, target);
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
