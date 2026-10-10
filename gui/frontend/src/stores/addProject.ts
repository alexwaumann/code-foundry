import { toast } from "sonner";
import { create } from "zustand";
import { registerRepo, type AddedProjectView } from "@/api/addProject";
import { errorMessage } from "@/api/stream";
import { refreshCommands } from "./commands";
import { openProject } from "./projectActions";
import { deleteProject, type CreatedProject } from "./publish";
import { useReposStore } from "./repos";

/** The Add Project dialog's tabs, in display order. */
export type AddProjectTab = "new" | "local" | "github";

export const addProjectTabs: readonly AddProjectTab[] = ["new", "local", "github"];

interface AddProjectState {
  open: boolean;
  tab: AddProjectTab;
  /** Incremented on every open, so the dialog's body starts fresh. */
  seq: number;
  /**
   * A project the New tab created that is not kept or published yet (its publish was
   * refused). Closing the dialog any other way than Keep it local or a successful
   * publish deletes it again.
   */
  created: CreatedProject | null;
  /** The New tab is creating or publishing: the dialog cannot be closed meanwhile. */
  busy: boolean;
}

export const useAddProjectStore = create<AddProjectState>()(() => ({ open: false, tab: "local", seq: 0, created: null, busy: false }));

/**
 * Opens the Add Project dialog (repo.add's presenter; repo.clone opens it on GitHub,
 * repo.create on New), on Local folder unless the caller says. Deferred, so that a
 * palette closing after its presenter ran does not take focus back from the dialog.
 */
export function openAddProject(tab: AddProjectTab = "local"): void {
  queueMicrotask(() => {
    useAddProjectStore.setState((s) => ({ open: true, tab, seq: s.seq + 1, created: null, busy: false }));
  });
}

/**
 * Cancels the dialog (Escape, the overlay, the close button). Ignored while the New tab
 * is creating or publishing. A project the New tab created and did not keep is deleted
 * again (repo.delete), folder included.
 */
export function closeAddProject(): void {
  const s = useAddProjectStore.getState();
  if (!s.open || s.busy) return;
  useAddProjectStore.setState({ open: false, created: null });
  if (s.created) void discardCreated(s.created);
}

/** Closes the dialog keeping what it made (a project added, created, kept or published). */
export function finishAddProject(): void {
  useAddProjectStore.setState({ open: false, created: null, busy: false });
}

/** The New tab's project awaiting Keep it local or a publish (null once decided). */
export function setCreatedProject(created: CreatedProject | null): void {
  useAddProjectStore.setState({ created });
}

export function setAddProjectBusy(busy: boolean): void {
  useAddProjectStore.setState({ busy });
}

async function discardCreated(p: CreatedProject): Promise<void> {
  try {
    await deleteProject(p.id);
    toast(`Deleted ${p.name}`, { description: "The project was not kept." });
  } catch (err) {
    toast.error(`Could not delete ${p.name}: ${errorMessage(err)}`);
  }
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
