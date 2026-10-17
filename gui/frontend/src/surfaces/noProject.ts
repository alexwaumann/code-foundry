/**
 * Whether a selection is about no project: a thread without one (lib/threadRow
 * isNoProject) or the no-project composer. Its side panel lists no git, worktree, pull
 * request or workspace surface (they are "hidden"); thread-scoped ones (Linked PRs, Usage,
 * MCP) stay. Pure over the stores' state; specs that use it watch the repos and threads
 * stores.
 */
import { isNoProject } from "@/lib/threadRow";
import { useReposStore, type ReposData } from "@/stores/repos";
import { useThreadsStore, type ThreadsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import type { Subscribable } from "./types";

export function selectionHasNoProject(sel: Selection, s: { repos: ReposData; threads: ThreadsData }): boolean {
  if (sel.kind === "compose") return sel.noProject === true;
  if (sel.kind !== "thread") return false;
  const x = s.threads.byId[sel.id];
  return x !== undefined && isNoProject(x, s.repos);
}

/** selectionHasNoProject over the stores now. */
export function noProjectNow(sel: Selection): boolean {
  return selectionHasNoProject(sel, { repos: useReposStore.getState(), threads: useThreadsStore.getState() });
}

/** What a spec using noProjectNow watches. */
export const NO_PROJECT_WATCHES: readonly Subscribable[] = [useReposStore, useThreadsStore];
