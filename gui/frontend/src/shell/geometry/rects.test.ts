import { describe, expect, it } from "vitest";
import fixture from "../../../../../internal/layout/testdata/rects.json?raw";
import { col, pane, randomTree, rng, row } from "@/test/shellTrees";
import { neighbour, type Direction } from "./neighbours";
import { shellFrame } from "./rails";
import {
  DEFAULT_MINIMUM,
  GUTTER,
  PANE_MINIMUMS,
  RAIL,
  frameRects,
  minimumOf,
  paneMinimum,
  plainRects,
  tilingErrors,
} from "./rects";
import { panesOf, type Frame, type GeoNode, type Rect, type Size } from "./types";

/** One case of internal/layout/testdata/rects.json (docs/notes/shell-1-layout-model.md). */
interface RectCase {
  doc: string;
  root: GeoNode;
  w: number;
  h: number;
  rects: Record<string, Rect>;
  gutters?: (Rect & { split: string; i: number; row: boolean })[];
  neighbours?: Record<string, Partial<Record<"right" | "left" | "bottom" | "top", string[]>>>;
}

const cases = JSON.parse(fixture) as RectCase[];

const plain = (r: Rect): Rect => ({ x: r.x, y: r.y, w: r.w, h: r.h });

function expectTiles(frame: Frame) {
  expect(tilingErrors(frame)).toEqual([]);
  for (const g of frame.gutters) expect(g.row ? g.w : g.h).toBe(GUTTER);
}

describe("plainRects agrees with the daemon's Rects", () => {
  it("reads the shared cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(7);
  });

  it.each(cases)("$doc", (c) => {
    const frame = plainRects(c.root, c.w, c.h);
    expect(Object.fromEntries(Object.entries(frame.rects).map(([id, r]) => [id, plain(r)]))).toEqual(c.rects);
    expect(frame.gutters.map((g) => ({ split: g.split, i: g.i, row: g.row, ...plain(g) }))).toEqual(c.gutters ?? []);
    expect(Object.values(frame.rects).some((r) => r.rail)).toBe(false);
    expectTiles(frame);
  });

  // Go lists every pane on a side, the longest shared edge first; the key moves to that first one.
  const sides: [keyof NonNullable<RectCase["neighbours"]>[string], Direction][] = [
    ["right", "right"],
    ["left", "left"],
    ["bottom", "down"],
    ["top", "up"],
  ];
  it.each(cases)("neighbours: $doc", (c) => {
    const frame = plainRects(c.root, c.w, c.h);
    for (const p of panesOf(c.root)) {
      for (const [side, dir] of sides) {
        expect(neighbour(frame, p.id, dir), `${p.id} ${dir}`).toBe(c.neighbours?.[p.id]?.[side]?.[0] ?? null);
      }
    }
  });

  it("an empty tree has no rectangles", () => {
    expect(plainRects(null, 800, 600)).toEqual({ w: 800, h: 600, rects: {}, gutters: [] });
  });
});

describe("pane minimums", () => {
  it("come from the active tab's kind, else the default", () => {
    expect(paneMinimum(pane("p", "thread:a"))).toEqual(PANE_MINIMUMS.thread);
    expect(paneMinimum(pane("p", "terminal", "thread:a"))).toEqual({ w: 240, h: 110 });
    expect(paneMinimum({ ...pane("p", "terminal", "diff:a"), active: "p/1" })).toEqual({ w: 260, h: 150 });
    expect(paneMinimum(pane("p", "prs"))).toEqual(DEFAULT_MINIMUM);
    expect(paneMinimum(pane("p"))).toEqual(DEFAULT_MINIMUM);
  });

  it("add up along a split with its gutters, and take the largest across it", () => {
    const tree = row("s", [0.5, 0.5], pane("a", "thread:x"), col("c", [0.5, 0.5], pane("b", "terminal"), pane("d", "diff")));
    expect(minimumOf(tree)).toEqual({ w: 360 + GUTTER + 260, h: 110 + GUTTER + 150 });
    expect(minimumOf(tree, new Set(["b", "d"]))).toEqual({ w: 360 + GUTTER + RAIL, h: 220 });
    expect(minimumOf(tree, new Set(["d"]))).toEqual({ w: 360 + GUTTER + 240, h: 220 });
    expect(minimumOf(null)).toEqual({ w: 0, h: 0 });
  });

  type Want = Record<string, [number, number, number, number]>;
  const table: { doc: string; root: GeoNode; w: number; h: number; rails?: string[]; want: Want }[] = [
    {
      doc: "a pane whose share falls short is held at its minimum, the rest share again",
      root: row("s", [0.8, 0.2], pane("a", "thread:x"), pane("b", "diff:x")),
      w: 1000,
      h: 600,
      want: { a: [0, 0, 728, 600], b: [740, 0, 260, 600] },
    },
    {
      doc: "the thread's minimum is larger",
      root: row("s", [0.2, 0.8], pane("a", "thread:x"), pane("b", "diff:x")),
      w: 1000,
      h: 600,
      want: { a: [0, 0, 360, 600], b: [372, 0, 628, 600] },
    },
    {
      doc: "shares that already fit are the plain ones",
      root: row("s", [0.5, 0.5], pane("a", "thread:x"), pane("b", "diff:x")),
      w: 1000,
      h: 600,
      want: { a: [0, 0, 494, 600], b: [506, 0, 494, 600] },
    },
    {
      doc: "when the minimums do not fit, the panes share in proportion to their minimums",
      root: row("s", [0.8, 0.2], pane("a", "thread:x"), pane("b", "diff:x")),
      w: 500,
      h: 600,
      want: { a: [0, 0, 283, 600], b: [295, 0, 205, 600] },
    },
    {
      doc: "a column holds a short terminal at its minimum height",
      root: col("s", [0.9, 0.1], pane("a", "thread:x"), pane("b", "terminal")),
      w: 800,
      h: 600,
      want: { a: [0, 0, 800, 478], b: [0, 490, 800, 110] },
    },
    {
      doc: "a rail in a row is 36px wide and the others share the rest",
      root: row("s", [0.4, 0.3, 0.3], pane("a", "thread:x"), pane("b", "diff:x"), pane("c", "terminal")),
      w: 800,
      h: 500,
      rails: ["b"],
      want: { a: [0, 0, 423, 500], b: [435, 0, 36, 500], c: [483, 0, 317, 500] },
    },
    {
      doc: "a rail in a column is 36px tall",
      root: col("s", [0.5, 0.5], pane("a", "thread:x"), pane("b", "terminal")),
      w: 800,
      h: 500,
      rails: ["b"],
      want: { a: [0, 0, 800, 452], b: [0, 464, 800, 36] },
    },
    {
      doc: "a column of rails is one rail wide; the rails share its height by their sizes",
      root: row("s", [0.5, 0.5], pane("a", "thread:x"), col("c", [0.75, 0.25], pane("b", "diff"), pane("d", "prs"))),
      w: 900,
      h: 500,
      rails: ["b", "d"],
      want: { a: [0, 0, 852, 500], b: [864, 0, 36, 366], d: [864, 378, 36, 122] },
    },
    {
      doc: "a row of rails under a pane is one rail tall; each rail keeps its minimum length",
      root: col("s", [0.5, 0.5], pane("a", "thread:x"), row("r", [0.98, 0.02], pane("b", "diff"), pane("d", "prs"))),
      w: 900,
      h: 500,
      rails: ["b", "d"],
      want: { a: [0, 0, 900, 452], b: [0, 464, 852, 36], d: [864, 464, 36, 36] },
    },
  ];

  it.each(table)("$doc", ({ root, w, h, rails, want }) => {
    const frame = frameRects(root, w, h, new Set(rails));
    const got = Object.fromEntries(Object.entries(frame.rects).map(([id, r]) => [id, [r.x, r.y, r.w, r.h]]));
    expect(got).toEqual(want);
    for (const [id, r] of Object.entries(frame.rects)) expect(r.rail, id).toBe((rails ?? []).includes(id));
    expectTiles(frame);
  });

  it("a gutter beside a rail is fixed; one between open panes is not", () => {
    const root = row("s", [0.4, 0.3, 0.3], pane("a", "thread:x"), pane("b", "diff:x"), pane("c", "terminal"));
    expect(frameRects(root, 800, 500, new Set(["c"])).gutters.map((g) => g.fixed)).toEqual([false, true]);
    expect(frameRects(root, 800, 500).gutters.map((g) => g.fixed)).toEqual([false, false]);
  });
});

describe("tiling", () => {
  // A split shorter than its gutters cannot tile (the daemon's Rects is the same), so the random
  // areas give every split room for its gutters at its proportions, with a few px to spare.
  const roomy = (n: GeoNode): Size => {
    if (n.t === "pane") return { w: 4, h: 4 };
    const row = n.dir === "row";
    const kids = n.kids.map(roomy);
    const along = Math.max(...kids.map((k, i) => (row ? k.w : k.h) / (n.sizes[i] ?? 1)));
    const across = Math.max(...kids.map((k) => (row ? k.h : k.w)));
    const len = Math.ceil(along + GUTTER * (n.kids.length - 1));
    return row ? { w: len, h: across } : { w: across, h: len };
  };

  it("random trees tile their area exactly: plain, held at minimums, and with rails folded", () => {
    const rand = rng(9);
    for (let n = 0; n < 400; n++) {
      const root = randomTree(rand);
      const g = roomy(root);
      const w = Math.round(g.w + 40 + rand() * 2200) + (n % 4 === 0 ? 0.5 : 0);
      const h = Math.round(g.h + 40 + rand() * 1400) + (n % 5 === 0 ? 0.25 : 0);
      const ids = panesOf(root).map((p) => p.id);
      const focus = ids[Math.floor(rand() * ids.length)];
      const frames = [plainRects(root, w, h), frameRects(root, w, h), shellFrame({ root, w, h, focus })];
      for (const frame of frames) {
        expect(tilingErrors(frame), `tree ${String(n)} at ${String(w)}x${String(h)} frame ${String(frames.indexOf(frame))}`).toEqual([]);
        expect(Object.keys(frame.rects).sort()).toEqual([...ids].sort());
      }
    }
  });

  it("every open pane keeps its minimum when the minimums fit", () => {
    const rand = rng(17);
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const root = randomTree(rand);
      const g = roomy(root);
      const w = Math.round(g.w + 40 + rand() * 2400);
      const h = Math.round(g.h + 40 + rand() * 1400);
      const focus = panesOf(root)[0]?.id;
      const frame = shellFrame({ root, w, h, focus });
      const rails = new Set(Object.entries(frame.rects).filter(([, r]) => r.rail).map(([id]) => id));
      const min = minimumOf(root, rails);
      if (min.w > w || min.h > h) continue;
      checked++;
      for (const p of panesOf(root)) {
        const r = frame.rects[p.id];
        if (!r || r.rail) continue;
        const m = paneMinimum(p);
        // A held pane is exact; a pane on its share may lose the rounding pixel.
        expect(r.w, `${p.id} of tree ${String(n)}`).toBeGreaterThanOrEqual(m.w - 1);
        expect(r.h, `${p.id} of tree ${String(n)}`).toBeGreaterThanOrEqual(m.h - 1);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("finds a gap or an overlap", () => {
    const frame = plainRects(row("s", [0.5, 0.5], pane("a"), pane("b")), 1000, 600);
    const a = frame.rects.a;
    if (!a) throw new Error("no pane a");
    expect(tilingErrors({ ...frame, rects: { ...frame.rects, a: { ...a, w: a.w - 1 } } })).toEqual(["covers 599400 of 600000 px²"]);
    expect(tilingErrors({ ...frame, rects: { ...frame.rects, a: { ...a, w: a.w + 1 } } })).toContain("a overlaps gutter s/0");
    expect(tilingErrors({ ...frame, rects: { ...frame.rects, a: { ...a, x: -1 } } })).toContain("a leaves the area");
  });
});
