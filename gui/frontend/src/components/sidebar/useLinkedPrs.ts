import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PullRequestView } from "@/api/gh";
import { branchPullRequestsResource, DASHBOARD_KEY, dashboardResource, pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { useThreadsStore } from "@/stores/threads";
import { findLinkedPr, fresher, linkedPrState, type LinkedPrFact } from "./linkedPrTag";

/**
 * Keeps the viewer's dashboard read while the sidebar is mounted: the Pull Requests row's
 * needs-review count and the linked PR tags' main source of state. One watch for both
 * (the dashboard is the daemon's last poll, re-read only when it changed, and the PRs page
 * shares the key); nothing is fetched per row. It selects nothing, so it never re-renders
 * its caller.
 */
export function useSidebarDashboard(): void {
  useEffect(() => dashboardResource.watch(DASHBOARD_KEY), []);
}

/** Newest linked first: the stored first-seen order reversed. */
function newestFirst<T>(links: readonly T[]): T[] {
  return [...links].reverse();
}

/** The thread's linked pull requests' keys (pullRequestKey), newest first. */
export function useLinkKeys(id: string): string[] {
  return useThreadsStore(useShallow((s) => newestFirst((s.byId[id]?.linkedPullRequests ?? []).map((l) => pullRequestKey(l.slug, l.number)))));
}

const numberOf = (key: string): number => Number(key.slice(key.lastIndexOf("#") + 1));

/**
 * What the summary caches (core viewer dashboard lists and branch lists) hold on each
 * linked PR, without watching or fetching full PullRequestDetail. Project-wide lists
 * (`projectOpen` / `projectMerged`) are excluded because they are gated on Pull Requests
 * page interest and can be frozen when that page is closed.
 * With `watchedOnly: true`, only currently watched branch keys count so stale unwatched
 * branch entries never suppress watching `pullRequestDetailResource`.
 * `keys` must be stable between renders.
 */
export function useSummaryPrViews(keys: readonly string[], opts?: { watchedOnly?: boolean }): (PullRequestView | null)[] {
  const watchedOnly = opts?.watchedOnly ?? false;
  const dashboard = dashboardResource.store(
    useShallow((s) => {
      const d = s.entries[DASHBOARD_KEY]?.data;
      const lists = d ? [d.authored, d.reviewRequested, d.reviewed, d.recentlyMerged] : [];
      return keys.map((k) => findLinkedPr(lists, k));
    }),
  );
  const branches = branchPullRequestsResource.store(
    useShallow((s) => {
      const watchedSet = watchedOnly ? new Set(branchPullRequestsResource.watched()) : null;
      const lists = Object.entries(s.entries).flatMap(([k, e]) => (e.data && (!watchedSet || watchedSet.has(k)) ? [e.data.pullRequests] : []));
      return keys.map((k) => findLinkedPr(lists, k));
    }),
  );
  return useMemo(() => keys.map((_, i) => fresher(dashboard[i] ?? null, branches[i] ?? null)), [keys, dashboard, branches]);
}

/**
 * What the GUI already holds on each linked pull request, without reading anything new:
 * its cached detail (the thread info card's and the PR tab's reads), the
 * viewer's dashboard and any branch's list on screen; the freshest read wins, null when
 * none has it. Each selector returns the stores' own objects, so a row re-renders only
 * when one of its pull requests is re-read. `keys` must be stable between renders.
 */
export function useLinkedPrViews(keys: readonly string[]): (PullRequestView | null)[] {
  const detail = pullRequestDetailResource.store(useShallow((s) => keys.map((k) => s.entries[k]?.data?.pullRequest ?? null)));
  const summary = useSummaryPrViews(keys);
  return useMemo(() => keys.map((_, i) => fresher(detail[i] ?? null, summary[i] ?? null)), [keys, detail, summary]);
}

/** The tag's and the sidebar card's facts on each linked pull request (useLinkedPrViews). */
export function useLinkedPrFacts(keys: readonly string[]): LinkedPrFact[] {
  const views = useLinkedPrViews(keys);
  return keys.map((k, i) => {
    const pr = views[i] ?? null;
    return { number: numberOf(k), state: linkedPrState(pr), title: pr?.title ?? "" };
  });
}
