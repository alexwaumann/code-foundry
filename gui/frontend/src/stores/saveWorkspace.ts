/**
 * "Save as workspace" (workspaces v2 handoff §6): a thread whose set has two or more
 * projects and matches no saved workspace can save the set as one. The dialog
 * (components/thread/SaveWorkspaceDialog.tsx) asks for a name; saving invokes
 * workspace.new with the thread's projects and its primary as the default primary, then
 * thread.workspace to make the new workspace the thread's reference. Two registry
 * commands; the dialog adds no user action of its own.
 */
import { create } from "zustand";
import { toast } from "sonner";
import { canSaveAsWorkspace, matchingWorkspace, WORKSPACE_PRIMARY } from "@/lib/projectSet";
import { runCommand, runCommandForResult } from "./commands";
import { THREAD_COMMANDS, threadContext } from "./threadActions";
import { useThreadsStore } from "./threads";
import { useWorkspacesStore } from "./workspaces";

interface SaveWorkspaceState {
  open: boolean;
  threadId: string;
  /** Incremented on every open, so the dialog's body starts fresh. */
  seq: number;
}

export const useSaveWorkspaceStore = create<SaveWorkspaceState>()(() => ({ open: false, threadId: "", seq: 0 }));

/** Whether "Save as workspace" applies to the thread (lib/projectSet canSaveAsWorkspace), as a narrow selector. */
export function useCanSaveAsWorkspace(threadId: string): boolean {
  const ids = useThreadsStore((s) => (s.byId[threadId]?.projectIds ?? []).join("\u0000"));
  // A thread in its workspace's folder (no project as its primary) belongs to that workspace.
  const inFolder = useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t !== undefined && t.projectId === "" && t.workspaceId !== "";
  });
  return useWorkspacesStore((s) => {
    const projectIds = ids ? ids.split("\u0000") : [];
    return canSaveAsWorkspace(
      projectIds,
      s.order.map((id) => ({ id, members: s.byId[id]?.members.map((m) => m.projectId) ?? [] })),
      inFolder,
    );
  });
}

/**
 * The saved workspace whose members are exactly the thread's set, when one exists and the
 * thread does not reference it (its id and name): the card offers "Use workspace <name>"
 * (thread.workspace) in place of saving the same set twice. null otherwise.
 */
export function useMatchingWorkspace(threadId: string): { id: string; name: string } | null {
  const ids = useThreadsStore((s) => (s.byId[threadId]?.projectIds ?? []).join("\u0000"));
  const current = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  const key = useWorkspacesStore((s) => {
    const projectIds = ids ? ids.split("\u0000") : [];
    if (projectIds.length < 2) return "";
    const w = matchingWorkspace(
      projectIds,
      s.order.map((id) => ({ id, members: s.byId[id]?.members.map((m) => m.projectId) ?? [] })),
    );
    return w && w.id !== current ? w.id + "\u0000" + (s.byId[w.id]?.name ?? "") : "";
  });
  if (!key) return null;
  const [id = "", name = ""] = key.split("\u0000");
  return { id, name: name || id };
}

/** Makes workspace `workspaceId` the thread's reference (thread.workspace): its set already matches. */
export function followWorkspace(threadId: string, workspaceId: string): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.setWorkspace, { workspace: workspaceId }, threadContext(threadId));
}

/** Opens the dialog for a thread. Deferred, so the menu that picked it finishes closing first. */
export function openSaveWorkspace(threadId: string): void {
  queueMicrotask(() => {
    useSaveWorkspaceStore.setState((s) => ({ open: true, threadId, seq: s.seq + 1 }));
  });
}

export function closeSaveWorkspace(): void {
  useSaveWorkspaceStore.setState({ open: false });
}

/** The workspace id in workspace.new's result JSON (the created Workspace), or "". */
function createdWorkspaceId(json: string): string {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && "id" in v && typeof v.id === "string" ? v.id : "";
  } catch {
    return "";
  }
}

/**
 * Saves the thread's set as workspace `name` (its primary the default primary; a thread
 * in a workspace's folder has none, and the daemon's default applies) and makes it the
 * thread's reference. Resolves to the error to show in the dialog, or null when saved.
 */
export async function saveThreadAsWorkspace(threadId: string, name: string): Promise<string | null> {
  const t = useThreadsStore.getState().byId[threadId];
  if (!t) return "This thread no longer exists.";
  const failure: { message: string | null } = { message: null };
  const args: Record<string, string> = { name: name.trim(), projects: t.projectIds.join(",") };
  if (t.projectId && t.projectId !== WORKSPACE_PRIMARY) args.primary = t.projectId;
  const created = await runCommandForResult("workspace.new", args, {
    quiet: true,
    ctx: threadContext(threadId),
    onError: (m) => {
      failure.message = m;
    },
    expected: () => true,
  });
  if (!created) return failure.message ?? "The workspace was not created.";
  const workspaceId = createdWorkspaceId(created.resultJson);
  if (!workspaceId) return null;
  // A failure here is toasted by runCommandForResult: the workspace exists, the thread just does not reference it.
  const set = await runCommandForResult(THREAD_COMMANDS.setWorkspace, { workspace: workspaceId }, { quiet: true, ctx: threadContext(threadId) });
  if (set) toast.success(`Saved workspace ${name.trim()}`);
  return null;
}
