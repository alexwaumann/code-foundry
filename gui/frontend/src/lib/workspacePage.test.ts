import { describe, expect, it } from "vitest";
import type { GitStatusView } from "@/api/project";
import type { ActivityThread, ActivityThreads } from "./projects";
import { memberCheckoutPath, memberCheckoutState, workspaceThreads, workspaceThreadsCaption, type MemberCheckoutInput } from "./workspacePage";

const thread = (o: Partial<ActivityThread>): ActivityThread => ({
  projectId: "",
  projectIds: [],
  workspaceId: "",
  archivedAtMs: null,
  state: "disconnected",
  status: "idle",
  statusChangedAtMs: null,
  createdAtMs: null,
  lastActivityAtMs: null,
  branch: "",
  worktreePath: "",
  checkoutPaths: [],
  ...o,
});
const slice = (ts: Record<string, ActivityThread>): ActivityThreads => ({ order: Object.keys(ts), byId: ts });
const working = { state: "connected", status: "busy" } as const;

describe("workspaceThreads", () => {
  it("lists the workspace's non-archived threads, working first then by activity, and counts the archived", () => {
    const got = workspaceThreads(
      slice({
        a: thread({ workspaceId: "w", createdAtMs: 10 }),
        b: thread({ workspaceId: "w", createdAtMs: 30 }),
        c: thread({ workspaceId: "w", createdAtMs: 5, ...working }),
        d: thread({ workspaceId: "w", createdAtMs: 50, archivedAtMs: 60 }),
        e: thread({ workspaceId: "other", createdAtMs: 99, ...working }),
        f: thread({ workspaceId: "w", archivedAtMs: 1, ...working }),
      }),
      "w",
    );
    expect(got).toEqual({ ids: ["c", "b", "a"], working: 1, idle: 2, archived: 2 });
  });

  it("is empty for a workspace no thread references", () => {
    expect(workspaceThreads(slice({ a: thread({ workspaceId: "x" }) }), "w")).toEqual({ ids: [], working: 0, idle: 0, archived: 0 });
  });
});

describe("workspaceThreadsCaption", () => {
  it.each<[number, number, number, string]>([
    [1, 0, 3, "1 working · 3 archived"],
    [0, 2, 0, "2 idle"],
    [2, 1, 1, "2 working · 1 idle · 1 archived"],
    [0, 0, 4, "4 archived"],
    [0, 0, 0, "none yet"],
  ])("%i working, %i idle, %i archived: %s", (w, i, a, want) => {
    expect(workspaceThreadsCaption({ working: w, idle: i, archived: a })).toBe(want);
  });
});

describe("memberCheckoutPath", () => {
  it.each<[string, Partial<ActivityThread>, string, string]>([
    ["a recorded member", { projectId: "a", worktreePath: "/a/wt", checkoutPaths: [{ projectId: "b", path: "/b/wt" }] }, "b", "/b/wt"],
    ["the primary: its cwd", { projectId: "a", worktreePath: "/a/wt", checkoutPaths: [] }, "a", "/a/wt"],
    ["the primary's recorded path wins", { projectId: "a", worktreePath: "/a/wt/sub", checkoutPaths: [{ projectId: "a", path: "/a/wt" }] }, "a", "/a/wt"],
    ["not recorded yet", { projectId: "a", projectIds: ["a", "b"], checkoutPaths: [] }, "b", ""],
    ["not in the set", { projectId: "a" }, "z", ""],
  ])("%s", (_name, o, member, want) => {
    expect(memberCheckoutPath(thread(o), member)).toBe(want);
  });
});

const status = (o: Partial<GitStatusView> = {}): GitStatusView => ({ upstream: "origin/x", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null, ...o });
const base: MemberCheckoutInput = { inSet: true, path: "/wt", git: true, known: true, worktree: { isMain: false, status: status() } };

describe("memberCheckoutState", () => {
  it.each<[string, Partial<MemberCheckoutInput>, string]>([
    ["clean and pushed", {}, "clean · up to date"],
    ["files to commit and commits to push", { worktree: { isMain: false, status: status({ modified: 3, untracked: 1, dirty: true, ahead: 2 }) } }, "4 files · 2 to push"],
    ["behind", { worktree: { isMain: false, status: status({ behind: 1 }) } }, "clean · 1 behind"],
    ["never pushed", { worktree: { isMain: false, status: status({ upstream: "" }) } }, "clean · not pushed"],
    ["merged and clean", { worktree: { isMain: false, mergedClean: true, status: status({ upstream: "" }) } }, "clean · merged"],
    ["merged but dirty again: the files show", { worktree: { isMain: false, mergedClean: true, status: status({ modified: 1, dirty: true }) } }, "1 file · up to date"],
    ["the main checkout", { worktree: { isMain: true, status: status({ behind: 2 }) } }, "clean · 2 behind"],
    ["not in the thread's set", { inSet: false }, "not in this thread"],
    ["an unregistered project", { known: false, git: false, worktree: undefined }, "not registered"],
    ["a plain folder", { git: false }, "folder · no git"],
    ["no path recorded yet", { path: "", worktree: undefined }, "made at the next start"],
    ["a path the projects slice does not know", { worktree: undefined }, "made at the next start"],
  ])("%s", (_name, o, want) => {
    expect(memberCheckoutState({ ...base, ...o })).toBe(want);
  });
});
