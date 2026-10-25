import { describe, expect, it } from "vitest";
import {
  cleanableTitle,
  collapsedProjectSummary,
  filterProjects,
  isCleanable,
  memberKey,
  pageItems,
  projectKey,
  projectKind,
  projectNextStep,
  projectsModel,
  projectWorktreeKey,
  projectRef,
  workspaceKey,
  worktreeThreadCount,
  type ProjectKind,
  type ProjectNextStep,
  type ProjectsModel,
  type ProjectsSlice,
  type ProjectsSearch,
  type ProjectsWorkspaces,
} from "./projects";

const projects: ProjectsSlice = {
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
        { projectId: "api", worktreePath: "" },
        { projectId: "web", worktreePath: "" },
      ],
    },
  },
};

describe("projectsModel", () => {
  it("lists every worktree under its project (a workspace has none of its own)", () => {
    expect(projectsModel(projects, workspaces)).toEqual({
      projects: [
        { projectId: "api", worktrees: ["/src/api", "/wt/api/cf-login"] },
        { projectId: "dot", worktrees: ["/src/dot"] },
        { projectId: "web", worktrees: ["/src/web", "/wt/web/feat", "/wt/web/cf-login"] },
      ],
      workspaces: ["w-1"],
    });
  });
  it("a workspace the slice does not know is left out", () => {
    expect(projectsModel(projects, { order: ["w-1", "w-gone"], byId: workspaces.byId }).workspaces).toEqual(["w-1"]);
  });
  it("pageItems: projects and their worktrees, then workspace cards and their members by id", () => {
    const keys = pageItems(projectsModel(projects, workspaces), workspaces).map((i) => i.key);
    expect(keys).toEqual([
      projectKey("api"),
      projectWorktreeKey("api", "/src/api"),
      projectWorktreeKey("api", "/wt/api/cf-login"),
      projectKey("dot"),
      projectWorktreeKey("dot", "/src/dot"),
      projectKey("web"),
      projectWorktreeKey("web", "/src/web"),
      projectWorktreeKey("web", "/wt/web/feat"),
      projectWorktreeKey("web", "/wt/web/cf-login"),
      workspaceKey("w-1"),
      memberKey("w-1", "api"),
      memberKey("w-1", "web"),
    ]);
  });
  it("pageItems: members by project name, as the card shows them (case-insensitive), the stored order by id", () => {
    const names: Record<string, string> = { api: "zeta", web: "Alpha" };
    const keys = pageItems(projectsModel(projects, workspaces), workspaces, undefined, (id) => names[id]).filter((i) => i.kind === "member").map((i) => i.key);
    expect(keys).toEqual([memberKey("w-1", "web"), memberKey("w-1", "api")]);
  });
  it("pageItems: a collapsed project or workspace keeps its header row only", () => {
    const keys = pageItems(projectsModel(projects, workspaces), workspaces, { projects: new Set(["web", "api"]), workspaces: new Set(["w-1"]) }).map((i) => i.key);
    expect(keys).toEqual([projectKey("api"), projectKey("dot"), projectWorktreeKey("dot", "/src/dot"), projectKey("web"), workspaceKey("w-1")]);
  });
});

describe("collapsed summaries", () => {
  it.each<[string, { worktrees: string[] }, string]>([
    ["one worktree", { worktrees: ["/a"] }, "1 worktree"],
    ["several", { worktrees: ["/a", "/b", "/c"] }, "3 worktrees"],
  ])("project: %s", (_name, p, want) => {
    expect(collapsedProjectSummary(p)).toBe(want);
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
  ])("%s", (_name, project, kind, meta) => {
    const info = projectKind(project);
    expect(info.kind).toBe(kind);
    expect(info.meta).toBe(meta);
    expect(info.title).toMatch(/\.$/);
  });
});

describe("filterProjects", () => {
  const model: ProjectsModel = {
    projects: [
      { projectId: "cf", worktrees: ["/Users/dev/src/code-foundry", "/Users/dev/wt/cf/feat-sidebar", "/Users/dev/wt/cf/fix-resize"] },
      { projectId: "dot", worktrees: ["/Users/dev/dotfiles"] },
      { projectId: "wr", worktrees: ["/Users/dev/Documents/writing"] },
    ],
    workspaces: ["w-login", "w-pay"],
  };
  const search: ProjectsSearch = {
    projects: {
      cf: {
        name: "code-foundry",
        githubSlug: "alexwaumann/code-foundry",
        branches: { "/Users/dev/src/code-foundry": "main", "/Users/dev/wt/cf/feat-sidebar": "feat/sidebar", "/Users/dev/wt/cf/fix-resize": "fix/resize" },
      },
      dot: { name: "dotfiles", githubSlug: "", branches: { "/Users/dev/dotfiles": "main" } },
      wr: { name: "writing", githubSlug: "", branches: { "/Users/dev/Documents/writing": "" } },
    },
    workspaces: { "w-login": { name: "login", members: ["dot"] }, "w-pay": { name: "payments-split", members: ["cf", "gone"] } },
  };
  const shape = (m: ProjectsModel) => ({ projects: Object.fromEntries(m.projects.map((p) => [p.projectId, p.worktrees.length])), workspaces: m.workspaces });
  it.each<[string, string, { projects: Record<string, number>; workspaces: string[] }]>([
    ["empty keeps everything", "", { projects: { cf: 3, dot: 1, wr: 1 }, workspaces: ["w-login", "w-pay"] }],
    ["blank keeps everything", "  ", { projects: { cf: 3, dot: 1, wr: 1 }, workspaces: ["w-login", "w-pay"] }],
    ["a project name shows all its rows, and the workspaces it is in", "Foundry", { projects: { cf: 3 }, workspaces: ["w-pay"] }],
    ["a member's name shows its workspace", "dotfiles", { projects: { dot: 1 }, workspaces: ["w-login"] }],
    ["a GitHub slug shows all its rows (a member matches by name only)", "alexwaumann/", { projects: { cf: 3 }, workspaces: [] }],
    ["a branch shows only its rows", "SIDEBAR", { projects: { cf: 1 }, workspaces: [] }],
    ["a branch in several projects", "main", { projects: { cf: 1, dot: 1 }, workspaces: [] }],
    ["a tildified path", "~/documents", { projects: { wr: 1 }, workspaces: [] }],
    ["the home prefix itself does not match", "/users/dev", { projects: {}, workspaces: [] }],
    ["a workspace name", "payments", { projects: {}, workspaces: ["w-pay"] }],
    ["a workspace has no branch to match", "cf/login", { projects: {}, workspaces: [] }],
    ["the cf/ prefix: the paths under ~/wt/cf", "cf/", { projects: { cf: 2 }, workspaces: [] }],
    ["nothing", "zzz", { projects: {}, workspaces: [] }],
  ])("%s", (_name, q, want) => {
    expect(shape(filterProjects(model, q, search))).toEqual(want);
  });
  it("a project matched by a row keeps only that row; by name all of them", () => {
    expect(filterProjects(model, "fix/", search).projects[0]).toEqual({ projectId: "cf", worktrees: ["/Users/dev/wt/cf/fix-resize"] });
    expect(filterProjects(model, "code", search).projects[0]?.worktrees).toHaveLength(3);
  });
});

describe("projectRef", () => {
  it("the name when unique, else the id", () => {
    expect(projectRef(projects, "api")).toBe("api");
    // "dot" is named web too: the name is ambiguous, so its id.
    expect(projectRef(projects, "dot")).toBe("dot");
    // Once the other is renamed, the name is unique again.
    expect(projectRef({ ...projects, byId: { ...projects.byId, web: { id: "web", name: "site", worktrees: [] } } }, "dot")).toBe("web");
    expect(projectRef(projects, "nope")).toBe("nope");
  });
});

describe("projectNextStep (the header's Publish / Initialize git gate)", () => {
  const wt = [{ projectId: "r", path: "/p", branch: "main", head: "", detached: false, isMain: true, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null } }];
  it.each<[string, { git: boolean; remotes: string[]; worktrees: typeof wt }, ProjectNextStep]>([
    ["git, no remote: publish", { git: true, remotes: [], worktrees: wt }, "publish"],
    ["git, not reconciled yet (no worktrees): nothing", { git: true, remotes: [], worktrees: [] }, null],
    ["GitHub remote: nothing", { git: true, remotes: ["origin"], worktrees: wt }, null],
    ["a remote elsewhere: nothing", { git: true, remotes: ["upstream"], worktrees: wt }, null],
    ["no git: initialize", { git: false, remotes: [], worktrees: wt }, "init"],
  ])("%s", (_name, project, want) => {
    expect(projectNextStep(project)).toBe(want);
  });
});

describe("worktreeThreadCount", () => {
  // Every thread on exactly the worktree, whether or not Claude runs for it; archived ones are put away.
  const threads = {
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
    expect(worktreeThreadCount(threads, path)).toBe(want);
  });
});

describe("isCleanable", () => {
  const WT = "/wt/cf-a";
  const none = { order: [], byId: {} };
  type Threads = Parameters<typeof isCleanable>[1];
  type Terminals = Parameters<typeof isCleanable>[2];
  const thread = (worktreePath: string, archivedAtMs: number | null = null): Threads => ({ order: ["s"], byId: { s: { archivedAtMs, worktreePath } } });
  const term = (state: "running" | "exited", cwd: string, worktree?: string): Terminals => ({
    order: ["t"],
    byId: { t: { state, cwd, labels: worktree ? { kind: "shell", worktree } : {} } },
  });
  const merged = { path: WT, mergedClean: true };
  const cases: { name: string; wt: Parameters<typeof isCleanable>[0]; threads?: Threads; terminals?: Terminals; want: boolean }[] = [
    { name: "merged, nothing holds it", wt: merged, want: true },
    { name: "not merged clean", wt: { path: WT, mergedClean: false }, want: false },
    { name: "an older daemon (no flag)", wt: { path: WT }, want: false },
    { name: "unknown worktree", wt: undefined, want: false },
    { name: "a thread on it", wt: merged, threads: thread(WT), want: false },
    { name: "a thread in a subdirectory", wt: merged, threads: thread(`${WT}/sub`), want: false },
    { name: "a thread on it holds whatever its state (stopped, snoozed); an archived one does not", wt: merged, threads: thread(WT, 5), want: true },
    { name: "a thread in a sibling with a common prefix", wt: merged, threads: thread(`${WT}-b`), want: true },
    { name: "a running shell it owns", wt: merged, terminals: term("running", "/elsewhere", WT), want: false },
    { name: "a running terminal inside it", wt: merged, terminals: term("running", `${WT}/src`), want: false },
    { name: "an exited shell does not hold", wt: merged, terminals: term("exited", WT, WT), want: true },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(isCleanable(c.wt, c.threads ?? none, c.terminals ?? none)).toBe(c.want);
    });
  }
  it("names the base in its tooltip", () => {
    expect(cleanableTitle("origin/main")).toBe("Clean: no changes, its work is in origin/main, no thread or terminal on it");
    expect(cleanableTitle("")).toContain("origin/<default>");
  });
});
