import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useProjectsStore } from "@/stores/projects";
import { useUiStore } from "@/stores/ui";
import { addThreads, CF, FEAT, FIX, seedWorld, thread } from "@/test/projectsWorld";
import { decodeTaskThreads, encodeTaskThread, headPaths, useTaskRouting } from "./useTaskRouting";

const REF = { slug: "alexwaumann/code-foundry", number: 145 };
const PR = { repoSlug: "alexwaumann/code-foundry", headRef: "fix/resize", isCrossRepository: false };
const LINK = { slug: REF.slug, number: REF.number, url: "", linkedAt: null };

describe("headPaths", () => {
  beforeEach(() => {
    seedWorld();
  });
  it.each([
    { name: "the worktree on the head branch", ref: REF, pr: PR, want: [FIX] },
    { name: "the main checkout on it", ref: REF, pr: { ...PR, headRef: "main" }, want: [CF] },
    { name: "a branch no checkout has", ref: REF, pr: { ...PR, headRef: "gone" }, want: [] },
    { name: "a fork's branch is another branch", ref: REF, pr: { ...PR, isCrossRepository: true }, want: [] },
    { name: "another repository's branch of that name", ref: { slug: "alexwaumann/ghostty-playground", number: 1 }, pr: { ...PR, repoSlug: "alexwaumann/ghostty-playground", headRef: "main" }, want: [`/Users/dev/src/ghostty-playground`] },
    { name: "renamed: the old clone by GitHub's current name", ref: { slug: "alexwaumann/foundry", number: 1 }, pr: { ...PR, repoSlug: "AlexWaumann/Code-Foundry" }, want: [FIX] },
  ])("$name", ({ ref, pr, want }) => {
    expect(headPaths(useProjectsStore.getState(), ref, pr)).toEqual(want);
  });
});

describe("encodeTaskThread", () => {
  it("decodes back what routing reads", () => {
    const keys = [
      encodeTaskThread(thread("s-1", { name: "a\u0000b", lastActivityAtMs: 50, archivedAtMs: 3 }), true, false),
      encodeTaskThread(thread("s-2", { name: "", lastActivityAtMs: null, createdAtMs: 7, resident: "ember" }), false, true),
      encodeTaskThread(thread("s-3", { lastActivityAtMs: null, createdAtMs: null }), false, false),
    ];
    expect(decodeTaskThreads(keys)).toEqual([
      { id: "s-1", name: "a\u0000b", archived: true, activity: 50, links: true, onHead: false, ember: false },
      { id: "s-2", name: "", archived: false, activity: 7, links: false, onHead: true, ember: true },
      { id: "s-3", name: "s-3", archived: false, activity: 0, links: false, onHead: false, ember: false },
    ]);
  });
});

describe("useTaskRouting", () => {
  beforeEach(() => {
    seedWorld();
    addThreads(
      thread("t-here", { worktreePath: CF }),
      thread("t-head", { worktreePath: FIX, lastActivityAtMs: 10, linkedPullRequests: [LINK] }),
      thread("t-recent", { worktreePath: FEAT, lastActivityAtMs: 90, linkedPullRequests: [LINK] }),
      thread("t-ember", { lastActivityAtMs: 99, resident: "ember", linkedPullRequests: [LINK] }),
    );
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "t-here" });
    });
  });

  const ids = (r: ReturnType<typeof useTaskRouting>) => r.targets.map((t) => (t.threadId === null ? "new" : `${t.kind}:${t.threadId}`));

  it("ranks the head branch's thread first and leaves Ember out", () => {
    const { result } = renderHook(() => useTaskRouting(REF, PR));
    expect(ids(result.current)).toEqual(["new", "this:t-here", "other:t-head", "other:t-recent"]);
  });

  it("keeps its result while a thread it does not read changes, or a field routing does not read", () => {
    const ref = REF;
    const pr = PR;
    const { result } = renderHook(() => useTaskRouting(ref, pr));
    const before = result.current;
    addThreads(thread("s-unrelated", { lastActivityAtMs: 1 }));
    addThreads({ ...thread("t-head", { worktreePath: FIX, lastActivityAtMs: 10, linkedPullRequests: [LINK] }), statusReason: "permission: Bash" });
    expect(result.current).toBe(before);
    addThreads(thread("t-head", { worktreePath: FIX, lastActivityAtMs: 200, linkedPullRequests: [LINK] }));
    expect(result.current).not.toBe(before);
  });
});
