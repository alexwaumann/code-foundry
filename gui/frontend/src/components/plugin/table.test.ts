/** A plugin table's layout and lines (docs/notes/plugin-table.md): pure. */
import { describe, expect, it } from "vitest";
import type { TableColumn, TableData, TableRow } from "@/api/pluginTable";
import { demoView } from "@/test/pluginFixtures";
import { cellParts, columnTrack, nextSort, rankColumns, tableItems, tableLayout } from "./table";

// Columns like the demo's Builds table's (plugins/examples/hello/builds.go).
const cols: TableColumn[] = [
  { key: "num", label: "#", width: 72, priority: 9, sortable: true, sortFirst: "desc" },
  { key: "status", label: "Status", width: 72, priority: 3 },
  { key: "branch", label: "Branch", weight: 2, minWidth: 96, style: "mono", priority: 6, sortable: true },
  { key: "cause", label: "Cause", weight: 3, minWidth: 140, priority: 1 },
  { key: "by", label: "Started by", width: 88, style: "muted", priority: 2 },
  { key: "dur", label: "Duration", width: 64, align: "end", style: "mono", priority: 7, sortable: true, sortFirst: "desc" },
  { key: "age", label: "Age", width: 40, align: "end", style: "caption", priority: 5 },
];
const row = (key: string, extra: Partial<TableRow> = {}): TableRow => ({ key, cells: { num: `#${key}` }, ...extra });
const shown = (t: TableData, w: number | null) => tableLayout(t, w).columns.map((c) => c.key);

describe("tableLayout", () => {
  const t: TableData = { columns: cols, rows: [row("1")] };
  // Widths are the table's inner width (px). The ranking is num, dur, branch, age, status, by, cause.
  it.each([
    { width: null, want: ["num", "status", "branch", "cause", "by", "dur", "age"] },
    { width: 900, want: ["num", "status", "branch", "cause", "by", "dur", "age"] },
    { width: 680, want: ["num", "status", "branch", "cause", "by", "dur", "age"] },
    { width: 640, want: ["num", "status", "branch", "by", "dur", "age"] },
    { width: 520, want: ["num", "status", "branch", "by", "dur", "age"] },
    { width: 470, want: ["num", "status", "branch", "dur", "age"] },
    { width: 400, want: ["num", "branch", "dur", "age"] },
    { width: 300, want: ["num", "branch", "dur"] },
    { width: 200, want: ["num", "dur"] },
    // However narrow, the first ranked stays.
    { width: 40, want: ["num"] },
    { width: 0, want: ["num"] },
  ])("at $width px: $want", ({ width, want }) => {
    expect(shown(t, width)).toEqual(want);
  });

  it("drops least important first: every shown set is a prefix of the ranking, in display order", () => {
    const ranking = rankColumns(cols).map((c) => c.key);
    for (let w = 0; w <= 1000; w += 7) {
      const s = new Set(shown(t, w));
      expect(ranking.slice(0, s.size).every((k) => s.has(k))).toBe(true);
      expect(shown(t, w)).toEqual(cols.map((c) => c.key).filter((k) => s.has(k)));
    }
  });

  it("ranks by priority, then the leftmost; without priorities columns drop from the right", () => {
    const plain: TableColumn[] = [{ key: "a", width: 100 }, { key: "b", width: 100 }, { key: "c", width: 100, priority: 1 }, { key: "d", width: 100 }];
    expect(rankColumns(plain).map((c) => c.key)).toEqual(["c", "a", "b", "d"]);
    expect(shown({ columns: plain.map((c) => ({ ...c, priority: 0 })) }, 260)).toEqual(["a", "b"]);
  });

  it("tracks: a fixed width, else a weight with its floor (80 px by default)", () => {
    expect(columnTrack({ key: "a", width: 40 })).toBe("40px");
    expect(columnTrack({ key: "a", weight: 2, minWidth: 96 })).toBe("minmax(96px,2fr)");
    expect(columnTrack({ key: "a" })).toBe("minmax(80px,1fr)");
    expect(tableLayout({ columns: cols.slice(0, 3) }, 900).template).toBe("72px 72px minmax(96px,2fr)");
  });

  it("adds a ⋯ track when a row has a menu", () => {
    const m = tableLayout({ columns: cols, rows: [row("1", { menu: { items: [{ key: "m", label: "M", action: { event: "m" } }] } })] }, 900);
    expect(m.more).toBe(true);
    expect(m.template.endsWith(" 24px")).toBe(true);
    // The ⋯ takes room: Cause goes sooner than without it.
    expect(shown({ columns: cols, rows: [row("1")] }, 680)).toContain("cause");
    expect(tableLayout({ columns: cols, rows: [row("1", { menu: { items: [{ key: "m", label: "M", action: { event: "m" } }] } })] }, 680).columns.map((c) => c.key)).not.toContain("cause");
  });

  describe("a row's buttons", () => {
    const rerun = { key: "r", label: "Rerun", icon: "rotate-ccw", action: { event: "rerun" } };
    const withButtons: TableData = { columns: cols, rows: [row("1"), row("2", { actions: [rerun] })] };

    it("show in their own track while every column fits beside them; no ⋯ without a menu", () => {
      const l = tableLayout(withButtons, 900);
      // Rerun with its icon: 16 px of padding, 14 of icon, 7 a character (menu.ts buttonWidth).
      expect(l).toMatchObject({ folded: false, buttons: 65, more: false });
      expect(l.columns).toHaveLength(7);
      expect(l.template.endsWith(" 65px")).toBe(true);
    });

    it("fold into the ⋯ before any column drops", () => {
      // 690 px (670 for the columns) fits them (644 px with their gaps) but not the buttons
      // beside them (77 px); with the ⋯ (36 px) instead, Cause goes too.
      const l = tableLayout(withButtons, 690);
      expect(l).toMatchObject({ folded: true, buttons: 0, more: true });
      expect(l.columns.map((c) => c.key)).toEqual(["num", "status", "branch", "by", "dur", "age"]);
    });

    it("always fold in a dense table when one is labelled (an icon-only one stays)", () => {
      expect(tableLayout({ ...withButtons, dense: true }, 2000)).toMatchObject({ folded: true, more: true });
      const icon = { ...rerun, iconOnly: true };
      expect(tableLayout({ columns: cols, dense: true, rows: [row("1", { actions: [icon] })] }, 2000)).toMatchObject({ folded: false, buttons: 24 });
    });

    it("count the widest row's", () => {
      const two = [rerun, { key: "l", label: "Open log", action: { event: "log" } }];
      expect(tableLayout({ columns: cols.slice(0, 1), rows: [row("1", { actions: [rerun] }), row("2", { actions: two })] }, 900).buttons).toBe(65 + 6 + 72);
    });
  });
});

describe("nextSort", () => {
  const asc: TableColumn = { key: "a", sortable: true };
  const desc: TableColumn = { key: "d", sortable: true, sortFirst: "desc" };
  it.each([
    { name: "unsorted, ascending first", c: asc, sort: undefined, want: "asc" },
    { name: "unsorted, descending first", c: desc, sort: undefined, want: "desc" },
    { name: "sorted by another column", c: desc, sort: { column: "a", dir: "asc" }, want: "desc" },
    { name: "sorted ascending by it", c: desc, sort: { column: "d", dir: "asc" }, want: "desc" },
    { name: "sorted descending by it", c: asc, sort: { column: "a", dir: "desc" }, want: "asc" },
  ] as const)("$name: $want", ({ c, sort, want }) => {
    expect(nextSort(c, sort)).toBe(want);
  });
});

describe("cellParts", () => {
  it.each([
    { name: "absent", cell: undefined, want: {} },
    { name: "a string", cell: "main", want: { value: "main" } },
    { name: "spans", cell: { spans: [{ duration: { ms: 1000 } }] }, want: { value: { spans: [{ duration: { ms: 1000 } }] } } },
    { name: "a glyph and a value", cell: { value: "#1", glyph: { status: "ok" } }, want: { value: "#1", glyph: { status: "ok" } } },
    { name: "a pill alone", cell: { pill: { label: "failed" } }, want: { pill: { label: "failed" } } },
    { name: "empty", cell: {}, want: {} },
  ] as const)("$name", ({ cell, want }) => {
    expect(cellParts(cell)).toEqual(want);
  });
});

describe("tableItems", () => {
  const t: TableData = {
    columns: [{ key: "k" }],
    groups: [
      { key: "g1", label: "In progress", rows: [row("a"), row("b")] },
      { key: "g2", label: "Done", count: 14, collapsed: true, rows: [row("c")] },
    ],
  };
  const lines = (collapsed: (key: string) => boolean) => tableItems(t, (g) => collapsed(g.key)).map((it) => (it.kind === "group" ? `${it.group.label} ${String(it.count)}${it.collapsed ? " ▸" : ""}` : it.row.key));

  it("puts each group's label before its rows, and leaves a collapsed group's rows out", () => {
    expect(lines((k) => k === "g2")).toEqual(["In progress 2", "a", "b", "Done 14 ▸"]);
    expect(lines(() => false)).toEqual(["In progress 2", "a", "b", "Done 14", "c"]);
    expect(lines(() => true)).toEqual(["In progress 2 ▸", "Done 14 ▸"]);
  });

  it("is the rows alone without groups", () => {
    expect(tableItems({ columns: [], rows: [row("x"), row("y")] }, () => false).map((it) => it.kind)).toEqual(["row", "row"]);
  });
});

describe("the demo's tables (run-list.json)", () => {
  const tables = demoView("run-list").nodes.flatMap((n) => (n.table ? [{ key: n.key, t: n.table }] : []));

  it("are the Builds table and the grouped tests table", () => {
    expect(tables.map((x) => x.key)).toEqual(["builds", "tests"]);
  });

  it("show what the sketches show: at the side panel's width the Builds table keeps #, Branch, Duration and Age, its Rerun buttons folded; expanded, every column and the buttons", () => {
    const b = tables[0]?.t;
    if (!b) throw new Error("no builds table");
    // The side panel's table is about 370 px wide (368 inside its border).
    expect(tableLayout(b, 368)).toMatchObject({ folded: true, more: true });
    expect(tableLayout(b, 368).columns.map((c) => c.label)).toEqual(["#", "Branch", "Duration", "Age"]);
    expect(tableLayout(b, 1100)).toMatchObject({ folded: false, buttons: 65, more: true });
    expect(tableLayout(b, 1100).columns).toHaveLength(7);
  });
});
