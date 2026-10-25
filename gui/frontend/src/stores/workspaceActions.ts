/**
 * Actions behind the Projects page's workspace cards (docs/notes/workspaces-v2-4-projects-page.md).
 * Each is a registry command (workspace.*, thread.new, thread.send) invoked with explicit
 * args and the page's context, so the palette and the CLI reach the same code; opening
 * the instructions file is a File tab (GUI state, like a path chip).
 */
import { toast } from "sonner";
import { create } from "zustand";
import type { UiContextView } from "@/api/command";
import { createdThreadId } from "@/lib/compose";
import { threadLabel } from "@/lib/prompt";
import { editInstructionsPrompt, instructionsStep, PRIMARY_WORKSPACE, workspaceFolder } from "@/lib/workspaceCard";
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

/**
 * workspace.set-primary: a member project by its id, or the workspace's own folder
 * (PRIMARY_WORKSPACE). Never the project's name: the daemon reads "workspace" in any case
 * as the folder, so a project named so would set the folder (ids never collide with it).
 */
export function setWorkspacePrimary(workspaceId: string, primary: string): Promise<boolean> {
  return runCommand("workspace.set-primary", { primary, workspace: workspaceId }, workspaceContext(workspaceId));
}

/** workspace.add-project, by the project's id: nothing on disk changes. */
export function addWorkspaceProject(workspaceId: string, projectId: string): Promise<boolean> {
  return runCommand("workspace.add-project", { project: projectId, workspace: workspaceId }, workspaceContext(workspaceId));
}

/** workspace.remove-project, by the project's id (an unregistered member too): nothing on disk changes; threads keep their projects. */
export function removeWorkspaceProject(workspaceId: string, projectId: string): Promise<boolean> {
  return runCommand("workspace.remove-project", { project: projectId, workspace: workspaceId }, workspaceContext(workspaceId));
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

/** Per workspace, the thread the last "Edit instructions" press sent to or started (lib/workspaceCard.ts instructionsStep). */
const lastEdit = new Map<string, string>();

/** Test hook: forget every press. */
export function resetInstructionsPresses(): void {
  lastEdit.clear();
}

function selectThread(id: string): void {
  useUiStore.getState().select({ kind: "thread", id });
}

/**
 * "Edit instructions" (lib/workspaceCard.ts instructionsStep): steers the user's thread
 * already in the workspace's folder and selects it, else starts one there (thread.new
 * --workspace <id> --project workspace, in the members' own checkouts: it edits
 * instructions, not code, so no worktrees are made) with the file as context; the daemon
 * focuses a new thread itself. While the thread a press sent to is still live, a press
 * only selects it (no second copy of the prompt). The steer's toast names the thread:
 * thread.send's own message is the CLI's ("wait with: code-foundry thread wait …").
 */
export async function editWorkspaceInstructions(workspaceId: string): Promise<boolean> {
  const ws = useWorkspacesStore.getState().byId[workspaceId];
  if (!ws) return false;
  const step = instructionsStep(useThreadsStore.getState(), ws, lastEdit.get(workspaceId) ?? "");
  if (step.kind === "focus") {
    selectThread(step.id);
    return true;
  }
  const prompt = editInstructionsPrompt(ws);
  if (step.kind === "steer") {
    const res = await runCommandForResult("thread.send", { text: prompt }, { ctx: { ...emptyContext, activeView: "thread", activeThreadId: step.id, activeWorkspaceId: workspaceId }, quiet: true });
    if (!res) return false;
    lastEdit.set(workspaceId, step.id);
    selectThread(step.id);
    toast.success(`Sent to ${threadLabel(useThreadsStore.getState().byId[step.id]?.name ?? "", step.id)}`);
    return true;
  }
  const res = await runCommandForResult(
    "thread.new",
    { workspace: workspaceId, project: PRIMARY_WORKSPACE, "new-worktree": "false", prompt },
    // The composer's context (thread.new is offered there with no project, as for a workspace without one).
    { ctx: { ...emptyContext, activeView: "compose", activeWorkspaceId: workspaceId }, quiet: true },
  );
  if (!res) return false;
  const id = createdThreadId(res.resultJson);
  if (id) lastEdit.set(workspaceId, id);
  return true;
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
