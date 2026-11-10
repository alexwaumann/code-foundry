import { describe, expect, it } from "vitest";
import { catalogEntries, countWords, flatIds, matchesWords, readHint, readWords, searchPlaceholder, updateAllWords } from "./model";

const DAY = 86_400_000;
const now = Date.parse("2026-10-20T12:00:00Z");

describe("the flat list", () => {
  it("flatIds leaves empty groups out; catalogEntries counts each group's rows", () => {
    const ids = flatIds([
      ["a", ["1", "2"]],
      ["b", []],
      ["c", ["3"]],
    ]);
    expect(ids).toEqual(["#a", "1", "2", "#c", "3"]);
    expect(catalogEntries(ids)).toEqual([
      { kind: "group", id: "a", count: 2 },
      { kind: "row", key: "1" },
      { kind: "row", key: "2" },
      { kind: "group", id: "c", count: 1 },
      { kind: "row", key: "3" },
    ]);
  });
});

describe("words", () => {
  it("matchesWords needs every word, in any field, whatever the case; none match everything", () => {
    expect(matchesWords(["sql", "house"], ["SQL helper", "the house style"])).toBe(true);
    expect(matchesWords(["sql", "nope"], ["SQL helper"])).toBe(false);
    expect(matchesWords([], [])).toBe(true);
  });

  it("countWords groups thousands", () => {
    expect(countWords(1240)).toBe("1,240");
  });

  const where = { place: "your marketplace", browse: "Search the marketplace" };
  it.each([
    [false, 1240, "Search installed and the 1,240 in your marketplace"],
    [false, null, "Search installed and your marketplace"],
    [false, 0, "Search installed"],
    [true, 1240, "Search the marketplace"],
  ])("searchPlaceholder(browsing %s, %s)", (browsing, n, want) => {
    expect(searchPlaceholder(browsing, n, where)).toBe(want);
  });

  it.each([
    ["a run", { running: true, at: 2, total: 3 }, 1, "Updating 2 of 3…"],
    ["several to do", { running: false, at: 0, total: 0 }, 3, "Update all 3"],
    ["one is the row's own", { running: false, at: 0, total: 0 }, 1, null],
    ["none", { running: false, at: 3, total: 3 }, 0, null],
  ])("updateAllWords: %s", (_name, run, n, want) => {
    expect(updateAllWords(run, n)).toBe(want);
  });

  it.each([
    [null, "not read yet"],
    [now - 10_000, "read just now"],
    [now - 5 * 60_000, "read 5m ago"],
    [now - 3 * 3_600_000, "read 3h ago"],
    [now - 2 * DAY, "read 2d ago"],
  ])("readWords(%s) is %s", (at, want) => {
    expect(readWords(at, now)).toBe(want);
  });

  it("readHint is the newest read, as a sentence", () => {
    expect(readHint([now - DAY, now - 5 * 60_000, null], now)).toBe("Read 5m ago");
    expect(readHint([null], now)).toBe("Not read yet");
    expect(readHint([], now)).toBe("Not read yet");
  });
});
