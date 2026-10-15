import { describe, expect, it } from "vitest";
import {
  addableRepos,
  cleanableTitle,
  collapsedProjectSummary,
  collapsedWorkspaceSummary,
  filterProjects,
  isCleanable,
  memberKey,
  pageItems,
  projectKey,
  projectKind,
  projectNextStep,
  projectsModel,
  projectWorktreeKey,
  repoRef,
  threadAt,
  workspaceKey,
  worktreeThreadCount,
  type ProjectKind,
  type ProjectNextStep,
  type ProjectsModel,
  type ProjectsRepos,
  type ProjectsSearch,
  type ProjectsWorkspaces,
} from "./projects";

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
  it("pageItems: a collapsed project or workspace keeps its header row only", () => {
    const keys = pageItems(projectsModel(repos, workspaces), workspaces, { projects: new Set(["web", "api"]), workspaces: new Set(["w-1"]) }).map((i) => i.key);
    expect(keys).toEqual([projectKey("api"), projectKey("dot"), projectWorktreeKey("dot", "/src/dot"), projectKey("web"), workspaceKey("w-1")]);
  });
});

describe("collapsed summaries", () => {
  it.each<[string, { worktrees: string[]; inWorkspaces: number }, string]>([
    ["one worktree", { worktrees: ["/a"], inWorkspaces: 0 }, "1 worktree"],
    ["several", { worktrees: ["/a", "/b", "/c"], inWorkspaces: 0 }, "3 worktrees"],
    ["one in a workspace counts in the total", { worktrees: ["/a", "/b"], inWorkspaces: 1 }, "3 worktrees · 1 in a workspace"],
    ["several in workspaces", { worktrees: ["/a"], inWorkspaces: 2 }, "3 worktrees · 2 in workspaces"],
    ["all in a workspace", { worktrees: [], inWorkspaces: 1 }, "1 worktree · 1 in a workspace"],
  ])("project: %s", (_name, p, want) => {
    expect(collapsedProjectSummary(p)).toBe(want);
  });
  it.each<[number, string]>([
    [0, "0 members"],
    [1, "1 member"],
    [3, "3 members"],
  ])("workspace with %d members", (n, want) => {
    expect(collapsedWorkspaceSummary(n)).toBe(want);
  });
});

describe("projectKind", () => {
  it.each<[string, { git?: boolean; githubSlug: string; remotes: string[] }, ProjectKind, string]>([
    ["a GitHub repository shows its slug", { git: true, githubSlug: "alexwaumann/code-foundry", remotes: ["origin"] }, "github", "alexwaumann/code-foundry"],
    ["git absent counts as git", { githubSlug: "acme/infra", remotes: ["origin"] }, "github", "acme/infra"],
    ["no remote: local only", { git: true, githubSlug: "", remotes: [] }, "git", "local only · no remote"],
    ["a remote that is not GitHub names it", { git: true, githubSlug: "", remotes: ["origin"] }, "git", "origin · not GitHub"],
    ["the first remote, sorted by the daemon", { git: true, githubSlug: "", remotes: ["gitlab", "origin"] }, "git", "gitlab · not GitHub"],
    ["no git: the badge says it", { git: false, githubSlug: "", remotes: [] }, "nogit", ""],
  ])("%s", (_name, repo, kind, meta) => {
    const info = projectKind(repo);
    expect(info.kind).toBe(kind);
    expect(info.meta).toBe(meta);
    expect(info.title).toMatch(/\.$/);
  });
});

describe("filterProjects", () => {
  const model: ProjectsModel = {
    projects: [
      { repoId: "cf", worktrees: ["/Users/dev/src/code-foundry", "/Users/dev/wt/cf/feat-sidebar", "/Users/dev/wt/cf/fix-resize"], inWorkspaces: 1 },
      { repoId: "dot", worktrees: ["/Users/dev/dotfiles"], inWorkspaces: 0 },
      { repoId: "wr", worktrees: ["/Users/dev/Documents/writing"], inWorkspaces: 0 },
    ],
    workspaces: ["w-login", "w-pay"],
  };
  const search: ProjectsSearch = {
    repos: {
      cf: {
        name: "code-foundry",
        githubSlug: "alexwaumann/code-foundry",
        branches: { "/Users/dev/src/code-foundry": "main", "/Users/dev/wt/cf/feat-sidebar": "feat/sidebar", "/Users/dev/wt/cf/fix-resize": "fix/resize" },
      },
      dot: { name: "dotfiles", githubSlug: "", branches: { "/Users/dev/dotfiles": "main" } },
      wr: { name: "writing", githubSlug: "", branches: { "/Users/dev/Documents/writing": "" } },
    },
    workspaces: { "w-login": { name: "login", branch: "cf/login" }, "w-pay": { name: "payments-split", branch: "cf/payments-split" } },
  };
  const shape = (m: ProjectsModel) => ({ projects: Object.fromEntries(m.projects.map((p) => [p.repoId, p.worktrees.length])), workspaces: m.workspaces });
  it.each<[string, string, { projects: Record<string, number>; workspaces: string[] }]>([
    ["empty keeps everything", "", { projects: { cf: 3, dot: 1, wr: 1 }, workspaces: ["w-login", "w-pay"] }],
    ["blank keeps everything", "  ", { projects: { cf: 3, dot: 1, wr: 1 }, workspaces: ["w-login", "w-pay"] }],
    ["a project name shows all its rows", "Foundry", { projects: { cf: 3 }, workspaces: [] }],
    ["a GitHub slug shows all its rows", "alexwaumann/", { projects: { cf: 3 }, workspaces: [] }],
    ["a branch shows only its rows", "SIDEBAR", { projects: { cf: 1 }, workspaces: [] }],
    ["a branch in several projects", "main", { projects: { cf: 1, dot: 1 }, workspaces: [] }],
    ["a tildified path", "~/documents", { projects: { wr: 1 }, workspaces: [] }],
    ["the home prefix itself does not match", "/users/dev", { projects: {}, workspaces: [] }],
    ["a workspace name", "payments", { projects: {}, workspaces: ["w-pay"] }],
    ["a workspace branch", "cf/login", { projects: {}, workspaces: ["w-login"] }],
    ["the cf/ prefix: both workspaces and the paths under ~/wt/cf", "cf/", { projects: { cf: 2 }, workspaces: ["w-login", "w-pay"] }],
    ["nothing", "zzz", { projects: {}, workspaces: [] }],
  ])("%s", (_name, q, want) => {
    expect(shape(filterProjects(model, q, search))).toEqual(want);
  });
  it("a project matched by a row drops the in-workspaces note; by name it keeps it", () => {
    expect(filterProjects(model, "fix/", search).projects[0]).toEqual({ repoId: "cf", worktrees: ["/Users/dev/wt/cf/fix-resize"], inWorkspaces: 0 });
    expect(filterProjects(model, "code", search).projects[0]?.inWorkspaces).toBe(1);
  });
});

describe("addableRepos and repoRef", () => {
  it("addable: registered projects that are not members, in name order", () => {
    expect(addableRepos(workspaces.byId["w-1"], repos)).toEqual(["dot"]);
    expect(addableRepos(undefined, repos)).toEqual(["api", "dot", "web"]);
  });
  it("addable: never a project without git", () => {
    const withNotes: ProjectsRepos = {
      order: [...repos.order, "notes"],
      byId: { ...repos.byId, dot: { id: "dot", name: "web", git: true, worktrees: [] }, notes: { id: "notes", name: "notes", git: false, worktrees: [{ path: "/src/notes", isMain: true }] } },
    };
    expect(addableRepos(undefined, withNotes)).toEqual(["api", "dot", "web"]);
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

describe("projectNextStep (the header's Publish / Initialize git gate)", () => {
  const wt = [{ repoId: "r", path: "/p", branch: "main", head: "", detached: false, isMain: true, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null } }];
  it.each<[string, { git: boolean; remotes: string[]; worktrees: typeof wt }, ProjectNextStep]>([
    ["git, no remote: publish", { git: true, remotes: [], worktrees: wt }, "publish"],
    ["git, not reconciled yet (no worktrees): nothing", { git: true, remotes: [], worktrees: [] }, null],
    ["GitHub remote: nothing", { git: true, remotes: ["origin"], worktrees: wt }, null],
    ["a remote elsewhere: nothing", { git: true, remotes: ["upstream"], worktrees: wt }, null],
    ["no git: initialize", { git: false, remotes: [], worktrees: wt }, "init"],
  ])("%s", (_name, repo, want) => {
    expect(projectNextStep(repo)).toBe(want);
  });
});

describe("worktreeThreadCount", () => {
  // Every thread on exactly the worktree, whether or not Claude runs for it; archived ones are put away.
  const sessions = {
    order: ["a", "b", "c", "d", "e", "f", "g"],
    byId: {
      a: { worktreePath: "/src/web", archivedAtMs: null },
      b: { worktreePath: "/src/web", archivedAtMs: null },
      c: { worktreePath: "/src/web", archivedAtMs: null },
      d: { worktreePath: "/wt/web/feat", archivedAtMs: null },
      e: { worktreePath: "/src/web/sub", archivedAtMs: null },
      f: { worktreePath: "/wt/web/feat", archivedAtMs: 5 },
      g: { worktreePath: "/src/web", archivedAtMs: 9 },
    },
  };
  it.each<[string, number]>([
    ["/src/web", 3],
    ["/wt/web/feat", 1],
    ["/src/web/sub", 1],
    ["/src/api", 0],
    ["", 0],
  ])("%s: %i", (path, want) => {
    expect(worktreeThreadCount(sessions, path)).toBe(want);
  });
});

describe("isCleanable", () => {
  const WT = "/wt/cf-a";
  const none = { order: [], byId: {} };
  type Sessions = Parameters<typeof isCleanable>[1];
  type Terminals = Parameters<typeof isCleanable>[2];
  const thread = (state: "connected" | "starting" | "closing" | "disconnected", worktreePath: string): Sessions => ({ order: ["s"], byId: { s: { state, worktreePath } } });
  const term = (state: "running" | "exited", cwd: string, worktree?: string): Terminals => ({
    order: ["t"],
    byId: { t: { state, cwd, labels: worktree ? { kind: "shell", worktree } : {} } },
  });
  const member = (path: string): ProjectsWorkspaces => ({ order: ["w"], byId: { w: { id: "w", members: [{ repoId: "r", worktreePath: path }] } } });
  const merged = { path: WT, mergedClean: true };
  const cases: { name: string; wt: Parameters<typeof isCleanable>[0]; sessions?: Sessions; terminals?: Terminals; workspaces?: ProjectsWorkspaces; want: boolean }[] = [
    { name: "merged, nothing holds it", wt: merged, want: true },
    { name: "not merged clean", wt: { path: WT, mergedClean: false }, want: false },
    { name: "an older daemon (no flag)", wt: { path: WT }, want: false },
    { name: "unknown worktree", wt: undefined, want: false },
    { name: "a running thread in it", wt: merged, sessions: thread("connected", WT), want: false },
    { name: "a starting thread in a subdirectory", wt: merged, sessions: thread("starting", `${WT}/sub`), want: false },
    { name: "a stopped thread does not hold (the daemon's guard counts processes)", wt: merged, sessions: thread("disconnected", WT), want: true },
    { name: "a thread in a sibling with a common prefix", wt: merged, sessions: thread("connected", `${WT}-b`), want: true },
    { name: "a running shell it owns", wt: merged, terminals: term("running", "/elsewhere", WT), want: false },
    { name: "a running terminal inside it", wt: merged, terminals: term("running", `${WT}/src`), want: false },
    { name: "an exited shell does not hold", wt: merged, terminals: term("exited", WT, WT), want: true },
    { name: "a workspace member", wt: merged, workspaces: member(WT), want: false },
    { name: "another workspace's member", wt: merged, workspaces: member("/wt/other"), want: true },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(isCleanable(c.wt, c.sessions ?? none, c.terminals ?? none, c.workspaces ?? none)).toBe(c.want);
    });
  }
  it("names the base in its tooltip", () => {
    expect(cleanableTitle("origin/main")).toBe("Clean: no changes, every commit is in origin/main, nothing running in it");
    expect(cleanableTitle("")).toContain("origin/<default>");
  });
});
