/**
 * A workspace's page on the Projects view (docs/notes/projects-redesign-3-workspace-page.md):
 * which threads its Threads table lists, in what order, the section's caption, and each
 * member's checkout state for a thread. Pure; inputs are the threads and projects slices'
 * shapes.
 */
import type { WorktreeView } from "@/api/project";
import { changesCell, isWorking, syncCell, threadActivityMs, type ActivityThread, type ActivityThreads } from "./projects";

/** A thread row's navigation key on a workspace's page. */
export const workspaceThreadKey = (workspaceId: string, threadId: string): string => `wt:${workspaceId}::${threadId}`;

export interface WorkspaceThreads {
  /** The non-archived threads that reference the workspace: working first, then by last activity (most recent first), id as the tiebreak. */
  ids: string[];
  working: number;
  idle: number;
  archived: number;
}

/** The threads a workspace's page lists (archived ones are only counted). */
export function workspaceThreads(threads: ActivityThreads, workspaceId: string): WorkspaceThreads {
  const rows: { id: string; working: boolean; last: number }[] = [];
  let archived = 0;
  for (const id of threads.order) {
    const t = threads.byId[id];
    if (t?.workspaceId !== workspaceId) continue;
    if (t.archivedAtMs !== null) {
      archived++;
      continue;
    }
    rows.push({ id, working: isWorking(t), last: threadActivityMs(t) ?? 0 });
  }
  rows.sort((a, b) => Number(b.working) - Number(a.working) || b.last - a.last || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const working = rows.filter((r) => r.working).length;
  return { ids: rows.map((r) => r.id), working, idle: rows.length - working, archived };
}

/** The Threads section's caption: "1 working · 3 archived", "2 idle", "none yet". */
export function workspaceThreadsCaption(c: Pick<WorkspaceThreads, "working" | "idle" | "archived">): string {
  const parts: string[] = [];
  if (c.working > 0) parts.push(`${String(c.working)} working`);
  if (c.idle > 0) parts.push(`${String(c.idle)} idle`);
  if (c.archived > 0) parts.push(`${String(c.archived)} archived`);
  return parts.length === 0 ? "none yet" : parts.join(" · ");
}

/**
 * The member's checkout the thread records: its own cwd for its primary, else its
 * checkout_paths entry; "" when the member is not in its set or has none recorded yet.
 */
export function memberCheckoutPath(t: Pick<ActivityThread, "projectId" | "projectIds" | "worktreePath" | "checkoutPaths">, projectId: string): string {
  const recorded = t.checkoutPaths.find((c) => c.projectId === projectId)?.path ?? "";
  if (recorded) return recorded;
  return t.projectId === projectId ? t.worktreePath : "";
}

export interface MemberCheckoutInput {
  /** The member is in the thread's set. */
  inSet: boolean;
  /** The checkout's path (memberCheckoutPath); "" with none recorded. */
  path: string;
  /** The member project is registered and a git repository (false: a plain folder). */
  git: boolean;
  /** The project is registered. */
  known: boolean;
  /** The project's worktree at the path, when the projects slice has it. */
  worktree: Pick<WorktreeView, "isMain" | "mergedClean" | "status"> | undefined;
}

/**
 * A member's cell in a thread's row: "clean · up to date", "4 files · 2 to push",
 * "clean · merged" (the daemon's merged_clean: nothing uncommitted, every commit on the
 * default branch), "not in this thread", "made at the next start" (worktree mode, not made
 * yet), "folder · no git", "not registered".
 */
export function memberCheckoutState(m: MemberCheckoutInput): string {
  if (!m.inSet) return "not in this thread";
  if (!m.known) return "not registered";
  if (!m.git) return "folder · no git";
  if (!m.path || !m.worktree) return "made at the next start";
  const st = m.worktree.status;
  if (m.worktree.mergedClean === true && !st.dirty) return "clean · merged";
  return `${changesCell(st)} · ${syncCell(st)}`;
}
