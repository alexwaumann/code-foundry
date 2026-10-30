/**
 * ThreadService.Checkouts: one checkout per project in a thread's set, the path the thread
 * records (the primary at its cwd; in worktree mode a git member's worktree made for the
 * thread's branch, a plain folder the folder; otherwise each member's own checkout) and
 * what is checked out there now (docs/notes/thread-checkouts.md). The Worktree tab's
 * "Also in" list reads it (docs/notes/workspaces-v2-4-projects-page.md). Generated types
 * stay here.
 */
import { ThreadService } from "@/gen/codefoundry/v1/thread_pb";
import type { ThreadCheckout } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { toGitStatusView, type GitStatusView } from "./project";

export interface ThreadCheckoutView {
  projectId: string;
  /** "" when the project is no longer registered. */
  projectName: string;
  /** "" when nothing is recorded and the project is no longer registered. */
  path: string;
  /** Checked out there now (HEAD); for a worktree not made yet, the branch it is made on. "" for a plain folder or a detached HEAD. */
  branch: string;
  /** The commit checked out; "" when unknown. */
  head: string;
  detached: boolean;
  /** The project's main checkout, not a linked worktree. */
  isMain: boolean;
  /** The checkout's git status (upstream ahead/behind, the operation in progress); null when the project does not list it. */
  status: GitStatusView | null;
  /** The thread's cwd. */
  primary: boolean;
  /** The path does not exist (a worktree not made yet, or removed). */
  missing: boolean;
  /** The project has git (false: a plain folder). */
  git: boolean;
  /** A worktree-mode git member: made by the app at the next start when missing. */
  worktreeMode: boolean;
  /** With worktreeMode: the branch it was made for (Thread.branch); moved: it has another checked out now, or is detached. */
  createdBranch: string;
  moved: boolean;
}

export interface ThreadCheckoutsView {
  checkouts: ThreadCheckoutView[];
  workspaceId: string;
  workspaceName: string;
}

export function toThreadCheckoutView(c: ThreadCheckout): ThreadCheckoutView {
  return {
    projectId: c.projectId,
    projectName: c.projectName,
    path: c.path,
    // A worktree not made yet has no HEAD: name the branch its next start makes it on.
    branch: c.branch || (c.missing ? c.createdBranch : ""),
    head: c.head,
    detached: c.detached,
    isMain: c.isMain,
    status: c.status ? toGitStatusView(c.status) : null,
    primary: c.primary,
    missing: c.missing,
    git: c.git,
    worktreeMode: c.worktreeMode,
    createdBranch: c.createdBranch,
    moved: c.moved,
  };
}

/** ThreadService.Checkouts for a thread by id. */
export async function getThreadCheckouts(threadId: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<ThreadCheckoutsView> {
  const c = await conn.client(ThreadService);
  const res = await c.checkouts({ id: threadId }, { signal });
  return { checkouts: res.checkouts.map(toThreadCheckoutView), workspaceId: res.workspaceId, workspaceName: res.workspaceName };
}
