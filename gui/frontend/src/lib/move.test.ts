import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { canMove, moveArgs, moveLine, movingLabel, movingTo, type MoveTarget } from "./move";

const web: MoveTarget = { kind: "project", projectId: "web" };
const platform: MoveTarget = { kind: "workspace", workspaceId: "w-1" };
const MAIN = "/src/web";

describe("moveArgs: thread.move's args for each choice", () => {
  it.each<[string, MoveTarget, Parameters<typeof moveArgs>[2], Record<string, string>]>([
    ["a fresh copy", web, { worktree: { kind: "new" }, base: "", primary: "web", mainPath: MAIN }, { id: "s-1", project: "web", "new-worktree": "true" }],
    ["a fresh copy from a picked branch", web, { worktree: { kind: "new" }, base: "release/v0.3", primary: "web", mainPath: MAIN }, { id: "s-1", project: "web", "new-worktree": "true", base: "release/v0.3" }],
    ["an existing branch (no base)", web, { worktree: { kind: "branch", name: "fix/resize" }, base: "main", primary: "web", mainPath: MAIN }, { id: "s-1", project: "web", "new-worktree": "true", branch: "fix/resize" }],
    ["the project folder (its main checkout)", web, { worktree: { kind: "existing", path: MAIN }, base: "", primary: "web", mainPath: MAIN }, { id: "s-1", project: "web", "new-worktree": "false" }],
    ["another existing worktree", web, { worktree: { kind: "existing", path: "/wt/feat" }, base: "", primary: "web", mainPath: MAIN }, { id: "s-1", project: "web", worktree: "/wt/feat" }],
    ["a workspace in fresh copies, run in a member", platform, { worktree: { kind: "new" }, base: "", primary: "api" }, { id: "s-1", workspace: "w-1", project: "api", "new-worktree": "true" }],
    ["a workspace in its projects' folders, run in its folder", platform, { worktree: { kind: "current" }, base: "", primary: "workspace" }, { id: "s-1", workspace: "w-1", project: "workspace", "new-worktree": "false" }],
    ["a workspace on an existing branch", platform, { worktree: { kind: "branch", name: "cf/auth" }, base: "", primary: "web" }, { id: "s-1", workspace: "w-1", project: "web", "new-worktree": "true", branch: "cf/auth" }],
  ])("%s", (_, target, p, want) => {
    expect(moveArgs("s-1", target, p)).toEqual(want);
  });
});

describe("moveLine: what the choice does", () => {
  it.each<[string, Parameters<typeof moveLine>[0], string]>([
    ["fresh copy", { worktree: { kind: "new" }, set: false, many: false, noGit: false }, "New branch, named from the conversation when it moves."],
    ["existing branch", { worktree: { kind: "branch", name: "fix/resize" }, set: false, many: false, noGit: false }, "Works on the existing branch fix/resize; a worktree is made for it if none exists."],
    ["project folder", { worktree: { kind: "existing", path: MAIN }, set: false, many: false, noGit: false, mainPath: MAIN }, "Works in the project's folder, on its current branch."],
    ["no git", { worktree: { kind: "existing", path: "/docs" }, set: false, many: false, noGit: true, mainPath: "/docs" }, "Works in the project's folder."],
    ["a set's folders", { worktree: { kind: "current" }, set: true, many: true, noGit: false }, "Works in each project's folder, on the branch it has checked out."],
    ["another worktree", { worktree: { kind: "existing", path: "/wt/feat" }, set: false, many: false, noGit: false, mainPath: MAIN }, "Works in the worktree at /wt/feat."],
  ])("%s", (_, p, want) => {
    expect(moveLine(p)).toBe(want);
  });
});

describe("movingTo: the crumb's destination while moving", () => {
  const names = { project: (id: string) => ({ web: "web-app" })[id], workspace: (id: string) => ({ "w-1": "platform" })[id] };
  it.each<[string, Parameters<typeof movingTo>[0], string | undefined, string | null]>([
    ["not moving", null, undefined, null],
    ["a project", { projectId: "web", workspaceId: "" }, undefined, "web-app"],
    ["a workspace, even with a primary member", { projectId: "web", workspaceId: "w-1" }, undefined, "platform"],
    ["an unknown project: its id", { projectId: "gone", workspaceId: "" }, undefined, "gone"],
    ["sent, no pending_move yet", null, "web-app", "web-app"],
    ["pending_move wins over what was sent", { projectId: "web", workspaceId: "" }, "other", "web-app"],
  ])("%s", (_, pending, sending, want) => {
    expect(movingTo(pending, sending, names)).toBe(want);
  });
  it("reads Moving to <name>…", () => {
    expect(movingLabel("code-foundry")).toBe("Moving to code-foundry…");
  });
});

describe("canMove", () => {
  const projects = { byId: { web: { worktrees: [{ path: MAIN }] } } } as never;
  const t = (o: Partial<ThreadView>) => ({ projectId: "", workspaceId: "", worktreePath: "/Users/me", archivedAtMs: null, resident: "", pendingMove: null, ...o }) as ThreadView;
  it.each<[string, ThreadView | undefined, boolean]>([
    ["a thread without a project", t({}), true],
    ["a project thread", t({ projectId: "web", worktreePath: MAIN }), false],
    ["a workspace thread", t({ workspaceId: "w-1" }), false],
    ["a thread whose cwd is in a project (an older row)", t({ worktreePath: `${MAIN}/sub` }), false],
    ["archived", t({ archivedAtMs: 1 }), false],
    ["resident (Ember)", t({ resident: "ember" }), false],
    ["moving", t({ pendingMove: { projectId: "web", workspaceId: "", worktreePath: "", branch: "" } }), false],
    ["unknown", undefined, false],
  ])("%s: %s", (_, thread, want) => {
    expect(canMove(thread, projects)).toBe(want);
  });
});
