import { create } from "zustand";
import type { ProjectEventView, ProjectView, WorktreeView } from "@/api/project";

export interface ProjectsData {
  byId: Readonly<Record<string, ProjectView>>;
  /** Repo ids sorted by name. */
  order: readonly string[];
}

interface ProjectsState extends ProjectsData {
  loaded: boolean;
}

export const emptyProjects: ProjectsData = { byId: {}, order: [] };

/** Main worktree first, then by branch (falling back to path). */
export function sortWorktrees(ws: readonly WorktreeView[]): WorktreeView[] {
  return [...ws].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return (a.branch || a.path).localeCompare(b.branch || b.path);
  });
}

function sortedOrder(byId: Readonly<Record<string, ProjectView>>): string[] {
  return Object.values(byId)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((r) => r.id);
}

function normalizeProject(r: ProjectView): ProjectView {
  return { ...r, worktrees: sortWorktrees(r.worktrees) };
}

export function replaceProjects(list: readonly ProjectView[]): ProjectsData {
  const byId: Record<string, ProjectView> = {};
  for (const r of list) byId[r.id] = normalizeProject(r);
  return { byId, order: sortedOrder(byId) };
}

export function applyProjectEvent(prev: ProjectsData, ev: ProjectEventView): ProjectsData {
  switch (ev.kind) {
    case "snapshot":
      return replaceProjects(ev.repos);
    case "projectUpdated": {
      const byId = { ...prev.byId, [ev.repo.id]: normalizeProject(ev.repo) };
      return { byId, order: sortedOrder(byId) };
    }
    case "projectRemoved": {
      if (!(ev.id in prev.byId)) return prev;
      const { [ev.id]: _removed, ...byId } = prev.byId;
      return { byId, order: prev.order.filter((id) => id !== ev.id) };
    }
    case "worktreeUpdated": {
      const w = ev.worktree;
      const repo = prev.byId[w.projectId];
      if (!repo) return prev; // the repo event will carry it
      const rest = repo.worktrees.filter((x) => x.path !== w.path);
      const next = { ...repo, worktrees: sortWorktrees([...rest, w]) };
      return { byId: { ...prev.byId, [repo.id]: next }, order: prev.order };
    }
    case "worktreeRemoved": {
      const repo = prev.byId[ev.projectId];
      if (!repo?.worktrees.some((x) => x.path === ev.path)) return prev;
      const next = { ...repo, worktrees: repo.worktrees.filter((x) => x.path !== ev.path) };
      return { byId: { ...prev.byId, [repo.id]: next }, order: prev.order };
    }
    case "worktreeDetailUpdated":
      return prev;
  }
}

/** Fed by the shared events stream (stores/events.ts). */
export const useProjectsStore = create<ProjectsState>()(() => ({
  ...emptyProjects,
  loaded: false,
}));

export function findWorktree(data: ProjectsData, projectId: string, path: string): WorktreeView | undefined {
  return data.byId[projectId]?.worktrees.find((w) => w.path === path);
}

/** A project's main worktree path (its checkout for a project without git); "" for an unknown project. */
export function mainWorktreePath(data: ProjectsData, projectId: string): string {
  const repo = data.byId[projectId];
  return repo?.worktrees.find((w) => w.isMain)?.path ?? repo?.path ?? "";
}
