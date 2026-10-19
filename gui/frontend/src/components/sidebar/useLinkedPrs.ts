import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { branchPullRequestsResource, dashboardResource, pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { useThreadsStore } from "@/stores/threads";
import { newestFirst } from "@/surfaces/linkedprsTarget";
import { findLinkedPr, fresher, linkedPrState, type LinkedPrFact } from "./linkedPrTag";

/** The dashboard key the tags read: the registered projects' pull requests (as the composer's `#`). */
const DASHBOARD_KEY = "tracked";

/**
 * Keeps the viewer's dashboard read while any thread has linked pull requests: the tags'
 * main source of state. One watch for the whole list (the dashboard is the daemon's last
 * poll, re-read only when it changed); nothing is fetched per row.
 */
export function useLinkedPrsDashboard(): void {
  const any = useThreadsStore((s) => Object.values(s.byId).some((t) => t.linkedPullRequests.length > 0));
  useEffect(() => (any ? dashboardResource.watch(DASHBOARD_KEY) : undefined), [any]);
}

/** The thread's linked pull requests' keys (pullRequestKey), newest first. */
export function useLinkKeys(id: string): string[] {
  return useThreadsStore(useShallow((s) => newestFirst((s.byId[id]?.linkedPullRequests ?? []).map((l) => pullRequestKey(l.slug, l.number)))));
}

const numberOf = (key: string): number => Number(key.slice(key.lastIndexOf("#") + 1));

/**
 * What the GUI already holds on each linked pull request, without reading anything new:
 * its cached detail (the Linked PRs surface's and the thread header's reads), the
 * viewer's dashboard and any branch's list on screen; the freshest read wins. Each
 * selector returns the stores' own objects, so a row re-renders only when one of its
 * pull requests is re-read.
 */
export function useLinkedPrFacts(keys: readonly string[]): LinkedPrFact[] {
  const detail = pullRequestDetailResource.store(useShallow((s) => keys.map((k) => s.entries[k]?.data?.pullRequest ?? null)));
  const dashboard = dashboardResource.store(
    useShallow((s) => {
      const d = s.entries[DASHBOARD_KEY]?.data;
      const lists = d ? [d.authored, d.reviewRequested, d.reviewed, d.recentlyMerged] : [];
      return keys.map((k) => findLinkedPr(lists, k));
    }),
  );
  const branches = branchPullRequestsResource.store(
    useShallow((s) => {
      const lists = Object.values(s.entries).flatMap((e) => (e.data ? [e.data.pullRequests] : []));
      return keys.map((k) => findLinkedPr(lists, k));
    }),
  );
  return keys.map((k, i) => {
    const pr = fresher(detail[i] ?? null, fresher(dashboard[i] ?? null, branches[i] ?? null));
    return { number: numberOf(k), state: linkedPrState(pr), title: pr?.title ?? "" };
  });
}
