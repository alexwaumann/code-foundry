import { describe, expect, it } from "vitest";
import type { FileChangeView } from "@/api/worktreeDetail";
import { buildFileRows, EXPAND_ALL_UNDER, fileTotals } from "./files";

const f = (path: string, over: Partial<FileChangeView> = {}): FileChangeView => ({
  path,
  oldPath: "",
  status: "M",
  added: 1,
  deleted: 0,
  binary: false,
  uncommitted: false,
  isDir: path.endsWith("/"),
  ...over,
});

const view = (rows: ReturnType<typeof buildFileRows>) => rows.map((r) => `${"  ".repeat(r.depth)}${r.kind === "dir" ? "▸" : "-"}${r.name}`);

describe("buildFileRows", () => {
  it("groups by directory, dirs first, compresses single-child chains", () => {
    const rows = buildFileRows(
      [f("README.md"), f("internal/store/gh/a.go"), f("internal/store/gh/b.go", { status: "A", added: 4, deleted: 2 }), f("internal/api/x.go"), f("scratch/", { status: "?" })],
      {},
    );
    expect(view(rows)).toEqual(["▸internal", "  ▸api", "    -x.go", "  ▸store/gh", "    -a.go", "    -b.go", "-README.md", "-scratch/"]);
    const gh = rows.find((r) => r.path === "internal/store/gh");
    expect(gh).toMatchObject({ kind: "dir", count: 2, added: 5, deleted: 2, status: "MA", expanded: true });
    expect(rows.find((r) => r.path === "internal")).toMatchObject({ count: 3, added: 6 });
  });

  it("compresses a lone top-level chain", () => {
    expect(view(buildFileRows([f("a/b/c/one.go"), f("a/b/c/two.go")], {}))).toEqual(["▸a/b/c", "  -one.go", "  -two.go"]);
  });

  it("honours overrides and collapses long lists by default", () => {
    const collapsed = buildFileRows([f("d/x"), f("d/y"), f("top")], { d: false });
    expect(view(collapsed)).toEqual(["▸d", "-top"]);
    const many = Array.from({ length: EXPAND_ALL_UNDER }, (_, i) => f(`pkg/f${String(i).padStart(2, "0")}.go`)).concat(f("z.go"));
    const rows = buildFileRows(many, {});
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "dir", expanded: false, count: EXPAND_ALL_UNDER });
    expect(buildFileRows(many, { pkg: true })).toHaveLength(EXPAND_ALL_UNDER + 2);
  });

  it("keeps keys unique and stable", () => {
    const rows = buildFileRows([f("a/b"), f("a/c"), f("b")], {});
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows.map((r) => r.key)).toEqual(["d:a", "f:a/b", "f:a/c", "f:b"]);
  });
});

describe("fileTotals", () => {
  it("sums counts", () => {
    expect(fileTotals([f("a", { added: 3, deleted: 1 }), f("b", { added: 2 })])).toEqual({ count: 2, added: 5, deleted: 1 });
  });
});
