/**
 * The Projects view's models (components/projects, docs/notes/projects-redesign-1-index.md):
 * the index's rows (projects and workspaces by last activity, each with a status
 * sentence), a project page's checkouts (cells and order) and details. Pure; inputs are
 * the projects, threads and workspaces slices' shapes.
 */
import { isRemoteless, type GitStatusView, type ProjectView, type WorktreeView } from "@/api/project";
import type { ThreadView } from "@/api/threads";
import type { TerminalView } from "@/api/terminal";
import type { WorkspaceView } from "@/api/workspace";
import { tildify } from "./path";
import { threadBadge } from "./thread";
import { compareByName } from "./workspaceCard";

export interface ProjectsSlice {
  /** `git` false: a project without git (a plain folder); absent counts as git. */
  byId: Readonly<Record<string, { id: string; name: string; git?: boolean; worktrees: readonly Pick<WorktreeView, "path" | "isMain">[] } | undefined>>;
  /** Sorted by name. */
  order: readonly string[];
}

export interface ProjectsWorkspaces {
  byId: Readonly<Record<string, Pick<WorkspaceView, "id" | "members"> | undefined>>;
  /** Sorted by name. */
  order: readonly string[];
}

export interface ProjectModel {
  projectId: string;
  /** Its worktrees, main first (the projects slice's order). */
  worktrees: string[];
}

export interface ProjectsModel {
  projects: ProjectModel[];
  workspaces: string[];
}

export function projectsModel(projects: ProjectsSlice, workspaces: Pick<ProjectsWorkspaces, "order" | "byId">): ProjectsModel {
  return {
    projects: projects.order.flatMap((id) => {
      const r = projects.byId[id];
      return r ? [{ projectId: id, worktrees: r.worktrees.map((w) => w.path) }] : [];
    }),
    workspaces: workspaces.order.filter((id) => workspaces.byId[id] !== undefined),
  };
}

/**
 * How a command names a project: its name when no other registered project has it
 * (confirm prompts read better), else its id. The daemon resolves both.
 */
export function projectRef(projects: ProjectsSlice, projectId: string): string {
  const name = projects.byId[projectId]?.name;
  if (!name) return projectId;
  let n = 0;
  for (const id of projects.order) if (projects.byId[id]?.name === name) n++;
  return n === 1 ? name : projectId;
}

/** Keyboard row keys of the page. */
export const projectKey = (projectId: string): string => `p:${projectId}`;
export const projectWorktreeKey = (projectId: string, path: string): string => `pw:${projectId}::${path}`;
export const workspaceKey = (id: string): string => `ws:${id}`;
/** A member row on a workspace's page. */
export const memberKey = (workspaceId: string, projectId: string): string => `m:${workspaceId}::${projectId}`;

/**
 * What kind of project it is, as the Projects page's header shows it: a GitHub
 * repository (pull requests and checks), a git repository without a GitHub remote (local
 * only, or a remote elsewhere), or a plain folder without git.
 */
export type ProjectKind = "github" | "git" | "nogit";

export interface ProjectKindInfo {
  kind: ProjectKind;
  /** Muted text after the name: the GitHub slug, "local only · no remote", "origin · not GitHub", or "" (no git: the badge says it). */
  meta: string;
  /** The kind icon's tooltip, one sentence. */
  title: string;
}

export function projectKind(r: Pick<ProjectView, "githubSlug" | "remotes"> & { git?: boolean }): ProjectKindInfo {
  if (r.git === false) return { kind: "nogit", meta: "", title: "Not a git repository: threads and terminals run in the folder itself." };
  if (r.githubSlug) return { kind: "github", meta: r.githubSlug, title: "A GitHub repository: its branches show their pull requests and checks." };
  const remote = r.remotes[0];
  if (remote === undefined) return { kind: "git", meta: "local only · no remote", title: "A local git repository with no remote: nothing to fetch, push or open pull requests against." };
  return { kind: "git", meta: `${remote} · not GitHub`, title: `A git repository whose remote (${remote}) is not on GitHub: no pull requests or checks.` };
}

/** What the page's filter matches against, per project and per workspace (only built while filtering). */
export interface ProjectsSearch {
  projects: Readonly<Record<string, { name: string; githubSlug: string; branches: Readonly<Record<string, string>> } | undefined>>;
  /** A workspace's name and its member project ids (matched by their names in `projects`). */
  workspaces: Readonly<Record<string, { name: string; members?: readonly string[] } | undefined>>;
}

/**
 * The model narrowed to what the filter matches, case-insensitive substring: a project by
 * its name or GitHub slug (then all its rows show), else by any of its worktrees' branch or
 * tildified path (then only those rows show); a workspace by its name or one of its
 * projects' names (then the whole card shows). An empty query keeps everything.
 */
export function filterProjects(model: ProjectsModel, query: string, search: ProjectsSearch): ProjectsModel {
  const q = query.trim().toLowerCase();
  if (!q) return model;
  const hit = (s: string | undefined) => s !== undefined && s.toLowerCase().includes(q);
  return {
    projects: model.projects.flatMap((p) => {
      const r = search.projects[p.projectId];
      if (hit(r?.name) || hit(r?.githubSlug)) return [p];
      const worktrees = p.worktrees.filter((path) => hit(r?.branches[path]) || hit(tildify(path)));
      return worktrees.length > 0 ? [{ ...p, worktrees }] : [];
    }),
    workspaces: model.workspaces.filter((id) => {
      const w = search.workspaces[id];
      return hit(w?.name) || (w?.members ?? []).some((p) => hit(search.projects[p]?.name));
    }),
  };
}

/**
 * The setup step a project header offers, by kind: Publish to GitHub for a git
 * repository without any remote (isRemoteless), Initialize git for a folder without git,
 * nothing for a GitHub repository or one whose remote is elsewhere.
 */
export type ProjectNextStep = "publish" | "init" | null;

export function projectNextStep(r: Pick<ProjectView, "git" | "remotes" | "worktrees">): ProjectNextStep {
  if (!r.git) return "init";
  return isRemoteless(r) ? "publish" : null;
}

/** A project's git status counts as stale (amber) in its header's freshness after this. */
export const PROJECT_STALE_MS = 10 * 60_000;

/** p is root or inside it (snapshot paths: cleaned, symlinks resolved). */
function inside(p: string, root: string): boolean {
  if (!p || !root) return false;
  return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export interface CleanupThreads {
  order: readonly string[];
  /** checkoutPaths absent counts as none (a fixture with only the cwd). */
  byId: Readonly<Record<string, (Pick<ThreadView, "archivedAtMs" | "worktreePath"> & { checkoutPaths?: ThreadView["checkoutPaths"] }) | undefined>>;
}

export interface CleanupTerminals {
  order: readonly string[];
  byId: Readonly<Record<string, Pick<TerminalView, "state" | "cwd" | "labels"> | undefined>>;
}

/**
 * A thread is on the worktree (its cwd, or one of its checkouts in a multi-project set, is
 * the worktree or inside it), whatever its state; archived ones are put away: the
 * daemon's cleanup guard (cleanupHold over checkoutThreads) counts exactly those. It is
 * also the leftover rule's "a thread has it" (lib/leftovers.ts).
 */
export function threadHolds(threads: CleanupThreads, path: string): boolean {
  return threads.order.some((id) => {
    const s = threads.byId[id];
    return s !== undefined && s.archivedAtMs === null && (inside(s.worktreePath, path) || (s.checkoutPaths ?? []).some((c) => inside(c.path, path)));
  });
}

/** A terminal that has not exited belongs to the worktree (its worktree label) or runs inside it. */
export function terminalHolds(terminals: CleanupTerminals, path: string): boolean {
  return terminals.order.some((id) => {
    const t = terminals.byId[id];
    return t !== undefined && t.state !== "exited" && (t.labels.worktree === path || inside(t.cwd, path));
  });
}

/**
 * Whether project.worktree.cleanup would remove the worktree now: the daemon's git verdict
 * (mergedClean) and nothing holds it, as the daemon's cleanupHold checks (a thread on it,
 * a terminal that has not exited). The daemon also holds a worktree another thread has as
 * a checkout (a multi-project thread's member), which only Checkouts knows: it then keeps
 * the worktree and says why. It checks again after a fetch.
 */
export function isCleanable(wt: Pick<WorktreeView, "path" | "mergedClean"> | undefined, threads: CleanupThreads, terminals: CleanupTerminals): boolean {
  if (!wt?.mergedClean) return false;
  return !threadHolds(threads, wt.path) && !terminalHolds(terminals, wt.path);
}


/** The thread fields the Projects view reads. */
export type ActivityThread = Pick<
  ThreadView,
  "projectId" | "projectIds" | "workspaceId" | "archivedAtMs" | "state" | "status" | "statusChangedAtMs" | "createdAtMs" | "lastActivityAtMs" | "branch" | "worktreePath" | "checkoutPaths"
>;

export interface ActivityThreads {
  order: readonly string[];
  byId: Readonly<Record<string, ActivityThread | undefined>>;
}

/** A thread's last sign of life: its latest status change, activity or creation; null when none is known. */
export function threadActivityMs(t: Pick<ActivityThread, "statusChangedAtMs" | "createdAtMs" | "lastActivityAtMs">): number | null {
  const ms = [t.statusChangedAtMs, t.lastActivityAtMs, t.createdAtMs].filter((x): x is number => x !== null);
  return ms.length === 0 ? null : Math.max(...ms);
}

/** The thread is working: not archived and its row shows busy (a turn running, or Claude starting). */
export function isWorking(t: Pick<ActivityThread, "archivedAtMs" | "state" | "status">): boolean {
  return t.archivedAtMs === null && threadBadge(t) === "busy";
}

/** The project is in the thread's set (its primary or another member). */
export function threadInProject(t: Pick<ActivityThread, "projectId" | "projectIds">, projectId: string): boolean {
  return t.projectId === projectId || t.projectIds.includes(projectId);
}

export interface Activity {
  /** Threads working now. */
  working: number;
  /** The latest activity of any of its threads, archived ones included; null with none. */
  lastMs: number | null;
}

function activityOf(threads: ActivityThreads, match: (t: ActivityThread) => boolean): Activity {
  let working = 0;
  let lastMs: number | null = null;
  for (const id of threads.order) {
    const t = threads.byId[id];
    if (!t || !match(t)) continue;
    if (isWorking(t)) working++;
    const at = threadActivityMs(t);
    if (at !== null && (lastMs === null || at > lastMs)) lastMs = at;
  }
  return { working, lastMs };
}

/** A project's activity: over every thread whose set has it. */
export function projectActivity(threads: ActivityThreads, projectId: string): Activity {
  return activityOf(threads, (t) => threadInProject(t, projectId));
}

/** A workspace's activity: over every thread that references it. */
export function workspaceActivity(threads: ActivityThreads, workspaceId: string): Activity {
  return activityOf(threads, (t) => t.workspaceId === workspaceId);
}

/** The branches the workspace's working threads are on, distinct, in thread order. */
export function workspaceWorkingBranches(threads: ActivityThreads, workspaceId: string): string[] {
  const out: string[] = [];
  for (const id of threads.order) {
    const t = threads.byId[id];
    if (t?.workspaceId === workspaceId && isWorking(t) && t.branch && !out.includes(t.branch)) out.push(t.branch);
  }
  return out;
}

/**
 * The index's order: by last activity, most recent first; rows with none known last, by
 * name (case-insensitive, then id). No grouping.
 */
export function sortByActivity(ids: readonly string[], lastMs: (id: string) => number | null, name: (id: string) => string): string[] {
  return [...ids].sort((a, b) => {
    const la = lastMs(a);
    const lb = lastMs(b);
    if (la !== null && lb !== null && la !== lb) return lb - la;
    if (la !== null && lb === null) return -1;
    if (la === null && lb !== null) return 1;
    return compareByName(name(a), a, name(b), b);
  });
}

const plural = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;

/**
 * An index row's status sentence: "4 threads working · 6 checkouts", "idle · main only";
 * a folder without git has no checkouts to count ("1 thread working", "idle").
 */
export function projectStatusSentence(a: { working: number; checkouts: number; git: boolean }): string {
  const head = a.working > 0 ? `${plural(a.working, "thread")} working` : "idle";
  if (!a.git) return head;
  return `${head} · ${a.checkouts <= 1 ? "main only" : plural(a.checkouts, "checkout")}`;
}

/** A workspace row's status: "1 thread working on cf/platform", "2 threads working", "idle". */
export function workspaceStatusSentence(working: number, branches: readonly string[]): string {
  if (working === 0) return "idle";
  const head = `${plural(working, "thread")} working`;
  return branches.length === 1 ? `${head} on ${branches[0] ?? ""}` : head;
}

/** A workspace row's right-hand caption: "no instructions · 2 skills", "CLAUDE.md · no skills". */
export function workspaceContents(ws: { instructions?: string; skills?: readonly string[] }): string {
  const file = ws.instructions ? (ws.instructions.split("/").pop() ?? ws.instructions) : "no instructions";
  const n = ws.skills?.length ?? 0;
  return `${file} · ${n === 0 ? "no skills" : plural(n, "skill")}`;
}

/** The index's pills: "2 PRs", "1 worktree to tidy". */
export const prCountLabel = (n: number): string => plural(n, "PR");
export const tidyLabel = (n: number): string => `${plural(n, "worktree")} to tidy`;

/**
 * An index row's caption under the name: the GitHub slug, "<remote> · not GitHub",
 * "local only", or "<path> · no git".
 */
export function indexCaption(r: Pick<ProjectView, "githubSlug" | "remotes" | "path"> & { git?: boolean }): string {
  if (r.git === false) return `${tildify(r.path)} · no git`;
  if (r.githubSlug) return r.githubSlug;
  const remote = r.remotes[0];
  return remote === undefined ? "local only" : `${remote} · not GitHub`;
}

/** A checkout's Threads cell: "2 working", "1 working · 1 idle", "2 idle", "none". */
export function threadsCell(working: number, idle: number): string {
  if (working === 0 && idle === 0) return "none";
  if (idle === 0) return `${String(working)} working`;
  if (working === 0) return `${String(idle)} idle`;
  return `${String(working)} working · ${String(idle)} idle`;
}

/** A checkout's Changes cell: "5 files", "1 file", "clean" (conflicted entries count). */
export function changesCell(st: Pick<GitStatusView, "staged" | "modified" | "untracked" | "conflicted" | "dirty">): string {
  const n = st.staged + st.modified + st.untracked + (st.conflicted ?? 0);
  if (n === 0) return st.dirty ? "changed" : "clean";
  return plural(n, "file");
}

/** A checkout's Sync cell against its upstream: "2 to push", "1 behind", both, "up to date", or "not pushed" without one. */
export function syncCell(st: Pick<GitStatusView, "upstream" | "ahead" | "behind">): string {
  if (!st.upstream) return "not pushed";
  const parts: string[] = [];
  if (st.ahead > 0) parts.push(`${String(st.ahead)} to push`);
  if (st.behind > 0) parts.push(`${String(st.behind)} behind`);
  return parts.length === 0 ? "up to date" : parts.join(" · ");
}

/** The thread is on the checkout: its own cwd, or one of its set's checkouts (a multi-project thread's member). */
export function threadOnCheckout(t: Pick<ActivityThread, "worktreePath" | "checkoutPaths">, path: string): boolean {
  return t.worktreePath === path || t.checkoutPaths.some((c) => c.path === path);
}

export interface CheckoutThreads {
  working: number;
  idle: number;
  lastMs: number | null;
  /** The workspace a thread on it references (the first found), "" for none. */
  workspaceId: string;
}

/** Who is on a checkout: its non-archived threads, working or not, their latest activity and a workspace. */
export function checkoutThreads(threads: ActivityThreads, path: string): CheckoutThreads {
  const out: CheckoutThreads = { working: 0, idle: 0, lastMs: null, workspaceId: "" };
  for (const id of threads.order) {
    const t = threads.byId[id];
    if (!t || t.archivedAtMs !== null || !threadOnCheckout(t, path)) continue;
    if (isWorking(t)) out.working++;
    else out.idle++;
    if (!out.workspaceId && t.workspaceId) out.workspaceId = t.workspaceId;
    const at = threadActivityMs(t);
    if (at !== null && (out.lastMs === null || at > out.lastMs)) out.lastMs = at;
  }
  return out;
}

export interface CheckoutSortRow {
  path: string;
  isMain: boolean;
  branch: string;
  working: number;
  lastMs: number | null;
}

/**
 * The Checkouts table's order: checkouts with a working thread first (most recent
 * first), then main, then the rest by activity (most recent first, none last), then branch.
 */
export function sortCheckouts<T extends CheckoutSortRow>(rows: readonly T[]): T[] {
  const rank = (r: CheckoutSortRow) => (r.working > 0 ? 0 : r.isMain ? 1 : 2);
  return [...rows].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    if (a.lastMs !== b.lastMs) {
      if (a.lastMs === null) return 1;
      if (b.lastMs === null) return -1;
      return b.lastMs - a.lastMs;
    }
    return a.branch.localeCompare(b.branch) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
}

/** The Checkouts title's detail: "main plus 5 worktrees · 2 threads working", "main only". */
export function checkoutsSummary(worktrees: number, working: number): string {
  const head = worktrees <= 1 ? "main only" : `main plus ${plural(worktrees - 1, "worktree")}`;
  return working > 0 ? `${head} · ${plural(working, "thread")} working` : head;
}

/** "refreshed just now", "refreshed 14m ago", "not refreshed yet"; "refresh failed 14m ago" with an error. */
export function refreshedText(at: number | null, now: number, failed = false): string {
  const verb = failed ? "refresh failed" : "refreshed";
  if (at === null) return failed ? "refresh failed" : "not refreshed yet";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return `${verb} just now`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${verb} ${String(m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${verb} ${String(h)}h ago`;
  return `${verb} ${String(Math.floor(h / 24))}d ago`;
}

/** Details' Remote row: "origin · github.com/o/r", "origin · pull requests need GitHub"; "" without a remote. */
export function remoteDetail(r: Pick<ProjectView, "githubSlug" | "remotes">): string {
  const remote = r.remotes[0];
  if (remote === undefined) return "";
  return r.githubSlug ? `${remote} · github.com/${r.githubSlug}` : `${remote} · pull requests need GitHub`;
}

/**
 * Details' Worktrees row: the folder they share (tildified), how many, and how many Code
 * Foundry made: "~/x.worktrees · 5, 3 made by Code Foundry", "… · 1 made by Code Foundry"
 * when it made them all, "… · 2" when none; just the count part when they share no folder;
 * "" with none.
 */
export function worktreesDetail(paths: readonly string[], managed = 0): string {
  if (paths.length === 0) return "";
  const made = managed <= 0 ? "" : managed >= paths.length ? " made by Code Foundry" : `, ${String(managed)} made by Code Foundry`;
  const count = `${String(paths.length)}${made}`;
  const parents = paths.map((p) => p.slice(0, Math.max(0, p.lastIndexOf("/"))));
  let common = parents[0] ?? "";
  for (const p of parents) {
    while (common && p !== common && !p.startsWith(`${common}/`)) common = common.slice(0, Math.max(0, common.lastIndexOf("/")));
  }
  return common && common !== "/" ? `${tildify(common)} · ${count}` : count;
}

/** Details' Actions row's count: "none", "1 project action", "2 project actions". */
export function actionsDetail(n: number): string {
  return n === 0 ? "none" : plural(n, "project action");
}

/** The narrow layout of a project page (Sync and the slug drop, Terminal shows its icon only) below this content width. */
export const PROJECT_NARROW_BELOW = 840;
