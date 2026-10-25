/**
 * ThreadService.Checkouts: one checkout per project in a thread's set (the primary at its
 * cwd; in worktree mode a git member's worktree on the thread's branch, a plain folder
 * the folder; otherwise each member's own checkout). The Worktree tab's "Also in" list
 * reads it (docs/notes/workspaces-v2-4-projects-page.md). Generated types stay here.
 */
import { ThreadService } from "@/gen/codefoundry/v1/thread_pb";
import type { ThreadCheckout } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { daemon, type DaemonConnection } from "./endpoint";

export interface ThreadCheckoutView {
  projectId: string;
  /** "" when the project is no longer registered. */
  projectName: string;
  /** "" when nothing can be derived (the project is no longer registered). */
  path: string;
  /** Checked out there now; for a worktree not made yet, the thread's branch. "" for a plain folder. */
  branch: string;
  /** The thread's cwd. */
  primary: boolean;
  /** The path does not exist (a worktree not made yet, or removed). */
  missing: boolean;
  /** The project has git (false: a plain folder). */
  git: boolean;
  /** A worktree-mode git member: made by the app at the next start when missing. */
  derived: boolean;
}

export interface ThreadCheckoutsView {
  checkouts: ThreadCheckoutView[];
  workspaceId: string;
  workspaceName: string;
}

export function toThreadCheckoutView(c: ThreadCheckout): ThreadCheckoutView {
  return { projectId: c.projectId, projectName: c.projectName, path: c.path, branch: c.branch, primary: c.primary, missing: c.missing, git: c.git, derived: c.derived };
}

/** ThreadService.Checkouts for a thread by id. */
export async function getThreadCheckouts(threadId: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<ThreadCheckoutsView> {
  const c = await conn.client(ThreadService);
  const res = await c.checkouts({ id: threadId }, { signal });
  return { checkouts: res.checkouts.map(toThreadCheckoutView), workspaceId: res.workspaceId, workspaceName: res.workspaceName };
}
