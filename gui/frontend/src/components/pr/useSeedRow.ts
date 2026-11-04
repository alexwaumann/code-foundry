import { useState } from "react";
import type { PullRequestView } from "@/api/gh";
import { fresher } from "@/components/sidebar/linkedPrTag";
import { branchPullRequestsResource, DASHBOARD_KEY, dashboardResource, pullRequestKey } from "@/stores/gh";
import { dashboardLists, freshestRow } from "./seed";

/**
 * The row the GUI already holds for key, while `wanted` (no detail yet): the dashboard's or
 * any branch list's on screen, the freshest. Reads nothing new. A row that leaves its list
 * during the wait (a poll landing) stays: the view does not fall back to a skeleton for it.
 * Never another pull request's: what is kept is checked against key.
 */
export function useSeedRow(key: string, wanted: boolean): PullRequestView | null {
  const dashboard = dashboardResource.store((s) => {
    const d = wanted ? s.entries[DASHBOARD_KEY]?.data : null;
    return d ? freshestRow(dashboardLists(d), key) : null;
  });
  const branches = branchPullRequestsResource.store((s) => (wanted ? freshestRow(Object.values(s.entries).flatMap((e) => (e.data ? [e.data.pullRequests] : [])), key) : null));
  const live = fresher(dashboard, branches);
  const [kept, setKept] = useState<PullRequestView | null>(null);
  if (live !== null && live !== kept) setKept(live);
  if (!wanted) return null;
  return live ?? (kept !== null && pullRequestKey(kept.repoSlug, kept.number) === key ? kept : null);
}
