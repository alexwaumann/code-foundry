import { describe, expect, it } from "vitest";
import fixture from "../../../../../internal/layout/testdata/neighbour.json?raw";
import { col, pane, randomTree, rng, row } from "@/test/shellTrees";
import { DIRECTIONS, neighbour, neighbours, type Direction } from "./neighbours";
import { shellFrame } from "./rails";
import { GUTTER, plainRects, tilingErrors } from "./rects";
import { activeTab, panesOf, type Frame, type GeoNode, type Rect } from "./types";

describe("neighbours", () => {
  // a | b
  // --+--
  // c | d
  const grid = plainRects(
    row("s", [0.5, 0.5], col("l", [0.5, 0.5], pane("a"), pane("c")), col("r", [0.5, 0.5], pane("b"), pane("d"))),
    1000,
    600,
  );

  it.each([
    { pane: "a", want: { left: null, down: "c", up: null, right: "b" } },
    { pane: "b", want: { left: "a", down: "d", up: null, right: null } },
    { pane: "c", want: { left: null, down: null, up: "a", right: "d" } },
    { pane: "d", want: { left: "c", down: null, up: "b", right: null } },
  ])("in a grid of four, from $pane", ({ pane: p, want }) => {
    expect(neighbours(grid, p)).toEqual(want);
  });

  it("an unknown pane has none", () => {
    for (const dir of DIRECTIONS) expect(neighbour(grid, "p-gone", dir)).toBeNull();
  });

  it("the one sharing more of the edge wins", () => {
    const frame = plainRects(row("s", [0.5, 0.5], pane("a"), col("c", [0.7, 0.3], pane("b"), pane("d"))), 1000, 600);
    expect(neighbour(frame, "a", "right")).toBe("b");
    const flipped = plainRects(row("s", [0.5, 0.5], pane("a"), col("c", [0.3, 0.7], pane("b"), pane("d"))), 1000, 600);
    expect(neighbour(flipped, "a", "right")).toBe("d");
  });

  it("of two sharing as much, the upper (for left and right) or the left (for up and down)", () => {
    const tall = plainRects(row("s", [0.5, 0.5], col("c", [0.5, 0.5], pane("b"), pane("d")), pane("a")), 1000, 600);
    expect(neighbour(tall, "a", "left")).toBe("b");
    const wide = plainRects(col("s", [0.5, 0.5], pane("a"), row("r", [0.5, 0.5], pane("b"), pane("d"))), 1000, 600);
    expect(neighbour(wide, "a", "down")).toBe("b");
    expect(neighbour(wide, "d", "up")).toBe("a");
  });

  it("the nearest wins over one further on that shares more", () => {
    // a | b | c with d under all three: from a, right is b, not c.
    const frame = plainRects(
      col("s", [0.5, 0.5], row("r", [0.2, 0.2, 0.6], pane("a"), pane("b"), pane("c")), pane("d")),
      1000,
      600,
    );
    expect(neighbours(frame, "a")).toEqual({ left: null, down: "d", up: null, right: "b" });
    expect(neighbours(frame, "d")).toEqual({ left: null, down: null, up: "c", right: null });
  });

  it("reaches rails and moves on past them, as drawn", () => {
    const root = row(
      "s",
      [0.25, 0.25, 0.25, 0.25],
      pane("a", "thread:A"),
      pane("b", "diff:A"),
      pane("c", "prs"),
      pane("d", "thread:B"),
    );
    const frame = shellFrame({ root, w: 900, h: 600, focus: "a", mru: ["a/0", "d/0", "b/0"] });
    expect(frame.rects.b?.rail && frame.rects.c?.rail).toBe(true);
    expect(neighbours(frame, "a")).toEqual({ left: null, down: null, up: null, right: "b" });
    expect(neighbours(frame, "b")).toEqual({ left: "a", down: null, up: null, right: "c" });
    expect(neighbours(frame, "c")).toEqual({ left: "b", down: null, up: null, right: "d" });
    expect(neighbours(frame, "d")).toEqual({ left: "c", down: null, up: null, right: null });
  });

  it("a horizontal rail is above or below its neighbours", () => {
    const root = col("s", [0.5, 0.25, 0.25], pane("a", "thread:A"), pane("b", "terminal"), pane("c", "diff"));
    const frame = shellFrame({ root, w: 800, h: 400, focus: "a", mru: ["a/0", "b/0", "c/0"] });
    expect(frame.rects.c?.rail).toBe(true);
    expect(neighbours(frame, "c")).toEqual({ left: null, down: null, up: "b", right: null });
    expect(neighbour(frame, "b", "down")).toBe("c");
  });

  it("of several touching, the one focused most recently wins, then the longest shared edge", () => {
    // a | (b over d), b the shorter.
    const root = row("s", [0.5, 0.5], pane("a", "prs"), col("c", [0.3, 0.7], pane("b", "prs", "diff"), pane("d", "prs")));
    const frame = plainRects(root, 1000, 600);
    expect(neighbour(frame, "a", "right")).toBe("d");
    expect(neighbour(frame, "a", "right", { root, mru: [] })).toBe("d");
    // b focused last, by a tab that is not active: going right from a returns there.
    expect(neighbour(frame, "a", "right", { root, mru: ["a/0", "b/1", "d/0"] })).toBe("b");
    expect(neighbour(frame, "a", "right", { root, mru: ["d/0", "b/0"] })).toBe("d");
    // A recent pane that does not touch that side does not count.
    expect(neighbour(frame, "b", "down", { root, mru: ["a/0"] })).toBe("d");
  });
});

/** The daemon's Neighbour on the same trees (internal/layout/testdata/neighbour.json, from Go's TestNeighbourCases). */
interface NeighbourCase {
  root: GeoNode;
  w: number;
  h: number;
  mru: string[];
  want: Record<string, Partial<Record<"right" | "left" | "bottom" | "top", string>>>;
}

describe("the GUI and the daemon agree", () => {
  const cases = JSON.parse(fixture) as NeighbourCase[];
  const sides: ["right" | "left" | "bottom" | "top", Direction][] = [
    ["right", "right"],
    ["left", "left"],
    ["bottom", "down"],
    ["top", "up"],
  ];

  it("reads the shared cases, ten of them with panes the user collapsed (rails in the plain layout too)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.filter((c) => panesOf(c.root).some((p) => p.collapsed)).length).toBeGreaterThanOrEqual(10);
  });

  it.each(cases.map((c, i) => [i, c] as const))("case %i: every pane, every side, with the case's mru", (_i, c) => {
    const frame = plainRects(c.root, c.w, c.h);
    for (const p of panesOf(c.root)) {
      for (const [side, dir] of sides) {
        expect(neighbour(frame, p.id, dir, { root: c.root, mru: c.mru }), `${p.id} ${dir}`).toBe(c.want[p.id]?.[side] ?? null);
      }
    }
  });
});

/**
 * Properties of the key over random trees laid out as drawn (minimums held, rails folded for the
 * focus and the mru), the frame drawn again after each move as the window does: a side with a pane
 * on it always has a neighbour; the neighbour touches (no pane is skipped); going back returns to
 * the start whenever the start still touches the pane reached (always when nothing refolds); a
 * rail is reached like any pane and is drawn open once focused.
 */
describe("neighbour properties over drawn frames", () => {
  const OPPOSITE: Record<Direction, Direction> = { left: "right", right: "left", up: "down", down: "up" };

  /** Where r lies from c in that direction: the gap between them, and how much of the edge they share. */
  function side(c: Rect, r: Rect, dir: Direction): { gap: number; ov: number } {
    const gap = { right: r.x - (c.x + c.w), left: c.x - (r.x + r.w), down: r.y - (c.y + c.h), up: c.y - (r.y + r.h) }[dir];
    const across = dir === "left" || dir === "right";
    const ov = across ? Math.min(r.y + r.h, c.y + c.h) - Math.max(r.y, c.y) : Math.min(r.x + r.w, c.x + c.w) - Math.max(r.x, c.x);
    return { gap, ov };
  }
  const touches = (f: Frame, a: string, b: string, dir: Direction) => {
    const s = side(f.rects[a] as Rect, f.rects[b] as Rect, dir);
    return Math.abs(s.gap - GUTTER) <= 1 && s.ov > 0;
  };

  /** A random tree in a random area its rails fit (the window's minimum keeps real ones there), walked by random keys. */
  function walk(seed: number, check: (step: { before: Frame; after: Frame; from: string; to: string; dir: Direction; mru: string[]; root: GeoNode }) => void) {
    const rand = rng(seed);
    const root = randomTree(rand, 3);
    const panes = panesOf(root);
    const w = 500 + Math.floor(rand() * 1500);
    const h = 300 + Math.floor(rand() * 900);
    let focus = panes[Math.floor(rand() * panes.length)]?.id ?? "";
    const tabOf = (id: string) => activeTab(panes.find((p) => p.id === id) as (typeof panes)[number])?.id ?? "";
    let mru = [tabOf(focus)];
    let frame = shellFrame({ root, w, h, focus, mru });
    if (tilingErrors(frame).length > 0 || Object.values(frame.rects).some((r) => r.w < 36 || r.h < 36)) return false;
    for (let i = 0; i < 25; i++) {
      const dir = DIRECTIONS[Math.floor(rand() * 4)] ?? "left";
      const from = focus;
      const to = neighbour(frame, from, dir, { root, mru });
      const c = frame.rects[from] as Rect;
      const anyThere = panes.some((p) => {
        if (p.id === from) return false;
        const s = side(c, frame.rects[p.id] as Rect, dir);
        return s.gap >= 0 && s.ov > 0;
      });
      expect(to !== null, `seed ${String(seed)}: ${from} ${dir} has a pane on that side`).toBe(anyThere);
      if (!to) continue;
      focus = to;
      mru = [tabOf(to), ...mru.filter((m) => m !== tabOf(to))];
      const before = frame;
      frame = shellFrame({ root, w, h, focus, mru });
      check({ before, after: frame, from, to, dir, mru, root });
    }
    return true;
  }

  it("a pane on that side is always reached, and the one reached touches: none is skipped", () => {
    let walked = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const ok = walk(seed, ({ before, from, to, dir }) => {
        expect(touches(before, from, to, dir), `seed ${String(seed)}: ${from} ${dir} reached ${to}, which does not touch`).toBe(true);
      });
      if (ok) walked++;
    }
    expect(walked).toBeGreaterThan(300);
  });

  it("going back returns to the start whenever the start still touches the pane reached", () => {
    let back = 0;
    for (let seed = 1; seed <= 400; seed++) {
      walk(seed, ({ after, from, to, dir, mru, root }) => {
        if (!touches(after, to, from, OPPOSITE[dir])) return;
        back++;
        expect(neighbour(after, to, OPPOSITE[dir], { root, mru }), `seed ${String(seed)}: ${from} ${dir} ${to} and back`).toBe(from);
      });
    }
    expect(back).toBeGreaterThan(1000);
  });

  it("with nothing folding (a large area), going back always returns", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const root = randomTree(rand, 3);
      const frame = plainRects(root, 4000, 3000);
      for (const p of panesOf(root)) {
        for (const dir of DIRECTIONS) {
          const mru = [activeTab(p)?.id ?? ""];
          const to = neighbour(frame, p.id, dir, { root, mru });
          if (!to) continue;
          const there = panesOf(root).find((q) => q.id === to);
          const after = [activeTab(there as GeoNode & { t: "pane" })?.id ?? "", ...mru];
          expect(neighbour(frame, to, OPPOSITE[dir], { root, mru: after }), `seed ${String(seed)}: ${p.id} ${dir} ${to} and back`).toBe(p.id);
        }
      }
    }
  });

  it("a rail is reached like any pane and is drawn open once focused", () => {
    let rails = 0;
    for (let seed = 1; seed <= 400; seed++) {
      walk(seed, ({ before, after, to }) => {
        if (!before.rects[to]?.rail) return;
        rails++;
        expect(after.rects[to]?.rail, `seed ${String(seed)}: ${to} focused`).toBe(false);
      });
    }
    expect(rails).toBeGreaterThan(100);
  });
});
