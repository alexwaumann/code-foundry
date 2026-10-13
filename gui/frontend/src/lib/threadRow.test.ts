import { describe, expect, it } from "vitest";
import { isNoProject, memberName, modelLabel, NO_PROJECT, threadRowModel, worktreeBranch, type RepoLookup, type WorkspaceLookup } from "./threadRow";

const repos: RepoLookup & { order: string[] } = {
  order: ["api", "notes", "web"],
  byId: {
    web: {
      name: "web",
      worktrees: [
        { path: "/src/web", branch: "main", head: "aaaaaaa1", isMain: true },
        { path: "/wt/web/cf-login", branch: "cf/login", head: "bbbbbbb2", isMain: false },
        { path: "/wt/web/detached", branch: "", head: "c0ffee0012", isMain: false },
      ],
    },
    api: { name: "api", worktrees: [{ path: "/wt/api/cf-login", branch: "cf/login", head: "ddddddd4" }] },
    // A project without git: one checkout with no branch or head.
    notes: { name: "notes", git: false, worktrees: [{ path: "/Users/dev/writing", branch: "", head: "", isMain: true }] },
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
    ["a project thread: no badge", { repoId: "web", worktreePath: "/src/web", workspaceId: "", pendingWorktreePath: "" }, { project: "web", branch: "main", workspace: null, movingTo: null, worktree: false }],
    [
      "a workspace thread: badge with the workspace name",
      { repoId: "web", worktreePath: "/wt/web/cf-login", workspaceId: "w-1", pendingWorktreePath: "" },
      { project: "web", branch: "cf/login", workspace: "login", movingTo: null, worktree: true },
    ],
    [
      "a queued move names the target member's project",
      { repoId: "web", worktreePath: "/wt/web/cf-login", workspaceId: "w-1", pendingWorktreePath: "/wt/api/cf-login" },
      { project: "web", branch: "cf/login", workspace: "login", movingTo: "api", worktree: true },
    ],
    [
      "a pending path equal to the cwd is no move",
      { repoId: "api", worktreePath: "/wt/api/cf-login", workspaceId: "w-1", pendingWorktreePath: "/wt/api/cf-login" },
      { project: "api", branch: "cf/login", workspace: "login", movingTo: null, worktree: false },
    ],
    [
      "an unknown workspace still badges, by id",
      { repoId: "api", worktreePath: "/wt/api/cf-login", workspaceId: "w-gone", pendingWorktreePath: "" },
      { project: "api", branch: "cf/login", workspace: "w-gone", movingTo: null, worktree: false },
    ],
    [
      "a detached head shows the short head",
      { repoId: "web", worktreePath: "/wt/web/detached", workspaceId: "", pendingWorktreePath: "" },
      { project: "web", branch: "c0ffee0", workspace: null, movingTo: null, worktree: true },
    ],
    [
      "an unknown repo falls back to its id and the path",
      { repoId: "gone", worktreePath: "/elsewhere/thing", workspaceId: "", pendingWorktreePath: "" },
      { project: "gone", branch: "thing", workspace: null, movingTo: null, worktree: false },
    ],
    [
      "an older row without a repo id inside a project is placed by its path",
      { repoId: "", worktreePath: "/src/web/docs", workspaceId: "", pendingWorktreePath: "" },
      { project: "web", branch: "docs", workspace: null, movingTo: null, worktree: false },
    ],
  ])("%s", (_name, s, want) => {
    expect(threadRowModel(s, repos, workspaces)).toEqual({ noGit: false, noProject: false, ...want });
  });

  it("a thread without a project: No project, no branch, no worktree", () => {
    const s = { repoId: "", worktreePath: "/Users/dev", workspaceId: "", pendingWorktreePath: "" };
    expect(threadRowModel(s, repos, workspaces)).toEqual({ project: NO_PROJECT, noProject: true, branch: "", noGit: false, workspace: null, movingTo: null, worktree: false });
  });
});

describe("isNoProject", () => {
  it.each([
    ["home, no repo, no workspace", { repoId: "", workspaceId: "", worktreePath: "/Users/dev" }, true],
    ["a path in no project", { repoId: "", workspaceId: "", worktreePath: "/elsewhere/thing" }, true],
    ["a project thread", { repoId: "web", workspaceId: "", worktreePath: "/src/web" }, false],
    ["a workspace thread", { repoId: "", workspaceId: "w-1", worktreePath: "/wt/web/cf-login" }, false],
    ["an older row inside a worktree", { repoId: "", workspaceId: "", worktreePath: "/wt/web/cf-login/src" }, false],
    ["an older row at a no-git checkout", { repoId: "", workspaceId: "", worktreePath: "/Users/dev/writing" }, false],
    ["a sibling with a shared prefix is not inside", { repoId: "", workspaceId: "", worktreePath: "/src/webapp" }, true],
  ])("%s", (_name, s, want) => {
    expect(isNoProject(s, repos)).toBe(want);
  });
});

describe("helpers", () => {
  it.each([
    ["opus", "Opus"],
    ["claude-sonnet-4-6", "Sonnet 4.6"],
    ["sonnet[1m]", "sonnet[1m]"],
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["", "Default"],
    ["  ", "Default"],
  ])("modelLabel(%j) is %j", (model, want) => {
    const models = [
      { value: "opus", label: "Opus" },
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    ];
    expect(modelLabel(model, models)).toBe(want);
  });
  it("worktreeBranch falls back to the directory name for an unknown worktree", () => {
    expect(worktreeBranch(repos, "web", "/wt/web/gone")).toBe("gone");
  });
  it("memberName prefers the workspace's member list, then any repo's worktrees", () => {
    expect(memberName(repos, workspaces.byId["w-1"], "/wt/api/cf-login")).toBe("api");
    expect(memberName(repos, undefined, "/src/web")).toBe("web");
    expect(memberName(repos, undefined, "/nowhere/x")).toBe("x");
  });
  it("a project without git: no branch, the No git badge", () => {
    const s = { repoId: "notes", worktreePath: "/Users/dev/writing", workspaceId: "", pendingWorktreePath: "" };
    expect(threadRowModel(s, repos, workspaces)).toEqual({ project: "notes", noProject: false, branch: "", noGit: true, workspace: null, movingTo: null, worktree: false });
    expect(worktreeBranch(repos, "notes", "/Users/dev/writing")).toBe("");
  });
});
