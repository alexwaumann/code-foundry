import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { findFiles, type FinderMatchView, type FinderSourceView } from "@/api/filesystem";
import { errorMessage, isAbort } from "@/api/stream";
import type { FileChangeView } from "@/api/worktreeDetail";
import { useThreadCheckouts } from "@/components/thread/useThreadCheckouts";
import { mainCheckout } from "@/lib/collisionHints";
import type { CheckoutChanges, FinderCheckout } from "@/lib/fileFinder";
import { normalizePath } from "@/lib/filePath";
import { isUnplaced } from "@/lib/threadSetup";
import { FILE_KIND } from "@/surfaces/fileTarget";
import { useTabPlace } from "@/shell/host";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";
import { detailKey, worktreeDetailResource } from "@/stores/worktreeDetail";

/** A burst of keystrokes sends one search (the composer's @ waits as long). */
export const FINDER_DEBOUNCE_MS = 80;
/** Matches asked for: about eight show, the rest scroll. */
export const FINDER_LIMIT = 50;

const SEP = "\u0001";

/**
 * The thread's checkouts the finder searches: one per project, the primary first, then
 * the thread's order (useThreadCheckouts); a project the thread has no recorded checkout
 * in is read from its main worktree. A workspace thread's members only, never the
 * workspace's folder (it is no project). Also each project's name and whether it has git
 * (only a git checkout has changes to list). A thread with no checkout yet searches its
 * projects' own, whose changes are not the thread's: it lists none.
 */
export function useFinderCheckouts(threadId: string): { checkouts: FinderCheckout[]; names: Record<string, string>; git: ReadonlySet<string> } {
  const { projectIds, paths } = useThreadCheckouts(threadId);
  const unplaced = useThreadsStore((s) => isUnplaced(s.byId[threadId]));
  const facts = useProjectsStore(
    useShallow((s) =>
      projectIds.map((id) => {
        const p = s.byId[id];
        const path = paths[id] ?? (p ? mainCheckout(p) : "");
        return [id, path, p?.name ?? id, p?.git ? "1" : ""].join(SEP);
      }),
    ),
  );
  return useMemo(() => {
    const checkouts: FinderCheckout[] = [];
    const names: Record<string, string> = {};
    const git = new Set<string>();
    for (const f of facts) {
      const [projectId = "", path = "", name = "", isGit = ""] = f.split(SEP);
      names[projectId] = name;
      if (isGit && !unplaced) git.add(projectId);
      if (path) checkouts.push({ projectId, path });
    }
    return { checkouts, names, git };
  }, [facts, unplaced]);
}

/** "Go to file in <name>…": the thread's workspace's name, else its primary project's. */
export function useFinderScopeName(threadId: string, names: Readonly<Record<string, string>>, first: string): string {
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  const workspace = useWorkspacesStore((s) => (workspaceId ? (s.byId[workspaceId]?.name ?? "") : ""));
  const primary = useThreadsStore((s) => s.byId[threadId]?.projectId ?? "");
  return workspace || names[primary] || names[first] || "this thread";
}

const NO_FILES: readonly FileChangeView[] = [];

/**
 * The changes of the git checkouts (ProjectService.GetWorktreeDetail, the Changes tab's
 * resource), watched while the finder is open, in checkout order. A checkout whose detail
 * has not arrived counts as unchanged.
 */
export function useCheckoutChanges(checkouts: readonly FinderCheckout[], git: ReadonlySet<string>): CheckoutChanges[] {
  const watched = useMemo(() => checkouts.filter((c) => git.has(c.projectId)), [checkouts, git]);
  const keys = useMemo(() => watched.map((c) => detailKey(c.projectId, c.path)), [watched]);
  useEffect(() => {
    const releases = keys.map((k) => worktreeDetailResource.watch(k));
    return () => {
      for (const r of releases) r();
    };
  }, [keys]);
  const files = worktreeDetailResource.store(useShallow((s) => keys.map((k) => s.entries[k]?.data?.files ?? NO_FILES)));
  return useMemo(() => watched.map((c, i) => ({ ...c, files: files[i] ?? NO_FILES })), [watched, files]);
}

/** Absolute paths of a panel's File tabs (normalized), in either group. */
export function useOpenFilePaths(panelKey: string): ReadonlySet<string> {
  const joined = useTabPlace(panelKey, (p) =>
    p.tabs
      .filter((t) => t.kind === FILE_KIND && t.params.path)
      .map((t) => normalizePath(t.params.path ?? ""))
      .join("\n"),
  );
  return useMemo(() => new Set(joined ? joined.split("\n") : []), [joined]);
}

/** A search's state: the last answer stays while a newer search is out (no flicker); a failed search answers with no matches. */
export interface FinderSearch {
  /** The query `matches` answer; null before the first answer. */
  answered: string | null;
  matches: readonly FinderMatchView[];
  /** The last search failed (its message); null otherwise. */
  error: string | null;
}

/** SearchFiles over several checkouts, replaceable in tests. */
export type FindFilesFn = typeof findFiles;

const NOTHING: FinderSearch = { answered: null, matches: [], error: null };

/**
 * Searches the checkouts for `query` (empty: nothing is sent), debounced by
 * FINDER_DEBOUNCE_MS; a newer query or a closed finder aborts the search out. The last
 * answer stays until the next lands.
 */
export function useFinderSearch(sources: readonly FinderSourceView[], query: string, search: FindFilesFn = findFiles): FinderSearch {
  const [state, setState] = useState<FinderSearch>(NOTHING);
  const key = sources.map((s) => s.projectId + SEP + s.path).join("\n");
  useEffect(() => {
    if (query === "" || sources.length === 0) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      search({ sources, query, limit: FINDER_LIMIT }, undefined, ctl.signal).then(
        (matches) => {
          if (!ctl.signal.aborted) setState({ answered: query, matches, error: null });
        },
        (err: unknown) => {
          if (ctl.signal.aborted || isAbort(err)) return;
          setState({ answered: query, matches: [], error: errorMessage(err) });
        },
      );
    }, FINDER_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // sources by key: a re-render with the same checkouts does not search again.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [key, query, search]);
  return state;
}
