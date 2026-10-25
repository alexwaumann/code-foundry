/**
 * The Projects page's view models: every registered project with its worktrees (all of
 * them: a workspace has no worktrees since workspaces v2, so a thread's checkouts show
 * under their projects), and every workspace as a card (lib/workspaceCard.ts). Pure;
 * inputs are the projects and workspaces slices' shapes.
 */
import { isRemoteless, type ProjectView, type WorktreeView } from "@/api/project";
import type { ThreadView } from "@/api/threads";
import type { TerminalView } from "@/api/terminal";
import type { WorkspaceView } from "@/api/workspace";
import { tildify } from "./path";

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
/** A workspace card's member row. */
export const memberKey = (workspaceId: string, projectId: string): string => `m:${workspaceId}::${projectId}`;

export type PageItem =
  | { key: string; kind: "project"; projectId: string }
  | { key: string; kind: "worktree"; projectId: string; path: string }
  | { key: string; kind: "workspace"; workspaceId: string }
  | { key: string; kind: "member"; workspaceId: string; projectId: string };

/** Projects and workspaces whose rows are hidden (the UI store's persisted sets; empty while filtering). */
export interface Collapsed {
  projects: ReadonlySet<string>;
  workspaces: ReadonlySet<string>;
}

export const NONE_COLLAPSED: Collapsed = { projects: new Set(), workspaces: new Set() };

/**
 * Every navigable row of the page in display order: projects and their worktrees, then
 * workspace cards and their members (sorted by id). A collapsed project or workspace
 * keeps its header row only.
 */
export function pageItems(model: ProjectsModel, workspaces: ProjectsWorkspaces, collapsed: Collapsed = NONE_COLLAPSED): PageItem[] {
  const out: PageItem[] = [];
  for (const p of model.projects) {
    out.push({ key: projectKey(p.projectId), kind: "project", projectId: p.projectId });
    if (collapsed.projects.has(p.projectId)) continue;
    for (const path of p.worktrees) out.push({ key: projectWorktreeKey(p.projectId, path), kind: "worktree", projectId: p.projectId, path });
  }
  for (const id of model.workspaces) {
    out.push({ key: workspaceKey(id), kind: "workspace", workspaceId: id });
    if (collapsed.workspaces.has(id)) continue;
    for (const m of workspaces.byId[id]?.members ?? []) out.push({ key: memberKey(id, m.projectId), kind: "member", workspaceId: id, projectId: m.projectId });
  }
  return out;
}

/** What a collapsed project header says about its hidden rows: "3 worktrees". */
export function collapsedProjectSummary(p: Pick<ProjectModel, "worktrees">): string {
  const n = p.worktrees.length;
  return `${String(n)} ${n === 1 ? "worktree" : "worktrees"}`;
}

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
  workspaces: Readonly<Record<string, { name: string } | undefined>>;
}

/**
 * The model narrowed to what the filter matches, case-insensitive substring: a project by
 * its name or GitHub slug (then all its rows show), else by any of its worktrees' branch or
 * tildified path (then only those rows show); a workspace by its name. An empty query
 * keeps everything.
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
    workspaces: model.workspaces.filter((id) => hit(search.workspaces[id]?.name)),
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

/**
 * How many threads are on exactly this worktree (a row's thread count): every thread whose
 * cwd it is, whether or not Claude runs for it, except archived ones (put away).
 */
export function worktreeThreadCount(threads: { order: readonly string[]; byId: Readonly<Record<string, Pick<ThreadView, "worktreePath" | "archivedAtMs"> | undefined>> }, path: string): number {
  if (!path) return 0;
  let n = 0;
  for (const id of threads.order) {
    const s = threads.byId[id];
    if (s?.worktreePath === path && s.archivedAtMs === null) n++;
  }
  return n;
}

/** p is root or inside it (snapshot paths: cleaned, symlinks resolved). */
function inside(p: string, root: string): boolean {
  if (!p || !root) return false;
  return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export interface CleanupThreads {
  order: readonly string[];
  byId: Readonly<Record<string, Pick<ThreadView, "archivedAtMs" | "worktreePath"> | undefined>>;
}

export interface CleanupTerminals {
  order: readonly string[];
  byId: Readonly<Record<string, Pick<TerminalView, "state" | "cwd" | "labels"> | undefined>>;
}

/**
 * A thread is on the worktree (its cwd is the worktree or inside it), whatever its state;
 * archived ones are put away: the daemon's cleanup guard (cleanupHold over
 * worktreeThreads) counts exactly those.
 */
export function threadHolds(threads: CleanupThreads, path: string): boolean {
  return threads.order.some((id) => {
    const s = threads.byId[id];
    return s !== undefined && s.archivedAtMs === null && inside(s.worktreePath, path);
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

/** The "in main" tag's tooltip. */
export function cleanableTitle(baseRef: string | undefined): string {
  return `Clean: no changes, its work is in ${baseRef || "origin/<default>"}, no thread or terminal on it`;
}
