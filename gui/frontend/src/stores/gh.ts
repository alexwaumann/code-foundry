import { toast } from "sonner";
import { create } from "zustand";
import { invokeCommand } from "@/api/command";
import { getBranchPullRequests, getDashboard, getPullRequestDetail, getRepoActivity, type GhEventView } from "@/api/gh";
import { errorMessage } from "@/api/stream";
import { getUiContext } from "./context";
import { createResource } from "./resource";

/**
 * GitHub views fed by GhService unary reads. The daemon polls GitHub and announces a
 * change only when its data changed; these re-read its cache then, and only for what is
 * on screen. "updated Ns ago" comes from the polled event instead (usePollStore), so a
 * poll that changed nothing costs the GUI no reads.
 */

interface PollState {
  /** When the daemon's last successful poll finished; null before the first event or poll. */
  fetchedAtMs: number | null;
  /** The last poll's error; "" when it succeeded. */
  lastError: string;
  /** Whether a polled event arrived since the stream (re)connected. */
  known: boolean;
}

export const usePollStore = create<PollState>()(() => ({ fetchedAtMs: null, lastError: "", known: false }));

export interface Freshness {
  fetchedAtMs: number | null;
  lastError: string;
}

/**
 * Freshness of data the poll covers: once a polled event arrived, its time is the
 * answer. Every successful poll confirms the data (it would have been re-read had it
 * changed), and the daemon sends the data events of a poll before its polled event.
 */
export function pollFreshness(poll: PollState, fetchedAtMs: number | null, lastError: string): Freshness {
  if (!poll.known) return { fetchedAtMs, lastError };
  return { fetchedAtMs: poll.fetchedAtMs ?? fetchedAtMs, lastError: poll.lastError || lastError };
}

/** pollFreshness for data the poll covers (polled: true); otherwise the data's own. */
export function useFreshness(fetchedAtMs: number | null, lastError: string, polled: boolean): Freshness {
  const pollAt = usePollStore((s) => s.fetchedAtMs);
  const pollErr = usePollStore((s) => s.lastError);
  const known = usePollStore((s) => s.known);
  return polled ? pollFreshness({ fetchedAtMs: pollAt, lastError: pollErr, known }, fetchedAtMs, lastError) : { fetchedAtMs, lastError };
}

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

/** Key of pullRequestDetailResource: "owner/name#number" (slug lower case, like the daemon's). */
export const pullRequestKey = (slug: string, number: number): string => `${slug.toLowerCase()}#${String(number)}`;

function parsePullRequestKey(key: string): [string, number] {
  const i = key.lastIndexOf("#");
  return [key.slice(0, i), Number(key.slice(i + 1))];
}

/**
 * How often an open detail is re-read: the daemon's default poll interval
 * (github.poll_interval_seconds). Reads are cache hits until the daemon's entry is older
 * than the poll interval; then the read fetches. That keeps a PR the poll does not cover
 * (not on a dashboard or watched branch, so no pull_request_detail_updated) from going stale.
 */
export const PULL_REQUEST_DETAIL_KEEPALIVE_MS = 60_000;

/**
 * Key: pullRequestKey(slug, number). The daemon caches the detail and announces a change
 * (pull_request_detail_updated) when a poll sees the PR move or a review request is set;
 * the re-read then fetches from GitHub.
 */
export const pullRequestDetailResource = createResource(
  (key, signal) => {
    const [slug, number] = parsePullRequestKey(key);
    return getPullRequestDetail(slug, number, false, undefined, signal);
  },
  { keepAliveMs: PULL_REQUEST_DETAIL_KEEPALIVE_MS },
);

/**
 * Fetches the detail from GitHub now (refresh) and writes the answer into the resource:
 * the fresh detail, or the daemon's cached copy with lastError when the fetch failed. An
 * RPC error (no cached copy) is recorded as the entry's error and rethrown.
 */
export async function refreshPullRequestDetail(slug: string, number: number): Promise<void> {
  const key = pullRequestKey(slug, number);
  try {
    pullRequestDetailResource.set(key, { data: await getPullRequestDetail(slug, number, true) });
  } catch (err) {
    pullRequestDetailResource.set(key, { error: errorMessage(err) });
    throw err;
  }
}

/** Routes one gh notification to the views it affects. */
export function applyGhEvent(ev: GhEventView): void {
  switch (ev.kind) {
    case "polled":
      usePollStore.setState({ fetchedAtMs: ev.fetchedAtMs, lastError: ev.lastError, known: true });
      break;
    case "dashboard":
    case "viewer":
      dashboardResource.invalidate(() => true);
      // Repo activity carries the dashboard's recently merged PRs for its repo.
      repoActivityResource.invalidate(() => true);
      break;
    case "repoActivity":
      repoActivityResource.invalidate(ev.repoSlug);
      break;
    case "branchPullRequests":
      branchPullRequestsResource.invalidate(branchKey(ev.repoSlug, ev.headRef));
      break;
    case "pullRequestDetail":
      pullRequestDetailResource.invalidate(pullRequestKey(ev.repoSlug, ev.number));
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
