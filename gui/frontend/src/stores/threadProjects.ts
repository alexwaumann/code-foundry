/**
 * A thread's project set from the thread info card (docs/notes/thread-project-set.md):
 * thread.project.add and thread.project.remove, the registry's commands. The daemon asks
 * before removing a member with uncommitted changes (the confirm dialog runCommand opens),
 * leaves the workspace the thread came from, and notes either in the timeline.
 */
import { runCommandForResult } from "./commands";
import { threadContext } from "./threadActions";

/** Adds one project; the picker's checked row is the feedback, a failure toasts. */
export async function addThreadProject(threadId: string, projectId: string): Promise<boolean> {
  return (await runCommandForResult("thread.project.add", { project: projectId }, { ctx: threadContext(threadId), quiet: true })) !== null;
}

/** Removes a member that is not the cwd's; its checkout stays on disk. */
export async function removeThreadProject(threadId: string, projectId: string): Promise<boolean> {
  return (await runCommandForResult("thread.project.remove", { project: projectId }, { ctx: threadContext(threadId) })) !== null;
}
