import { describe, expect, it } from "vitest";
import type { Row, Section } from "@/lib/tree";
import { ROW_HEIGHTS } from "@/stores/settings";
import { HEADER_HEIGHT, ROW_GAP, rowSize, SECOND_LINE } from "./rowSizes";

const thread = (section: Section): Row => ({ key: `s:${section}`, kind: "thread", section, threadId: section });
const header: Row = { key: "h:working", kind: "header", section: "working", label: "Working", count: 2, collapsed: false };

describe("rowSize", () => {
  it.each<[string, Row | undefined, keyof typeof ROW_HEIGHTS, number]>([
    ["two-line idle row, comfortable", thread("idle"), "comfortable", 50],
    ["two-line idle row, compact", thread("idle"), "compact", 46],
    ["two-line pinned row, comfortable", thread("pinned"), "comfortable", 50],
    ["two-line working row (Working footer), compact", thread("working"), "compact", 46],
    ["one-line archived row, comfortable", thread("archived"), "comfortable", 32],
    ["one-line archived row, compact", thread("archived"), "compact", 28],
    ["one-line snoozed row, comfortable", thread("snoozed"), "comfortable", 32],
    ["one-line snoozed row, compact", thread("snoozed"), "compact", 28],
    ["footer header, comfortable", header, "comfortable", HEADER_HEIGHT],
    ["footer header, compact", header, "compact", HEADER_HEIGHT],
    ["no row (out of range) sizes as a two-line row", undefined, "comfortable", 50],
  ])("%s", (_name, row, density, want) => {
    expect(rowSize(row, ROW_HEIGHTS[density])).toBe(want);
  });

  it("each line keeps a text-body name (22px) and a caption-sm status line (16px + 2px gap) inside the row's padding", () => {
    for (const h of Object.values(ROW_HEIGHTS)) {
      const pad = (h - 22) / 2;
      expect(pad).toBeGreaterThanOrEqual(3);
      expect(h + SECOND_LINE - (22 + 2 + 16)).toBe(2 * pad);
    }
  });

  it("the gap between rows is 4px", () => {
    expect(ROW_GAP).toBe(4);
  });
});
