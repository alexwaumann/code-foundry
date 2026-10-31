import { describe, expect, it } from "vitest";
import type { Row, Section } from "@/lib/tree";
import { ROW_HEIGHTS } from "@/stores/settings";
import { HEADER_HEIGHT, ROW_GAP, rowSize, THREE_LINE_ROW } from "./rowSizes";

const thread = (section: Section): Row => ({ key: `s:${section}`, kind: "thread", section, threadId: section });
const header: Row = { key: "h:working", kind: "header", section: "working", label: "Working", count: 2, collapsed: false };

describe("rowSize", () => {
  it.each<[string, Row | undefined, keyof typeof ROW_HEIGHTS, number]>([
    ["three-line idle row, comfortable", thread("idle"), "comfortable", 60],
    ["three-line idle row, compact", thread("idle"), "compact", 60],
    ["three-line pinned row, comfortable", thread("pinned"), "comfortable", 60],
    ["three-line attention row, compact", thread("attention"), "compact", 60],
    ["three-line done row, comfortable", thread("done"), "comfortable", 60],
    ["three-line working row (Working footer), compact", thread("working"), "compact", 60],
    ["one-line archived row, comfortable", thread("archived"), "comfortable", 32],
    ["one-line archived row, compact", thread("archived"), "compact", 28],
    ["one-line snoozed row, comfortable", thread("snoozed"), "comfortable", 32],
    ["one-line snoozed row, compact", thread("snoozed"), "compact", 28],
    ["footer header, comfortable", header, "comfortable", HEADER_HEIGHT],
    ["footer header, compact", header, "compact", HEADER_HEIGHT],
    ["no row (out of range) sizes as a three-line row", undefined, "comfortable", 60],
  ])("%s", (_name, row, density, want) => {
    expect(rowSize(row, ROW_HEIGHTS[density])).toBe(want);
  });

  it("a one-line row keeps a text-body name (22px) inside at least 3px of padding", () => {
    for (const h of Object.values(ROW_HEIGHTS)) expect((h - 22) / 2).toBeGreaterThanOrEqual(3);
  });

  it("a three-line row is two caption-sm lines (16px) and a text-body name (22px) with 3px above and below", () => {
    expect(THREE_LINE_ROW).toBe(16 + 22 + 16 + 2 * 3);
  });

  it("the gap between rows is 4px", () => {
    expect(ROW_GAP).toBe(4);
  });
});
