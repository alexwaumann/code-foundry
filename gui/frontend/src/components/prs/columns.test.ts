import { describe, expect, it } from "vitest";
import { COLUMNS, gridTemplate, IMPORTANCE, visibleColumns } from "./columns";
import { SECTIONS } from "./pageModel";

describe("visibleColumns", () => {
  // Widths are the table's inner width in px.
  it.each([
    { section: "review", width: 1150, want: ["Repository", "#", "Author", "Title", "Why", "Checks", "Diff", "Age"] },
    { section: "review", width: 810, want: ["Repository", "#", "Author", "Title", "Why", "Checks", "Age"] },
    { section: "review", width: 610, want: ["Repository", "#", "Author", "Title", "Why"] },
    { section: "review", width: 470, want: ["#", "Title", "Why"] },
    { section: "reviewed", width: 610, want: ["Repository", "#", "Author", "Title", "Your review"] },
    { section: "authored", width: 1150, want: ["Repository", "#", "Title", "Status", "Checks", "Comments", "Diff", "Age"] },
    { section: "authored", width: 810, want: ["Repository", "#", "Title", "Status", "Checks", "Comments", "Age"] },
    { section: "authored", width: 610, want: ["Repository", "#", "Title", "Status"] },
    { section: "else", width: 810, want: ["#", "Author", "Title", "Status", "Checks", "Diff", "Age"] },
    { section: "else", width: 610, want: ["#", "Author", "Title", "Status"] },
    { section: "else", width: 470, want: ["#", "Title", "Status"] },
    { section: "merged", width: 610, want: ["#", "Author", "Title", "Diff", "Merged"] },
    { section: "merged", width: 470, want: ["#", "Author", "Title", "Merged"] },
    // However narrow, Title, the number and the state column stay.
    { section: "merged", width: 100, want: ["#", "Title", "Merged"] },
    { section: "review", width: 0, want: ["#", "Title", "Why"] },
  ] as const)("$section at $width px: $want", ({ section, width, want }) => {
    expect(visibleColumns(section, width)).toEqual(want);
  });

  it("each table ranks exactly its own columns, and every shown set is a prefix of the ranking", () => {
    for (const s of SECTIONS) {
      expect([...IMPORTANCE[s]].sort()).toEqual([...COLUMNS[s]].sort());
      for (let w = 0; w <= 1400; w += 10) {
        const shown = new Set(visibleColumns(s, w));
        expect(IMPORTANCE[s].slice(0, shown.size).every((c) => shown.has(c))).toBe(true);
      }
    }
  });

  it("the grid template has one track per column", () => {
    expect(gridTemplate(["#", "Title", "Merged"])).toBe("4.5rem minmax(10rem,2.4fr) 3.5rem");
  });
});
