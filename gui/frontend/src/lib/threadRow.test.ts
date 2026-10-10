import { describe, expect, it } from "vitest";
import { memberName, terminalPlace, threadRowModel, worktreeBranch, type RepoLookup, type WorkspaceLookup } from "./threadRow";

const repos: RepoLookup & { order: string[] } = {
  order: ["api", "notes", "web"],
  byId: {
    web: {
      name: "web",
      worktrees: [
        { path: "/src/web", branch: "main", head: "aaaaaaa1" },
        { path: "/wt/web/cf-login", branch: "cf/login", head: "bbbbbbb2" },
        { path: "/wt/web/detached", branch: "", head: "c0ffee0012" },
      ],
    },
    api: { name: "api", worktrees: [{ path: "/wt/api/cf-login", branch: "cf/login", head: "ddddddd4" }] },
    // A project without git: one checkout with no branch or head.
    notes: { name: "notes", git: false, worktrees: [{ path: "/Users/dev/writing", branch: "", head: "" }] },
  },
};
const workspaces: WorkspaceLookup = {
  byId: {
    "w-1": {
      name: "login",
      members: [
        { repoId: "web", worktreePath: "/wt/web/cf-login" },
        { repoId: "api", worktreePath: "/wt/api/cf-login" },
      ],
    },
  },
};

describe("threadRowModel", () => {
  it.each([
    ["a project thread: no badge", { repoId: "web", worktreePath: "/src/web", workspaceId: "", pendingWorktreePath: "" }, { project: "web", branch: "main", workspace: null, movingTo: null }],
    [
      "a workspace thread: badge with the workspace name",
      { repoId: "web", worktreePath: "/wt/web/cf-login", workspaceId: "w-1", pendingWorktreePath: "" },
      { project: "web", branch: "cf/login", workspace: "login", movingTo: null },
    ],
    [
      "a queued move names the target member's project",
      { repoId: "web", worktreePath: "/wt/web/cf-login", workspaceId: "w-1", pendingWorktreePath: "/wt/api/cf-login" },
      { project: "web", branch: "cf/login", workspace: "login", movingTo: "api" },
    ],
    [
      "a pending path equal to the cwd is no move",
      { repoId: "api", worktreePath: "/wt/api/cf-login", workspaceId: "w-1", pendingWorktreePath: "/wt/api/cf-login" },
      { project: "api", branch: "cf/login", workspace: "login", movingTo: null },
    ],
    [
      "an unknown workspace still badges, by id",
      { repoId: "api", worktreePath: "/wt/api/cf-login", workspaceId: "w-gone", pendingWorktreePath: "" },
      { project: "api", branch: "cf/login", workspace: "w-gone", movingTo: null },
    ],
    [
      "a detached head shows the short head",
      { repoId: "web", worktreePath: "/wt/web/detached", workspaceId: "", pendingWorktreePath: "" },
      { project: "web", branch: "c0ffee0", workspace: null, movingTo: null },
    ],
    [
      "an unknown repo and worktree fall back to the path",
      { repoId: "", worktreePath: "/elsewhere/thing", workspaceId: "", pendingWorktreePath: "" },
      { project: "thing", branch: "thing", workspace: null, movingTo: null },
    ],
  ])("%s", (_name, s, want) => {
    expect(threadRowModel(s, repos, workspaces)).toEqual({ noGit: false, ...want });
  });
});

describe("helpers", () => {
  it("worktreeBranch falls back to the directory name for an unknown worktree", () => {
    expect(worktreeBranch(repos, "web", "/wt/web/gone")).toBe("gone");
  });
  it("memberName prefers the workspace's member list, then any repo's worktrees", () => {
    expect(memberName(repos, workspaces.byId["w-1"], "/wt/api/cf-login")).toBe("api");
    expect(memberName(repos, undefined, "/src/web")).toBe("web");
    expect(memberName(repos, undefined, "/nowhere/x")).toBe("x");
  });
  it("terminalPlace: project and branch of the worktree it sits in, else its cwd", () => {
    expect(terminalPlace(repos, { cwd: "/src/web/internal", worktreeLabel: "" })).toBe("web · main");
    expect(terminalPlace(repos, { cwd: "/tmp", worktreeLabel: "/wt/api/cf-login" })).toBe("api · cf/login");
    expect(terminalPlace(repos, { cwd: "/Users/dev/notes", worktreeLabel: "" })).toBe("~/notes");
  });
  it("a project without git: no branch, the No git badge (No git in text)", () => {
    const s = { repoId: "notes", worktreePath: "/Users/dev/writing", workspaceId: "", pendingWorktreePath: "" };
    expect(threadRowModel(s, repos, workspaces)).toEqual({ project: "notes", branch: "", noGit: true, workspace: null, movingTo: null });
    expect(worktreeBranch(repos, "notes", "/Users/dev/writing")).toBe("");
    expect(terminalPlace(repos, { cwd: "/Users/dev/writing/drafts", worktreeLabel: "" })).toBe("notes · No git");
  });
});
