/**
 * The Projects view's own state outside the UI store: a row a page should move its
 * keyboard cursor to once the row exists (the cursor highlights the row and scrolls it
 * into view, NavRow), and each page's scroll position (in memory only, by panel key, so
 * coming back to a page finds it where it was).
 */
import { create } from "zustand";
import { projectWorktreeKey } from "@/lib/projects";
import { useProjectsStore } from "./projects";
import { projectPage, useUiStore, workspacePage } from "./ui";

interface ProjectsPageState {
  /** The row's nav key (lib/projects.ts workspaceKey, projectKey, projectWorktreeKey), or null. */
  reveal: string | null;
}

export const useProjectsPageStore = create<ProjectsPageState>()(() => ({ reveal: null }));

export function revealOnProjectsPage(key: string, timeoutMs = 5000): void {
  useProjectsPageStore.setState({ reveal: key });
  setTimeout(() => {
    clearProjectsPageReveal(key);
  }, timeoutMs);
}

/** Shows a workspace's page (a workspace just added, or picked); the keyboard is on the page's list, no row picked. */
export function showWorkspacePage(workspaceId: string): void {
  useUiStore.getState().select(workspacePage(workspaceId));
}

/**
 * Shows a project from anywhere (ui.focus.project, a project just added): its page, the
 * cursor on the worktree's checkout row for a path given. False for an unknown project.
 */
export function showProjectOnProjectsPage(projectId: string, path = ""): boolean {
  const projects = useProjectsStore.getState();
  if (!projects.byId[projectId]) return false;
  useUiStore.getState().select(projectPage(projectId));
  if (path) revealOnProjectsPage(projectWorktreeKey(projectId, path));
  return true;
}

/** Drops the pending row if it is still `key` (the page moved its cursor there, or it never showed). */
export function clearProjectsPageReveal(key: string): void {
  useProjectsPageStore.setState((s) => (s.reveal === key ? { reveal: null } : s));
}

/** Each page's scroll offset by its panel key; not persisted (a reload starts at the top). */
const scrollTops = new Map<string, number>();

export function savedScrollTop(key: string): number {
  return scrollTops.get(key) ?? 0;
}

export function saveScrollTop(key: string, top: number): void {
  if (top > 0) scrollTops.set(key, top);
  else scrollTops.delete(key);
}
