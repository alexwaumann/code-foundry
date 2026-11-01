/**
 * A thread's project set from the thread info card (docs/notes/thread-project-set.md):
 * thread.project.add and thread.project.remove, the registry's commands. The daemon asks
 * before removing a member with uncommitted changes (the confirm dialog runCommand opens),
 * leaves the workspace the thread came from, and notes either in the timeline.
 */
import { create } from "zustand";
import { runCommandForResult } from "./commands";
import { threadContext } from "./threadActions";

/** The project each thread is adding right now (the daemon may be making its worktree), by thread id. */
export const useAddingProjectStore = create<{ byThread: Readonly<Record<string, string>> }>()(() => ({ byThread: {} }));

/** The project thread `threadId` is adding, "" while none. */
export function useAddingProject(threadId: string): string {
  return useAddingProjectStore((s) => s.byThread[threadId] ?? "");
}

function setAdding(threadId: string, projectId: string): void {
  useAddingProjectStore.setState((s) => ({
    byThread: projectId ? { ...s.byThread, [threadId]: projectId } : Object.fromEntries(Object.entries(s.byThread).filter(([id]) => id !== threadId)),
  }));
}

/**
 * Adds one project. The project row says "Adding <name>…" until the daemon answers (in
 * worktree mode it makes the worktree first, which takes a moment); the row's "+N" is the
 * result, a failure toasts.
 */
export async function addThreadProject(threadId: string, projectId: string): Promise<boolean> {
  setAdding(threadId, projectId);
  try {
    return (await runCommandForResult("thread.project.add", { project: projectId }, { ctx: threadContext(threadId), quiet: true })) !== null;
  } finally {
    setAdding(threadId, "");
  }
}

/** Removes a member that is not the cwd's; its checkout stays on disk. */
export async function removeThreadProject(threadId: string, projectId: string): Promise<boolean> {
  return (await runCommandForResult("thread.project.remove", { project: projectId }, { ctx: threadContext(threadId) })) !== null;
}
