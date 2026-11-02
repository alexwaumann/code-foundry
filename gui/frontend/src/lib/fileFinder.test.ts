import { describe, expect, it } from "vitest";
import type { FinderMatchView } from "@/api/filesystem";
import { changeStatuses, emptyGroups, highlightRuns, parseFinderQuery, queryWords, RECENT_SHOWN, searchRows, splitMatchPath, type CheckoutChanges, type RowContext } from "./fileFinder";

const CF = "/Users/dev/src/code-foundry";
const GP = "/Users/dev/src/ghostty-playground";
const names = { cf: "code-foundry", gp: "ghostty-playground" };

function ctx(o: Partial<RowContext> = {}): RowContext {
  return { names, multi: false, openPaths: new Set(), statuses: new Map(), ...o };
}

function match(projectId: string, checkout: string, path: string, pathPositions: number[] = [], projectPositions: number[] = []): FinderMatchView {
  return { projectId, checkout, path, pathPositions, projectPositions };
}

/** Runs as "plain[bold]plain". */
const shown = (runs: readonly { text: string; hit: boolean }[]) => runs.map((r) => (r.hit ? `[${r.text}]` : r.text)).join("");

describe("parseFinderQuery", () => {
  it.each([
    ["", { query: "", tooMany: false }],
    ["  tree  ", { query: "tree", tooMany: false }],
    ["Composer.tsx:42", { query: "Composer.tsx", line: 42, tooMany: false }],
    ["comp tsx:7", { query: "comp tsx", line: 7, tooMany: false }],
    // Typing the number: the name is searched, no line yet.
    ["Composer.tsx:", { query: "Composer.tsx", tooMany: false }],
    ["Composer.tsx:0", { query: "Composer.tsx", tooMany: false }],
    // A colon inside the text is part of the query.
    ["a:b", { query: "a:b", tooMany: false }],
    [":42", { query: ":42", tooMany: false }],
    ["a b c d e f g h", { query: "a b c d e f g h", tooMany: false }],
    ["a b c d e f g h i", { query: "a b c d e f g h i", tooMany: true }],
    ["a b c d e f g h i:3", { query: "a b c d e f g h i", line: 3, tooMany: true }],
  ])("%j", (raw, want) => {
    expect(parseFinderQuery(raw)).toEqual(want);
  });

  it("counts words at Go's spaces, as the daemon does", () => {
    expect(queryWords("a\tb c　d  e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(queryWords("   ")).toEqual([]);
  });
});

describe("highlightRuns and splitMatchPath", () => {
  it("bolds the positions, merging neighbours", () => {
    expect(shown(highlightRuns("tree.ts", [0, 1, 2, 3]))).toBe("[tree].ts");
    expect(shown(highlightRuns("code-foundry", [0, 5, 6]))).toBe("[c]ode-[fo]undry");
    expect(shown(highlightRuns("abc", []))).toBe("abc");
  });

  it("counts code points, not UTF-16 units", () => {
    // "😀" is two UTF-16 units but one code point: the daemon's position 1 is "é".
    expect(shown(highlightRuns("😀é", [1]))).toBe("😀[é]");
  });

  it("splits the directory off and shifts the name's positions", () => {
    const { dir, name } = splitMatchPath("gui/frontend/src/lib/tree.ts", [21, 22, 23, 24]);
    expect(dir).toBe("gui/frontend/src/lib");
    expect(shown(name)).toBe("[tree].ts");
  });

  it("drops directory positions from the name and has no directory at the top", () => {
    expect(shown(splitMatchPath("src/tree.ts", [0, 4]).name)).toBe("[t]ree.ts");
    expect(splitMatchPath("README.md", [0])).toEqual({ dir: "", name: [{ text: "R", hit: true }, { text: "EADME.md", hit: false }] });
  });
});

describe("searchRows", () => {
  const matches = [match("cf", CF, "gui/src/lib/tree.ts", [12, 13, 14, 15]), match("gp", GP, "src/render/Tree.zig", [11, 12, 13, 14], [0, 1])];

  it("labels no project in a one-project thread", () => {
    const rows = searchRows(matches.slice(0, 1), ctx());
    expect(rows.map((r) => [r.key, r.dir, shown(r.name), r.project, r.status, r.open])).toEqual([[`${CF}/gui/src/lib/tree.ts`, "gui/src/lib", "[tree].ts", null, "", false]]);
  });

  it("labels each row with its project, its matched letters bold, with two or more", () => {
    const rows = searchRows(matches, ctx({ multi: true }));
    expect(rows.map((r) => shown(r.project ?? []))).toEqual(["code-foundry", "[gh]ostty-playground"]);
  });

  it("marks a file the panel has a tab for, and a changed file's status", () => {
    const rows = searchRows(matches, ctx({ multi: true, openPaths: new Set([`${GP}/src/render/Tree.zig`]), statuses: changeStatuses([{ projectId: "cf", path: CF, files: [{ path: "gui/src/lib/tree.ts", status: "M" }] }]) }));
    expect(rows.map((r) => [r.status, r.open])).toEqual([
      ["M", false],
      ["", true],
    ]);
  });

  it("lists a file found twice once, where it ranked first", () => {
    const nested = `${CF}/.claude/worktrees/x`;
    const rows = searchRows([match("cf", CF, ".claude/worktrees/x/a.ts"), match("x", nested, "a.ts")], ctx());
    expect(rows.map((r) => r.projectId)).toEqual(["cf"]);
  });
});

describe("emptyGroups", () => {
  const checkouts = [
    { projectId: "cf", path: CF },
    { projectId: "gp", path: GP },
  ];
  const changes: CheckoutChanges[] = [
    { projectId: "cf", path: CF, files: [{ path: "gui/src/lib/tree.ts", status: "M" }, { path: "old.ts", status: "D" }, { path: "gui/src/lib/virtualRows.ts", status: "A" }] },
    { projectId: "gp", path: GP, files: [{ path: "src/render/Renderer.zig", status: "M" }] },
  ];

  it("lists the changed files in checkout order without deleted ones, then the recent ones not changed", () => {
    const recent = [{ path: `${CF}/README.md` }, { path: `${CF}/gui/src/lib/tree.ts` }, { path: `${GP}/build.zig` }];
    const groups = emptyGroups(changes, recent, checkouts, ctx({ multi: true, openPaths: new Set([`${CF}/README.md`]) }));
    expect(groups.map((g) => [g.heading, g.rows.map((r) => [r.projectId, r.path, r.status, r.open])])).toEqual([
      [
        "Changed in this thread",
        [
          ["cf", "gui/src/lib/tree.ts", "M", false],
          ["cf", "gui/src/lib/virtualRows.ts", "A", false],
          ["gp", "src/render/Renderer.zig", "M", false],
        ],
      ],
      [
        "Recently opened",
        [
          ["cf", "README.md", "", true],
          ["gp", "build.zig", "", false],
        ],
      ],
    ]);
    expect(groups[1]?.rows.map((r) => shown(r.project ?? []))).toEqual(["code-foundry", "ghostty-playground"]);
  });

  it("leaves out recent files outside the thread's checkouts, and files the most specific checkout", () => {
    const nested = `${CF}/vendor/lib`;
    const groups = emptyGroups([], [{ path: "/Users/dev/notes.md" }, { path: `${nested}/x.ts` }, { path: `${CF}/vendor/y.ts` }], [...checkouts, { projectId: "lib", path: nested }], ctx());
    expect(groups.map((g) => g.key)).toEqual(["recent"]);
    expect(groups[0]?.rows.map((r) => [r.projectId, r.path, r.dir])).toEqual([
      ["lib", "x.ts", ""],
      ["cf", "vendor/y.ts", "vendor"],
    ]);
  });

  it("shows at most RECENT_SHOWN recent files and no empty group", () => {
    const recent = Array.from({ length: RECENT_SHOWN + 2 }, (_, i) => ({ path: `${CF}/f${String(i)}.ts` }));
    const groups = emptyGroups([], recent, checkouts, ctx());
    expect(groups.map((g) => [g.key, g.rows.length])).toEqual([["recent", RECENT_SHOWN]]);
    expect(emptyGroups([], [], checkouts, ctx())).toEqual([]);
  });
});
