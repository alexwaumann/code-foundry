import { describe, expect, it } from "vitest";
import type { FileChangeView } from "@/api/worktreeDetail";
import { buildFileRows, fileTotals, splitPath } from "./files";

const f = (path: string, over: Partial<FileChangeView> = {}): FileChangeView => ({
  path,
  oldPath: "",
  status: "M",
  added: 1,
  deleted: 0,
  binary: false,
  uncommitted: false,
  ...over,
});

describe("splitPath", () => {
  it.each([
    ["a/b/c.ts", "a/b/", "c.ts"],
    ["top.md", "", "top.md"],
    ["a/notes/todo.md", "a/notes/", "todo.md"],
    [".github/workflows/ci.yml", ".github/workflows/", "ci.yml"],
  ])("%s → %s + %s", (path, dir, name) => {
    expect(splitPath(path)).toEqual([dir, name]);
  });
});

describe("buildFileRows", () => {
  it("is flat, keeps the daemon's order and splits each path", () => {
    const rows = buildFileRows([f("z/b.ts"), f("a.ts"), f("m/n/o.go", { status: "A" })]);
    expect(rows.map((r) => [r.dir, r.name, r.status])).toEqual([
      ["z/", "b.ts", "M"],
      ["", "a.ts", "M"],
      ["m/n/", "o.go", "A"],
    ]);
    expect(rows.map((r) => r.key)).toEqual(["f:z/b.ts", "f:a.ts", "f:m/n/o.go"]);
  });

  it("lists conflicted files first, each group in its own order", () => {
    const rows = buildFileRows([f("a.ts"), f("x/u1.go", { status: "U" }), f("b.ts"), f("u2.go", { status: "U" })]);
    expect(rows.map((r) => `${r.status} ${r.path}${r.conflict ? " !" : ""}`)).toEqual(["U x/u1.go !", "U u2.go !", "M a.ts", "M b.ts"]);
  });

  it("keeps counts, binary, uncommitted and a rename's source", () => {
    const [r] = buildFileRows([f("docs/new.md", { status: "R", oldPath: "docs/old.md", added: 4, deleted: 1, binary: true, uncommitted: true })]);
    expect(r).toMatchObject({ added: 4, deleted: 1, binary: true, oldPath: "docs/old.md", conflict: false, uncommitted: true });
  });
});

describe("fileTotals", () => {
  it("counts files and sums the changes", () => {
    expect(fileTotals([f("a", { added: 3, deleted: 1 }), f("b", { added: 2 })])).toEqual({ count: 2, added: 5, deleted: 1 });
  });
});
