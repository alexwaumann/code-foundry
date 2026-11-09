/** The arithmetic of a list's interactive rows (rows.ts; docs/notes/plugin-list-rows.md). */
import { describe, expect, it } from "vitest";
import type { Row } from "@/api/plugin";
import { addPending, afterOf, applyChanges, dropAt, edgeScroll, editCommit, keyMove, moveKeys, settle, shows, type PendingChange, type RowChange } from "./rows";

const rows = (...keys: string[]): Row[] => keys.map((k) => ({ key: k, title: k.toUpperCase() }));
const keys = (rs: readonly Row[]) => rs.map((r) => r.key).join(" ");

describe("moveKeys", () => {
  it.each([
    ["to the top", "c", "", "c a b d"],
    ["under another", "a", "c", "b c a d"],
    ["to the end", "a", "d", "b c d a"],
    ["where it is", "b", "a", "a b c d"],
    ["under itself", "b", "b", "a b c d"],
    ["a missing row", "z", "", "a b c d"],
    ["under a missing row", "a", "z", "a b c d"],
  ])("%s", (_, key, after, want) => {
    expect(moveKeys(["a", "b", "c", "d"], key, after).join(" ")).toBe(want);
  });
});

describe("afterOf and keyMove", () => {
  const ks = ["a", "b", "c"];
  it("names the row above, or the top", () => {
    expect([afterOf(ks, "a"), afterOf(ks, "b"), afterOf(ks, "c"), afterOf(ks, "z")]).toEqual(["", "a", "b", ""]);
  });
  it.each([
    ["up from the top", "a", -1, null],
    ["up from second", "b", -1, ""],
    ["up from third", "c", -1, "a"],
    ["down from the top", "a", 1, "b"],
    ["down from the bottom", "c", 1, null],
    ["a missing row", "z", 1, null],
  ] as const)("%s", (_, key, dir, want) => {
    expect(keyMove(ks, key, dir)).toBe(want);
  });
});

describe("applyChanges", () => {
  it("ticks, renames and moves in order", () => {
    const out = applyChanges(rows("a", "b", "c"), [
      { kind: "check", key: "b", checked: true },
      { kind: "move", key: "c", after: "" },
      { kind: "edit", key: "a", title: "Alpha" },
      { kind: "move", key: "a", after: "b" },
    ]);
    expect(keys(out)).toBe("c b a");
    expect(out.find((r) => r.key === "b")?.checked).toBe(true);
    expect(out.find((r) => r.key === "a")?.title).toBe("Alpha");
  });
  it("leaves the rows alone without changes, and ignores a row that is gone", () => {
    const rs = rows("a");
    expect(applyChanges(rs, [])).toBe(rs);
    expect(applyChanges(rs, [{ kind: "check", key: "z", checked: true }])).toEqual(rs);
  });
});

describe("shows and settle", () => {
  const check: RowChange = { kind: "check", key: "a", checked: true };
  const move: RowChange = { kind: "move", key: "b", after: "" };
  const edit: RowChange = { kind: "edit", key: "a", title: "New" };
  it("knows when the plugin's rows have a change", () => {
    expect(shows(rows("a"), check)).toBe(false);
    expect(shows([{ key: "a", title: "A", checked: true }], check)).toBe(true);
    expect(shows(rows("a", "b"), move)).toBe(false);
    expect(shows(rows("b", "a"), move)).toBe(true);
    expect(shows([{ key: "a", title: "New" }], edit)).toBe(true);
    expect(shows(rows("z"), check)).toBe(true); // the row went (to another list)
  });
  const p = (change: RowChange, answered: boolean, at: number, id = 1): PendingChange => ({ id, change, answered, at });
  it.each([
    ["unanswered, whatever the view", p(check, false, 0), rows("a"), 9, true],
    ["answered, the view at the answer does not show it", p(check, true, 3), rows("a"), 3, true],
    ["answered, the view shows it", p(check, true, 3), [{ key: "a", title: "A", checked: true }], 3, false],
    ["answered, a newer view without it", p(check, true, 3), rows("a"), 4, false],
  ] as const)("%s", (_, pending, rs, version, kept) => {
    expect(settle([pending], rs, version).length).toBe(kept ? 1 : 0);
  });
  it("keeps the same array when nothing settles", () => {
    const ps = [p(check, false, 0)];
    expect(settle(ps, rows("a"), 1)).toBe(ps);
  });
  it("replaces a change of the same kind on the same row", () => {
    const ps = addPending(addPending(addPending([], check, 1), edit, 2), { kind: "check", key: "a", checked: false }, 3);
    expect(ps.map((x) => x.id)).toEqual([2, 3]);
    expect(ps.every((x) => !x.answered)).toBe(true);
  });
});

describe("editCommit", () => {
  it.each([
    ["new text, trimmed", "Old", "  New  ", "New"],
    ["empty", "Old", "   ", null],
    ["unchanged", "Old", " Old ", null],
  ])("%s", (_, title, text, want) => {
    expect(editCommit(title, text)).toBe(want);
  });
});

describe("dropAt", () => {
  // Rows a..d, 30 px each from y 100; d is not drawn (virtualized away).
  const boxes = [
    { key: "a", top: 100, bottom: 130 },
    { key: "b", top: 130, bottom: 160 },
    { key: "c", top: 160, bottom: 190 },
  ];
  const ks = ["a", "b", "c", "d", "e"];
  it.each([
    ["above a's middle: the top", "c", 110, "", 100],
    ["between a and b", "c", 120, "a", 130],
    ["just above itself", "c", 150, null, 160],
    ["just below itself", "c", 180, null, 190],
    ["under the last drawn row", "a", 185, "c", 190],
    ["under the last drawn row, its next undrawn", "a", 400, "c", 190],
  ] as const)("%s", (_, key, y, after, lineY) => {
    expect(dropAt(ks, boxes, key, y)).toEqual({ after, lineY });
  });
  it("a gap whose upper row is not drawn names it from the order", () => {
    // Only c and d drawn: above c's middle is under b (scrolled away).
    expect(dropAt(ks, [{ key: "c", top: 0, bottom: 30 }, { key: "d", top: 30, bottom: 60 }], "e", 5)).toEqual({ after: "b", lineY: 0 });
  });
  it("nothing drawn: nowhere", () => {
    expect(dropAt(ks, [], "a", 0)).toBeNull();
  });
});

describe("edgeScroll", () => {
  it.each([
    ["the middle", 300, 0],
    ["near the top", 120, -7],
    ["past the top", 50, -14],
    ["near the bottom", 480, 7],
    ["past the bottom", 600, 14],
  ])("%s", (_, y, want) => {
    expect(edgeScroll(y, 100, 500)).toBe(want);
  });
  it("a box too short for both zones does not scroll", () => {
    expect(edgeScroll(100, 100, 150)).toBe(0);
  });
});
