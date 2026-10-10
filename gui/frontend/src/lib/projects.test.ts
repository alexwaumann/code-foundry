import { describe, expect, it } from "vitest";
import { addableRepos, memberKey, pageItems, projectKey, projectsModel, projectWorktreeKey, repoRef, threadAt, workspaceKey, type ProjectsRepos, type ProjectsWorkspaces } from "./projects";

const repos: ProjectsRepos = {
  order: ["api", "dot", "web"],
  byId: {
    web: {
      id: "web",
      name: "web",
      worktrees: [
        { path: "/src/web", isMain: true },
        { path: "/wt/web/feat", isMain: false },
        { path: "/wt/web/cf-login", isMain: false },
      ],
    },
    api: { id: "api", name: "api", worktrees: [{ path: "/src/api", isMain: true }, { path: "/wt/api/cf-login", isMain: false }] },
    dot: { id: "dot", name: "web", worktrees: [{ path: "/src/dot", isMain: true }] },
  },
};
const workspaces: ProjectsWorkspaces = {
  order: ["w-1"],
  byId: {
    "w-1": {
      id: "w-1",
      members: [
        { repoId: "web", worktreePath: "/wt/web/cf-login" },
        { repoId: "api", worktreePath: "/wt/api/cf-login" },
      ],
    },
  },
};

describe("projectsModel", () => {
  it("lists each project's own worktrees; workspace members only under their workspace", () => {
    expect(projectsModel(repos, workspaces)).toEqual({
      projects: [
        { repoId: "api", worktrees: ["/src/api"], inWorkspaces: 1 },
        { repoId: "dot", worktrees: ["/src/dot"], inWorkspaces: 0 },
        { repoId: "web", worktrees: ["/src/web", "/wt/web/feat"], inWorkspaces: 1 },
      ],
      workspaces: ["w-1"],
    });
  });
  it("with no workspaces every worktree is the project's", () => {
    const m = projectsModel(repos, { order: [], byId: {} });
    expect(m.projects.find((p) => p.repoId === "web")?.worktrees).toEqual(["/src/web", "/wt/web/feat", "/wt/web/cf-login"]);
    expect(m.workspaces).toEqual([]);
  });
  it("pageItems: projects and their worktrees, then workspaces and their members", () => {
    const keys = pageItems(projectsModel(repos, workspaces), workspaces).map((i) => i.key);
    expect(keys).toEqual([
      projectKey("api"),
      projectWorktreeKey("api", "/src/api"),
      projectKey("dot"),
      projectWorktreeKey("dot", "/src/dot"),
      projectKey("web"),
      projectWorktreeKey("web", "/src/web"),
      projectWorktreeKey("web", "/wt/web/feat"),
      workspaceKey("w-1"),
      memberKey("w-1", "web"),
      memberKey("w-1", "api"),
    ]);
  });
});

describe("addableRepos and repoRef", () => {
  it("addable: registered projects that are not members, in name order", () => {
    expect(addableRepos(workspaces.byId["w-1"], repos)).toEqual(["dot"]);
    expect(addableRepos(undefined, repos)).toEqual(["api", "dot", "web"]);
  });
  it("repoRef: the name when unique, else the id", () => {
    expect(repoRef(repos, "api")).toBe("api");
    // "dot" is named web too: the name is ambiguous, so its id.
    expect(repoRef(repos, "dot")).toBe("dot");
    // Once the other is renamed, the name is unique again.
    expect(repoRef({ ...repos, byId: { ...repos.byId, web: { id: "web", name: "site", worktrees: [] } } }, "dot")).toBe("web");
    expect(repoRef(repos, "nope")).toBe("nope");
  });
});

describe("threadAt (the workspace surface's member markers)", () => {
  const API = "/wt/api/cf-demo";
  const WEB = "/wt/web/cf-demo";
  it.each<[string, { worktreePath: string; pendingWorktreePath: string } | undefined, string, "current" | "queued" | null]>([
    ["the thread's cwd is the member", { worktreePath: API, pendingWorktreePath: "" }, API, "current"],
    ["a cwd inside the member counts", { worktreePath: `${API}/internal`, pendingWorktreePath: "" }, API, "current"],
    ["a sibling path with the same prefix does not", { worktreePath: `${API}-old`, pendingWorktreePath: "" }, API, null],
    ["another member", { worktreePath: WEB, pendingWorktreePath: "" }, API, null],
    ["a queued Run in marks its target", { worktreePath: WEB, pendingWorktreePath: API }, API, "queued"],
    ["the source of a queued move is still current", { worktreePath: WEB, pendingWorktreePath: API }, WEB, "current"],
    ["no thread (the Projects page)", undefined, API, null],
  ])("%s", (_name, thread, member, want) => {
    expect(threadAt(thread, member)).toBe(want);
  });
});
