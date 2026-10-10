import { create } from "zustand";
import type { Visibility } from "@/lib/publish";
import { invokeConfirmed, refreshCommands } from "./commands";
import { getUiContext } from "./context";
import { useReposStore } from "./repos";

/**
 * Creating a project (repo.create, the Add Project dialog's New tab) and publishing one
 * to GitHub (repo.github.publish: the New tab's second step, and the publish dialog the
 * overview's Publish to GitHub button and the palette open). Errors reject with the
 * daemon's message, which for a refused publish is gh's own words; nothing is toasted
 * here (the dialogs show errors in place).
 */

interface PublishDialogState {
  open: boolean;
  repoId: string;
  /** Incremented on every open, so the dialog's body starts fresh. */
  seq: number;
}

export const usePublishDialogStore = create<PublishDialogState>()(() => ({ open: false, repoId: "", seq: 0 }));

/**
 * Opens the publish dialog for a project (repo.github.publish's presenter). False when
 * there is no such project, so the command falls back to its prompts. Deferred like
 * openAddProject, so a palette closing after its presenter ran keeps focus off.
 */
export function openPublishDialog(repoId: string): boolean {
  if (!repoId || !useReposStore.getState().byId[repoId]) return false;
  queueMicrotask(() => {
    usePublishDialogStore.setState((s) => ({ open: true, repoId, seq: s.seq + 1 }));
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

/** repo.create: a new project in the projects directory, git initialized. */
export async function createProject(name: string): Promise<CreatedProject> {
  try {
    const res = await invokeConfirmed("repo.create", { name });
    if (!res) throw new Error("cancelled");
    const repo = JSON.parse(res.resultJson || "{}") as { id?: string; name?: string; path?: string };
    if (!repo.id) throw new Error(res.message || "the daemon did not say which project it created");
    return { id: repo.id, name: repo.name ?? name, path: repo.path ?? "" };
  } finally {
    void refreshCommands();
  }
}

export interface PublishRequest {
  repoId: string;
  owner: string;
  /** GitHub repository name; the project's name when empty. */
  name: string;
  visibility: Visibility;
}

/**
 * repo.github.publish for one project. The context names only that project, so the
 * daemon judges availability (git, no origin) for it and not for what is selected.
 */
export async function publishProject(req: PublishRequest): Promise<string> {
  const ctx = { ...getUiContext(), activeRepoId: req.repoId, activeWorktreePath: "", activeSessionId: "", activeTerminalId: "", activeWorkspaceId: "" };
  try {
    const res = await invokeConfirmed("repo.github.publish", { repo: req.repoId, owner: req.owner, name: req.name, visibility: req.visibility }, ctx);
    if (!res) throw new Error("cancelled");
    return res.message;
  } finally {
    void refreshCommands();
  }
}
