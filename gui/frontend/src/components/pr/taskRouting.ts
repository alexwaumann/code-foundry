/**
 * Where a readiness row's thread task goes (pr.task, docs/notes/pr-panel-tasks.md), as
 * pure data: the row's verb, the default target and the ▾ menu's targets. Table-tested in
 * taskRouting.test.ts.
 *
 * Routing (agreed): (1) the selection is a thread that links this pull request → that
 * thread (pr.task --thread). Otherwise a new thread (no --thread): the daemon reuses or
 * creates the worktree on the head branch (2, 3), cloning the repository first when it is
 * no project (4). The menu adds "this thread" (any selected thread, linked or not) and up
 * to OTHER_THREADS other non-archived threads that link it: those with the head branch
 * checked out first, then the most recently active. Ember's thread is never a target: it
 * creates every worker, so it links all their pull requests, and it only splits and
 * assigns work.
 */
import type { PullRequestDetailView } from "@/api/gh";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { samePullRequest } from "./model";
import type { TaskKind } from "./readiness";
import { sameLogin } from "./review";

/** The button's verb per task: "Fix in this thread". */
export const TASK_VERBS: Readonly<Record<TaskKind, string>> = {
  checks: "Fix",
  review: "Address",
  conversations: "Address",
  conflicts: "Resolve",
  behind: "Update",
  "review-request": "Review",
};

/** What the task asks of the thread: the target menu's heading. */
export const TASK_TITLES: Readonly<Record<TaskKind, string>> = {
  checks: "Fix the failing checks",
  review: "Address the requested changes",
  conversations: "Address the unresolved conversations",
  conflicts: "Resolve the conflicts",
  behind: "Bring the branch up to date",
  "review-request": "Review it (read-only, nothing is submitted)",
};

/** The menu lists at most this many other threads that link the pull request. */
export const OTHER_THREADS = 3;

/** A task that pushes to the head branch: every kind but review-request. */
export const pushes = (kind: TaskKind): boolean => kind !== "review-request";

/**
 * The verb a row's task button shows, or null for no button: no task, a pull request that
 * is not open, or a task that pushes for a viewer who cannot (neither write access nor the
 * author). A fork the viewer cannot push to is the daemon's to refuse (its error toasts).
 */
export function taskVerb(task: TaskKind | null, d: Pick<PullRequestDetailView, "viewerCanUpdate"> & { pullRequest: { state: string; author: string } }, viewer: string): string | null {
  if (task === null || d.pullRequest.state !== "open") return null;
  if (pushes(task) && !d.viewerCanUpdate && !sameLogin(d.pullRequest.author, viewer)) return null;
  return TASK_VERBS[task];
}

/** What routing reads of a thread (useTaskThreads derives it from the stores). */
export interface TaskThread {
  id: string;
  name: string;
  archived: boolean;
  /** Its last activity, else its creation, epoch ms; 0 when neither is known. */
  activity: number;
  /** Its linked pull requests include this one (linksPullRequest). */
  links: boolean;
  /** One of its checkouts, in a project of the pull request's repository, has the head branch checked out. */
  onHead: boolean;
  /** Ember's resident thread: never a target. */
  ember: boolean;
}

/** Where a task goes: the selected thread, a new thread, or another thread that links the pull request. */
export type TaskTarget =
  | { kind: "this"; threadId: string }
  | { kind: "new"; threadId: null; /** The repository is no project: the daemon clones it first ("Clones o/r first"). */ clones: string }
  | { kind: "other"; threadId: string; name: string };

export interface TaskRouting {
  default: TaskTarget;
  /** The ▾ menu, the default first. */
  targets: TaskTarget[];
}

/**
 * Whether linked (a thread's linked pull requests) holds ref: its number, and the slug as
 * the panel names it or as GitHub does now (`repoSlug`, after a rename), case aside.
 */
export function linksPullRequest(linked: readonly { slug: string; number: number }[], ref: PrRef, repoSlug: string): boolean {
  return linked.some((l) => samePullRequest(l, ref) || (repoSlug !== "" && samePullRequest(l, { slug: repoSlug, number: ref.number })));
}

/** A thread's name as the menu shows it: its id when it has none. */
export const threadName = (t: Pick<TaskThread, "id" | "name">): string => t.name.trim() || t.id;

/** Whether a project is a clone of the repository (its GitHub slug, or GitHub's current name for it), case aside. */
export function isProjectRepo(projectSlugs: readonly string[], ...slugs: readonly string[]): boolean {
  const want = new Set(slugs.filter(Boolean).map((s) => s.toLowerCase()));
  return projectSlugs.some((s) => s !== "" && want.has(s.toLowerCase()));
}

/**
 * The routing for ref. `selection` is the selected thread's id (null for a page, a
 * composer, or a thread the threads store does not know); `threads` the threads that may
 * be targets (the selection's included); `isProject` whether a project is a clone of the
 * repository.
 */
export function taskRouting(input: { selection: string | null; ref: PrRef; threads: readonly TaskThread[]; isProject: boolean }): TaskRouting {
  const { selection, ref, threads, isProject } = input;
  const found = selection === null ? undefined : threads.find((t) => t.id === selection);
  // Ember's chat selected: as a page, a new thread by default and no "this thread".
  const selected = found?.ember ? undefined : found;
  const fresh: TaskTarget = { kind: "new", threadId: null, clones: isProject ? "" : ref.slug };
  const here: TaskTarget | null = selected ? { kind: "this", threadId: selected.id } : null;
  const others: TaskTarget[] = threads
    .filter((t) => t.id !== found?.id && !t.archived && !t.ember && t.links)
    .sort((a, b) => Number(b.onHead) - Number(a.onHead) || b.activity - a.activity || a.id.localeCompare(b.id))
    .slice(0, OTHER_THREADS)
    .map((t) => ({ kind: "other", threadId: t.id, name: threadName(t) }));
  if (here && selected?.links) return { default: here, targets: [here, fresh, ...others] };
  return { default: fresh, targets: here ? [fresh, here, ...others] : [fresh, ...others] };
}

/** The button: "Fix in this thread", "Fix in new thread", "Fix in <name>". */
export function buttonLabel(verb: string, t: TaskTarget): string {
  switch (t.kind) {
    case "this":
      return `${verb} in this thread`;
    case "new":
      return `${verb} in new thread`;
    case "other":
      return `${verb} in ${t.name}`;
  }
}

/** A menu item: "In this thread", "In a new thread", "In <name>". */
export function menuLabel(t: TaskTarget): string {
  switch (t.kind) {
    case "this":
      return "In this thread";
    case "new":
      return "In a new thread";
    case "other":
      return `In ${t.name}`;
  }
}

/** A menu item's hint: the clone a new thread starts with, if any. */
export const menuHint = (t: TaskTarget): string => (t.kind === "new" && t.clones ? `Clones ${t.clones} first` : "");

/** pr.task's args for the target: --thread for a thread, none for a new one. */
export function prTaskArgs(ref: PrRef, kind: TaskKind, t: TaskTarget): Record<string, string> {
  const args: Record<string, string> = { "repo-slug": ref.slug, number: String(ref.number), kind };
  if (t.threadId !== null) args.thread = t.threadId;
  return args;
}
