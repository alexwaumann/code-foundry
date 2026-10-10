import { create } from "zustand";
import { registerRepo, type AddedProjectView } from "@/api/addProject";
import { refreshCommands } from "./commands";
import { openProject } from "./projectActions";
import { useReposStore } from "./repos";

/** The Add Project dialog's tabs, in display order. */
export type AddProjectTab = "new" | "local" | "github";

export const addProjectTabs: readonly AddProjectTab[] = ["new", "local", "github"];

interface AddProjectState {
  open: boolean;
  tab: AddProjectTab;
  /** Incremented on every open, so the dialog's body starts fresh. */
  seq: number;
}

export const useAddProjectStore = create<AddProjectState>()(() => ({ open: false, tab: "local", seq: 0 }));

/**
 * The tab the dialog opens on when the caller does not say: New when there are no
 * projects yet (start one), else Local folder.
 */
export function defaultAddProjectTab(projectCount: number): AddProjectTab {
  return projectCount === 0 ? "new" : "local";
}

/**
 * Opens the Add Project dialog (repo.add's presenter; repo.clone opens it on GitHub).
 * Deferred, so that a palette closing after its presenter ran does not take focus back
 * from the dialog.
 */
export function openAddProject(tab: AddProjectTab = defaultAddProjectTab(useReposStore.getState().order.length)): void {
  queueMicrotask(() => {
    useAddProjectStore.setState((s) => ({ open: true, tab, seq: s.seq + 1 }));
  });
}

export function closeAddProject(): void {
  useAddProjectStore.setState({ open: false });
}

export function setAddProjectTab(tab: AddProjectTab): void {
  useAddProjectStore.setState({ tab });
}

/**
 * Adds a folder as a project (the Local folder tab, and an existing clone destination)
 * over RepoService.Register: resolves with the project's id and name. Errors reject with
 * the daemon's message; nothing is toasted (the dialog shows them in place). Commands
 * are refreshed afterwards so their When guards see the new project.
 */
export async function registerFolder(path: string): Promise<AddedProjectView> {
  try {
    return await registerRepo(path.length > 1 ? path.replace(/\/+$/, "") : path);
  } finally {
    void refreshCommands();
  }
}

/**
 * Shows a project just added (its overview) once the repos store has it: the command or
 * clone answers before the repo event arrives on the event stream. Gives up after
 * timeoutMs (the user can open it from the Projects page).
 */
export function selectAddedProject(repoId: string, timeoutMs = 5000): void {
  if (useReposStore.getState().byId[repoId]) {
    openProject(repoId);
    return;
  }
  const timer = setTimeout(() => {
    unsub();
  }, timeoutMs);
  const unsub = useReposStore.subscribe((s) => {
    if (!s.byId[repoId]) return;
    clearTimeout(timer);
    unsub();
    openProject(repoId);
  });
}
