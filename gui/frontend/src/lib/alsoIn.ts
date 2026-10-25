/**
 * The Worktree tab's "Also in" list (docs/notes/workspaces-v2-4-projects-page.md): the
 * other checkouts of the thread whose panel shows the tab, from ThreadService.Checkouts.
 * Pure.
 */
import type { ThreadCheckoutsView } from "@/api/checkouts";
import type { ThreadView } from "@/api/threads";

export interface AlsoInRow {
  projectId: string;
  path: string;
  /** The project's name; its id when it is no longer registered. */
  name: string;
  branch: string;
  missing: boolean;
  git: boolean;
}

/**
 * One row per checkout of the thread other than the tab's, in the response's order (by
 * project id). Empty unless the tab's path is one of the thread's checkouts and there is
 * another: a single-project thread, or a worktree tab the thread does not work in, shows
 * no list. Checkouts without a path (an unregistered project) are left out.
 */
export function alsoInRows(view: ThreadCheckoutsView | null | undefined, tabPath: string): AlsoInRow[] {
  const all = (view?.checkouts ?? []).filter((c) => c.path !== "");
  if (!all.some((c) => c.path === tabPath)) return [];
  return all
    .filter((c) => c.path !== tabPath)
    .map((c) => ({ projectId: c.projectId, path: c.path, name: c.projectName || c.projectId, branch: c.branch, missing: c.missing, git: c.git }));
}

const SEP = "\u0000";

/**
 * The checkouts resource key for a thread: its id, then what the checkouts follow (the
 * cwd, the branch, the project set, and the members' worktree paths, so a worktree made
 * or removed asks again). Null when the thread has one project or none: one checkout, no
 * list, no call.
 */
export function checkoutsKey(t: Pick<ThreadView, "id" | "worktreePath" | "branch" | "projectIds"> | undefined, worktrees: readonly string[]): string | null {
  if (!t || (t.projectIds?.length ?? 0) < 2) return null;
  return [t.id, t.worktreePath, t.branch ?? "", (t.projectIds ?? []).join(","), worktrees.join(",")].join(SEP);
}

/** The thread id a checkouts key names. */
export function threadOfCheckoutsKey(key: string): string {
  return key.split(SEP)[0] ?? "";
}

/** The members' worktree paths, sorted (checkoutsKey's last part), from the projects slice. */
export function memberWorktrees(projects: { byId: Readonly<Record<string, { worktrees: readonly { path: string }[] } | undefined>> }, projectIds: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const id of projectIds ?? []) for (const w of projects.byId[id]?.worktrees ?? []) out.push(w.path);
  return out.sort();
}
