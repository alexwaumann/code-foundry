import { describe, expect, it } from "vitest";
import type { Row, Section } from "@/lib/tree";
import { HEADER_HEIGHT, ONE_LINE_ROW, QUIET_ROW_GAP, rowGap, rowSize, THREE_LINE_ROW, TWO_LINE_ROW } from "./rowSizes";

const thread = (section: Section): Row => ({ key: `s:${section}`, kind: "thread", section, threadId: section });
const header: Row = { key: "h:working", kind: "header", section: "working", label: "Working", count: 2, collapsed: false };

describe("rowSize", () => {
  it.each<[string, Row | undefined, number]>([
    ["three-line idle row", thread("idle"), 60],
    ["three-line pinned row", thread("pinned"), 60],
    ["three-line attention row", thread("attention"), 60],
    ["three-line done row", thread("done"), 60],
    ["three-line working row (Working footer)", thread("working"), 60],
    ["one-line archived row", thread("archived"), 24],
    ["one-line snoozed row", thread("snoozed"), 24],
    ["footer header", header, HEADER_HEIGHT],
    ["no row (out of range) sizes as a three-line row", undefined, 60],
  ])("%s", (_name, row, want) => {
    expect(rowSize(row)).toBe(want);
  });

  it.each<[string, Row, number]>([
    ["no branch line (no project, no git): two lines", thread("idle"), 44],
    ["a footer's live row too", thread("working"), 44],
    ["a quiet row stays one line", thread("archived"), 24],
  ])("branchless %s", (_name, row, want) => {
    expect(rowSize(row, true)).toBe(want);
  });

  it("a two-line row is the name (22px) and the project line (16px) with 3px above and below", () => {
    expect(TWO_LINE_ROW).toBe(22 + 16 + 2 * 3);
  });

  it("two one-line rows leave 4px between their text-body names (22px)", () => {
    expect(ONE_LINE_ROW - 22 + QUIET_ROW_GAP).toBe(4);
  });

  it("a three-line row is a text-body name (22px) and two caption-sm lines (16px) with 3px above and below", () => {
    expect(THREE_LINE_ROW).toBe(16 + 22 + 16 + 2 * 3);
  });

});

describe("rowGap", () => {
  it.each<[Section, number]>([
    ["pinned", 8],
    ["attention", 8],
    ["done", 8],
    ["idle", 8],
    ["working", 8],
    ["snoozed", 2],
    ["archived", 2],
  ])("%s rows sit %ipx apart", (section, want) => {
    expect(rowGap(section)).toBe(want);
  });
});
