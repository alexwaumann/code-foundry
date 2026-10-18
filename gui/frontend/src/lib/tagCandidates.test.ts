import { describe, expect, it } from "vitest";
import type { PullRequestView } from "@/api/gh";
import { PR_ROWS, prCandidates, prEnterPicks, prItems, prPool, prScore, THREAD_ROWS, threadCandidates, threadItems, threadScore, type ThreadCandidate } from "./tagCandidates";

const thread = (id: string, name: string, o: Partial<ThreadCandidate> = {}): ThreadCandidate => ({
  id,
  name,
  archivedAtMs: null,
  snoozedUntilMs: null,
  lastActivityAtMs: 0,
  createdAtMs: 0,
  ...o,
});

const pr = (slug: string, number: number, title: string, o: Partial<PullRequestView> = {}): PullRequestView =>
  ({ repoSlug: slug, number, title, state: "open", draft: false, updatedAtMs: 0, partial: false, ...o }) as PullRequestView;

describe("threadScore", () => {
  it.each([
    ["Fix resize race", "", 1],
    ["Fix resize race", "fix resize race", 5],
    ["Fix resize race", "fix", 4],
    ["Fix resize race", "RES", 3],
    ["Fix resize race", "size", 2],
    ["Fix resize race", "frr", 0],
    ["Fix resize race", "zzz", 0],
  ])("%s for %j: %i", (name, query, want) => {
    expect(threadScore(name, query)).toBe(want);
  });
});

describe("threadCandidates", () => {
  const threads = [
    thread("s-1", "Refactor sidebar tree", { lastActivityAtMs: 50 }),
    thread("s-2", "Fix resize race", { lastActivityAtMs: 10 }),
    thread("s-3", "Resize the dock", { lastActivityAtMs: 30 }),
    thread("s-arch", "Resize archived", { archivedAtMs: 1, lastActivityAtMs: 99 }),
    thread("s-snz", "Resize snoozed", { snoozedUntilMs: 1, lastActivityAtMs: 99 }),
    thread("s-me", "Resize me", { lastActivityAtMs: 99 }),
    thread("s-4", "Docs resize", { lastActivityAtMs: 40 }),
    thread("s-5", "Another resize pass", { lastActivityAtMs: 60 }),
  ];
  const ids = (query: string, current = "s-me", cap?: number) => threadCandidates(threads, query, current, cap).map((t) => t.id);

  it("archived, snoozed and the current thread are left out", () => {
    expect(ids("resize", "s-me", 10)).not.toEqual(expect.arrayContaining(["s-arch", "s-snz", "s-me"]));
    expect(ids("resize", "", 10)).toContain("s-me");
  });

  it("best match first, then the most recently active; capped at three", () => {
    // "Resize the dock" is a prefix (4); the rest match a word (3), newest first.
    expect(ids("resize", "s-me", 10)).toEqual(["s-3", "s-5", "s-4", "s-2"]);
    expect(ids("resize")).toEqual(["s-3", "s-5", "s-4"]);
    expect(THREAD_ROWS).toBe(3);
  });

  it("an empty query lists the most recently active", () => {
    expect(ids("")).toEqual(["s-5", "s-1", "s-4"]);
  });

  it("nothing matching: none", () => {
    expect(ids("zzz")).toEqual([]);
  });

  it("a thread without a name matches by its id", () => {
    expect(threadCandidates([thread("s-abc", "")], "s-a", "").map((t) => t.id)).toEqual(["s-abc"]);
  });
});

describe("threadItems", () => {
  it("rows insert a thread tag with a cleaned name", () => {
    expect(threadItems([{ id: "s-1", name: 'Fix "the" race', detail: "code-foundry · Working" }])).toEqual([
      { key: "thread:s-1", label: "Fix the race", detail: "code-foundry · Working", tag: { tagKind: "thread", id: "s-1", name: "Fix the race" } },
    ]);
  });
});

describe("prScore", () => {
  const p = pr("o/r", 1385, "fix(gh): pace requests");
  it.each([
    ["1385", 6],
    ["13", 5],
    ["385", 0],
    ["fix", 4],
    ["PACE", 3],
    ["ace", 2],
    ["", 0],
    ["zzz", 0],
  ])("%j: %i", (query, want) => {
    expect(prScore(p, query)).toBe(want);
  });

  it("digits that are not the number can still match the title", () => {
    expect(prScore(pr("o/r", 7, "bump to 2026 deps"), "2026")).toBe(3);
  });
});

describe("prPool", () => {
  it("keeps the asked repositories' pull requests once each (any case), skips partial ones", () => {
    const a = pr("Alex/CF", 1, "one");
    const dup = pr("alex/cf", 1, "one again");
    const other = pr("other/x", 2, "two");
    const partial = pr("alex/cf", 3, "", { partial: true });
    const b = pr("alex/cf", 4, "four");
    expect(prPool([[a, other], [dup, partial, b]], ["alex/cf"])).toEqual([a, b]);
    expect(prPool([[a]], [])).toEqual([]);
  });
});

describe("prCandidates", () => {
  const pool = [
    pr("o/r", 120, "chore: bump", { state: "merged", updatedAtMs: 90 }),
    pr("o/r", 12, "feat: resize", { updatedAtMs: 10 }),
    pr("o/r", 125, "fix: resize race", { updatedAtMs: 50 }),
    pr("o/r", 126, "docs", { updatedAtMs: 60 }),
    pr("o/r", 127, "x", { state: "closed", updatedAtMs: 99 }),
    pr("o/r", 128, "y", { updatedAtMs: 1 }),
    pr("o/r", 129, "z", { updatedAtMs: 2 }),
  ];
  const numbers = (query: string) => prCandidates(pool, query).map((p) => p.number);

  it("the exact number first, then numbers starting with it: open ones, then the most recently updated; at most five", () => {
    expect(numbers("12")).toEqual([12, 126, 125, 129, 128]);
    expect(PR_ROWS).toBe(5);
  });

  it("by title", () => {
    expect(numbers("resize")).toEqual([125, 12]);
  });

  it("a number nothing has stays text: no candidates", () => {
    expect(numbers("999")).toEqual([]);
    expect(numbers("")).toEqual([]);
  });
});

describe("prItems", () => {
  it("#N, the title with the typed text emphasized, a pull request tag", () => {
    expect(prItems([pr("Alex/CF", 7, "Fix the Resize race")], "resize", false)).toEqual([
      { key: "alex/cf#7", label: "#7", detail: "Fix the Resize race", emphasis: [[8, 14]], tag: { tagKind: "pr", slug: "alex/cf", number: 7 } },
    ]);
  });

  it("a number query emphasizes nothing; several repositories show theirs as the hint", () => {
    expect(prItems([pr("o/r", 7, "x")], "7", true)).toEqual([{ key: "o/r#7", label: "#7", hint: "o/r", detail: "x", tag: { tagKind: "pr", slug: "o/r", number: 7 } }]);
  });
});

describe("prEnterPicks", () => {
  const row = (number: number) => ({ key: "k", label: `#${String(number)}`, detail: "", tag: { tagKind: "pr" as const, slug: "o/r", number } });
  it.each([
    ["the exact number", 187, "187", true],
    ["a prefix of the number", 187, "18", false],
    ["a title query", 187, "fix", false],
    ["digits then letters", 187, "187a", false],
    ["a zero-led number", 187, "0187", false],
  ] as const)("%s", (_name, number, query, want) => {
    expect(prEnterPicks(row(number), query)).toBe(want);
  });
  it("only pull request rows", () => {
    expect(prEnterPicks({ key: "k", label: "x", detail: "", tag: { tagKind: "thread", id: "s-1", name: "187" } }, "187")).toBe(false);
  });
});
