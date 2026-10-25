/**
 * Actions behind the Projects page's workspace cards (docs/notes/workspaces-v2-4-projects-page.md).
 * Each is a registry command (workspace.*, thread.new, thread.send) invoked with explicit
 * args and the page's context, so the palette and the CLI reach the same code; opening
 * the instructions file is a File tab (GUI state, like a path chip).
 */
import { create } from "zustand";
import type { UiContextView } from "@/api/command";
import { editInstructionsPrompt, instructionsThread, PRIMARY_WORKSPACE, workspaceFolder } from "@/lib/workspaceCard";
import { projectRef } from "@/lib/projects";
import { runCommand, runCommandForResult } from "./commands";
import { emptyContext } from "./context";
import { openFileInPanel } from "./filePanel";
import { togglePanel } from "./panel";
import { useProjectsStore } from "./projects";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";
import { useWorkspacesStore } from "./workspaces";

/** The context of an action on one workspace from the Projects page: no selection involved. */
export function workspaceContext(workspaceId: string): UiContextView {
  return { ...emptyContext, activeView: "projects", activeWorkspaceId: workspaceId };
}

function ref(projectId: string): string {
  return projectRef(useProjectsStore.getState(), projectId);
}

/** workspace.rename. */
export function renameWorkspace(workspaceId: string, name: string): Promise<boolean> {
  return runCommand("workspace.rename", { name: name.trim(), workspace: workspaceId }, workspaceContext(workspaceId));
}

/** workspace.set-primary: a member project, or the workspace's own folder (PRIMARY_WORKSPACE). */
export function setWorkspacePrimary(workspaceId: string, primary: string): Promise<boolean> {
  return runCommand("workspace.set-primary", { primary: primary === PRIMARY_WORKSPACE ? PRIMARY_WORKSPACE : ref(primary), workspace: workspaceId }, workspaceContext(workspaceId));
}

/** workspace.add-project: nothing on disk changes. */
export function addWorkspaceProject(workspaceId: string, projectId: string): Promise<boolean> {
  return runCommand("workspace.add-project", { project: ref(projectId), workspace: workspaceId }, workspaceContext(workspaceId));
}

/** workspace.remove-project: nothing on disk changes; threads keep their projects. */
export function removeWorkspaceProject(workspaceId: string, projectId: string): Promise<boolean> {
  return runCommand("workspace.remove-project", { project: ref(projectId), workspace: workspaceId }, workspaceContext(workspaceId));
}

/** workspace.remove (the daemon confirms: a synthetic workspace's instructions and skills go too). Named by name, which reads better in the prompt. */
export function removeWorkspace(workspaceId: string): Promise<boolean> {
  const name = useWorkspacesStore.getState().byId[workspaceId]?.name ?? workspaceId;
  return runCommand("workspace.remove", { workspace: name }, workspaceContext(workspaceId));
}

/** workspace.reveal: its root, else its own folder, in Finder. */
export function revealWorkspace(workspaceId: string): Promise<boolean> {
  return runCommand("workspace.reveal", { workspace: workspaceId }, workspaceContext(workspaceId));
}

/** The instructions file as a File tab in the page's side panel (shown, not focused, like the page's worktree rows). */
export function openWorkspaceInstructions(workspaceId: string): boolean {
  const ws = useWorkspacesStore.getState().byId[workspaceId];
  if (!ws?.instructions) return false;
  if (!openFileInPanel("current", { project: "", base: workspaceFolder(ws), path: ws.instructions })) return false;
  togglePanel("current", true, { focus: false });
  return true;
}

/**
 * "Edit instructions": steers the user's thread already in the workspace's folder
 * (lib/workspaceCard.ts instructionsThread) and selects it, else starts one there
 * (thread.new --workspace <id> --project workspace, in the members' own checkouts: it
 * edits instructions, not code, so no worktrees are made) with the file as context.
 * The daemon focuses a new thread itself.
 */
export async function editWorkspaceInstructions(workspaceId: string): Promise<boolean> {
  const ws = useWorkspacesStore.getState().byId[workspaceId];
  if (!ws) return false;
  const prompt = editInstructionsPrompt(ws);
  const existing = instructionsThread(useThreadsStore.getState(), ws);
  if (existing) {
    const sel = { kind: "thread" as const, id: existing };
    const ok = await runCommand("thread.send", { text: prompt }, { ...emptyContext, activeView: "thread", activeThreadId: existing, activeWorkspaceId: workspaceId });
    if (ok) useUiStore.getState().select(sel);
    return ok;
  }
  const res = await runCommandForResult(
    "thread.new",
    { workspace: workspaceId, project: PRIMARY_WORKSPACE, "new-worktree": "false", prompt },
    { ctx: workspaceContext(workspaceId), quiet: true },
  );
  return res !== null;
}

/**
 * workspace.new with its members (the New workspace dialog). Resolves with the daemon's
 * error message on failure (shown in the dialog), "" on success.
 */
export async function createWorkspace(name: string, projectIds: readonly string[]): Promise<string> {
  let error = "";
  const res = await runCommandForResult(
    "workspace.new",
    { name: name.trim(), projects: projectIds.map(ref).join(",") },
    {
      ctx: { ...emptyContext, activeView: "projects" },
      quiet: true,
      onError: (m) => {
        error = m;
      },
      expected: () => true,
    },
  );
  return res ? "" : error || "cancelled";
}

interface NewWorkspaceDialogState {
  open: boolean;
  /** Incremented on every open, so the dialog's body starts fresh. */
  seq: number;
}

export const useNewWorkspaceDialogStore = create<NewWorkspaceDialogState>()(() => ({ open: false, seq: 0 }));

/** workspace.new's presenter (the page's New workspace button, the palette): the dialog. Deferred like openPublishDialog. */
export function openNewWorkspaceDialog(): boolean {
  queueMicrotask(() => {
    useNewWorkspaceDialogStore.setState((s) => ({ open: true, seq: s.seq + 1 }));
  });
  return true;
}

export function closeNewWorkspaceDialog(): void {
  useNewWorkspaceDialogStore.setState({ open: false });
}
