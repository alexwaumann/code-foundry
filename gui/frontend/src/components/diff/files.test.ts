import { describe, expect, it } from "vitest";
import type { CompareFileSidesView, CompareFileView, CompareSideView } from "@/api/compare";
import { buildFileRows, CODE_MIN, diffTitle, fileTotals, filterRows, inProject, listPace, narrowedTo, pickRow, sameSides, shortRef, sourceLabel, splitPath, stepRow, TOP_ROWS, topListFit } from "./files";
import { refChoices, REF_CHOICES_MAX } from "./sources";

const file = (path: string, o: Partial<CompareFileView> = {}): CompareFileView => ({ path, oldPath: "", status: "M", added: 1, deleted: 1, binary: false, submodule: false, ...o });

describe("listPace", () => {
  it.each([
    [0, 250],
    [60, 250],
    [125, 250],
    [130, 500],
    [500, 1000],
    [1400, 3000],
    [60000, 3000],
  ])("a read of %ims waits %ims", (took, want) => {
    expect(listPace(took)).toBe(want);
  });
});

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
  it("the tab's file, listed or not; the first only without one; nothing with neither", () => {
    expect(pickRow(rows, "b")?.path).toBe("b");
    expect(pickRow(rows, "")?.path).toBe("a");
    const gone = pickRow(rows, "x/gone.ts", "x/was.ts");
    expect(gone).toMatchObject({ path: "x/gone.ts", oldPath: "x/was.ts", dir: "x/", name: "gone.ts", status: "" });
    expect(rows.includes(gone as never)).toBe(false);
    expect(pickRow([], "")).toBeNull();
    expect(pickRow([], "a")?.path).toBe("a");
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

describe("topListFit with something under the rows", () => {
  it("leaves the code its share", () => {
    expect(topListFit(800, 30, 10, false).rows).toBe(5);
    expect(topListFit(420, 30, 10, false).rows).toBe(3);
    expect(topListFit(420, 30, 10, false, 32).rows).toBe(2);
    expect(topListFit(420, 30, 10, false, 122)).toEqual({ rows: 2, fold: true });
  });
});

describe("shortRef of a commit", () => {
  it("cuts a full sha, and only a full one", () => {
    expect(shortRef("a".repeat(40), [])).toBe("aaaaaaa");
    expect(shortRef("b".repeat(64), [])).toBe("bbbbbbb");
    expect(shortRef("abc123", [])).toBe("abc123");
    expect(shortRef("Empty tree", [])).toBe("Empty tree");
  });
});

describe("a tab's name and band", () => {
  it("another project's name leads, so one title on two checkouts stays two names", () => {
    expect(inProject("Review", { project: "web", own: false })).toBe("web · Review");
    expect(inProject("Review", { project: "web", own: true })).toBe("Review");
  });
  it("a narrowed list names one path and counts several", () => {
    expect(narrowedTo(["src"])).toBe("Listing only src");
    expect(narrowedTo(["a.go", "b.go", "c.go"])).toBe("Listing only 3 paths");
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
  it("on the default branch the two sides stay apart", () => {
    expect(diffTitle(view, { ...o, branch: "main" })).toBe("main vs origin/main");
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

describe("listPace", () => {
  it.each([
    [0, 250],
    [60, 250],
    [125, 250],
    [130, 500],
    [500, 1000],
    [1400, 3000],
    [60000, 3000],
  ])("a read of %ims waits %ims", (took, want) => {
    expect(listPace(took)).toBe(want);
  });
});

describe("splitPath", () => {
  it.each([
    ["a.ts", "", "a.ts"],
    ["a/b/c.ts", "a/b/", "c.ts"],
    ["emb/", "", "emb/"],
    ["a/emb/", "a/", "emb/"],
  ])("%s", (path, dir, name) => {
    expect(splitPath(path)).toEqual([dir, name]);
  });
});

describe("sourceLabel", () => {
  it.each([
    [{ kind: "ref", ref: "v1" } as const, "v1"],
    [{ kind: "working" } as const, "Working tree"],
    [{ kind: "staged" } as const, "Staged"],
    [{ kind: "merge-base" } as const, "origin/main"],
  ])("%j", (s, want) => {
    expect(sourceLabel(s, "origin/main")).toBe(want);
  });
});

describe("topListFit", () => {
  const ROW = 30;
  const CHROME = 44 + 36 + 48;
  it.each([
    // height, files, filter, rows, fold
    ["tall: the most it shows", 900, 8, true, TOP_ROWS, false],
    ["a stacked group at 1280x800", 386, 8, true, 2, true],
    ["the same, without a filter", 386, 4, false, 2, false],
    ["short", 300, 8, true, 2, true],
    ["short, one file that still fits", 340, 1, false, 2, false],
    ["no room even for that", 200, 1, false, 2, true],
  ])("%s", (_name, height, files, filter, rows, fold) => {
    expect(topListFit(height, ROW, files, filter)).toEqual({ rows, fold });
  });

  it("an unfolded list never leaves the code less than CODE_MIN when it fits by itself", () => {
    for (let height = 200; height < 1000; height += 7) {
      const filter = true;
      const fit = topListFit(height, ROW, 100, filter);
      if (!fit.fold) expect(height - CHROME - 32 - fit.rows * ROW).toBeGreaterThanOrEqual(CODE_MIN);
    }
  });
});

describe("sameSides", () => {
  const side = (o: Partial<CompareSideView> = {}): CompareSideView => ({ present: true, text: "a\n", truncated: false, binary: false, submodule: false, ...o });
  const sides = (o: Partial<CompareFileSidesView> = {}): CompareFileSidesView => ({ old: side(), new: side({ text: "b\n" }), status: "M", error: "", ...o });
  it.each<[string, CompareFileSidesView, boolean]>([
    ["the same answer, another object", sides(), true],
    ["the new side's text", sides({ new: side({ text: "c\n" }) }), false],
    ["the old side's text", sides({ old: side({ text: "z\n" }) }), false],
    ["a side gone", sides({ new: side({ present: false, text: "" }), status: "D" }), false],
    ["binary", sides({ old: side({ binary: true }) }), false],
    ["truncated", sides({ new: side({ text: "b\n", truncated: true }) }), false],
    ["a submodule", sides({ old: side({ submodule: true }) }), false],
    ["the status", sides({ status: "R" }), false],
    ["an error", sides({ error: "gone" }), false],
  ])("%s", (_name, b, same) => {
    expect(sameSides(sides(), b)).toBe(same);
  });
});
