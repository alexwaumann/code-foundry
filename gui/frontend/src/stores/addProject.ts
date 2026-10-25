import { toast } from "sonner";
import { create } from "zustand";
import { inspectFolder, registerProject, type AddedProjectView, type FolderInfoView } from "@/api/addProject";
import { errorMessage } from "@/api/stream";
import { invokeConfirmed, refreshCommands } from "./commands";
import { deleteProject, type CreatedProject } from "./publish";
import { useProjectsStore } from "./projects";
import { useUiStore } from "./ui";
import { showWorktreeOnProjectsPage } from "./worktreePanel";

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
 * Opens the Add Project dialog (project.add's presenter; project.clone opens it on GitHub,
 * project.create on New), on Local folder unless the caller says. Deferred, so that a
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
 * again (project.delete), folder included.
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
 * over ProjectService.Register: resolves with the project's id and name. Errors reject with
 * the daemon's message; nothing is toasted (the dialog shows them in place). Commands
 * are refreshed afterwards so their When guards see the new project.
 */
export async function registerFolder(path: string): Promise<AddedProjectView> {
  try {
    return await registerProject(trimSlash(path));
  } finally {
    void refreshCommands();
  }
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The folder-of-repos scan (docs/notes/workspaces-v2-6-scan.md): the folder when it is not a
 * git repository but has git repositories directly inside it, so the dialog offers to add it
 * as a workspace; null otherwise. Null too when the daemon cannot say (a path it refuses):
 * the dialog then adds the folder as before, and Register reports the error.
 */
export async function folderOfRepos(path: string): Promise<FolderInfoView | null> {
  try {
    const f = await inspectFolder(trimSlash(path));
    return !f.isRepo && f.childRepos.length > 0 ? f : null;
  } catch {
    return null;
  }
}

/** A workspace project.add-workspace made. */
export interface AddedWorkspaceView {
  id: string;
  name: string;
}

/**
 * Adds a folder of repositories as a workspace (project.add-workspace): each repository
 * inside becomes a project, and a rooted workspace named after the folder holds them.
 * Errors reject with the daemon's message; nothing is toasted (the dialog shows them).
 */
export async function addFolderAsWorkspace(path: string): Promise<AddedWorkspaceView> {
  try {
    const res = await invokeConfirmed("project.add-workspace", { folder: trimSlash(path) });
    if (!res) throw new Error("cancelled");
    const w = JSON.parse(res.resultJson || "{}") as { id?: string; name?: string };
    if (!w.id) throw new Error(res.message || "the daemon did not say which workspace it made");
    return { id: w.id, name: w.name ?? w.id };
  } finally {
    void refreshCommands();
  }
}

/** Shows a workspace just added: the Projects page, which lists the workspaces. */
export function showAddedWorkspace(): void {
  useUiStore.getState().select({ kind: "view", name: "projects" });
}

/**
 * Shows a project just added (its overview) once the projects store has it: the command or
 * clone answers before the project event arrives on the event stream. Gives up after
 * timeoutMs (the user can open it from the Projects page).
 */
export function selectAddedProject(projectId: string, timeoutMs = 5000): void {
  if (useProjectsStore.getState().byId[projectId]) {
    showWorktreeOnProjectsPage(projectId);
    return;
  }
  const timer = setTimeout(() => {
    unsub();
  }, timeoutMs);
  const unsub = useProjectsStore.subscribe((s) => {
    if (!s.byId[projectId]) return;
    clearTimeout(timer);
    unsub();
    showWorktreeOnProjectsPage(projectId);
  });
}
