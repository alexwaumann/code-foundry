/**
 * Small pure helpers over a thread's linked pull requests and the selection's thread, kept
 * from the Linked PRs surface (removed; docs/notes/thread-header-crumb.md): the selection's
 * thread (the MCP surface's availability), the links' order and the sidebar tag's count.
 */
import type { ProjectsData } from "@/stores/projects";
import type { ThreadsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";

export interface SelectionStores {
  projects: ProjectsData;
  threads: ThreadsData;
}

/** The selection's thread, when the threads store knows it. Null for a page or a composer. */
export function selectionThread(sel: Selection, s: SelectionStores): string | null {
  return sel.kind === "thread" && s.threads.byId[sel.id] ? sel.id : null;
}

/** Newest linked first: the stored first-seen order reversed. */
export function newestFirst<T>(links: readonly T[]): T[] {
  return [...links].reverse();
}

/** The sidebar badge: "1 PR", "3 PRs". */
export function prBadge(n: number): string {
  return `${String(n)} ${n === 1 ? "PR" : "PRs"}`;
}
