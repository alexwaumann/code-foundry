import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { addThreads, CF, FEAT, FIX, seedWorld, thread } from "@/test/projectsWorld";
import { decodeTaskThreads, encodeTaskThread, userThread, useTaskRouting } from "./useTaskRouting";

const REF = { slug: "alexwaumann/code-foundry", number: 145 };
const PR = { repoSlug: "alexwaumann/code-foundry" };
const LINK = { slug: REF.slug, number: REF.number, url: "", linkedAt: null };

describe("userThread", () => {
  const byId = { parent: {}, ember: {} };
  it.each([
    { name: "a thread no thread created", t: { createdBy: "", owner: "", resident: undefined }, want: true },
    { name: "a child whose creator is alive", t: { createdBy: "parent", owner: "", resident: undefined }, want: false },
    { name: "a child whose creator is gone (shown in the sidebar)", t: { createdBy: "gone", owner: "", resident: undefined }, want: true },
    { name: "Ember's thread", t: { createdBy: "", owner: "", resident: "ember" }, want: true },
    { name: "a plugin's thread", t: { createdBy: "", owner: "my-plugin", resident: undefined }, want: false },
    { name: "another resident", t: { createdBy: "", owner: "", resident: "other" }, want: false },
  ])("$name", ({ t, want }) => {
    expect(userThread(t, byId)).toBe(want);
  });
});

describe("encodeTaskThread", () => {
  it("decodes back what routing reads", () => {
    const keys = [
      encodeTaskThread(thread("s-1", { name: "a\u0000b", lastActivityAtMs: 50, archivedAtMs: 3 }), true, false),
      encodeTaskThread(thread("s-2", { name: "", lastActivityAtMs: null, createdAtMs: 7 }), false, true),
      encodeTaskThread(thread("s-3", { lastActivityAtMs: null, createdAtMs: null }), false, false),
    ];
    expect(decodeTaskThreads(keys)).toEqual([
      { id: "s-1", name: "a\u0000b", archived: true, activity: 50, links: true, user: false },
      { id: "s-2", name: "", archived: false, activity: 7, links: false, user: true },
      { id: "s-3", name: "s-3", archived: false, activity: 0, links: false, user: false },
    ]);
  });
});

describe("useTaskRouting", () => {
  beforeEach(() => {
    seedWorld();
    addThreads(
      thread("t-here", { worktreePath: CF, lastActivityAtMs: 1, linkedPullRequests: [LINK] }),
      thread("t-old", { worktreePath: FIX, lastActivityAtMs: 10, linkedPullRequests: [LINK] }),
      thread("t-recent", { worktreePath: FEAT, lastActivityAtMs: 90, linkedPullRequests: [LINK] }),
      thread("t-ember", { lastActivityAtMs: 99, resident: "ember", linkedPullRequests: [LINK] }),
      thread("t-child", { lastActivityAtMs: 120, createdBy: "t-recent", linkedPullRequests: [LINK] }),
      thread("t-plugin", { lastActivityAtMs: 130, owner: "a-plugin", linkedPullRequests: [LINK] }),
      thread("t-renamed", { worktreePath: FEAT, lastActivityAtMs: 5, linkedPullRequests: [{ ...LINK, slug: "alexwaumann/foundry" }] }),
      thread("t-unlinked", { lastActivityAtMs: 200 }),
    );
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "t-here" });
    });
  });

  const ids = (r: ReturnType<typeof useTaskRouting>) => r.targets.map((t) => (t.threadId === null ? "new" : `${t.kind}:${t.threadId}`));

  it("lists the user's threads that link it, this one first, Ember included, children and plugins' left out; matches a renamed repository", () => {
    const { result } = renderHook(() => useTaskRouting(REF, { repoSlug: "alexwaumann/foundry" }));
    expect(ids(result.current)).toEqual(["this:t-here", "other:t-ember", "other:t-recent", "other:t-old", "other:t-renamed", "new"]);
    expect(result.current.default).toBe(result.current.targets[0]);
  });

  it("a child whose creator was removed is the user's again", () => {
    const { result } = renderHook(() => useTaskRouting(REF, PR));
    act(() => {
      useThreadsStore.setState((s) => {
        const { "t-recent": _gone, ...byId } = s.byId;
        return { byId, order: s.order.filter((id) => id !== "t-recent") };
      });
    });
    expect(ids(result.current)).toEqual(["this:t-here", "other:t-child", "other:t-ember", "other:t-old", "new"]);
  });

  it("keeps its result while a thread it does not read changes, or a field routing does not read", () => {
    const ref = REF;
    const pr = PR;
    const { result } = renderHook(() => useTaskRouting(ref, pr));
    const before = result.current;
    addThreads(thread("s-unrelated", { lastActivityAtMs: 1 }));
    addThreads({ ...thread("t-old", { worktreePath: FIX, lastActivityAtMs: 10, linkedPullRequests: [LINK] }), statusReason: "permission: Bash" });
    expect(result.current).toBe(before);
    addThreads(thread("t-old", { worktreePath: FIX, lastActivityAtMs: 200, linkedPullRequests: [LINK] }));
    expect(result.current).not.toBe(before);
  });
});
