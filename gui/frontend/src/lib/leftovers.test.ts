import { describe, expect, it } from "vitest";
import type { WorktreeView } from "@/api/project";
import { holdsWork, isLeftover, lastArchivedOn, leftoverReason, lossFiles, lossLine, removeCleanLabel, uncommittedCount, type ArchivedThreads } from "./leftovers";

const NOW = Date.UTC(2026, 9, 31, 12);
const DAY = 86_400_000;
const WT = "/wt/cf-a";

function wt(over: Partial<WorktreeView> = {}, status: Partial<WorktreeView["status"]> = {}): WorktreeView {
  return {
    projectId: "p",
    path: WT,
    branch: "cf/a",
    head: "c1",
    detached: false,
    isMain: false,
    managed: true,
    landed: true,
    mergedClean: true,
    cleanupReason: "branch is in origin/main",
    ...over,
    status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0, dirty: false, refreshedAtMs: NOW, baseRef: "origin/main", baseAhead: 0, baseBehind: 0, error: "", ...status },
  } as WorktreeView;
}

const input = { defaultBranch: "main", archivedAtMs: null, terminal: false, now: NOW };

describe("isLeftover", () => {
  type Threads = Parameters<typeof isLeftover>[1];
  const none: Threads = { order: [], byId: {} };
  const one = (t: { archivedAtMs: number | null; worktreePath: string; checkoutPaths?: { projectId: string; path: string }[] }): Threads => ({ order: ["s"], byId: { s: t } });
  const cases: { name: string; w: { path: string; isMain: boolean }; threads: Threads; want: boolean }[] = [
    { name: "no thread at all", w: { path: WT, isMain: false }, threads: none, want: true },
    { name: "the main worktree never is", w: { path: WT, isMain: true }, threads: none, want: false },
    { name: "a thread's cwd", w: { path: WT, isMain: false }, threads: one({ archivedAtMs: null, worktreePath: WT }), want: false },
    { name: "a thread in a subdirectory", w: { path: WT, isMain: false }, threads: one({ archivedAtMs: null, worktreePath: `${WT}/src` }), want: false },
    { name: "a thread's checkout in a set", w: { path: WT, isMain: false }, threads: one({ archivedAtMs: null, worktreePath: "/x", checkoutPaths: [{ projectId: "p", path: WT }] }), want: false },
    { name: "only an archived thread", w: { path: WT, isMain: false }, threads: one({ archivedAtMs: 5, worktreePath: WT }), want: true },
    { name: "a sibling sharing a prefix", w: { path: WT, isMain: false }, threads: one({ archivedAtMs: null, worktreePath: `${WT}-b` }), want: true },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(isLeftover(c.w, c.threads)).toBe(c.want);
    });
  }
});

describe("holdsWork", () => {
  it.each([
    ["clean and landed", wt(), false],
    ["uncommitted files", wt({}, { untracked: 2, dirty: true }), true],
    ["commits not landed", wt({ landed: false }, { baseAhead: 3 }), true],
    ["nothing to compare with (landed unknown)", wt({ landed: false }, { baseRef: "" }), true],
    ["an older daemon without landed", wt({ landed: undefined }), true],
  ])("%s", (_, w, want) => {
    expect(holdsWork(w)).toBe(want);
  });
});

describe("leftoverReason", () => {
  const cases: { name: string; w: WorktreeView; o?: Partial<typeof input>; want: string }[] = [
    { name: "commits not on main, its thread archived", w: wt({ landed: false }, { baseAhead: 3 }), o: { archivedAtMs: NOW - 12 * DAY }, want: "3 commits not on main · last thread archived 12d ago" },
    { name: "one commit", w: wt({ landed: false }, { baseAhead: 1 }), want: "1 commit not on main" },
    { name: "uncommitted files, merged otherwise", w: wt({}, { modified: 2, untracked: 2, dirty: true }), o: { archivedAtMs: NOW - 21 * DAY }, want: "4 uncommitted files · merged otherwise · last thread archived 3w ago" },
    { name: "commits and uncommitted files", w: wt({ landed: false }, { baseAhead: 2, staged: 1, dirty: true }), want: "2 commits not on main · 1 uncommitted file" },
    { name: "made outside the app, clean, merged", w: wt({ managed: false, mergedClean: false, cleanupReason: "not a Code Foundry worktree" }), want: "made outside Code Foundry · clean · merged" },
    { name: "a rebased copy landed: merged", w: wt({}, { baseAhead: 4 }), want: "clean · merged" },
    { name: "a terminal open in it", w: wt(), o: { terminal: true }, want: "clean · merged · a terminal is open in it" },
    { name: "conflicted entries count as uncommitted", w: wt({ landed: false }, { conflicted: 2, dirty: true, baseAhead: 0 }), want: "2 uncommitted files" },
    { name: "the default branch unknown: the base ref without its remote", w: wt({ landed: false }, { baseAhead: 3, baseRef: "origin/trunk" }), o: { defaultBranch: "" }, want: "3 commits not on trunk" },
    { name: "no remote default branch", w: wt({ landed: false, cleanupReason: "no remote default branch to compare with" }, { baseRef: "" }), want: "no remote default branch to compare with · clean" },
    { name: "an operation in progress: the daemon's reason", w: wt({ landed: false, cleanupReason: "rebase in progress" }, { operation: "rebase", conflicted: 1, dirty: true, baseAhead: 2 }), want: "rebase in progress · 1 uncommitted file" },
    { name: "a failed read: the daemon's reason", w: wt({ landed: false, cleanupReason: "git status failed: boom" }, { error: "boom" }), want: "git status failed: boom · clean" },
    { name: "unmanaged and detached: said in words", w: wt({ managed: false, detached: true, branch: "", landed: true, cleanupReason: "not a Code Foundry worktree" }), want: "made outside Code Foundry · detached HEAD · clean · merged" },
    { name: "archived just now", w: wt(), o: { archivedAtMs: NOW - 10_000 }, want: "clean · merged · last thread archived just now" },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(leftoverReason(c.w, { ...input, ...c.o })).toBe(c.want);
    });
  }
});

describe("lastArchivedOn", () => {
  const threads: ArchivedThreads = {
    order: ["a", "b", "c", "d"],
    byId: {
      a: { id: "a", archivedAtMs: 10, worktreePath: WT, checkoutPaths: [] },
      b: { id: "b", archivedAtMs: 30, worktreePath: "/x", checkoutPaths: [{ projectId: "p", path: WT }] },
      c: { id: "c", archivedAtMs: null, worktreePath: WT, checkoutPaths: [] },
      d: { id: "d", archivedAtMs: 99, worktreePath: `${WT}-b`, checkoutPaths: [] },
    },
  };
  it("the newest archived thread whose cwd or checkout it was", () => {
    expect(lastArchivedOn(threads, WT)).toEqual({ id: "b", archivedAtMs: 30 });
  });
  it("none", () => {
    expect(lastArchivedOn(threads, "/nowhere")).toBeNull();
  });
});

describe("labels", () => {
  it("removeCleanLabel", () => {
    expect(removeCleanLabel(1)).toBe("Remove the 1 that is clean");
    expect(removeCleanLabel(3)).toBe("Remove the 3 that are clean");
  });
  it("lossLine", () => {
    expect(lossLine(1)).toBe("1 uncommitted file is lost.");
    expect(lossLine(4)).toBe("4 uncommitted files are lost.");
  });
  it("lossFiles: the first three, then how many more", () => {
    expect(lossFiles(["a", "b", "c", "d"], 4)).toEqual({ names: "a, b, c", more: 1 });
    expect(lossFiles(["a", "b"], 2)).toEqual({ names: "a, b", more: 0 });
    expect(lossFiles([], 4)).toEqual({ names: "", more: 4 });
  });
  it("uncommittedCount", () => {
    expect(uncommittedCount({ staged: 1, modified: 2, untracked: 3, conflicted: 4 })).toBe(10);
  });
});
