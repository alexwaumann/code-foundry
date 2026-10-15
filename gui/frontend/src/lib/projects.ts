/**
 * The Projects page's view models: every project (registered repository) with its own
 * worktrees, and every workspace with its members. A workspace's member worktrees are
 * listed under the workspace only, never under their project (one change stays in one
 * place). Pure; inputs are the repos and workspaces slices' shapes.
 */
import { isRemoteless, type RepoView, type WorktreeView } from "@/api/repo";
import type { SessionView } from "@/api/session";
import type { TerminalView } from "@/api/terminal";
import type { WorkspaceView } from "@/api/workspace";
import { tildify } from "./path";

export interface ProjectsRepos {
  /** `git` false: a project without git (never a workspace member); absent counts as git. */
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
  repoId: string;
  /** Its worktrees that belong to no workspace, main first (the repos slice's order). */
  worktrees: string[];
  /** How many of its worktrees are workspace members (listed under their workspaces). */
  inWorkspaces: number;
}

export interface ProjectsModel {
  projects: ProjectModel[];
  workspaces: string[];
}

/** Worktree paths that are members of some workspace. */
export function memberPaths(workspaces: ProjectsWorkspaces): Set<string> {
  const out = new Set<string>();
  for (const id of workspaces.order) for (const m of workspaces.byId[id]?.members ?? []) out.add(m.worktreePath);
  return out;
}

export function projectsModel(repos: ProjectsRepos, workspaces: ProjectsWorkspaces): ProjectsModel {
  const members = memberPaths(workspaces);
  return {
    projects: repos.order.flatMap((id) => {
      const r = repos.byId[id];
      if (!r) return [];
      const own = r.worktrees.filter((w) => !members.has(w.path)).map((w) => w.path);
      return [{ repoId: id, worktrees: own, inWorkspaces: r.worktrees.length - own.length }];
    }),
    workspaces: workspaces.order.filter((id) => workspaces.byId[id] !== undefined),
  };
}

/**
 * Projects that can be added to the workspace: registered, git (a member is a worktree on
 * the workspace branch; a repository without a remote is fine), and not yet members, by
 * name.
 */
export function addableRepos(ws: Pick<WorkspaceView, "members"> | undefined, repos: ProjectsRepos): string[] {
  const inWs = new Set(ws?.members.map((m) => m.repoId) ?? []);
  return repos.order.filter((id) => {
    const r = repos.byId[id];
    return !inWs.has(id) && r !== undefined && r.git !== false;
  });
}

/**
 * How a command names a repository: its name when no other registered repository has it
 * (confirm prompts read better), else its id. The daemon resolves both.
 */
export function repoRef(repos: ProjectsRepos, repoId: string): string {
  const name = repos.byId[repoId]?.name;
  if (!name) return repoId;
  let n = 0;
  for (const id of repos.order) if (repos.byId[id]?.name === name) n++;
  return n === 1 ? name : repoId;
}

/**
 * Where a thread is relative to a workspace member (the side panel's member rows): it
 * runs there (its cwd is the member worktree or inside it), a queued "Run in…" moves it
 * there, or neither. No thread (the Projects page) is always neither.
 */
export function threadAt(thread: { worktreePath: string; pendingWorktreePath: string } | undefined, memberPath: string): "current" | "queued" | null {
  if (!thread || !memberPath) return null;
  const cwd = thread.worktreePath;
  if (cwd === memberPath || cwd.startsWith(`${memberPath}/`)) return "current";
  return thread.pendingWorktreePath === memberPath && thread.pendingWorktreePath !== cwd ? "queued" : null;
}

/** Keyboard row keys of the page. */
export const projectKey = (repoId: string): string => `p:${repoId}`;
export const projectWorktreeKey = (repoId: string, path: string): string => `pw:${repoId}::${path}`;
export const workspaceKey = (id: string): string => `ws:${id}`;
export const memberKey = (workspaceId: string, repoId: string): string => `m:${workspaceId}::${repoId}`;

export type PageItem =
  | { key: string; kind: "project"; repoId: string }
  | { key: string; kind: "worktree"; repoId: string; path: string }
  | { key: string; kind: "workspace"; workspaceId: string }
  | { key: string; kind: "member"; workspaceId: string; repoId: string; path: string };

/** Projects and workspaces whose rows are hidden (the UI store's persisted sets; empty while filtering). */
export interface Collapsed {
  projects: ReadonlySet<string>;
  workspaces: ReadonlySet<string>;
}

export const NONE_COLLAPSED: Collapsed = { projects: new Set(), workspaces: new Set() };

/**
 * Every navigable row of the page in display order: projects and their worktrees, then
 * workspaces and their members. A collapsed project or workspace keeps its header row only.
 */
export function pageItems(model: ProjectsModel, workspaces: ProjectsWorkspaces, collapsed: Collapsed = NONE_COLLAPSED): PageItem[] {
  const out: PageItem[] = [];
  for (const p of model.projects) {
    out.push({ key: projectKey(p.repoId), kind: "project", repoId: p.repoId });
    if (collapsed.projects.has(p.repoId)) continue;
    for (const path of p.worktrees) out.push({ key: projectWorktreeKey(p.repoId, path), kind: "worktree", repoId: p.repoId, path });
  }
  for (const id of model.workspaces) {
    out.push({ key: workspaceKey(id), kind: "workspace", workspaceId: id });
    if (collapsed.workspaces.has(id)) continue;
    for (const m of workspaces.byId[id]?.members ?? []) out.push({ key: memberKey(id, m.repoId), kind: "member", workspaceId: id, repoId: m.repoId, path: m.worktreePath });
  }
  return out;
}

/** What a collapsed project header says about its hidden rows: "3 worktrees · 1 in a workspace". */
export function collapsedProjectSummary(p: Pick<ProjectModel, "worktrees" | "inWorkspaces">): string {
  const total = p.worktrees.length + p.inWorkspaces;
  const head = `${String(total)} ${total === 1 ? "worktree" : "worktrees"}`;
  if (p.inWorkspaces === 0) return head;
  return `${head} · ${String(p.inWorkspaces)} ${p.inWorkspaces === 1 ? "in a workspace" : "in workspaces"}`;
}

/** What a collapsed workspace header says about its hidden rows: "2 members". */
export function collapsedWorkspaceSummary(members: number): string {
  return `${String(members)} ${members === 1 ? "member" : "members"}`;
}

/**
 * What kind of project a repository is, as the Projects page's header shows it: a GitHub
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

export function projectKind(r: Pick<RepoView, "githubSlug" | "remotes"> & { git?: boolean }): ProjectKindInfo {
  if (r.git === false) return { kind: "nogit", meta: "", title: "Not a git repository: threads and terminals run in the folder itself." };
  if (r.githubSlug) return { kind: "github", meta: r.githubSlug, title: "A GitHub repository: its branches show their pull requests and checks." };
  const remote = r.remotes[0];
  if (remote === undefined) return { kind: "git", meta: "local only · no remote", title: "A local git repository with no remote: nothing to fetch, push or open pull requests against." };
  return { kind: "git", meta: `${remote} · not GitHub`, title: `A git repository whose remote (${remote}) is not on GitHub: no pull requests or checks.` };
}

/** What the page's filter matches against, per project and per workspace (only built while filtering). */
export interface ProjectsSearch {
  repos: Readonly<Record<string, { name: string; githubSlug: string; branches: Readonly<Record<string, string>> } | undefined>>;
  workspaces: Readonly<Record<string, { name: string; branch: string } | undefined>>;
}

/**
 * The model narrowed to what the filter matches, case-insensitive substring: a project by
 * its name or GitHub slug (then all its rows show), else by any of its worktrees' branch or
 * tildified path (then only those rows show); a workspace by its name or branch. An empty
 * query keeps everything.
 */
export function filterProjects(model: ProjectsModel, query: string, search: ProjectsSearch): ProjectsModel {
  const q = query.trim().toLowerCase();
  if (!q) return model;
  const hit = (s: string | undefined) => s !== undefined && s.toLowerCase().includes(q);
  return {
    projects: model.projects.flatMap((p) => {
      const r = search.repos[p.repoId];
      if (hit(r?.name) || hit(r?.githubSlug)) return [p];
      const worktrees = p.worktrees.filter((path) => hit(r?.branches[path]) || hit(tildify(path)));
      return worktrees.length > 0 ? [{ ...p, worktrees, inWorkspaces: 0 }] : [];
    }),
    workspaces: model.workspaces.filter((id) => {
      const w = search.workspaces[id];
      return hit(w?.name) || hit(w?.branch);
    }),
  };
}

/**
 * The setup step a project header offers, by kind: Publish to GitHub for a git
 * repository without any remote (isRemoteless), Initialize git for a folder without git,
 * nothing for a GitHub repository or one whose remote is elsewhere.
 */
export type ProjectNextStep = "publish" | "init" | null;

export function projectNextStep(r: Pick<RepoView, "git" | "remotes" | "worktrees">): ProjectNextStep {
  if (!r.git) return "init";
  return isRemoteless(r) ? "publish" : null;
}

/** A project's git status counts as stale (amber) in its header's freshness after this. */
export const PROJECT_STALE_MS = 10 * 60_000;

/**
 * How many threads are on exactly this worktree (a row's thread count): every thread whose
 * cwd it is, whether or not Claude runs for it, except archived ones (put away).
 */
export function worktreeThreadCount(sessions: { order: readonly string[]; byId: Readonly<Record<string, Pick<SessionView, "worktreePath" | "archivedAtMs"> | undefined>> }, path: string): number {
  if (!path) return 0;
  let n = 0;
  for (const id of sessions.order) {
    const s = sessions.byId[id];
    if (s?.worktreePath === path && s.archivedAtMs === null) n++;
  }
  return n;
}

/** p is root or inside it (snapshot paths: cleaned, symlinks resolved). */
function inside(p: string, root: string): boolean {
  if (!p || !root) return false;
  return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export interface CleanupSessions {
  order: readonly string[];
  byId: Readonly<Record<string, Pick<SessionView, "state" | "worktreePath"> | undefined>>;
}

export interface CleanupTerminals {
  order: readonly string[];
  byId: Readonly<Record<string, Pick<TerminalView, "state" | "cwd" | "labels"> | undefined>>;
}

/**
 * A thread whose Claude process runs (or is starting or stopping) has its cwd in the
 * worktree: the daemon's cleanup guard (cleanupHold) counts exactly those, so the
 * prediction reads the process state here. Internal only; nothing on screen says it.
 */
export function threadHolds(sessions: CleanupSessions, path: string): boolean {
  return sessions.order.some((id) => {
    const s = sessions.byId[id];
    return s !== undefined && s.state !== "disconnected" && inside(s.worktreePath, path);
  });
}

/** A terminal that has not exited belongs to the worktree (its worktree label) or runs inside it. */
export function terminalHolds(terminals: CleanupTerminals, path: string): boolean {
  return terminals.order.some((id) => {
    const t = terminals.byId[id];
    return t !== undefined && t.state !== "exited" && (t.labels.worktree === path || inside(t.cwd, path));
  });
}

/** The worktree is (inside) a workspace member. */
export function memberHolds(workspaces: ProjectsWorkspaces, path: string): boolean {
  return workspaces.order.some((id) => workspaces.byId[id]?.members.some((m) => inside(path, m.worktreePath)) ?? false);
}

/**
 * Whether repo.worktree.cleanup would remove the worktree now: the daemon's git verdict
 * (mergedClean) and nothing holds it, as the daemon's cleanupHold checks (a running thread,
 * a terminal that has not exited, a workspace). The daemon checks again after a fetch.
 */
export function isCleanable(
  wt: Pick<WorktreeView, "path" | "mergedClean"> | undefined,
  sessions: CleanupSessions,
  terminals: CleanupTerminals,
  workspaces: ProjectsWorkspaces,
): boolean {
  if (!wt?.mergedClean) return false;
  return !threadHolds(sessions, wt.path) && !terminalHolds(terminals, wt.path) && !memberHolds(workspaces, wt.path);
}

/** The "in main" tag's tooltip. */
export function cleanableTitle(baseRef: string | undefined): string {
  return `Clean: no changes, every commit is in ${baseRef || "origin/<default>"}, nothing running in it`;
}
