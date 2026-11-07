import { describe, expect, it } from "vitest";
import { DEFAULT_BASE, DEFAULT_HEAD, EMPTY_TREE, diffOfTab, diffTab, type DiffTarget } from "@/surfaces/diffTarget";
import { COMMITS_HEADING_H, COMMIT_ROW_H, NO_MESSAGE, commitRows, commitSides, commitSubject, commitUrl, commitsHeight, commitsShown, leaveCommit, listSides, viewCommit } from "./commits";

const target = (o: Partial<DiffTarget> = {}): DiffTarget => ({ project: "web", worktree: "/w", base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "a.ts", oldPath: "", own: true, ...o });

describe("what a commit's two sides are", () => {
  it("its first parent and itself", () => {
    expect(commitSides({ sha: "c1", parent: "p1" })).toEqual({ base: { kind: "ref", ref: "p1" }, head: { kind: "ref", ref: "c1" } });
  });
  it("a root commit compares against nothing", () => {
    expect(commitSides({ sha: "c1", parent: "" }).base).toEqual({ kind: "ref", ref: EMPTY_TREE });
  });
});

describe("a click on a commit", () => {
  it("sets the two sides, lets the file follow, and remembers what the tab showed", () => {
    const set = viewCommit(target({ file: "new.ts", oldPath: "old.ts", head: { kind: "staged" } }), { sha: "c1", parent: "p1" });
    expect(set).toEqual({
      base: { kind: "ref", ref: "p1" },
      head: { kind: "ref", ref: "c1" },
      file: "",
      oldPath: "",
      commit: { sha: "c1", base: DEFAULT_BASE, head: { kind: "staged" }, file: "new.ts", oldPath: "old.ts" },
    });
  });

  it("from another commit keeps the first view, so All changes goes all the way back", () => {
    const first = { ...target(), ...viewCommit(target(), { sha: "c1", parent: "p1" }) };
    const second = { ...first, ...viewCommit(first, { sha: "c2", parent: "c1" }) };
    expect(second.commit).toEqual({ sha: "c2", base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "a.ts", oldPath: "" });
    expect(leaveCommit(second.commit as NonNullable<DiffTarget["commit"]>)).toEqual({ base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "a.ts", oldPath: "", commit: undefined });
  });

  it("the list stays the branch's while a commit is on screen", () => {
    const seen = { ...target(), ...viewCommit(target(), { sha: "c1", parent: "p1" }) };
    expect(listSides(seen)).toEqual({ base: DEFAULT_BASE, head: DEFAULT_HEAD });
    expect(listSides(target({ base: { kind: "staged" } })).base).toEqual({ kind: "staged" });
  });

  it("survives the tab's params", () => {
    const seen = { ...target({ oldPath: "old.ts", commitsOpen: true, paths: [], thread: "", heading: "", note: "", hide: [] }), ...viewCommit(target({ oldPath: "old.ts" }), { sha: "c1", parent: "" }) };
    expect(diffOfTab(diffTab(seen))).toEqual({ ...seen, oldPath: "" });
    expect(diffTab(target()).params.commit).toBeUndefined();
    expect(diffTab(seen).id).toBe(diffTab(target()).id);
  });
});

describe("whether the tab shows Commits", () => {
  it.each([
    ["nothing taken away", {}, true],
    ["the compare bar hidden: its sides are fixed", { hide: ["compare"] as const }, false],
    ["the file list hidden", { hide: ["files"] as const }, false],
    ["a narrowed list", { paths: ["a.ts"] }, false],
    ["a thread's tab with nothing taken away", { thread: "s1", heading: "Review", note: "Why" }, true],
  ])("%s", (_name, o, want) => {
    expect(commitsShown(target(o))).toBe(want);
  });
});

describe("the section's height", () => {
  it("in the rail, about a third of the tab, never more than eight rows or than there are", () => {
    expect(commitRows(100, 900, true)).toBe(8);
    expect(commitRows(100, 450, true)).toBe(5);
    expect(commitRows(100, 250, true)).toBe(2);
    expect(commitRows(3, 900, true)).toBe(3);
  });
  it("on top, three rows at most, and always two when there are", () => {
    expect(commitRows(100, 900, false)).toBe(3);
    expect(commitRows(100, 250, false)).toBe(2);
    expect(commitRows(100, 100, true)).toBe(2);
    expect(commitRows(1, 100, true)).toBe(1);
  });
  it("folded is its heading; open adds the rows", () => {
    expect(commitsHeight(100, 900, false, false)).toBe(COMMITS_HEADING_H);
    expect(commitsHeight(100, 900, false, true)).toBe(COMMITS_HEADING_H + 3 * COMMIT_ROW_H);
  });
});

describe("commitSubject", () => {
  it("is the subject, or says there is none", () => {
    expect(commitSubject({ subject: "Fix it" })).toBe("Fix it");
    expect(commitSubject({ subject: "" })).toBe(NO_MESSAGE);
  });
});

describe("commitUrl", () => {
  it("is a GitHub page only for a project on GitHub", () => {
    expect(commitUrl("o/web", "c1")).toBe("https://github.com/o/web/commit/c1");
    expect(commitUrl("", "c1")).toBeNull();
    expect(commitUrl(undefined, "c1")).toBeNull();
  });
});
