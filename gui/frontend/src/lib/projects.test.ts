import { describe, expect, it } from "vitest";
import {
  actionsDetail,
  changesCell,
  checkoutsSummary,
  checkoutThreads,
  filterProjects,
  indexCaption,
  isCleanable,
  projectActivity,
  projectKind,
  projectNextStep,
  projectsModel,
  projectRef,
  projectStatusSentence,
  refreshedText,
  remoteDetail,
  sortByActivity,
  sortCheckouts,
  syncCell,
  threadActivityMs,
  threadsCell,
  workspaceActivity,
  workspaceContents,
  workspaceStatusSentence,
  workspaceWorkingBranches,
  worktreesDetail,
  type ActivityThread,
  type ActivityThreads,
  type CheckoutSortRow,
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
});

const NOW = 1_800_000_000_000;
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

describe("threadActivityMs", () => {
  it.each<[string, Partial<ActivityThread>, number | null]>([
    ["nothing known", {}, null],
    ["the creation alone", { createdAtMs: 5 }, 5],
    ["the latest of status change, activity and creation", { createdAtMs: 5, statusChangedAtMs: 9, lastActivityAtMs: 7 }, 9],
  ])("%s", (_name, o, want) => {
    expect(threadActivityMs(thread(o))).toBe(want);
  });
});

describe("projectActivity and workspaceActivity", () => {
  const ts = slice({
    a: thread({ projectId: "cf", projectIds: ["cf"], ...working, statusChangedAtMs: NOW - 60_000 }),
    b: thread({ projectId: "gp", projectIds: ["cf", "gp"], workspaceId: "w-1", ...working, branch: "cf/platform", createdAtMs: NOW - 10_000 }),
    c: thread({ projectId: "cf", projectIds: ["cf"], ...working, archivedAtMs: NOW, statusChangedAtMs: NOW }),
    d: thread({ projectId: "cf", projectIds: ["cf"], state: "starting", status: "idle", createdAtMs: NOW - 120_000 }),
    e: thread({ projectId: "dot", projectIds: ["dot"], status: "attention", state: "connected", lastActivityAtMs: NOW - 5 }),
  });
  it("counts the working threads whose set has the project; archived ones only for the age", () => {
    expect(projectActivity(ts, "cf")).toEqual({ working: 3, lastMs: NOW });
    expect(projectActivity(ts, "gp")).toEqual({ working: 1, lastMs: NOW - 10_000 });
    expect(projectActivity(ts, "dot")).toEqual({ working: 0, lastMs: NOW - 5 });
    expect(projectActivity(ts, "none")).toEqual({ working: 0, lastMs: null });
  });
  it("a workspace's threads are the ones referencing it; working branches distinct", () => {
    expect(workspaceActivity(ts, "w-1")).toEqual({ working: 1, lastMs: NOW - 10_000 });
    expect(workspaceWorkingBranches(ts, "w-1")).toEqual(["cf/platform"]);
  });
});

describe("sortByActivity (the index's order)", () => {
  const last: Record<string, number | null> = { cf: NOW, gp: NOW - 1000, dot: NOW - 1000, sk: null, wr: null, Ab: null };
  const names: Record<string, string> = { cf: "code-foundry", gp: "ghostty", dot: "dotfiles", sk: "sketches", wr: "writing", Ab: "alpha" };
  it("most recent first; ties and projects with no threads by name", () => {
    expect(sortByActivity(["wr", "sk", "dot", "Ab", "gp", "cf"], (id) => last[id] ?? null, (id) => names[id] ?? id)).toEqual(["cf", "dot", "gp", "Ab", "sk", "wr"]);
  });
});

describe("status sentences", () => {
  it.each<[string, { working: number; checkouts: number; git: boolean }, string]>([
    ["working with worktrees", { working: 4, checkouts: 6, git: true }, "4 threads working · 6 checkouts"],
    ["one thread on main only", { working: 1, checkouts: 1, git: true }, "1 thread working · main only"],
    ["idle with main only", { working: 0, checkouts: 1, git: true }, "idle · main only"],
    ["idle with two checkouts", { working: 0, checkouts: 2, git: true }, "idle · 2 checkouts"],
    ["no git: no checkouts to count", { working: 0, checkouts: 1, git: false }, "idle"],
    ["no git, working", { working: 2, checkouts: 1, git: false }, "2 threads working"],
  ])("project: %s", (_name, a, want) => {
    expect(projectStatusSentence(a)).toBe(want);
  });
  it.each<[string, number, string[], string]>([
    ["idle", 0, [], "idle"],
    ["one branch", 1, ["cf/platform"], "1 thread working on cf/platform"],
    ["two threads on one branch", 2, ["cf/platform"], "2 threads working on cf/platform"],
    ["several branches", 2, ["a", "b"], "2 threads working"],
  ])("workspace: %s", (_name, n, branches, want) => {
    expect(workspaceStatusSentence(n, branches)).toBe(want);
  });
  it("workspace contents", () => {
    expect(workspaceContents({ skills: ["a", "b"] })).toBe("no instructions · 2 skills");
    expect(workspaceContents({ instructions: "/x/w-1/CLAUDE.md", skills: [] })).toBe("CLAUDE.md · no skills");
    expect(workspaceContents({ instructions: "AGENTS.md", skills: ["a"] })).toBe("AGENTS.md · 1 skill");
  });
});

describe("indexCaption", () => {
  it.each<[string, { git?: boolean; githubSlug: string; remotes: string[]; path: string }, string]>([
    ["GitHub: the slug", { githubSlug: "o/r", remotes: ["origin"], path: "/x" }, "o/r"],
    ["another remote", { githubSlug: "", remotes: ["origin"], path: "/x" }, "origin · not GitHub"],
    ["no remote", { git: true, githubSlug: "", remotes: [], path: "/x" }, "local only"],
    ["no git: the path", { git: false, githubSlug: "", remotes: [], path: "/tmp/writing" }, "/tmp/writing · no git"],
  ])("%s", (_name, r, want) => {
    expect(indexCaption(r)).toBe(want);
  });
});

describe("checkout cells", () => {
  it.each<[number, number, string]>([
    [0, 0, "none"],
    [2, 0, "2 working"],
    [0, 2, "2 idle"],
    [1, 1, "1 working · 1 idle"],
  ])("threads %i working %i idle", (w, i, want) => {
    expect(threadsCell(w, i)).toBe(want);
  });
  it.each<[string, { staged: number; modified: number; untracked: number; conflicted?: number; dirty: boolean }, string]>([
    ["clean", { staged: 0, modified: 0, untracked: 0, dirty: false }, "clean"],
    ["one file", { staged: 0, modified: 1, untracked: 0, dirty: true }, "1 file"],
    ["every kind counts", { staged: 1, modified: 2, untracked: 1, conflicted: 1, dirty: true }, "5 files"],
    ["dirty without counts", { staged: 0, modified: 0, untracked: 0, dirty: true }, "changed"],
  ])("changes: %s", (_name, st, want) => {
    expect(changesCell(st)).toBe(want);
  });
  it.each<[string, { upstream: string; ahead: number; behind: number }, string]>([
    ["up to date", { upstream: "origin/x", ahead: 0, behind: 0 }, "up to date"],
    ["to push", { upstream: "origin/x", ahead: 2, behind: 0 }, "2 to push"],
    ["behind", { upstream: "origin/x", ahead: 0, behind: 1 }, "1 behind"],
    ["both", { upstream: "origin/x", ahead: 2, behind: 1 }, "2 to push · 1 behind"],
    ["no upstream", { upstream: "", ahead: 0, behind: 0 }, "not pushed"],
  ])("sync: %s", (_name, st, want) => {
    expect(syncCell(st)).toBe(want);
  });
  it("checkoutThreads: own cwd or a set member's checkout, archived left out, the first workspace", () => {
    const ts = slice({
      a: thread({ worktreePath: "/wt/a", ...working, lastActivityAtMs: 3 }),
      b: thread({ worktreePath: "/src/gp", checkoutPaths: [{ projectId: "cf", path: "/wt/a" }], workspaceId: "w-1", lastActivityAtMs: 9 }),
      c: thread({ worktreePath: "/wt/a", archivedAtMs: 1, lastActivityAtMs: 99 }),
    });
    expect(checkoutThreads(ts, "/wt/a")).toEqual({ working: 1, idle: 1, lastMs: 9, workspaceId: "w-1" });
    expect(checkoutThreads(ts, "/wt/none")).toEqual({ working: 0, idle: 0, lastMs: null, workspaceId: "" });
  });
});

describe("sortCheckouts", () => {
  const row = (path: string, o: Partial<CheckoutSortRow> = {}): CheckoutSortRow => ({ path, isMain: false, branch: path, working: 0, lastMs: null, ...o });
  it("working first (most recent first), then main, then the rest by activity, none last, then branch", () => {
    const rows = [
      row("chore/deps"),
      row("fix/resize", { lastMs: 5 }),
      row("main", { isMain: true, lastMs: 1 }),
      row("cf/platform", { working: 1, lastMs: 2 }),
      row("feat/sidebar", { working: 2, lastMs: 8 }),
      row("a-later", { lastMs: 7 }),
      row("b-none"),
    ];
    expect(sortCheckouts(rows).map((r) => r.path)).toEqual(["feat/sidebar", "cf/platform", "main", "a-later", "fix/resize", "b-none", "chore/deps"]);
  });
  it("a working main sorts with the working ones", () => {
    expect(sortCheckouts([row("x", { working: 1, lastMs: 9 }), row("main", { isMain: true, working: 1, lastMs: 1 })]).map((r) => r.path)).toEqual(["x", "main"]);
  });
});

describe("details and summaries", () => {
  it("checkoutsSummary", () => {
    expect(checkoutsSummary(6, 2)).toBe("main plus 5 worktrees · 2 threads working");
    expect(checkoutsSummary(2, 0)).toBe("main plus 1 worktree");
    expect(checkoutsSummary(1, 1)).toBe("main only · 1 thread working");
    expect(checkoutsSummary(1, 0)).toBe("main only");
  });
  it.each<[string, number | null, number, boolean, string]>([
    ["just now", NOW - 5_000, NOW, false, "refreshed just now"],
    ["minutes", NOW - 14 * 60_000, NOW, false, "refreshed 14m ago"],
    ["hours", NOW - 3 * 3_600_000, NOW, false, "refreshed 3h ago"],
    ["days", NOW - 3 * 86_400_000, NOW, false, "refreshed 3d ago"],
    ["never", null, NOW, false, "not refreshed yet"],
    ["failed", NOW - 14 * 60_000, NOW, true, "refresh failed 14m ago"],
  ])("refreshedText: %s", (_name, at, now, failed, want) => {
    expect(refreshedText(at, now, failed)).toBe(want);
  });
  it("remoteDetail", () => {
    expect(remoteDetail({ githubSlug: "o/r", remotes: ["origin"] })).toBe("origin · github.com/o/r");
    expect(remoteDetail({ githubSlug: "", remotes: ["origin"] })).toBe("origin · pull requests need GitHub");
    expect(remoteDetail({ githubSlug: "", remotes: [] })).toBe("");
  });
  it("worktreesDetail: the folder they share and the count", () => {
    expect(worktreesDetail(["/tmp/x.worktrees/a", "/tmp/x.worktrees/b"])).toBe("/tmp/x.worktrees · 2");
    expect(worktreesDetail(["/tmp/wt/cf/a", "/tmp/wt/gp/b"])).toBe("/tmp/wt · 2");
    expect(worktreesDetail(["/a/x", "/b/y"])).toBe("2");
    expect(worktreesDetail([])).toBe("");
  });
  it("actionsDetail", () => {
    expect(actionsDetail(0)).toBe("none");
    expect(actionsDetail(1)).toBe("1 project action");
    expect(actionsDetail(2)).toBe("2 project actions");
  });
});
