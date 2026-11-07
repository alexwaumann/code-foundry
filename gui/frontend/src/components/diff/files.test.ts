import { describe, expect, it } from "vitest";
import type { CompareFileView } from "@/api/compare";
import { buildFileRows, diffTitle, fileTotals, filterRows, pickRow, shortRef, splitPath, stepRow } from "./files";
import { refChoices, REF_CHOICES_MAX } from "./sources";

const file = (path: string, o: Partial<CompareFileView> = {}): CompareFileView => ({ path, oldPath: "", status: "M", added: 1, deleted: 1, binary: false, submodule: false, ...o });

describe("splitPath", () => {
  it.each([
    ["a/b/c.ts", "a/b/", "c.ts"],
    ["c.ts", "", "c.ts"],
  ])("%s", (p, dir, name) => {
    expect(splitPath(p)).toEqual([dir, name]);
  });
});

describe("buildFileRows", () => {
  it("conflicts first, the rest in the daemon's order", () => {
    const rows = buildFileRows([file("a.ts"), file("b.ts", { status: "U" }), file("c.ts")]);
    expect(rows.map((r) => r.path)).toEqual(["b.ts", "a.ts", "c.ts"]);
    expect(rows[0]).toMatchObject({ conflict: true, key: "f:b.ts", name: "b.ts", dir: "" });
  });
});

describe("fileTotals", () => {
  it("counts", () => {
    expect(fileTotals([file("a", { added: 2, deleted: 3 }), file("b", { added: 4, deleted: 0 })])).toEqual({ count: 2, added: 6, deleted: 3 });
  });
});

describe("filterRows", () => {
  const rows = buildFileRows([file("src/Tree.ts"), file("docs/new.md", { oldPath: "docs/old.md", status: "R" })]);
  it.each([
    ["", 2],
    ["  ", 2],
    ["tree", 1],
    ["SRC/", 1],
    ["old.md", 1],
    ["nope", 0],
  ])("%j finds %i", (q, n) => {
    expect(filterRows(rows, q)).toHaveLength(n);
  });
});

describe("pickRow and stepRow", () => {
  const rows = buildFileRows([file("a"), file("b"), file("c")]);
  it("the tab's file while it is listed, else the first; nothing in an empty list", () => {
    expect(pickRow(rows, "b")?.path).toBe("b");
    expect(pickRow(rows, "gone")?.path).toBe("a");
    expect(pickRow(rows, "")?.path).toBe("a");
    expect(pickRow([], "a")).toBeNull();
  });
  it("steps, and stops at the ends", () => {
    expect(stepRow(rows, rows[1] ?? null, 1)?.path).toBe("c");
    expect(stepRow(rows, rows[1] ?? null, -1)?.path).toBe("a");
    expect(stepRow(rows, rows[2] ?? null, 1)).toBeNull();
    expect(stepRow(rows, rows[0] ?? null, -1)).toBeNull();
    expect(stepRow([], null, 1)).toBeNull();
  });
});

describe("shortRef", () => {
  it.each([
    ["origin/main", ["origin"], "main"],
    ["upstream/main", ["origin"], "upstream/main"],
    ["main", ["origin"], "main"],
  ])("%s", (ref, remotes, want) => {
    expect(shortRef(ref, remotes)).toBe(want);
  });
});

describe("diffTitle", () => {
  const view = { base: { source: { kind: "merge-base" as const }, label: "origin/main", sha: "a" }, head: { source: { kind: "working" as const }, label: "Working tree", sha: "" } };
  const o = { branch: "feat/sidebar", remotes: ["origin"], project: "web", own: true };
  it("the working tree goes by its branch, as the strip's title", () => {
    expect(diffTitle(view, o)).toBe("feat/sidebar vs main");
  });
  it("on a detached HEAD it is the working tree", () => {
    expect(diffTitle(view, { ...o, branch: "" })).toBe("Working tree vs main");
  });
  it("another side keeps its own name", () => {
    expect(diffTitle({ ...view, head: { source: { kind: "staged" }, label: "Staged", sha: "" } }, o)).toBe("Staged vs main");
  });
  it("another project's checkout says whose, so a thread's checkouts stay apart", () => {
    expect(diffTitle(view, { ...o, own: false })).toBe("web · feat/sidebar vs main");
  });
});

describe("refChoices", () => {
  const refs = ["main", "origin/main", "feat/Tree", "origin/feat/tree"];
  it("everything without a query; what holds it, case aside, with one", () => {
    expect(refChoices(refs, "")).toEqual(refs);
    expect(refChoices(refs, "TREE")).toEqual(["feat/Tree", "origin/feat/tree"]);
  });
  it("leaves out the exact match, which the typed row already offers", () => {
    expect(refChoices(refs, "main")).toEqual(["origin/main"]);
  });
  it("never lists more than it can show", () => {
    expect(refChoices(Array.from({ length: 5000 }, (_, i) => `b${String(i)}`), "")).toHaveLength(REF_CHOICES_MAX);
  });
});
