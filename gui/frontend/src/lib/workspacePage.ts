/**
 * A workspace's page on the Projects view (docs/notes/projects-redesign-3-workspace-page.md):
 * which threads its Threads table lists, in what order, the section's caption, a member's
 * checkout for a thread, and a thread's Changes over them. Pure; inputs are the threads and
 * projects slices' shapes.
 */
import type { GitStatusView } from "@/api/project";
import { checkoutHasChanges, isWorking, threadActivityMs, type ActivityThread, type ActivityThreads } from "./projects";

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

type ChangesStatus = Pick<GitStatusView, "staged" | "modified" | "untracked" | "conflicted" | "dirty" | "baseAhead">;

const count = (n: number, one: string): string => `${String(n)} ${n === 1 ? one : `${one}s`}`;

/**
 * A thread row's Changes cell, over its member checkouts' statuses (the ones the projects
 * slice has): uncommitted files and commits on its branch summed, "3 files · 2 commits";
 * "changed" when git says dirty without counts; "clean" with nothing; "" without a status to
 * read (no checkout made yet), drawn as "—".
 */
export function threadChangesCell(statuses: readonly ChangesStatus[]): string {
  if (statuses.length === 0) return "";
  let files = 0;
  let commits = 0;
  let dirty = false;
  for (const st of statuses) {
    files += st.staged + st.modified + st.untracked + (st.conflicted ?? 0);
    commits += st.baseAhead ?? 0;
    dirty ||= st.dirty;
  }
  const parts: string[] = [];
  if (files > 0) parts.push(count(files, "file"));
  else if (dirty) parts.push("changed");
  if (commits > 0) parts.push(count(commits, "commit"));
  return parts.length === 0 ? "clean" : parts.join(" · ");
}

/** The member checkouts of a thread whose changes its row's menu offers to show: the ones not clean (lib/projects.ts checkoutHasChanges). */
export function changedCheckouts<T extends { status: ChangesStatus | undefined }>(checkouts: readonly T[]): T[] {
  return checkouts.filter((c) => c.status !== undefined && checkoutHasChanges(c.status));
}
