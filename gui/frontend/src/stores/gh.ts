import { toast } from "sonner";
import { invokeCommand } from "@/api/command";
import { getBranchPullRequests, getDashboard, getRepoActivity, type GhEventView } from "@/api/gh";
import { errorMessage } from "@/api/stream";
import { getUiContext } from "./context";
import { createResource } from "./resource";

/**
 * GitHub views fed by GhService unary reads. The daemon polls GitHub; these only re-read
 * its cache when a gh event says something changed, and only for what is on screen.
 */

/** Keys: "tracked" (registered repos only) or "all". */
export const dashboardResource = createResource((key, signal) => getDashboard(key === "all", undefined, signal));

/** Key: repo slug. */
export const repoActivityResource = createResource((slug, signal) => getRepoActivity(slug, undefined, signal));

const SEP = "\u0000";
export const branchKey = (slug: string, head: string): string => `${slug}${SEP}${head}`;

/**
 * Key: branchKey(slug, head). Re-read every 5 minutes while shown: the daemon keeps a
 * branch polled for 10 minutes after the last GetBranchPullRequests.
 */
export const branchPullRequestsResource = createResource(
  (key, signal) => {
    const [slug = "", head = ""] = key.split(SEP);
    return getBranchPullRequests(slug, head, undefined, signal);
  },
  { keepAliveMs: 5 * 60_000 },
);

/** Routes one gh notification to the views it affects. */
export function applyGhEvent(ev: GhEventView): void {
  switch (ev.kind) {
    case "dashboard":
    case "viewer":
      dashboardResource.invalidate(() => true);
      // Repo activity carries the dashboard's recently merged PRs for its repo.
      repoActivityResource.invalidate(() => true);
      break;
    case "repoActivity":
      repoActivityResource.invalidate(ev.repoSlug);
      break;
    case "pullRequests":
      // Every PR poll also refreshes default-branch CI (fetched_at moves even when
      // nothing changed, which publishes no repoActivity event).
      repoActivityResource.invalidate(ev.repoSlug);
      break;
    case "branchPullRequests":
      branchPullRequestsResource.invalidate(branchKey(ev.repoSlug, ev.headRef));
      break;
  }
}

/** Opens a link in the default browser through the registry (view.open.url). */
export async function openUrl(url: string): Promise<void> {
  if (!url) return;
  try {
    await invokeCommand("view.open.url", getUiContext(), { url });
  } catch (err) {
    toast.error("Open in browser failed", { description: errorMessage(err) });
  }
}
