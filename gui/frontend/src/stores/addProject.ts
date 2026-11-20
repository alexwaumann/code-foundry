import { notify } from "@/lib/notify";
import { create } from "zustand";
import { inspectFolder, registerProject, type AddedProjectView, type FolderInfoView } from "@/api/addProject";
import { errorMessage } from "@/api/stream";
import { invokeConfirmed, refreshCommands } from "./commands";
import { deleteProject, type CreatedProject } from "./publish";
import { useProjectsStore } from "./projects";
import { showWorkspacePage } from "./projectsPage";
import { showProjectOnProjectsPage } from "./projectsPage";

/** The Add Project dialog's tabs, in display order. */
export type AddProjectTab = "new" | "local" | "github";

interface AddProjectState {
  open: boolean;
  tab: AddProjectTab;
  /** Incremented on every open, so the dialog's body starts fresh. */
  seq: number;
  /**
   * The project the New tab created this opening (its publish may have been refused).
   * Cancelling the dialog deletes it again; Keep it local or a successful publish closes the
   * dialog keeping it. The New tab shows it from here, the one place it is kept: reset on
   * each opening, left as it was on close so the closing dialog still shows it.
   */
  created: CreatedProject | null;
  /** What the New tab is doing; while it creates or publishes, the dialog cannot be closed. */
  busy: NewProjectBusy;
  /**
   * The dialog was opened by project.add's intent (a page in a thread, or the CLI): what it
   * adds is not shown on the Projects page, so the window stays where it is. Kept until the
   * next open.
   */
  stay: boolean;
}

/** The New tab's call in flight: project.create, project.github.publish, or none. */
export type NewProjectBusy = "create" | "publish" | null;

export const useAddProjectStore = create<AddProjectState>()(() => ({ open: false, tab: "local", seq: 0, created: null, busy: null, stay: false }));

export interface OpenAddProjectOptions {
  /** Do not move the window to what gets added (see AddProjectState.stay). */
  stay?: boolean;
}

/**
 * Opens the Add Project dialog (project.add's presenter; project.clone opens it on GitHub,
 * project.create on New), on Local folder unless the caller says. Deferred, so that a
 * palette closing after its presenter ran does not take focus back from the dialog.
 */
export function openAddProject(tab: AddProjectTab = "local", { stay = false }: OpenAddProjectOptions = {}): void {
  queueMicrotask(() => {
    useAddProjectStore.setState((s) => ({ open: true, tab, seq: s.seq + 1, created: null, busy: null, stay }));
  });
}

/**
 * Cancels the dialog (Escape, the overlay, the close button). Ignored while the New tab
 * is creating or publishing. A project the New tab created and did not keep is deleted
 * again (project.delete), folder included.
 */
export function closeAddProject(): void {
  const s = useAddProjectStore.getState();
  if (!s.open || s.busy !== null) return;
  useAddProjectStore.setState({ open: false });
  if (s.created) void discardCreated(s.created);
}

/** Closes the dialog keeping what it made (a project added, created, kept or published). */
export function finishAddProject(): void {
  useAddProjectStore.setState({ open: false });
}

/**
 * The success toast for what the dialog added ("Added api"), only when the window stays
 * where it is (`stay`: a page or the CLI opened it). Otherwise the dialog closes onto the
 * new project or workspace (selectAddedProject, showAddedWorkspace), which shows it.
 */
export function noticeAdded(n: { title: string; description?: string }): void {
  if (useAddProjectStore.getState().stay) notify({ level: "success", ...n });
}

/**
 * The New tab's step (what it created, what it is doing) for the opening it started in
 * (`seq`): an answer that arrives after the dialog was opened again changes nothing, as the
 * tab it belonged to is gone.
 */
export function setNewProjectStep(seq: number, step: Partial<Pick<AddProjectState, "created" | "busy">>): void {
  if (useAddProjectStore.getState().seq === seq) useAddProjectStore.setState(step);
}

async function discardCreated(p: CreatedProject): Promise<void> {
  try {
    await deleteProject(p.id);
    notify({ level: "info", title: `Deleted ${p.name}`, description: "The project was not kept." });
  } catch (err) {
    notify({ level: "error", title: `Could not delete ${p.name}`, description: errorMessage(err) });
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

/** A step inside a tab that Escape leaves before it closes the dialog (the Local folder tab's two choices). */
let escapeBack: (() => void) | null = null;

/** Registers the step's way back while it shows; returns the unregister. */
export function onAddProjectEscape(back: () => void): () => void {
  escapeBack = back;
  return () => {
    if (escapeBack === back) escapeBack = null;
  };
}

/** The dialog's Escape: true when a step went back (the dialog stays open). */
export function addProjectEscapeBack(): boolean {
  if (!escapeBack) return false;
  escapeBack();
  return true;
}

/**
 * Shows a workspace just added: the Projects page, its cursor on the new card (scrolled into
 * view) once the card is there. Nothing when the dialog was opened to stay.
 */
export function showAddedWorkspace(workspaceId: string): void {
  if (useAddProjectStore.getState().stay) return;
  showWorkspacePage(workspaceId);
}

/**
 * Shows a project just added (its row on the Projects page) once the projects store has it: the command or
 * clone answers before the project event arrives on the event stream. Gives up after
 * timeoutMs (the user can open it from the Projects page). Nothing when the dialog was
 * opened to stay: the project shows wherever projects are listed.
 */
export function selectAddedProject(projectId: string, timeoutMs = 5000): void {
  if (useAddProjectStore.getState().stay) return;
  if (useProjectsStore.getState().byId[projectId]) {
    showProjectOnProjectsPage(projectId);
    return;
  }
  const timer = setTimeout(() => {
    unsub();
  }, timeoutMs);
  const unsub = useProjectsStore.subscribe((s) => {
    if (!s.byId[projectId]) return;
    clearTimeout(timer);
    unsub();
    showProjectOnProjectsPage(projectId);
  });
}
