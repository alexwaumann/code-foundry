import { describe, expect, it } from "vitest";
import { hitRanges, moveSelection, nextScope, oneLine, opensPicker, pickerAction, pickerHeading, relativeAge, type PickerKeyEvent } from "./promptHistory";

function key(k: string, mods: Partial<Omit<PickerKeyEvent, "key">> = {}): PickerKeyEvent {
  return { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("relativeAge", () => {
  // Wed Oct 28 2026, 15:00 local time.
  const now = new Date(2026, 9, 28, 15, 0).getTime();
  const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi).getTime();
  it.each([
    ["seconds ago", now - 20_000, "now"],
    ["in the future (clock skew)", now + 60_000, "now"],
    ["minutes", now - 5 * 60_000, "5m"],
    ["59 minutes", now - 59 * 60_000 - 30_000, "59m"],
    ["hours", now - 2 * 3_600_000, "2h"],
    ["late yesterday, within a day", at(2026, 9, 27, 22), "17h"],
    ["yesterday, over a day", at(2026, 9, 27, 9), "yesterday"],
    ["two calendar days", at(2026, 9, 26, 18), "2d"],
    ["six days", at(2026, 9, 22, 8), "6d"],
    ["a week", at(2026, 9, 21, 8), new Date(at(2026, 9, 21, 8)).toLocaleDateString([], { month: "short", day: "numeric" })],
    ["last year", at(2025, 4, 3, 8), new Date(at(2025, 4, 3, 8)).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })],
  ])("%s", (_name, ms, want) => {
    expect(relativeAge(ms, now)).toBe(want);
  });
  it("just after midnight, last evening is hours, not yesterday", () => {
    const night = new Date(2026, 9, 28, 0, 30).getTime();
    expect(relativeAge(new Date(2026, 9, 27, 22, 0).getTime(), night)).toBe("2h");
  });
});

describe("pickerAction", () => {
  it.each<[string, PickerKeyEvent, boolean, ReturnType<typeof pickerAction>]>([
    ["Up moves up", key("ArrowUp"), true, { kind: "move", by: -1 }],
    ["Down moves down", key("ArrowDown"), true, { kind: "move", by: 1 }],
    ["Enter uses", key("Enter"), true, { kind: "use" }],
    ["Escape closes", key("Escape"), true, { kind: "close" }],
    ["cmd+Enter shows", key("Enter", { metaKey: true }), true, { kind: "show" }],
    ["cmd+C copies", key("c", { metaKey: true }), true, { kind: "copy" }],
    ["cmd+C with a selection copies the selection", key("c", { metaKey: true }), false, null],
    ["cmd+S cycles the scope", key("s", { metaKey: true }), true, { kind: "scope" }],
    ["cmd+S with caps lock", key("S", { metaKey: true }), true, { kind: "scope" }],
    ["Shift+Enter is the editor's", key("Enter", { shiftKey: true }), true, null],
    ["cmd+shift+S is not the picker's", key("s", { metaKey: true, shiftKey: true }), true, null],
    ["ctrl+Enter is not the picker's", key("Enter", { ctrlKey: true }), true, null],
    ["a letter filters", key("a"), true, null],
    ["Backspace edits the filter", key("Backspace"), true, null],
    ["cmd+A selects the filter", key("a", { metaKey: true }), true, null],
  ])("%s", (_name, e, selectionEmpty, want) => {
    expect(pickerAction(e, selectionEmpty)).toEqual(want);
  });
});

describe("opensPicker", () => {
  it.each<[string, PickerKeyEvent, boolean, boolean]>([
    ["Up in an empty composer", key("ArrowUp"), true, true],
    ["Up when the composer may not open it", key("ArrowUp"), false, false],
    ["Shift+Up selects", key("ArrowUp", { shiftKey: true }), true, false],
    ["cmd+Up moves the caret", key("ArrowUp", { metaKey: true }), true, false],
    ["Down never opens", key("ArrowDown"), true, false],
  ])("%s", (_name, e, canOpen, want) => {
    expect(opensPicker(e, canOpen)).toBe(want);
  });
});

describe("moveSelection", () => {
  it.each([
    [0, 1, 3, 1],
    [2, 1, 3, 0],
    [0, -1, 3, 2],
    [1, -1, 3, 0],
    [0, 1, 0, 0],
    [0, -1, 1, 0],
  ] as const)("from %i by %i of %i is %i", (from, by, count, want) => {
    expect(moveSelection(from, by, count)).toBe(want);
  });
});

describe("nextScope", () => {
  it.each([
    ["thread", true, "project"],
    ["project", true, "all"],
    ["all", true, "thread"],
    ["project", false, "all"],
    ["all", false, "project"],
  ] as const)("%s (thread scope %s) -> %s", (from, threadScope, want) => {
    expect(nextScope(from, threadScope)).toBe(want);
  });
});

describe("pickerHeading", () => {
  it.each([
    ["loading", { count: 0, more: false, filtering: false, loaded: false }, "Previous prompts"],
    ["all of them", { count: 12, more: false, filtering: false, loaded: true }, "Previous prompts"],
    ["limited", { count: 50, more: true, filtering: false, loaded: true }, "Previous prompts · latest 50"],
    ["filtering", { count: 2, more: false, filtering: true, loaded: true }, "Previous prompts · 2 matches"],
    ["one match", { count: 1, more: false, filtering: true, loaded: true }, "Previous prompts · 1 match"],
    ["no match", { count: 0, more: false, filtering: true, loaded: true }, "Previous prompts · 0 matches"],
    ["more matches than shown", { count: 50, more: true, filtering: true, loaded: true }, "Previous prompts · 50+ matches"],
  ])("%s", (_name, state, want) => {
    expect(pickerHeading(state)).toBe(want);
  });
});

describe("hitRanges", () => {
  it.each<[string, string, string, [number, number][]]>([
    ["no query", "The PR badge", "", []],
    ["blank query", "The PR badge", "  ", []],
    ["one hit, any case", "The PR Badge", "badge", [[7, 12]]],
    ["every hit", "badge and badge", "badge", [[0, 5], [10, 15]]],
    ["not overlapping", "aaaa", "aa", [[0, 2], [2, 4]]],
    ["trimmed", "fix the race", " race ", [[8, 12]]],
    ["none", "fix the race", "flake", []],
  ])("%s", (_name, text, query, want) => {
    expect(hitRanges(text, query)).toEqual(want);
  });
});

describe("oneLine", () => {
  it("joins lines and collapses whitespace", () => {
    expect(oneLine("  first line\n\nsecond\t line  ")).toBe("first line second line");
  });
});
