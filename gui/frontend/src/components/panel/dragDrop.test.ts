import type { ClientRect, Collision, CollisionDetection, DroppableContainer } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import { BAND_DROP_ID, bodyDropId, clampTranslate, dropDataOf, dropMove, dropTargetOf, headerDropId, insertionIndex, panelCollision, sameTarget, type DropData, type DropTarget } from "./dragDrop";

function box(left: number, top: number, width: number, height: number): ClientRect {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

type Args = Parameters<CollisionDetection>[0];

/**
 * A split panel, stacked: group 0's header (y 0..44) with tabs a and b, its body, then
 * group 1's header (y 345..389) with tabs c and d (or none) and its body. Tabs are 80px
 * wide, 90px apart, so their centres are at x 50 and 140. `band` adds an unsplit panel's
 * band over the right of group 0's body.
 */
function layout(opts: { otherTabs?: boolean; band?: boolean } = {}): { containers: DroppableContainer[]; rects: Map<string, ClientRect> } {
  const items: [string, DropData, ClientRect][] = [
    [headerDropId(0), { kind: "header", group: 0 }, box(0, 0, 400, 44)],
    ["a", { kind: "tab", group: 0 }, box(10, 8, 80, 28)],
    ["b", { kind: "tab", group: 0 }, box(100, 8, 80, 28)],
    [bodyDropId(0), { kind: "body", group: 0 }, box(0, 44, 400, 300)],
    [headerDropId(1), { kind: "header", group: 1 }, box(0, 345, 400, 44)],
    [bodyDropId(1), { kind: "body", group: 1 }, box(0, 389, 400, 300)],
  ];
  if (opts.otherTabs ?? true) items.push(["c", { kind: "tab", group: 1 }, box(10, 353, 80, 28)], ["d", { kind: "tab", group: 1 }, box(100, 353, 80, 28)]);
  if (opts.band) items.push([BAND_DROP_ID, { kind: "band" }, box(220, 52, 172, 284)]);
  const containers = items.map(([id, data]) => ({ id, key: id, data: { current: data }, disabled: false, node: { current: null }, rect: { current: null } }));
  return { containers, rects: new Map(items.map(([id, , r]) => [id, r])) };
}

/** Collision args for tab `active` (of `group`) lifted to `lifted` with the pointer at (x, y). */
function args(active: string, group: 0 | 1, pointer: { x: number; y: number } | null, lifted: ClientRect, opts: { otherTabs?: boolean; band?: boolean } = {}): Args {
  const { containers, rects } = layout(opts);
  return {
    active: { id: active, data: { current: { sortable: {}, kind: "tab", group } }, rect: { current: { initial: null, translated: null } } },
    collisionRect: lifted,
    droppableRects: rects,
    droppableContainers: containers,
    pointerCoordinates: pointer,
  };
}

const targetOf = (c: Collision[]) => ({ id: c[0]?.id ?? null, target: dropTargetOf(c) });

describe("panelCollision", () => {
  it.each<[string, Args, { id: string | null; target: DropTarget | null }]>([
    ["in its own header: the closest own tab by the lifted tab's centre", args("a", 0, { x: 130, y: 20 }, box(120, 8, 80, 28)), { id: "b", target: { kind: "reorder", overId: "b" } }],
    ["in its own header over itself", args("a", 0, { x: 40, y: 20 }, box(10, 8, 80, 28)), { id: "a", target: { kind: "reorder", overId: "a" } }],
    ["never another group's tab by closeness", args("c", 1, { x: 130, y: 360 }, box(100, 0, 80, 28)), { id: "d", target: { kind: "reorder", overId: "d" } }],
    ["the other header left of every tab: slot 0, its nearest tab", args("a", 0, { x: 20, y: 360 }, box(0, 350, 80, 28)), { id: "c", target: { kind: "strip", group: 1, index: 0 } }],
    ["the other header between its tabs: slot 1", args("a", 0, { x: 100, y: 360 }, box(80, 350, 80, 28)), { id: "d", target: { kind: "strip", group: 1, index: 1 } }],
    ["the other header past its last tab: slot 2", args("a", 0, { x: 320, y: 360 }, box(300, 350, 80, 28)), { id: "d", target: { kind: "strip", group: 1, index: 2 } }],
    ["the other header of an empty group: the header, slot 0", args("a", 0, { x: 100, y: 360 }, box(80, 350, 80, 28), { otherTabs: false }), { id: headerDropId(1), target: { kind: "strip", group: 1, index: 0 } }],
    ["the other group's body", args("a", 0, { x: 200, y: 500 }, box(180, 490, 80, 28)), { id: bodyDropId(1), target: { kind: "body", group: 1 } }],
    ["the other way: group 0's body from group 1", args("c", 1, { x: 200, y: 100 }, box(180, 90, 80, 28)), { id: bodyDropId(0), target: { kind: "body", group: 0 } }],
    ["its own body: nothing", args("a", 0, { x: 200, y: 100 }, box(180, 90, 80, 28)), { id: null, target: null }],
    ["outside the panel: nothing", args("a", 0, { x: 600, y: 20 }, box(580, 8, 80, 28)), { id: null, target: null }],
    ["the band, over its own body", args("a", 0, { x: 300, y: 200 }, box(280, 190, 80, 28), { band: true }), { id: BAND_DROP_ID, target: { kind: "band" } }],
    ["beside the band: nothing", args("a", 0, { x: 100, y: 200 }, box(80, 190, 80, 28), { band: true }), { id: null, target: null }],
    ["no pointer: nothing", args("a", 0, null, box(10, 8, 80, 28)), { id: null, target: null }],
  ])("%s", (_name, a, want) => {
    expect(targetOf(panelCollision(a))).toEqual(want);
  });

  it("finds nothing for a draggable that is not a tab", () => {
    const a = args("a", 0, { x: 40, y: 20 }, box(10, 8, 80, 28));
    expect(panelCollision({ ...a, active: { ...a.active, data: { current: { kind: "other" } } } })).toEqual([]);
  });

  it("does not count a rect without area as containing the pointer", () => {
    const a = args("a", 0, { x: 0, y: 500 }, box(0, 490, 80, 28));
    a.droppableRects.set(bodyDropId(1), box(0, 500, 0, 0));
    expect(panelCollision(a)).toEqual([]);
  });
});

describe("insertionIndex", () => {
  it.each<[string, number[], number, number]>([
    ["no tabs", [], 10, 0],
    ["left of all", [50, 140], 20, 0],
    ["between", [50, 140], 95, 1],
    ["right of all", [50, 140], 300, 2],
    ["any order", [140, 50, 230], 150, 2],
    ["on a centre: before it", [50, 140], 50, 0],
  ])("%s", (_name, centers, x, want) => {
    expect(insertionIndex(centers, x)).toBe(want);
  });
});

describe("dropMove", () => {
  const ids = ["a", "b", "c"];
  it.each<[string, DropTarget | null, string, ReturnType<typeof dropMove>]>([
    ["no target", null, "a", null],
    ["onto a later tab: its index", { kind: "reorder", overId: "c" }, "a", { kind: "reorder", to: 2 }],
    ["onto an earlier tab: its index", { kind: "reorder", overId: "a" }, "c", { kind: "reorder", to: 0 }],
    ["onto itself: nothing", { kind: "reorder", overId: "b" }, "b", null],
    ["onto a tab no longer there: nothing", { kind: "reorder", overId: "gone" }, "a", null],
    ["the other strip: that group at the slot", { kind: "strip", group: 1, index: 1 }, "a", { kind: "group", group: 1, index: 1 }],
    ["the other body: that group, last", { kind: "body", group: 0 }, "a", { kind: "group", group: 0 }],
    ["the band: group 1", { kind: "band" }, "a", { kind: "group", group: 1 }],
  ])("%s", (_name, t, id, want) => {
    expect(dropMove(t, id, ids)).toEqual(want);
  });
});

describe("sameTarget", () => {
  it.each<[string, DropTarget | null, DropTarget | null, boolean]>([
    ["both none", null, null, true],
    ["none and one", null, { kind: "band" }, false],
    ["bands", { kind: "band" }, { kind: "band" }, true],
    ["reorders over the same tab", { kind: "reorder", overId: "a" }, { kind: "reorder", overId: "a" }, true],
    ["reorders over different tabs", { kind: "reorder", overId: "a" }, { kind: "reorder", overId: "b" }, false],
    ["strip slots", { kind: "strip", group: 1, index: 1 }, { kind: "strip", group: 1, index: 1 }, true],
    ["different strip slots", { kind: "strip", group: 1, index: 1 }, { kind: "strip", group: 1, index: 2 }, false],
    ["bodies of different groups", { kind: "body", group: 0 }, { kind: "body", group: 1 }, false],
    ["different kinds", { kind: "body", group: 1 }, { kind: "strip", group: 1, index: 0 }, false],
  ])("%s", (_name, a, b, want) => {
    expect(sameTarget(a, b)).toBe(want);
  });
});

describe("dropDataOf and dropTargetOf", () => {
  it.each<[string, unknown, DropData | null]>([
    ["a tab", { kind: "tab", group: 1, sortable: {} }, { kind: "tab", group: 1 }],
    ["a header", { kind: "header", group: 0 }, { kind: "header", group: 0 }],
    ["the band", { kind: "band" }, { kind: "band" }],
    ["a bad group", { kind: "tab", group: 2 }, null],
    ["an unknown kind", { kind: "x", group: 0 }, null],
    ["nothing", undefined, null],
  ])("%s", (_name, data, want) => {
    expect(dropDataOf(data)).toEqual(want);
  });

  it("reads the first collision's target", () => {
    expect(dropTargetOf([{ id: "x", data: { target: { kind: "band" } } }])).toEqual({ kind: "band" });
    expect(dropTargetOf([{ id: "x" }])).toBeNull();
    expect(dropTargetOf(null)).toBeNull();
  });
});

describe("clampTranslate", () => {
  const panel = { left: 100, top: 0, right: 500, bottom: 800 };
  const tab = box(120, 10, 80, 28);
  it.each<[string, { x: number; y: number }, ClientRect | null, typeof panel | null, { x: number; y: number }]>([
    ["inside: unchanged", { x: 50, y: 300 }, tab, panel, { x: 50, y: 300 }],
    ["past the right edge", { x: 400, y: 0 }, tab, panel, { x: 300, y: 0 }],
    ["past the left edge", { x: -100, y: 0 }, tab, panel, { x: -20, y: 0 }],
    ["past the top", { x: 0, y: -50 }, tab, panel, { x: 0, y: -10 }],
    ["past the bottom", { x: 0, y: 900 }, tab, panel, { x: 0, y: 762 }],
    ["no rect", { x: 900, y: 900 }, null, panel, { x: 900, y: 900 }],
    ["no bounds", { x: 900, y: 900 }, tab, null, { x: 900, y: 900 }],
    ["empty bounds (not laid out)", { x: 900, y: 900 }, tab, { left: 0, top: 0, right: 0, bottom: 0 }, { x: 900, y: 900 }],
    ["a node wider than the bounds: its left edge wins", { x: 0, y: 0 }, box(100, 0, 500, 28), panel, { x: 0, y: 0 }],
  ])("%s", (_name, t, rect, bounds, want) => {
    expect(clampTranslate(t, rect, bounds)).toEqual(want);
  });
});
