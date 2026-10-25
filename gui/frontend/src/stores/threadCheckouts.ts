import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { getThreadCheckouts } from "@/api/checkouts";
import { alsoInRows, checkoutsKey, memberWorktrees, threadOfCheckoutsKey, type AlsoInRow } from "@/lib/alsoIn";
import { useProjectsStore } from "./projects";
import { createResource, useResource } from "./resource";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";
import { openWorktreeTab } from "./worktreePanel";

const SEP = "\u0000";

/**
 * ThreadService.Checkouts for the thread whose Worktree tab is on screen (its "Also in"
 * list). Keyed by lib/alsoIn.ts checkoutsKey: the key changes when the thread's cwd,
 * branch or project set changes, or a member's worktree is made or removed, and a new key
 * is a new read. Nothing polls; only a visible tab watches a key.
 */
export const checkoutsResource = createResource((key, signal) => getThreadCheckouts(threadOfCheckoutsKey(key), undefined, signal), { abortOnRelease: true });

/** An Also in row's keyboard key in the Worktree tab's list. */
export const alsoInKey = (path: string): string => `also:${path}`;

/** Opens an Also in row's checkout as its own Worktree tab in the same (the thread's) panel. */
export function openAlsoIn(row: Pick<AlsoInRow, "projectId" | "path">): void {
  openWorktreeTab("current", row.projectId, row.path);
}

/**
 * The other checkouts of the thread whose panel shows the Worktree tab of `path` (the
 * selected thread: a panel always shows the selection's), from one ThreadService.Checkouts
 * read keyed by what they follow. Empty, and no read, for a single-project thread, the
 * Projects page's panel and anything else that is no thread. `folder`: the tab is the
 * workspace folder the thread runs in (a folder head), so every checkout is listed and a
 * one-project thread reads them too.
 */
export function useAlsoIn(path: string, folder = false): AlsoInRow[] {
  const threadId = useUiStore((s) => (s.selection.kind === "thread" ? s.selection.id : ""));
  const thread = useThreadsStore(
    useShallow((s) => {
      const t = threadId ? s.byId[threadId] : undefined;
      return t ? { id: t.id, worktreePath: t.worktreePath, branch: t.branch, projectIds: t.projectIds.join(",") } : null;
    }),
  );
  const idsKey = thread?.projectIds ?? "";
  const ids = useMemo(() => (idsKey ? idsKey.split(",") : []), [idsKey]);
  const worktrees = useProjectsStore((s) => memberWorktrees(s, ids).join(SEP));
  const key = thread ? checkoutsKey({ ...thread, projectIds: ids }, worktrees ? worktrees.split(SEP) : [], folder ? 1 : 2) : null;
  const data = useResource(checkoutsResource, key)?.data;
  return useMemo(() => alsoInRows(data, path, folder), [data, path, folder]);
}
