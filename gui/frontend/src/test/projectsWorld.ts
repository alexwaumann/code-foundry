/**
 * The mock daemon's Projects world as view models, seeded straight into the stores for
 * component tests: code-foundry (repo-cf) and ghostty-playground (repo-gp) on GitHub,
 * dotfiles (repo-dot, a remote that is not GitHub), sketches (repo-sk, git without a remote)
 * and writing (repo-wr, no git), with the threads that work in them. Pair with
 * src/test/daemonFakes.ts for the commands and GitHub reads.
 */
import { act } from "@testing-library/react";
import type { BranchPullRequestsView, CheckRollupView, PullRequestView } from "@/api/gh";
import type { GitStatusView, ProjectView, WorktreeView } from "@/api/project";
import type { TerminalView } from "@/api/terminal";
import type { ThreadView } from "@/api/threads";
import type { WorkspaceView } from "@/api/workspace";
import { useConfirmStore } from "@/stores/confirm";
import { branchPullRequestsResource, repoActivityResource } from "@/stores/gh";
import { useProjectsStore } from "@/stores/projects";
import { useRemoveWorktreeStore } from "@/stores/removeWorktree";
import { useTerminalsStore } from "@/stores/terminals";
import { useThreadsStore } from "@/stores/threads";
import { PROJECTS_INDEX, useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { worktreeDetailResource } from "@/stores/worktreeDetail";
import { daemon } from "./daemonFakes";

export const HOME = "/Users/dev";
export const CF = `${HOME}/src/code-foundry`;
export const FEAT = `${CF}.worktrees/feat-sidebar`;
export const FIX = `${CF}.worktrees/fix-resize`;
export const GP = `${HOME}/src/ghostty-playground`;
export const DOT = `${HOME}/dotfiles`;
export const SK = `${HOME}/src/sketches`;
export const WR = `${HOME}/Documents/writing`;
const ROOT = `${HOME}/.code-foundry/worktrees/alexwaumann/code-foundry`;
export const SPIKE = `${ROOT}/cf-perf-spike`;
export const COPY = `${ROOT}/cf-old-copy`;
export const SHADERS = `${CF}-shaders`;
export const MERGED = `${ROOT}/cf-usage-polish`;

/** A few minutes ago, the way the mock's `ago(min)` dates its threads. */
const ago = (min: number) => Date.now() - min * 60_000;

export function status(o: Partial<GitStatusView> = {}): GitStatusView {
  return { upstream: "origin/main", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0, dirty: false, refreshedAtMs: Date.now(), baseRef: "origin/main", baseAhead: 0, baseBehind: 0, operation: "", operationStep: 0, operationTotal: 0, error: "", ...o };
}

export function worktree(projectId: string, path: string, branch: string, o: Partial<WorktreeView> = {}): WorktreeView {
  return { projectId, path, branch, head: "c0ffee00", detached: false, isMain: false, status: status(), ...o };
}

export function thread(id: string, o: Partial<ThreadView> = {}): ThreadView {
  const projectId = o.projectId ?? "repo-cf";
  return {
    id,
    claudeSessionId: "",
    projectId,
    worktreePath: CF,
    name: id,
    autoNamed: false,
    nameProvisional: false,
    naming: false,
    model: "",
    effort: "",
    state: "disconnected",
    status: "idle",
    statusReason: "",
    statusChangedAtMs: null,
    createdAtMs: ago(100),
    lastActivityAtMs: null,
    parentId: "",
    permissionMode: "",
    baseRef: "",
    createdWorktree: false,
    branch: "",
    projectIds: projectId ? [projectId] : [],
    checkoutPaths: [],
    workspaceId: "",
    pendingWorktreePath: "",
    pinned: false,
    archivedAtMs: null,
    snoozedUntilMs: null,
    ...o,
  } as ThreadView;
}

function projects(): ProjectView[] {
  return [
    {
      id: "repo-cf",
      path: CF,
      name: "code-foundry",
      defaultBranch: "main",
      githubSlug: "alexwaumann/code-foundry",
      remotes: ["origin"],
      git: true,
      worktrees: [
        worktree("repo-cf", CF, "main", { isMain: true }),
        worktree("repo-cf", FEAT, "feat/sidebar", { status: status({ upstream: "origin/feat/sidebar", ahead: 2, modified: 3, untracked: 1, dirty: true, baseAhead: 3, baseBehind: 1 }) }),
        worktree("repo-cf", FIX, "fix/resize", { status: status({ upstream: "origin/fix/resize", behind: 1, baseAhead: 12 }) }),
      ],
    },
    { id: "repo-gp", path: GP, name: "ghostty-playground", defaultBranch: "main", githubSlug: "alexwaumann/ghostty-playground", remotes: ["origin"], git: true, worktrees: [worktree("repo-gp", GP, "main", { isMain: true, status: status({ staged: 1, dirty: true }) })] },
    { id: "repo-dot", path: DOT, name: "dotfiles", defaultBranch: "main", githubSlug: "", remotes: ["origin"], git: true, worktrees: [worktree("repo-dot", DOT, "main", { isMain: true, status: status({ upstream: "", baseRef: "" }) })] },
    { id: "repo-sk", path: SK, name: "sketches", defaultBranch: "main", githubSlug: "", remotes: [], git: true, worktrees: [worktree("repo-sk", SK, "main", { isMain: true, status: status({ upstream: "", baseRef: "" }) })] },
    { id: "repo-wr", path: WR, name: "writing", defaultBranch: "", githubSlug: "", remotes: [], git: false, worktrees: [worktree("repo-wr", WR, "", { isMain: true, head: "", status: status({ upstream: "", baseRef: "", refreshedAtMs: null }) })] },
  ];
}

/** The mock's seeded threads in these projects (s-7 archived, s-8 and s-9 snoozed). */
function threads(): ThreadView[] {
  return [
    thread("s-1", { worktreePath: CF, name: "Refactor sidebar tree", state: "connected", status: "busy", createdAtMs: ago(42) }),
    thread("s-2", { projectId: "repo-gp", worktreePath: GP, name: "Port renderer", state: "connected", status: "attention", statusChangedAtMs: ago(3), createdAtMs: ago(40) }),
    thread("s-3", { worktreePath: FIX, name: "Fix resize race", createdAtMs: ago(300), lastActivityAtMs: ago(95) }),
    thread("s-4", { worktreePath: FEAT, name: "Investigate flaky e2e", createdAtMs: ago(200), lastActivityAtMs: ago(17) }),
    thread("s-5", { worktreePath: FEAT, name: "Write thread docs", state: "starting", status: "busy", createdAtMs: ago(0) }),
    thread("s-6", { projectId: "repo-dot", worktreePath: DOT, name: "Tidy zshrc", state: "closing", statusChangedAtMs: ago(1), createdAtMs: ago(60) }),
    thread("s-7", { worktreePath: CF, name: "Spike a canvas sidebar", status: "attention", statusChangedAtMs: ago(95), createdAtMs: ago(600), lastActivityAtMs: ago(95), archivedAtMs: ago(90) }),
    thread("s-8", { worktreePath: CF, name: "Refactor the gh poller", status: "attention", statusChangedAtMs: ago(30), createdAtMs: ago(500), lastActivityAtMs: ago(30), snoozedUntilMs: Date.now() + 150 * 60_000 }),
    thread("s-9", { projectId: "repo-gp", worktreePath: GP, name: "Bump wails to v3.1", createdAtMs: ago(450), lastActivityAtMs: ago(20), snoozedUntilMs: Date.now() + 4 * 86_400_000 }),
  ];
}

const rollup = (o: Partial<CheckRollupView>): CheckRollupView => ({ state: "success", total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, ...o });

export function pullRequest(o: Partial<PullRequestView>): PullRequestView {
  return { repoSlug: "", number: 1, title: "", author: "dev", url: "", state: "open", draft: false, headRef: "", headSha: "", baseRef: "main", baseSha: "", review: "none", checks: rollup({ state: "none" }), createdAtMs: null, updatedAtMs: null, mergedAtMs: null, mergeable: "unknown", mergeState: "", additions: 0, deletions: 0, changedFiles: 0, comments: 0, reviews: 0, latestReviews: [], reviewRequests: [], isCrossRepository: false, headRepoSlug: "", partial: false, ...o } as PullRequestView;
}

function branchPrs(prs: PullRequestView[]): BranchPullRequestsView {
  return { pullRequests: prs, fetchedAtMs: Date.now(), lastError: "" };
}

/** What the mock's GitHub says: code-foundry's main fails 2 of 16, ghostty-playground's passes; #142 on feat/sidebar, a draft on fix/resize. */
function seedGitHub(): void {
  const failing = [{ name: "error", workflow: "Jenkins", url: "https://ci.example.com/job/code-foundry/main/812/", conclusion: "failure" }];
  daemon.repoActivity.set("alexwaumann/code-foundry", { repoSlug: "alexwaumann/code-foundry", defaultBranch: { branch: "main", rollup: rollup({ state: "failure", total: 16, passed: 14, failed: 2 }), failing, fetchedAtMs: Date.now(), lastError: "" } });
  daemon.repoActivity.set("alexwaumann/ghostty-playground", { repoSlug: "alexwaumann/ghostty-playground", defaultBranch: { branch: "main", rollup: rollup({ state: "success", total: 10, passed: 10 }), failing: [], fetchedAtMs: Date.now(), lastError: "" } });
  const slug = "alexwaumann/code-foundry";
  daemon.branchPullRequests.set(`${slug}\u0000feat/sidebar`, branchPrs([pullRequest({ repoSlug: slug, number: 142, title: "Sidebar tree", state: "open", headRef: "feat/sidebar" })]));
  daemon.branchPullRequests.set(`${slug}\u0000fix/resize`, branchPrs([pullRequest({ repoSlug: slug, number: 151, title: "Fix resize", state: "open", draft: true, headRef: "fix/resize" })]));
}

/**
 * Resets the stores to the mock's initial world (GitHub included) and the Projects index
 * selected. `empty`: no projects at all (POST /__mock/empty).
 */
export function seedWorld(opts: { empty?: boolean } = {}): void {
  // jsdom lays nothing out: the list's cursor and a revealed row scroll into view.
  if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => undefined;
  const ps = opts.empty ? [] : projects();
  const ts = opts.empty ? [] : threads();
  repoActivityResource.store.setState({ entries: {} });
  branchPullRequestsResource.store.setState({ entries: {} });
  worktreeDetailResource.store.setState({ entries: {} });
  if (!opts.empty) seedGitHub();
  const byId = Object.fromEntries(ps.map((p) => [p.id, p]));
  useProjectsStore.setState({ byId, order: byName(byId), loaded: true });
  useThreadsStore.setState({ byId: Object.fromEntries(ts.map((t) => [t.id, t])), order: ts.map((t) => t.id), loaded: true });
  useWorkspacesStore.setState({ byId: {}, order: [], loaded: true });
  useTerminalsStore.setState({ byId: {}, order: [], loaded: true });
  useConfirmStore.setState({ pending: null });
  useRemoveWorktreeStore.setState({ pending: null });
  useUiStore.getState().select(PROJECTS_INDEX);
}

/** Project ids by name, as the projects store orders them. */
function byName(byId: Readonly<Record<string, ProjectView>>): string[] {
  return Object.values(byId)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((p) => p.id);
}

/** Updates one project in place (a project event). */
export function updateProject(id: string, f: (p: ProjectView) => ProjectView): void {
  act(() => {
    useProjectsStore.setState((s) => {
      const p = s.byId[id];
      if (!p) return {};
      const byId = { ...s.byId, [id]: f(p) };
      return { byId, order: byName(byId) };
    });
  });
}

/** Adds (or replaces) worktrees of a project. */
export function addWorktrees(projectId: string, ...ws: WorktreeView[]): void {
  updateProject(projectId, (p) => ({ ...p, worktrees: [...p.worktrees.filter((w) => !ws.some((x) => x.path === w.path)), ...ws] }));
}

export function addThreads(...ts: ThreadView[]): void {
  act(() => {
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, ...Object.fromEntries(ts.map((t) => [t.id, t])) }, order: [...s.order.filter((id) => !ts.some((t) => t.id === id)), ...ts.map((t) => t.id)] }));
  });
}

export function removeProject(id: string): void {
  act(() => {
    useProjectsStore.setState((s) => {
      const { [id]: _gone, ...byId } = s.byId;
      return { byId, order: s.order.filter((x) => x !== id) };
    });
  });
}

let wsSeq = 0;

/**
 * A workspace like POST /__mock/workspace: members (project ids), the first one starting
 * threads unless `primary` says otherwise, a rooted one when `root` is set.
 */
export function addWorkspace(name: string, members: string[], o: { root?: string; primary?: string; instructions?: string; skills?: string[]; id?: string } = {}): WorkspaceView {
  const id = o.id ?? `w-${String(++wsSeq).padStart(12, "0")}`;
  const managedDir = `${HOME}/.code-foundry/workspaces/${id}`;
  const dir = o.root ?? managedDir;
  const w: WorkspaceView = {
    id,
    name,
    branch: "",
    members: [...members].sort().map((projectId) => ({ projectId, worktreePath: "" })),
    rootPath: o.root ?? "",
    rootMissing: false,
    defaultPrimary: o.primary ?? (o.root ? "workspace" : (members[0] ?? "workspace")),
    managedDir,
    instructions: o.instructions ? `${dir}/${o.instructions}` : "",
    skills: [...(o.skills ?? [])].sort(),
    createdAtMs: Date.now(),
  };
  act(() => {
    useWorkspacesStore.setState((s) => {
      const byId = { ...s.byId, [id]: w };
      return { byId, order: Object.keys(byId).sort((a, b) => (byId[a]?.name ?? "").localeCompare(byId[b]?.name ?? "")) };
    });
  });
  return w;
}

export function removeWorkspace(id: string): void {
  act(() => {
    useWorkspacesStore.setState((s) => {
      const { [id]: _gone, ...byId } = s.byId;
      return { byId, order: s.order.filter((x) => x !== id) };
    });
  });
}

/** Removes worktrees of a project (the daemon's worktreeRemoved). */
export function removeWorktrees(projectId: string, ...paths: string[]): void {
  updateProject(projectId, (p) => ({ ...p, worktrees: p.worktrees.filter((w) => !paths.includes(w.path)) }));
}

export function updateWorkspace(id: string, f: (w: WorkspaceView) => WorkspaceView): void {
  act(() => {
    useWorkspacesStore.setState((s) => {
      const w = s.byId[id];
      return w ? { byId: { ...s.byId, [id]: f(w) } } : {};
    });
  });
}

/** A running shell in a checkout, as terminal.new from the CLI leaves it. */
export function addTerminal(id: string, projectId: string, worktreePath: string): void {
  const t = { id, argv: ["/bin/zsh", "-l"], cwd: worktreePath, title: "", state: "running", labels: { project: projectId, worktree: worktreePath } } as unknown as TerminalView;
  act(() => {
    useTerminalsStore.setState((s) => ({ byId: { ...s.byId, [id]: t }, order: [...s.order, id] }));
  });
}

/**
 * POST /__mock/leftovers: three worktrees without threads on code-foundry (cf/perf-spike with
 * 3 commits not on main, cf/old-copy with 4 uncommitted files, exp/shaders made outside the
 * app) and their archived threads; `clean` adds cf/usage-polish, merged and clean.
 */
export function addLeftovers(clean = false): void {
  const base = "origin/main";
  const days = (d: number) => Date.now() - d * 86_400_000;
  const ws = [
    worktree("repo-cf", SPIKE, "cf/perf-spike", { managed: true, status: status({ upstream: "origin/cf/perf-spike", baseRef: base, baseAhead: 3, baseBehind: 9 }) }),
    worktree("repo-cf", COPY, "cf/old-copy", { managed: true, landed: true, status: status({ upstream: "", modified: 2, untracked: 2, dirty: true, baseRef: base, baseBehind: 30 }) }),
    worktree("repo-cf", SHADERS, "exp/shaders", { managed: false, landed: true, status: status({ upstream: "", baseRef: base, baseBehind: 4 }) }),
  ];
  if (clean) ws.push(worktree("repo-cf", MERGED, "cf/usage-polish", { managed: true, landed: true, mergedClean: true, status: status({ upstream: "", baseRef: base }) }));
  addWorktrees("repo-cf", ...ws);
  addThreads(
    thread("s-lo-spike", { worktreePath: SPIKE, name: "Profile the renderer", statusChangedAtMs: days(12), createdAtMs: days(14), lastActivityAtMs: days(12), archivedAtMs: days(12) }),
    thread("s-lo-copy", { worktreePath: COPY, name: "Copy the old settings page", statusChangedAtMs: days(21), createdAtMs: days(23), lastActivityAtMs: days(21), archivedAtMs: days(21) }),
  );
  daemon.worktreeDetail.set(`repo-cf\u0000${COPY}`, {
    files: [
      { path: "gui/frontend/src/lib/tree.ts", added: 12, deleted: 4, uncommitted: true },
      { path: "docs/notes/sidebar.md", added: 3, deleted: 1, uncommitted: true },
      { path: "scratch.txt", added: 3, deleted: 0, uncommitted: true },
      { path: "notes/todo.md", added: 4, deleted: 0, uncommitted: true },
    ],
  } as never);
}

/** The text of every element with the test id, whitespace collapsed. */
export function texts(root: ParentNode, testId: string): string[] {
  return [...root.querySelectorAll(`[data-testid="${testId}"]`)].map((e) => e.textContent.replace(/\s+/g, " ").trim());
}

/** The open menu's items as read ("Clean up merged worktrees 1"), "—" for a separator. */
export function menuEntries(menu: HTMLElement, separators = false): string[] {
  return [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')]
    .filter((e) => separators || e.getAttribute("role") === "menuitem")
    .map((e) =>
      e.getAttribute("role") === "separator"
        ? "—"
        : [...e.childNodes]
            .map((n) => (n.textContent ?? "").trim())
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " "),
    );
}
