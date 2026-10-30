import { describe, expect, it } from "vitest";
import { canNewLike, canRunElsewhere, isNoProject, modelLabel, NO_PROJECT, projectOfPath, projectsLabel, setLabel, threadPlace, threadRowModel, worktreeBranch, type ProjectLookup, type ThreadPlaceInput, type WorkspaceLookup } from "./threadRow";

const projects: ProjectLookup & { order: string[] } = {
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
const workspaces: WorkspaceLookup = { byId: { "w-1": { name: "login" } } };

describe("threadRowModel", () => {
  it.each<[string, ThreadPlaceInput, Partial<ReturnType<typeof threadRowModel>>]>([
    ["a single-project thread: the project", { projectId: "web", worktreePath: "/src/web", workspaceId: "", pendingWorktreePath: "" }, { project: "web", branch: "main", set: null, movingTo: null, worktree: false }],
    [
      "a single-project thread with a workspace reference: unchanged",
      { projectId: "web", worktreePath: "/wt/web/cf-login", workspaceId: "w-1", pendingWorktreePath: "", projectCount: 1 },
      { project: "web", branch: "cf/login", set: null, worktree: true },
    ],
    [
      "several projects with a workspace in worktree mode: its name and the cwd's branch, read from HEAD, not the one it was created for",
      { projectId: "web", worktreePath: "/wt/web/cf-login", workspaceId: "w-1", pendingWorktreePath: "", projectCount: 3, branch: "feat/x", createdWorktree: true },
      { project: "web", branch: "cf/login", set: "login", worktree: true },
    ],
    [
      "several projects without a workspace, in place: N projects and the cwd's branch",
      { projectId: "web", worktreePath: "/src/web", workspaceId: "", pendingWorktreePath: "", projectCount: 2, branch: "", createdWorktree: false },
      { project: "web", branch: "main", set: "2 projects" },
    ],
    [
      "a thread in its workspace's folder: the workspace's name, no checkout branch in place",
      { projectId: "", worktreePath: "/Users/dev/.code-foundry/workspaces/w-1", workspaceId: "w-1", pendingWorktreePath: "", projectCount: 2, branch: "", createdWorktree: false },
      { project: "login", branch: "", set: "login" },
    ],
    [
      "a queued move names the target checkout's project",
      { projectId: "web", worktreePath: "/wt/web/cf-login", workspaceId: "w-1", pendingWorktreePath: "/wt/api/cf-login", projectCount: 2, branch: "cf/login", createdWorktree: true },
      { project: "web", branch: "cf/login", set: "login", movingTo: "api", worktree: true },
    ],
    [
      "a pending path equal to the cwd is no move",
      { projectId: "api", worktreePath: "/wt/api/cf-login", workspaceId: "", pendingWorktreePath: "/wt/api/cf-login" },
      { project: "api", branch: "cf/login", movingTo: null, worktree: false },
    ],
    [
      "an unknown workspace names its id",
      { projectId: "api", worktreePath: "/wt/api/cf-login", workspaceId: "w-gone", pendingWorktreePath: "", projectCount: 2, branch: "cf/login", createdWorktree: true },
      { project: "api", branch: "cf/login", set: "w-gone" },
    ],
    ["a detached head shows the short head", { projectId: "web", worktreePath: "/wt/web/detached", workspaceId: "", pendingWorktreePath: "" }, { project: "web", branch: "c0ffee0", worktree: true }],
    ["an unknown project falls back to its id and the path", { projectId: "gone", worktreePath: "/elsewhere/thing", workspaceId: "", pendingWorktreePath: "" }, { project: "gone", branch: "thing", worktree: false }],
    [
      "an older row without a project id inside a project is placed by its path",
      { projectId: "", worktreePath: "/src/web/docs", workspaceId: "", pendingWorktreePath: "" },
      { project: "web", branch: "docs", worktree: false },
    ],
  ])("%s", (_name, s, want) => {
    expect(threadRowModel(s, projects, workspaces)).toMatchObject({ noGit: false, noProject: false, set: null, movingTo: null, ...want });
  });

  it("a thread without a project: No project, no branch, no worktree", () => {
    const s = { projectId: "", worktreePath: "/Users/dev", workspaceId: "", pendingWorktreePath: "" };
    expect(threadRowModel(s, projects, workspaces)).toEqual({ project: NO_PROJECT, noProject: true, branch: "", noGit: false, set: null, movingTo: null, worktree: false, place: null });
  });

  it("a project without git: no branch, the No git badge; in a set the set label instead", () => {
    const s = { projectId: "notes", worktreePath: "/Users/dev/writing", workspaceId: "", pendingWorktreePath: "" };
    expect(threadRowModel(s, projects, workspaces)).toEqual({ project: "notes", noProject: false, branch: "", noGit: true, set: null, movingTo: null, worktree: false, place: "folder" });
    expect(threadRowModel({ ...s, projectCount: 2, branch: "feat/x", createdWorktree: true }, projects, workspaces)).toMatchObject({ noGit: false, set: "2 projects", branch: "feat/x" });
  });
});

describe("threadPlace (the card's Fresh copy / Project folder chip)", () => {
  it.each<[string, Parameters<typeof threadPlace>[1], ReturnType<typeof threadPlace>]>([
    ["the project's main checkout: folder", { projectId: "web", worktreePath: "/src/web", createdWorktree: false }, "folder"],
    ["the main checkout in worktree mode (a set member that has no worktree there): folder", { projectId: "web", worktreePath: "/src/web", createdWorktree: true }, "folder"],
    ["a worktree made for it: fresh", { projectId: "web", worktreePath: "/wt/web/cf-login", createdWorktree: true }, "fresh"],
    ["a made worktree missing until its next start: fresh", { projectId: "web", worktreePath: "/wt/web/gone", createdWorktree: true }, "fresh"],
    ["a worktree the user picked: none", { projectId: "web", worktreePath: "/wt/web/cf-login", createdWorktree: false }, null],
    ["a worktree whose main flag is unknown, picked: none", { projectId: "api", worktreePath: "/wt/api/cf-login", createdWorktree: false }, null],
    ["a project without git: folder", { projectId: "notes", worktreePath: "/Users/dev/writing", createdWorktree: true }, "folder"],
    ["a workspace's folder (no project id): none", { projectId: "", worktreePath: "/Users/dev/.code-foundry/workspaces/w-1", createdWorktree: true }, null],
  ])("%s", (_name, s, want) => {
    expect(threadPlace(projects, s)).toBe(want);
  });

  it("threadRowModel carries it; a thread without a project has none", () => {
    expect(threadRowModel({ projectId: "web", worktreePath: "/wt/web/cf-login", workspaceId: "w-1", pendingWorktreePath: "", projectCount: 2, branch: "cf/login", createdWorktree: true }, projects, workspaces).place).toBe("fresh");
    expect(threadRowModel({ projectId: "", worktreePath: "/Users/dev", workspaceId: "", pendingWorktreePath: "" }, projects, workspaces).place).toBeNull();
  });
});

describe("projectsLabel", () => {
  it.each<[number, string]>([
    [1, "1 project"],
    [2, "2 projects"],
    [9, "9 projects"],
  ])("%d", (n, want) => {
    expect(projectsLabel(n)).toBe(want);
  });
});

describe("setLabel", () => {
  it.each<[string, Parameters<typeof setLabel>[0], string | null]>([
    ["one project", { projectId: "web", workspaceId: "", projectCount: 1 }, null],
    ["the count absent counts as one", { projectId: "web", workspaceId: "w-1" }, null],
    ["two projects", { projectId: "web", workspaceId: "", projectCount: 2 }, "2 projects"],
    ["a workspace's name over the count", { projectId: "web", workspaceId: "w-1", projectCount: 4 }, "login"],
    ["the workspace's folder with one project", { projectId: "", workspaceId: "w-1", projectCount: 1 }, "login"],
  ])("%s", (_name, s, want) => {
    expect(setLabel(s, workspaces)).toBe(want);
  });
});

describe("isNoProject", () => {
  it.each([
    ["home, no project, no workspace", { projectId: "", workspaceId: "", worktreePath: "/Users/dev" }, true],
    ["a path in no project", { projectId: "", workspaceId: "", worktreePath: "/elsewhere/thing" }, true],
    ["a project thread", { projectId: "web", workspaceId: "", worktreePath: "/src/web" }, false],
    ["a workspace thread", { projectId: "", workspaceId: "w-1", worktreePath: "/wt/web/cf-login" }, false],
    ["an older row inside a worktree", { projectId: "", workspaceId: "", worktreePath: "/wt/web/cf-login/src" }, false],
    ["an older row at a no-git checkout", { projectId: "", workspaceId: "", worktreePath: "/Users/dev/writing" }, false],
    ["a sibling with a shared prefix is not inside", { projectId: "", workspaceId: "", worktreePath: "/src/webapp" }, true],
  ])("%s", (_name, s, want) => {
    expect(isNoProject(s, projects)).toBe(want);
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
    expect(worktreeBranch(projects, "web", "/wt/web/gone")).toBe("gone");
    expect(worktreeBranch(projects, "notes", "/Users/dev/writing")).toBe("");
  });
  it("projectOfPath: a project's worktree, else one containing it, else the directory name", () => {
    expect(projectOfPath(projects, "/wt/api/cf-login")).toBe("api");
    expect(projectOfPath(projects, "/src/web/docs")).toBe("web");
    expect(projectOfPath(projects, "/nowhere/x")).toBe("x");
  });
});

describe("canNewLike and canRunElsewhere (the menus', the palette's and the daemon's rule)", () => {
  it.each([
    ["no project", [], "", false, false],
    ["one project", ["web"], "", true, false],
    ["one project and a workspace: its folder is the other place", ["web"], "w-1", true, true],
    ["two projects", ["api", "web"], "", true, true],
    ["a workspace without projects, in its folder", [], "w-1", true, false],
  ])("%s", (_name, projectIds, workspaceId, newLike, runIn) => {
    expect(canNewLike({ projectIds, workspaceId })).toBe(newLike);
    expect(canRunElsewhere({ projectIds, workspaceId })).toBe(runIn);
  });
  it("an unknown thread gets neither", () => {
    expect(canNewLike(undefined)).toBe(false);
    expect(canRunElsewhere(undefined)).toBe(false);
  });
});
