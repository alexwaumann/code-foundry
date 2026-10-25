/**
 * A row the Projects page should move its keyboard cursor to once the row exists: the
 * cursor highlights the row and scrolls it into view (NavRow), the page's own way of
 * pointing at something. Set after Add as workspace, whose card arrives on the event
 * stream after the command answers; dropped after timeoutMs if the row never shows.
 */
import { create } from "zustand";

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

/** Drops the pending row if it is still `key` (the page moved its cursor there, or it never showed). */
export function clearProjectsPageReveal(key: string): void {
  useProjectsPageStore.setState((s) => (s.reveal === key ? { reveal: null } : s));
}
