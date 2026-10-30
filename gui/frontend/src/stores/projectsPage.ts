/**
 * A row the Projects page should move its keyboard cursor to once the row exists: the
 * cursor highlights the row and scrolls it into view (NavRow), the page's own way of
 * pointing at something. Set after Add as workspace, whose card arrives on the event
 * stream after the command answers; dropped after timeoutMs if the row never shows.
 */
import { create } from "zustand";
import { projectKey, projectWorktreeKey, workspaceKey } from "@/lib/projects";
import { mainWorktreePath, useProjectsStore } from "./projects";
import { useUiStore } from "./ui";

interface ProjectsPageState {
  /** The row's nav key (lib/projects.ts workspaceKey, projectKey, …), or null. */
  reveal: string | null;
}

export const useProjectsPageStore = create<ProjectsPageState>()(() => ({ reveal: null }));

export function revealOnProjectsPage(key: string, timeoutMs = 5000): void {
  useProjectsPageStore.setState({ reveal: key });
  setTimeout(() => {
    clearProjectsPageReveal(key);
  }, timeoutMs);
}

/**
 * Shows a workspace's card: the Projects page, its cursor on the card (scrolled into
 * view) once the card is there. A workspace just added.
 */
export function showWorkspaceCard(workspaceId: string): void {
  useUiStore.getState().select({ kind: "view", name: "projects" });
  revealOnProjectsPage(workspaceKey(workspaceId));
}

/**
 * Shows a project from anywhere (ui.focus.project, a project just added): the Projects
 * page, its cursor on the project's row, or on the worktree's row for a path other than
 * the main one. False for an unknown project.
 */
export function showProjectOnProjectsPage(projectId: string, path = ""): boolean {
  const projects = useProjectsStore.getState();
  if (!projects.byId[projectId]) return false;
  useUiStore.getState().select({ kind: "view", name: "projects" });
  revealOnProjectsPage(path && path !== mainWorktreePath(projects, projectId) ? projectWorktreeKey(projectId, path) : projectKey(projectId));
  return true;
}

/** Drops the pending row if it is still `key` (the page moved its cursor there, or it never showed). */
export function clearProjectsPageReveal(key: string): void {
  useProjectsPageStore.setState((s) => (s.reveal === key ? { reveal: null } : s));
}
