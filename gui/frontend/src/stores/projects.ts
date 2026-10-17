import { create } from "zustand";
import type { ProjectEventView, ProjectView, WorktreeView } from "@/api/project";

export interface ProjectsData {
  byId: Readonly<Record<string, ProjectView>>;
  /** Project ids sorted by name. */
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
      return replaceProjects(ev.projects);
    case "projectUpdated": {
      const byId = { ...prev.byId, [ev.project.id]: normalizeProject(ev.project) };
      return { byId, order: sortedOrder(byId) };
    }
    case "projectRemoved": {
      if (!(ev.id in prev.byId)) return prev;
      const { [ev.id]: _removed, ...byId } = prev.byId;
      return { byId, order: prev.order.filter((id) => id !== ev.id) };
    }
    case "worktreeUpdated": {
      const w = ev.worktree;
      const project = prev.byId[w.projectId];
      if (!project) return prev; // the project event will carry it
      const rest = project.worktrees.filter((x) => x.path !== w.path);
      const next = { ...project, worktrees: sortWorktrees([...rest, w]) };
      return { byId: { ...prev.byId, [project.id]: next }, order: prev.order };
    }
    case "worktreeRemoved": {
      const project = prev.byId[ev.projectId];
      if (!project?.worktrees.some((x) => x.path === ev.path)) return prev;
      const next = { ...project, worktrees: project.worktrees.filter((x) => x.path !== ev.path) };
      return { byId: { ...prev.byId, [project.id]: next }, order: prev.order };
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
  const project = data.byId[projectId];
  return project?.worktrees.find((w) => w.isMain)?.path ?? project?.path ?? "";
}
