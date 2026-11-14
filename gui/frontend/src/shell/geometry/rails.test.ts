import { describe, expect, it } from "vitest";
import { col, pane, randomTree, rng, row } from "@/test/shellTrees";
import { foldOrder, foldRails, shellFrame, unfoldable, type RailsInput } from "./rails";
import { RAIL, minimumOf, paneMinimum, tilingErrors } from "./rects";
import { panesOf, type GeoNode } from "./types";

/** Freezes a tree all the way down, so any write to the stored layout throws. */
function frozen<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(frozen);
    Object.freeze(v);
  }
  return v;
}

const sorted = (s: Set<string>) => [...s].sort();

// a: thread A, b: A's diff, c: Pull Requests, d: thread B, each 480 wide at least. 1956 x 400.
const four = frozen(
  row("s", [0.25, 0.25, 0.25, 0.25], pane("a", "thread:A"), pane("b", "diff:A"), pane("c", "prs"), pane("d", "thread:B")),
);
const fourAt = (w: number, extra: Partial<RailsInput> = {}): RailsInput => ({
  root: four,
  w,
  h: 600,
  focus: "a",
  mru: ["a/0", "d/0", "b/0"],
  ...extra,
});

describe("fold order", () => {
  it("panes without a thread tab first, least recently focused first, never-focused before any", () => {
    expect(foldOrder(four, "a", ["a/0", "d/0", "b/0"])).toEqual(["c", "b", "d"]);
    expect(foldOrder(four, "a", ["a/0", "b/0", "c/0", "d/0"])).toEqual(["c", "b", "d"]);
    expect(foldOrder(four, "a", ["c/0", "b/0", "a/0", "d/0"])).toEqual(["b", "c", "d"]);
  });

  it("a pane is as recent as its most recently focused tab", () => {
    const tree = row("s", [0.5, 0.25, 0.25], pane("a", "thread:A"), pane("b", "prs", "projects"), pane("c", "diff"));
    expect(foldOrder(tree, "a", ["b/1", "c/0", "b/0"])).toEqual(["c", "b"]);
  });

  it("panes never focused fold later ones in layout order first", () => {
    const tree = row("s", [0.4, 0.2, 0.2, 0.2], pane("a", "thread:A"), pane("b", "prs"), pane("c", "projects"), pane("d", "diff"));
    expect(foldOrder(tree, "a", [])).toEqual(["d", "c", "b"]);
  });

  it("panes with thread tabs fold after every pane without, whatever their recency", () => {
    const tree = row("s", [0.4, 0.3, 0.3], pane("a", "thread:A"), pane("b", "thread:B", "diff:B"), pane("c", "prs"));
    expect(foldOrder(tree, "a", ["c/0", "a/0"])).toEqual(["c", "b"]);
  });
});

describe("never folds", () => {
  it("the focused pane", () => {
    expect(sorted(unfoldable(four, "c"))).toEqual(["c"]);
  });

  it("the pane of the focused thread, when the focus is on its own tab", () => {
    expect(sorted(unfoldable(four, "a"))).toEqual(["a"]);
  });

  it("the pane of the focused thread, when the focus is on one of its linked surfaces", () => {
    expect(sorted(unfoldable(four, "b"))).toEqual(["a", "b"]);
    expect(foldOrder(four, "b", [])).toEqual(["c", "d"]);
  });

  it("nothing when no pane is focused", () => {
    expect(sorted(unfoldable(four, undefined))).toEqual([]);
    expect(sorted(unfoldable(four, "p-gone"))).toEqual([]);
  });

  it("not even when the window cannot hold them", () => {
    const rails = foldRails(fourAt(300, { focus: "b" }));
    expect(sorted(rails)).toEqual(["c", "d"]);
    const frame = shellFrame(fourAt(300, { focus: "b" }));
    expect(frame.rects.a?.rail).toBe(false);
    expect(frame.rects.b?.rail).toBe(false);
    expect(tilingErrors(frame)).toEqual([]);
  });
});

describe("folding", () => {
  it.each([
    { w: 2000, want: [] },
    { w: 1956, want: [] },
    { w: 1955, want: ["c"] },
    { w: 1600, want: ["c"] },
    { w: 1100, want: ["b", "c"] },
    { w: 700, want: ["b", "c", "d"] },
    { w: 400, want: ["b", "c", "d"] },
  ])("at $w px wide: $want", ({ w, want }) => {
    expect(sorted(foldRails(fourAt(w)))).toEqual(want);
    const frame = shellFrame(fourAt(w));
    expect(tilingErrors(frame)).toEqual([]);
    for (const id of want) expect(frame.rects[id]?.w).toBe(RAIL);
  });

  it("unfolds when there is room again: the rails come from the area alone", () => {
    const input = fourAt(1100);
    expect(sorted(foldRails(input))).toEqual(["b", "c"]);
    expect(sorted(foldRails({ ...input, w: 1600 }))).toEqual(["c"]);
    expect(sorted(foldRails({ ...input, w: 2000 }))).toEqual([]);
  });

  it("never changes the stored layout", () => {
    const before = JSON.stringify(four);
    expect(() => shellFrame(fourAt(500))).not.toThrow();
    expect(JSON.stringify(four)).toBe(before);
  });

  it("a fold that does not help unfolds again", () => {
    // c folds first (never focused) but the column stays as wide as b; b folds too, and then c unfolds.
    const tree = row("s", [0.5, 0.5], pane("a", "thread:A"), col("k", [0.5, 0.5], pane("b", "prs"), pane("c", "terminal")));
    expect(minimumOf(tree)).toEqual({ w: 972, h: 632 });
    expect(sorted(foldRails({ root: tree, w: 800, h: 600, focus: "a", mru: ["b/0"] }))).toEqual(["b"]);
  });

  it("folds for height as well as width", () => {
    const tree = col("s", [0.5, 0.25, 0.25], pane("a", "thread:A"), pane("b", "terminal"), pane("c", "diff"));
    expect(minimumOf(tree).h).toBe(400 + 220 + 400 + 24);
    const input = { root: tree, w: 800, h: 700, focus: "a", mru: ["a/0", "b/0", "c/0"] };
    expect(sorted(foldRails(input))).toEqual(["c"]);
    expect(shellFrame(input).rects.c).toEqual({ x: 0, y: 664, w: 800, h: RAIL, rail: true });
  });

  it("unfolds an earlier fold a later one made unnecessary", () => {
    // The terminal folds first and saves 264px, not enough; thread B then saves 444px alone.
    const tree = row("s", [0.4, 0.2, 0.4], pane("a", "thread:A"), pane("t", "terminal"), pane("u", "thread:B"));
    expect(foldOrder(tree, "a", [])).toEqual(["t", "u"]);
    expect(sorted(foldRails({ root: tree, w: 900, h: 600, focus: "a" }))).toEqual(["u"]);
  });

  it("folds a whole column when only all of it folding narrows it", () => {
    // Two panes stacked in a column: folding either alone leaves the column as wide as the other.
    const tree = row("s", [0.4, 0.3, 0.3], pane("a", "thread:A"), col("k", [0.5, 0.5], pane("b", "compose"), pane("c", "thread:C")), pane("d", "diff:A"));
    const input = { root: tree, w: 1100, h: 600, focus: "d", mru: ["d/0", "a/0"] };
    expect(sorted(foldRails(input))).toEqual(["b", "c"]);
    const frame = shellFrame(input);
    expect(frame.rects.a?.w).toBeGreaterThanOrEqual(480);
    expect(frame.rects.d?.w).toBeGreaterThanOrEqual(480);
  });

  it("folds a whole row of short panes into horizontal strips", () => {
    // A row of two panes over a thread: the row is only shorter once both fold, and then each is a
    // strip as wide as its share and a rail tall.
    const tree = col("s", [0.5, 0.5], row("r", [0.5, 0.5], pane("a", "diff:A"), pane("b", "prs")), pane("c", "thread:A"));
    const input = { root: tree, w: 1000, h: 500, focus: "c", mru: ["c/0"] };
    expect(sorted(foldRails(input))).toEqual(["a", "b"]);
    const frame = shellFrame(input);
    expect(frame.rects.a).toMatchObject({ h: RAIL, rail: true });
    expect(frame.rects.b).toMatchObject({ h: RAIL, rail: true });
    expect((frame.rects.a?.w ?? 0) > RAIL).toBe(true);
    expect(frame.rects.c?.h).toBe(500 - RAIL - 12);
    expect(tilingErrors(frame)).toEqual([]);
  });

  it("folds nothing for an empty space", () => {
    expect(sorted(foldRails({ root: null, w: 10, h: 10 }))).toEqual([]);
  });
});

// The owner's layout at the window's minimum width (MIN_GRID_W: 940 less the sidebar at its minimum
// and two gaps): a thread, a column of a draft over a thread, a pane with a thread, A's diff, Pull
// Requests and Projects; one thread under the row. docs/notes/shell-25a-test-feedback.md; the
// minimums since docs/notes/shell-25f-sizes.md.
const MIN_GRID_W = 940 - 240 - 24;
const owner = (active: string) =>
  col(
    "root",
    [0.6, 0.4],
    row(
      "r",
      [0.33, 0.33, 0.34],
      pane("a", "thread:A"),
      col("m", [0.5, 0.5], pane("cmp", "compose"), pane("b", "thread:B")),
      { ...pane("c", "thread:C", "diff:A", "prs", "projects"), active },
    ),
    pane("d", "thread:D"),
  );
const ownerAt = (active: string, focus: string, w = MIN_GRID_W) => ({ root: owner(active), w, h: 900, focus, mru: ["c/1", "a/0", "b/0", "cmp/0", "d/0"] });

describe("the owner's layout at the minimum width", () => {
  it.each([
    // Focus on the diff keeps a (its thread) and c. Before: nothing folded (neither panes of the
    // middle column narrowed it alone) and the middle column was drawn at 204px.
    { doc: "the diff focused", active: "c/1", focus: "c", want: ["b", "cmp"] },
    { doc: "thread A focused, the diff active", active: "c/1", focus: "a", want: ["b", "c", "cmp"] },
    { doc: "Pull Requests focused", active: "c/2", focus: "c", want: ["a", "b", "cmp"] },
  ])("$doc: folds $want and draws no pane that may fold below its minimum", ({ active, focus, want }) => {
    const input = ownerAt(active, focus);
    expect(sorted(foldRails(input))).toEqual(want);
    const frame = shellFrame(input);
    expect(tilingErrors(frame)).toEqual([]);
    const keep = unfoldable(input.root, focus);
    for (const p of panesOf(input.root)) {
      const r = frame.rects[p.id];
      if (!r || r.rail || keep.has(p.id)) continue;
      const m = paneMinimum(p);
      expect(r.w, p.id).toBeGreaterThanOrEqual(m.w);
      expect(r.h, p.id).toBeGreaterThanOrEqual(m.h);
    }
  });

  it("the diff focused: a and c share what is left in proportion to their minimums", () => {
    const frame = shellFrame(ownerAt("c/1", "c"));
    // The width less two 12px gaps and the 36px rail column, shared 480 : 480.
    const left = MIN_GRID_W - 24 - RAIL;
    expect(frame.rects.a?.w).toBe(Math.round(left / 2));
    expect((frame.rects.a?.w ?? 0) + (frame.rects.c?.w ?? 0)).toBe(left);
  });

  it("with room for the diff and its thread, both keep their minimums", () => {
    const frame = shellFrame(ownerAt("c/1", "c", 480 + 12 + RAIL + 12 + 480));
    expect(frame.rects.a?.w).toBeGreaterThanOrEqual(480);
    expect(frame.rects.c?.w).toBeGreaterThanOrEqual(480);
  });
});

describe("random trees", () => {
  it("keep the unfoldable panes, tile the area, and unfold every rail that could", () => {
    const rand = rng(23);
    for (let n = 0; n < 300; n++) {
      const root: GeoNode = frozen(randomTree(rand, 2));
      const panes = panesOf(root);
      const focus = panes[Math.floor(rand() * panes.length)]?.id;
      const mru = panes.flatMap((p) => (p.tabs ?? []).map((t) => t.id)).filter(() => rand() < 0.5);
      const min = minimumOf(root);
      const w = Math.max(400, Math.round(min.w * (0.4 + rand() * 0.8)));
      const h = Math.max(400, Math.round(min.h * (0.4 + rand() * 0.8)));
      const input = { root, w, h, focus, mru };
      const rails = foldRails(input);
      for (const id of unfoldable(root, focus)) expect(rails.has(id), `tree ${String(n)}: ${id} folded`).toBe(false);
      const frame = shellFrame(input);
      expect(tilingErrors(frame), `tree ${String(n)} at ${String(w)}x${String(h)}`).toEqual([]);
      const fits = (s: { w: number; h: number }) => s.w <= w && s.h <= h;
      const keep = unfoldable(root, focus);
      const short = panesOf(root).filter((p) => {
        const r = frame.rects[p.id];
        const m = paneMinimum(p);
        return !!r && !r.rail && (r.w < m.w - 1 || r.h < m.h - 1);
      });
      // Only a pane that never folds is drawn short, and then no other fold would help.
      for (const p of short) expect(keep.has(p.id), `tree ${String(n)}: ${p.id} short`).toBe(true);
      if (short.length > 0) {
        const over = (s: { w: number; h: number }) => [Math.max(0, s.w - w), Math.max(0, s.h - h)];
        const [ow = 0, oh = 0] = over(minimumOf(root, rails));
        for (const p of panesOf(root)) {
          if (rails.has(p.id) || keep.has(p.id)) continue;
          const [fw = 0, fh = 0] = over(minimumOf(root, new Set([...rails, p.id])));
          expect(fw < ow || fh < oh, `tree ${String(n)}: folding ${p.id} would help`).toBe(false);
        }
      }
      if (fits(minimumOf(root, rails))) {
        for (const id of rails) {
          const without = new Set(rails);
          without.delete(id);
          expect(fits(minimumOf(root, without)), `tree ${String(n)}: ${id} could unfold`).toBe(false);
        }
      }
    }
  });
});
