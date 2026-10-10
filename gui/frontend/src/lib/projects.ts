/**
 * The Projects page's view models: every project (registered repository) with its own
 * worktrees, and every workspace with its members. A workspace's member worktrees are
 * listed under the workspace only, never under their project (one change stays in one
 * place). Pure; inputs are the repos and workspaces slices' shapes.
 */
import type { WorktreeView } from "@/api/repo";
import type { WorkspaceView } from "@/api/workspace";

export interface ProjectsRepos {
  byId: Readonly<Record<string, { id: string; name: string; worktrees: readonly Pick<WorktreeView, "path" | "isMain">[] } | undefined>>;
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

/** Projects that can be added to the workspace: registered and not yet members, by name. */
export function addableRepos(ws: Pick<WorkspaceView, "members"> | undefined, repos: ProjectsRepos): string[] {
  const inWs = new Set(ws?.members.map((m) => m.repoId) ?? []);
  return repos.order.filter((id) => !inWs.has(id) && repos.byId[id] !== undefined);
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

/** Every navigable row of the page in display order: projects and their worktrees, then workspaces and their members. */
export function pageItems(model: ProjectsModel, workspaces: ProjectsWorkspaces): PageItem[] {
  const out: PageItem[] = [];
  for (const p of model.projects) {
    out.push({ key: projectKey(p.repoId), kind: "project", repoId: p.repoId });
    for (const path of p.worktrees) out.push({ key: projectWorktreeKey(p.repoId, path), kind: "worktree", repoId: p.repoId, path });
  }
  for (const id of model.workspaces) {
    out.push({ key: workspaceKey(id), kind: "workspace", workspaceId: id });
    for (const m of workspaces.byId[id]?.members ?? []) out.push({ key: memberKey(id, m.repoId), kind: "member", workspaceId: id, repoId: m.repoId, path: m.worktreePath });
  }
  return out;
}
