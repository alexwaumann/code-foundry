import { describe, expect, it } from "vitest";
import type { GitStatusView } from "@/api/project";
import type { ActivityThread, ActivityThreads } from "./projects";
import { changedCheckouts, memberCheckoutPath, threadChangesCell, threadPlace, workspaceThreads, workspaceThreadsCaption } from "./workspacePage";

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
describe("threadChangesCell (a thread row's Changes over its member checkouts)", () => {
  it.each<[string, Partial<GitStatusView>[], string]>([
    ["files and commits summed over the members", [{ modified: 2, dirty: true, baseAhead: 1 }, { untracked: 1, dirty: true, baseAhead: 1 }], "3 files · 2 commits"],
    ["one of each", [{ staged: 1, dirty: true, baseAhead: 1 }, {}], "1 file · 1 commit"],
    ["commits only", [{ baseAhead: 4 }], "4 commits"],
    ["conflicted entries count as files", [{ conflicted: 2, dirty: true }], "2 files"],
    ["dirty without counts", [{ dirty: true }, { baseAhead: 1 }], "changed · 1 commit"],
    ["nothing anywhere", [{}, {}], "clean"],
    ["no checkout to read", [], ""],
  ])("%s", (_name, sts, want) => {
    expect(threadChangesCell(sts.map((o) => status(o)))).toBe(want);
  });
});

describe("changedCheckouts (the row menu's Show changes)", () => {
  it("keeps the members whose checkout has files or commits on its branch, in order", () => {
    const cs = [
      { projectId: "a", status: status() },
      { projectId: "b", status: status({ modified: 1, dirty: true }) },
      { projectId: "c", status: undefined },
      { projectId: "d", status: status({ baseAhead: 2 }) },
    ];
    expect(changedCheckouts(cs).map((c) => c.projectId)).toEqual(["b", "d"]);
  });
});

describe("threadPlace", () => {
  it.each([
    ["its primary's checkout", { projectId: "repo-cf", worktreePath: "/wt/repo-cf/x", workspaceId: "w-1" }, { kind: "checkout", projectId: "repo-cf", path: "/wt/repo-cf/x" }],
    ["the workspace's folder (no primary)", { projectId: "", worktreePath: "/Users/dev/.code-foundry/workspaces/w-1", workspaceId: "w-1" }, { kind: "folder", workspaceId: "w-1" }],
    ["a primary with no checkout yet: nothing", { projectId: "repo-cf", worktreePath: "", workspaceId: "w-1" }, null],
    ["neither: nothing", { projectId: "", worktreePath: "/tmp", workspaceId: "" }, null],
  ])("%s", (_, t, want) => {
    expect(threadPlace(t)).toEqual(want);
  });
});
