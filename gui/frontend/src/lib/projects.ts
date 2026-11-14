/**
 * The Projects view's models (components/projects, docs/notes/projects-redesign-1-index.md):
 * the index's rows (projects and workspaces by last activity, each with a status
 * sentence), a project page's checkouts (cells and order) and details. Pure; inputs are
 * the projects, threads and workspaces slices' shapes.
 */
import type { CheckRollupView, DefaultBranchView } from "@/api/gh";
import { isRemoteless, type GitStatusView, type ProjectView, type WorktreeView } from "@/api/project";
import type { ThreadView } from "@/api/threads";
import type { TerminalView } from "@/api/terminal";
import { isWithin, tildify } from "./path";
import { threadBadge } from "./thread";
import { compareByName } from "./workspaceCard";

export interface ProjectsSlice {
  /** `git` false: a project without git (a plain folder); absent counts as git. */
  byId: Readonly<Record<string, { id: string; name: string; git?: boolean; worktrees: readonly Pick<WorktreeView, "path" | "isMain">[] } | undefined>>;
  /** Sorted by name. */
  order: readonly string[];
}

export interface ProjectsModel {
  /** Each project's worktrees, main first (the projects slice's order). */
  projects: { projectId: string; worktrees: string[] }[];
  workspaces: string[];
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
    return s !== undefined && s.archivedAtMs === null && (isWithin(s.worktreePath, path) || (s.checkoutPaths ?? []).some((c) => isWithin(c.path, path)));
  });
}

/** A terminal that has not exited belongs to the worktree (its worktree label) or runs inside it. */
export function terminalHolds(terminals: CleanupTerminals, path: string): boolean {
  return terminals.order.some((id) => {
    const t = terminals.byId[id];
    return t !== undefined && t.state !== "exited" && (t.labels.worktree === path || isWithin(t.cwd, path));
  });
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
 * A workspace member's caption under its name: the GitHub slug, "<remote> · not GitHub",
 * "local only", or "<path> · no git".
 */
export function memberCaption(r: Pick<ProjectView, "githubSlug" | "remotes" | "path"> & { git?: boolean }): string {
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

/** A checkout's Sync text against its upstream: "2 to push", "1 behind", both, "up to date", or "not pushed" without one. */
export function syncCell(st: Pick<GitStatusView, "upstream" | "ahead" | "behind">): string {
  if (!st.upstream) return "not pushed";
  const parts: string[] = [];
  if (st.ahead > 0) parts.push(`${String(st.ahead)} to push`);
  if (st.behind > 0) parts.push(`${String(st.behind)} behind`);
  return parts.length === 0 ? "up to date" : parts.join(" · ");
}

/**
 * How a checkout stands against its upstream, for the Checkouts table's Sync cell: `none`
 * without one ("not pushed"), `even` ("up to date"), `ahead` ("2 to push"), `behind`
 * ("1 behind"), or both at once, `diverged` ("diverged ↑2 ↓1": the counts stay in sight).
 */
export type SyncKind = "none" | "even" | "ahead" | "behind" | "diverged";

export interface SyncState {
  kind: SyncKind;
  text: string;
}

/** A checkout's Sync state against its upstream (SyncKind). */
export function syncState(st: Pick<GitStatusView, "upstream" | "ahead" | "behind">): SyncState {
  if (!st.upstream) return { kind: "none", text: "not pushed" };
  if (st.ahead > 0 && st.behind > 0) return { kind: "diverged", text: `diverged ↑${String(st.ahead)} ↓${String(st.behind)}` };
  return { kind: st.ahead > 0 ? "ahead" : st.behind > 0 ? "behind" : "even", text: syncCell(st) };
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

/** The Checkouts title's hint: "2 threads working"; "" while none works (the title's count says how many checkouts). */
export function checkoutsHint(working: number): string {
  return working > 0 ? `${plural(working, "thread")} working` : "";
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

/** The title block's failed refresh: "Refresh failed · 14m ago", "Refresh failed" before any read. */
export function refreshFailedText(at: number | null, now: number): string {
  if (at === null) return "Refresh failed";
  return `Refresh failed · ${refreshedText(at, now).replace(/^refreshed /, "")}`;
}

/** Details' Remote row: "origin · github.com/o/r", "origin · pull requests need GitHub"; "" without a remote. */
export function remoteDetail(r: Pick<ProjectView, "githubSlug" | "remotes">): string {
  const remote = r.remotes[0];
  if (remote === undefined) return "";
  return r.githubSlug ? `${remote} · github.com/${r.githubSlug}` : `${remote} · pull requests need GitHub`;
}

/**
 * Details' Worktrees row: how many, how many Code Foundry made, and the folder they share
 * (tildified): "6 · 3 made by Code Foundry, in ~/.code-foundry/worktrees", "2 · all made by
 * Code Foundry, in …", "2 in ~/x.worktrees", "2". The folder is left out when they share
 * none, only "/" or only the home folder ("~" says nothing). "" with none.
 */
export function worktreesDetail(paths: readonly string[], managed = 0): string {
  const n = paths.length;
  if (n === 0) return "";
  const made = managed <= 0 ? "" : managed >= n ? (n === 1 ? " · made by Code Foundry" : " · all made by Code Foundry") : ` · ${String(managed)} made by Code Foundry`;
  const parents = paths.map((p) => p.slice(0, Math.max(0, p.lastIndexOf("/"))));
  let common = parents[0] ?? "";
  for (const p of parents) {
    while (common && p !== common && !p.startsWith(`${common}/`)) common = common.slice(0, Math.max(0, common.lastIndexOf("/")));
  }
  const folder = common && common !== "/" ? tildify(common) : "";
  const where = folder && folder !== "~" ? `${made ? "," : ""} in ${folder}` : "";
  return `${String(n)}${made}${where}`;
}

/** Details' Actions row: the actions' names, "Dev · Test · Build", or "none". */
export function actionsDetail(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(" · ");
}

/** A project page's title block and Details drop to their compact layout (no slug, Open in Finder's icon only) below this content width. */
export const PROJECT_TITLE_COMPACT_BELOW = 720;

/** The Projects index's optional columns (Project and Needs a look always show). */
export interface IndexColumns {
  activity: boolean;
  updated: boolean;
  /** Default branch; a workspace's Contents. */
  branch: boolean;
}

/** The content widths the index drops its columns below: Activity first, then Updated, then Default branch. */
export const INDEX_DROP_BELOW = { activity: 840, updated: 700, branch: 600 } as const;

/** The index's columns at a content width (the scroll box's, in its pane). */
export function indexColumns(width: number): IndexColumns {
  return { activity: width >= INDEX_DROP_BELOW.activity, updated: width >= INDEX_DROP_BELOW.updated, branch: width >= INDEX_DROP_BELOW.branch };
}

/** The Checkouts table's optional columns (Branch and, on GitHub, Pull request always show). */
export interface CheckoutColumns {
  threads: boolean;
  changes: boolean;
  /** With a remote and room for it. */
  sync: boolean;
  /** On GitHub. */
  pr: boolean;
}

/** The table widths the Checkouts table drops its columns below: Sync first, then Threads, then Changes. */
export const CHECKOUT_DROP_BELOW = { sync: 900, threads: 720, changes: 560 } as const;

/** The Checkouts table's columns at its own width (its pane's), for a project with or without a remote, on GitHub or not. */
export function checkoutColumns(width: number, project: { remote: boolean; github: boolean }): CheckoutColumns {
  return {
    threads: width >= CHECKOUT_DROP_BELOW.threads,
    changes: width >= CHECKOUT_DROP_BELOW.changes,
    sync: project.remote && width >= CHECKOUT_DROP_BELOW.sync,
    pr: project.github,
  };
}

/** A checkout has something to show in its Changes tab: uncommitted files, or commits ahead of its base. */
export function checkoutHasChanges(st: Pick<GitStatusView, "staged" | "modified" | "untracked" | "conflicted" | "dirty" | "baseAhead">): boolean {
  return st.dirty || st.staged + st.modified + st.untracked + (st.conflicted ?? 0) > 0 || (st.baseAhead ?? 0) > 0;
}

/** An index row's Default branch cell; null shows "—". */
export interface DefaultBranchCell {
  branch: string;
  rollup: CheckRollupView;
  /** The first failed check's link (what a click on the checks opens); "" for none. */
  failingUrl: string;
}

/**
 * A project's Default branch cell from its repository activity: none for a project not on
 * GitHub, before the activity arrives, or while the daemon has only an error for it.
 */
export function defaultBranchCell(githubSlug: string, d: DefaultBranchView | null | undefined): DefaultBranchCell | null {
  if (!githubSlug || !d || d.fetchedAtMs === null) return null;
  return { branch: d.branch, rollup: d.rollup, failingUrl: d.failing.find((c) => c.url !== "")?.url ?? "" };
}
