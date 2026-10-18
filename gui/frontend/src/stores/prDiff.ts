/**
 * The PR Code tab's data (components/pr/PrCode.tsx): the pull request's diff, read while
 * the tab shows. Keyed like the detail (pullRequestKey). The daemon serves its cached
 * diff when it was fetched for the head the cached detail has, so the tab reads it only
 * after the detail loaded; when the detail's head moves (a push the poll saw, a
 * pull_request_detail_updated re-read), the tab invalidates it (syncPullRequestDiff).
 */
import { toast } from "sonner";
import { create } from "zustand";
import { getPullRequestDiff, getPullRequestFile, type PullRequestDiffView } from "@/api/prDiff";
import { errorMessage } from "@/api/stream";
import { ExpandError } from "@/components/pr/diffModel";
import { pullRequestKey } from "./gh";
import { createResource } from "./resource";

function parseKey(key: string): [string, number] {
  const i = key.lastIndexOf("#");
  return [key.slice(0, i), Number(key.slice(i + 1))];
}

/** Key: pullRequestKey(slug, number). No keep-alive: the head SHA decides when to read again. */
export const pullRequestDiffResource = createResource((key, signal) => {
  const [slug, number] = parseKey(key);
  return getPullRequestDiff(slug, number, false, undefined, signal);
});

interface PrDiffState {
  /** pullRequestKey → a refresh in flight. */
  refreshing: Readonly<Record<string, boolean>>;
}

export const usePrDiffStore = create<PrDiffState>()(() => ({ refreshing: {} }));

/**
 * The strip's refresh button: fetches the diff from GitHub (refresh=true) and writes it
 * into the resource. A failure becomes the entry's error over the diff shown.
 */
export async function refreshPullRequestDiff(slug: string, number: number): Promise<void> {
  const key = pullRequestKey(slug, number);
  if (usePrDiffStore.getState().refreshing[key]) return;
  usePrDiffStore.setState((s) => ({ refreshing: { ...s.refreshing, [key]: true } }));
  try {
    pullRequestDiffResource.set(key, { data: await getPullRequestDiff(slug, number, true) });
  } catch (err) {
    pullRequestDiffResource.set(key, { error: errorMessage(err) });
  } finally {
    usePrDiffStore.setState((s) => {
      const { [key]: _done, ...rest } = s.refreshing;
      return { refreshing: rest };
    });
  }
}

/** Heads a re-read was already asked for, by key: the daemon may answer with the same diff (its detail not yet moved). */
const asked = new Map<string, string>();

/**
 * Called when the detail's head or the diff changes: re-reads the diff once per new head
 * when the diff was computed for another one. A diff without a head (the daemon had no
 * detail cached) is read again once the detail has one.
 */
export function syncPullRequestDiff(key: string, detailHead: string, diff: PullRequestDiffView | null): void {
  if (!detailHead || !diff || diff.headSha === detailHead) return;
  if (asked.get(key) === detailHead) return;
  asked.set(key, detailHead);
  pullRequestDiffResource.invalidate(key);
}

/** loadDiffFiles' read, through the daemon (cached there by repository, commit and path). */
export const readPullRequestFile = (repoSlug: string, ref: string, path: string) => getPullRequestFile(repoSlug, ref, path);

/** A hunk expansion that could not load its file: toasted once per file. */
export function expandFailed(path: string, err: unknown): void {
  const why = err instanceof ExpandError ? err.message : errorMessage(err);
  toast.error(`Cannot expand ${path}`, { id: `pr-expand:${path}`, description: why });
}
