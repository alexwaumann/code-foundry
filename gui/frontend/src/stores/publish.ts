import { create } from "zustand";
import { invokeCommand } from "@/api/command";
import type { Visibility } from "@/lib/publish";
import { invokeConfirmed, refreshCommands } from "./commands";
import { getUiContext } from "./context";
import { useProjectsStore } from "./projects";

/**
 * Creating a project (project.create, the Add Project dialog's New tab), publishing one to
 * GitHub (project.github.publish: the New tab's second step, and the publish dialog the
 * overview's Publish to GitHub button and the palette open) and deleting one the New
 * tab made and then cancelled (project.delete). Errors reject with the daemon's message,
 * which for a refused publish is gh's own words; nothing is toasted here (the dialogs
 * show errors in place).
 */

interface PublishDialogState {
  open: boolean;
  projectId: string;
  /** Incremented on every open, so the dialog's body starts fresh. */
  seq: number;
}

export const usePublishDialogStore = create<PublishDialogState>()(() => ({ open: false, projectId: "", seq: 0 }));

/**
 * Opens the publish dialog for a project (project.github.publish's presenter). False when
 * there is no such project, so the command falls back to its prompts. Deferred like
 * openAddProject, so a palette closing after its presenter ran keeps focus off.
 */
export function openPublishDialog(projectId: string): boolean {
  if (!projectId || !useProjectsStore.getState().byId[projectId]) return false;
  queueMicrotask(() => {
    usePublishDialogStore.setState((s) => ({ open: true, projectId, seq: s.seq + 1 }));
  });
  return true;
}

export function closePublishDialog(): void {
  usePublishDialogStore.setState({ open: false });
}

export interface CreatedProject {
  id: string;
  name: string;
  path: string;
}

/** project.create: a new project in the projects directory, git initialized. */
export async function createProject(name: string): Promise<CreatedProject> {
  try {
    const res = await invokeConfirmed("project.create", { name });
    if (!res) throw new Error("cancelled");
    const project = JSON.parse(res.resultJson || "{}") as { id?: string; name?: string; path?: string };
    if (!project.id) throw new Error(res.message || "the daemon did not say which project it created");
    return { id: project.id, name: project.name ?? name, path: project.path ?? "" };
  } finally {
    void refreshCommands();
  }
}

export interface PublishRequest {
  projectId: string;
  owner: string;
  /** GitHub repository name; the project's name when empty. */
  name: string;
  visibility: Visibility;
}

/**
 * project.github.publish for one project. The context names only that project, so the
 * daemon judges availability (git, no origin) for it and not for what is selected.
 */
export async function publishProject(req: PublishRequest): Promise<string> {
  const ctx = { ...getUiContext(), activeProjectId: req.projectId, activeWorktreePath: "", activeThreadId: "", activeTerminalId: "", activeWorkspaceId: "" };
  try {
    const res = await invokeConfirmed("project.github.publish", { project: req.projectId, owner: req.owner, name: req.name, visibility: req.visibility }, ctx);
    if (!res) throw new Error("cancelled");
    return res.message;
  } finally {
    void refreshCommands();
  }
}

/**
 * project.delete for a project the New tab created: unregisters it and removes its folder.
 * Invoked as already confirmed: the user cancelled the dialog, which is the decision.
 */
export async function deleteProject(projectId: string): Promise<void> {
  const ctx = { ...getUiContext(), activeProjectId: projectId, activeWorktreePath: "", activeThreadId: "", activeTerminalId: "", activeWorkspaceId: "" };
  try {
    await invokeCommand("project.delete", ctx, { project: projectId }, undefined, { confirmed: true });
  } finally {
    void refreshCommands();
  }
}
