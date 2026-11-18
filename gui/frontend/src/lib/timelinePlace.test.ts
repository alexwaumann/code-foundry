import { beforeEach, describe, expect, it } from "vitest";
import { keepTimelinePlace, placeRow, placeTop, resetTimelinePlaces, timelinePlace } from "./timelinePlace";

const rowsOf = (...keys: string[]) => keys.map((key) => ({ key }));

describe("placeRow", () => {
  const was = rowsOf("u1", "h1", "t1", "t2", "a1", "u2");
  const cases: { name: string; index: number; now: string[]; want: { at: number; own: boolean } | undefined }[] = [
    { name: "the same row", index: 3, now: ["u1", "h1", "t1", "t2", "a1", "u2"], want: { at: 3, own: true } },
    { name: "the same row after rows arrived above it", index: 3, now: ["u0", "u1", "h1", "t1", "t2"], want: { at: 4, own: true } },
    // The turn folded: its tool rows went, its header stands in.
    { name: "the nearest row before one that went", index: 3, now: ["u1", "h1", "a1", "u2"], want: { at: 1, own: false } },
    { name: "the nearest row after when none before is left", index: 1, now: ["a1", "u2"], want: { at: 0, own: false } },
    { name: "nothing left of it", index: 3, now: ["x", "y"], want: undefined },
    { name: "no rows", index: 3, now: [], want: undefined },
  ];
  for (const c of cases)
    it(c.name, () => {
      expect(placeRow({ index: c.index, offset: 0, rows: was }, rowsOf(...c.now))).toEqual(c.want);
    });
});

describe("placeTop", () => {
  it("keeps the row's own offset, into it or under the top", () => {
    expect(placeTop({ offset: -499 }, 5000, true)).toBe(5499);
    expect(placeTop({ offset: 12 }, 5000, true)).toBe(4988);
  });
  it("starts a stand-in at the top, not as far into it as the row that went", () => {
    expect(placeTop({ offset: -499 }, 5000, false)).toBe(5000);
    expect(placeTop({ offset: 12 }, 5000, false)).toBe(4988);
  });
});

describe("kept places", () => {
  beforeEach(resetTimelinePlaces);
  const place = (index: number) => ({ index, offset: -3, rows: rowsOf("a", "b", "c") });

  it("keeps a place per list and forgets one that follows the bottom", () => {
    keepTimelinePlace("t1", place(1));
    keepTimelinePlace("t2", place(2));
    expect(timelinePlace("t1")?.index).toBe(1);
    expect(timelinePlace("t2")?.index).toBe(2);
    keepTimelinePlace("t1", null);
    expect(timelinePlace("t1")).toBeUndefined();
    expect(timelinePlace("t2")?.index).toBe(2);
  });

  it("drops the least recently kept past its limit", () => {
    for (let i = 0; i < 64; i++) keepTimelinePlace(`t${String(i)}`, place(0));
    // Kept again: t0 is now the most recent.
    keepTimelinePlace("t0", place(1));
    keepTimelinePlace("t64", place(0));
    expect(timelinePlace("t1")).toBeUndefined();
    expect(timelinePlace("t0")?.index).toBe(1);
    expect(timelinePlace("t64")).toBeDefined();
  });
});
