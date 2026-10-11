import { describe, expect, it } from "vitest";
import type { SkillView } from "@/api/filesystem";
import {
  dismissCard,
  emphasis,
  fileItems,
  fileSources,
  findTrigger,
  groupSkills,
  LEAF_CHAR,
  nextCard,
  skillScore,
  skillSources,
  skillSourcesKey,
  type CardMemo,
  type FileResults,
} from "./completion";

describe("findTrigger", () => {
  it.each<[string, string, { query: string; offset: number } | null]>([
    ["a slash at the start", "/", { query: "", offset: 0 }],
    ["a query", "/dep", { query: "dep", offset: 0 }],
    ["after a space", "run /dep", { query: "dep", offset: 4 }],
    ["after a newline-free tab", "run\t/x", { query: "x", offset: 4 }],
    ["inside a word", "and/or", null],
    ["after a tag", `${LEAF_CHAR}/x`, null],
    ["a space ends it", "/dep ", null],
    ["a query never spans a tag", `/de${LEAF_CHAR}p`, null],
    ["a second slash is part of the query", "//x", { query: "/x", offset: 0 }],
    ["empty text", "", null],
  ])("%s", (_name, before, want) => {
    const t = findTrigger(before, ["/"]);
    expect(t && { query: t.query, offset: t.offset }).toEqual(want);
  });

  it("only the trigger characters asked for", () => {
    expect(findTrigger("see @src", ["/"])).toBeNull();
    expect(findTrigger("see @src", ["/", "@"])).toEqual({ char: "@", query: "src", offset: 4 });
    expect(findTrigger("mail a@b", ["@"])).toBeNull();
  });
});

describe("nextCard", () => {
  const t = (query: string, at = 10) => ({ at, query });
  const memo = (query: string, empty: boolean, at = 10): CardMemo => ({ at, query, empty, dismissed: false });

  it.each<[string, CardMemo | null, { at: number; query: string } | null, number, string, CardMemo | null]>([
    ["no trigger: closed, forgotten", memo("de", false), null, 3, "none", null],
    ["matches show", null, t("de"), 2, "list", memo("de", false)],
    ["the first query without matches says so", memo("de", false), t("dez"), 0, "empty", memo("dez", true)],
    ["one more character closes", memo("dez", true), t("dezz"), 0, "none", memo("dez", true)],
    ["and more keep it closed", memo("dez", true), t("dezzz"), 0, "none", memo("dez", true)],
    ["back to the empty query says so again", memo("dez", true), t("dez"), 0, "empty", memo("dez", true)],
    ["back to matches opens", memo("dez", true), t("de"), 1, "list", memo("de", false)],
    ["a no-match trigger seen first says so", null, t("zz"), 0, "empty", memo("zz", true)],
    ["another trigger starts over", memo("dez", true, 3), t("zz"), 0, "empty", memo("zz", true)],
  ])("%s", (_name, prev, trigger, count, show, want) => {
    expect(nextCard(prev, trigger, count)).toEqual({ show, memo: want });
  });

  it("Escape keeps the trigger closed until the caret leaves it", () => {
    const d = dismissCard(t("de"));
    expect(nextCard(d, t("dep"), 1)).toEqual({ show: "none", memo: d });
    expect(nextCard(d, null, 1)).toEqual({ show: "none", memo: null });
    expect(nextCard(d, t("de", 20), 1).show).toBe("list");
  });

  it("is idempotent (it runs on every render)", () => {
    for (const [prev, trigger, count] of [
      [memo("de", false), t("dez"), 0],
      [memo("dez", true), t("dezz"), 0],
      [null, t("de"), 3],
    ] as const) {
      const once = nextCard(prev, trigger, count);
      expect(nextCard(once.memo, trigger, count)).toEqual(once);
    }
  });
});

const skill = (name: string, repoId: string, description = ""): SkillView => ({
  name,
  description,
  scope: repoId ? "project" : "user",
  repoId,
  path: `/x/${repoId}/${name}`,
});

describe("skillScore", () => {
  it.each<[string, string, string, number]>([
    ["empty query", "deploy", "", 1],
    ["exact, any case", "Deploy", "dEPLOY", 5],
    ["prefix", "deploy", "dep", 4],
    ["subsequence", "deploy", "dpl", 3],
    ["description word prefix", "ship", "sta", 2],
    ["no match", "deploy", "zz", 0],
    ["description inside a word is no match", "ship", "aging", 0],
  ])("%s", (_name, name, query, want) => {
    expect(skillScore({ name, description: "Ship the current branch to staging." }, query)).toBe(want);
  });
});

describe("groupSkills", () => {
  const skills = [
    skill("dependencies", "r1", "Audit and bump deps"),
    skill("deploy", "r1", "Build and push a release"),
    skill("deploy", "r1", "the command of the same name"),
    skill("review", "r1"),
    skill("deploy", "r2", "Deploy the API"),
    skill("old", "r9"),
    skill("depcheck", ""),
    skill("commit", "", "Write a commit message"),
  ];

  it.each<[string, string, string[], [string, string[]][]]>([
    ["all, members in order, user last", "", ["r2", "r1"], [["r2", ["deploy"]], ["r1", ["dependencies", "deploy", "review"]], ["", ["depcheck", "commit"]]]],
    ["filtered and ranked: prefix before subsequence", "depl", ["r1", "r2"], [["r1", ["deploy"]], ["r2", ["deploy"]]]],
    ["exact first", "deploy", ["r1"], [["r1", ["deploy"]]]],
    ["description words match", "message", ["r1"], [["", ["commit"]]]],
    ["empty groups are left out", "zz", ["r1"], []],
    ["a non-member's skills are left out", "old", ["r1"], []],
  ])("%s", (_name, query, members, want) => {
    expect(groupSkills(skills, query, members).map((g) => [g.repoId, g.skills.map((s) => s.name)])).toEqual(want);
  });

  it("keeps the first of a duplicate", () => {
    expect(groupSkills(skills, "deploy", ["r1"])[0]?.skills[0]?.description).toBe("Build and push a release");
  });
});

describe("skillSources", () => {
  const ws = [
    { repoId: "r1", worktreePath: "/h/w/r1" },
    { repoId: "r2", worktreePath: "/h/w/r2" },
  ];
  it.each<[string, Parameters<typeof skillSources>[0], { repoId: string; path?: string }[]]>([
    ["a project in a new worktree: its main worktree", { target: "project", repoIds: ["r1"], worktree: { kind: "new" }, wsMembers: [] }, [{ repoId: "r1" }]],
    ["a project in an existing worktree: that one", { target: "project", repoIds: ["r1"], worktree: { kind: "existing", path: "/h/r1-wt" }, wsMembers: [] }, [{ repoId: "r1", path: "/h/r1-wt" }]],
    ["a project with Also in: main worktrees in order", { target: "project", repoIds: ["r1", "r3"], worktree: { kind: "new" }, wsMembers: [] }, [{ repoId: "r1" }, { repoId: "r3" }]],
    ["a workspace: its member worktrees", { target: "workspace", repoIds: ["r2", "r1"], worktree: { kind: "members" }, wsMembers: ws }, [{ repoId: "r2", path: "/h/w/r2" }, { repoId: "r1", path: "/h/w/r1" }]],
    ["a workspace in new-worktree mode: still its members", { target: "workspace", repoIds: ["r1", "r2"], worktree: { kind: "new" }, wsMembers: ws }, [{ repoId: "r1", path: "/h/w/r1" }, { repoId: "r2", path: "/h/w/r2" }]],
  ])("%s", (_name, input, want) => {
    expect(skillSources(input)).toEqual(want);
  });

  it("keys differ by member and path", () => {
    const k = (s: { repoId: string; path?: string }[]) => skillSourcesKey(s);
    expect(k([{ repoId: "r1" }])).toBe(k([{ repoId: "r1" }]));
    expect(k([{ repoId: "r1" }])).not.toBe(k([{ repoId: "r1", path: "/h/r1" }]));
    expect(k([{ repoId: "r1" }, { repoId: "r2" }])).not.toBe(k([{ repoId: "r2" }, { repoId: "r1" }]));
    expect(k([])).toBe("");
  });
});

describe("fileSources", () => {
  const ws = [
    { repoId: "r1", worktreePath: "/h/w/r1" },
    { repoId: "r2", worktreePath: "/h/w/r2" },
  ];
  it.each<[string, Parameters<typeof fileSources>[0], { repoId: string; path?: string }[]]>([
    ["a project in a new worktree: its main worktree", { target: "project", repoIds: ["r1"], worktree: { kind: "new" }, wsMembers: [] }, [{ repoId: "r1" }]],
    ["a project in an existing worktree: that one", { target: "project", repoIds: ["r1"], worktree: { kind: "existing", path: "/h/r1-wt" }, wsMembers: [] }, [{ repoId: "r1", path: "/h/r1-wt" }]],
    ["a project without git: its folder", { target: "project", repoIds: ["r1"], worktree: { kind: "existing", path: "/h/notes" }, wsMembers: [] }, [{ repoId: "r1", path: "/h/notes" }]],
    ["a project with Also in: main worktrees in member order", { target: "project", repoIds: ["r1", "r3"], worktree: { kind: "new" }, wsMembers: [] }, [{ repoId: "r1" }, { repoId: "r3" }]],
    ["Also in with a stale existing choice: still main worktrees", { target: "project", repoIds: ["r1", "r3"], worktree: { kind: "existing", path: "/h/r1-wt" }, wsMembers: [] }, [{ repoId: "r1" }, { repoId: "r3" }]],
    ["a workspace in Workspace worktrees: its member worktrees", { target: "workspace", repoIds: ["r2", "r1"], worktree: { kind: "members" }, wsMembers: ws }, [{ repoId: "r2", path: "/h/w/r2" }, { repoId: "r1", path: "/h/w/r1" }]],
    ["a workspace in new-worktree mode: main worktrees", { target: "workspace", repoIds: ["r1", "r2"], worktree: { kind: "new" }, wsMembers: ws }, [{ repoId: "r1" }, { repoId: "r2" }]],
    ["a workspace member without a known worktree: its main worktree", { target: "workspace", repoIds: ["r1", "r9"], worktree: { kind: "members" }, wsMembers: ws }, [{ repoId: "r1", path: "/h/w/r1" }, { repoId: "r9" }]],
  ])("%s", (_name, input, want) => {
    expect(fileSources(input)).toEqual(want);
  });
});

describe("emphasis", () => {
  it.each<[string, string, string, [number, number][]]>([
    ["no query", "internal/api/session.go", "", []],
    ["a run in the base name", "internal/api/session.go", "ses", [[13, 16]]],
    ["case-insensitive", "src/components/Composer.tsx", "COMP", [[15, 19]]],
    ["the base name before an earlier run", "src/api/session.ts", "s", [[8, 9]]],
    ["spread over the base name", "src/components/ThreadRow.tsx", "trw", [[15, 16], [17, 18], [23, 24]]],
    ["a run across directories", "src/components/Composer.tsx", "src/comp", [[0, 8]]],
    ["spread over the path", "internal/store/session", "isse", [[0, 1], [9, 10], [15, 17]]],
    ["no match", "README.md", "xyz", []],
    ["a directory (no trailing slash)", "internal/store/session", "sess", [[15, 19]]],
    ["repeated characters: the run in the base name", "assets/sass.ts", "ss", [[9, 11]]],
    ["repeated characters spread greedily", "banana/aria.ts", "aa", [[7, 8], [10, 11]]],
    ["a repeated character not in the base name twice: spread over the path", "a/xa.ts", "aa", [[0, 1], [3, 4]]],
    ["positions stay the path's when lower case is longer (İ)", "İ/İses.go", "ses", [[3, 6]]],
    ["non-ASCII query", "docs/Über.md", "über", [[5, 9]]],
  ])("%s", (_name, path, query, want) => {
    expect(emphasis(path, query)).toEqual(want);
  });
});

describe("fileItems", () => {
  const cf: FileResults = {
    repoId: "cf",
    matches: [
      { path: "internal/api/session.go", isDir: false },
      { path: "internal/store/session", isDir: true },
    ],
  };
  const api: FileResults = { repoId: "api", matches: [{ path: "internal/api/session.go", isDir: false }] };

  it("one project: no heading; base name, path, emphasis and the tag (a directory keeps its /)", () => {
    const groups = fileItems([cf], "ses", ["cf"], "cf");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.heading).toBeNull();
    expect(groups[0]?.items).toEqual([
      {
        key: "cf/internal/api/session.go",
        label: "session.go",
        mono: true,
        detail: "internal/api/session.go",
        emphasis: [[13, 16]],
        tag: { tagKind: "file", repoId: "cf", path: "internal/api/session.go" },
      },
      {
        key: "cf/internal/store/session/",
        label: "session/",
        mono: true,
        detail: "internal/store/session",
        emphasis: [[15, 18]],
        tag: { tagKind: "file", repoId: "cf", path: "internal/store/session/" },
      },
    ]);
  });

  it.each<[string, FileResults[], string[], string, (string | null)[]]>([
    ["several projects: headings in member order", [cf, api], ["cf", "api"], "cf", ["cf", "api"]],
    ["the primary first", [cf, api], ["cf", "api"], "api", ["api", "cf"]],
    ["results in another order: member order", [api, cf], ["cf", "api"], "cf", ["cf", "api"]],
    ["a project without matches has no group", [cf, { repoId: "api", matches: [] }], ["cf", "api"], "cf", ["cf"]],
    ["a non-member's results are left out (one project: no heading)", [cf, api], ["cf"], "cf", [null]],
    ["nothing", [], ["cf", "api"], "cf", []],
  ])("%s", (_name, results, members, primary, want) => {
    expect(fileItems(results, "", members, primary).map((g) => (g.heading?.kind === "project" ? g.heading.repoId : null))).toEqual(want);
  });
});
