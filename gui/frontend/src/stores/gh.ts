import { Code, ConnectError } from "@connectrpc/connect";
import { notify } from "@/lib/notify";
import { create } from "zustand";
import { invokeCommand } from "@/api/command";
import {
  getBranchesPullRequests,
  getBranchPullRequests,
  getDashboard,
  getPullRequestDetail,
  getRepoActivity,
  getViewer,
  type BranchPullRequestsBatchEntry,
  type BranchPullRequestsView,
  type GhEventView,
  type ProjectPullRequestsView,
  type PrChangeKindView,
  type PullRequestView,
} from "@/api/gh";
import { errorMessage, isPageVisible, onBecameVisible } from "@/api/stream";
import { getUiContext } from "./context";
import { createResource, useResource } from "./resource";

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
  /** When the project-wide lists (the Pull Requests page's) were last fetched, from the same polled event; null if never. */
  projectsFetchedAtMs: number | null;
  /** Their last fetch's error; "" when it succeeded. */
  projectsLastError: string;
}

export const usePollStore = create<PollState>()(() => ({ fetchedAtMs: null, lastError: "", known: false, projectsFetchedAtMs: null, projectsLastError: "" }));

export interface Freshness {
  fetchedAtMs: number | null;
  lastError: string;
}

/**
 * Freshness of data the poll covers: once a polled event arrived, its time is the
 * answer. Every successful poll confirms the data (it would have been re-read had it
 * changed), and the daemon sends the data events of a poll before its polled event.
 */
export function pollFreshness(poll: Pick<PollState, "fetchedAtMs" | "lastError" | "known">, fetchedAtMs: number | null, lastError: string): Freshness {
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

/**
 * useFreshness for the project-wide lists (DashboardView.projectOpen, projectMerged): the
 * polled event's projects fetch time and error once one arrived, else the dashboard's.
 */
export function useProjectsFreshness(fetchedAtMs: number | null, lastError: string): Freshness {
  const pollAt = usePollStore((s) => s.projectsFetchedAtMs);
  const pollErr = usePollStore((s) => s.projectsLastError);
  const known = usePollStore((s) => s.known);
  return pollFreshness({ fetchedAtMs: pollAt, lastError: pollErr, known }, fetchedAtMs, lastError);
}

/** The one key of viewerResource. */
export const VIEWER_KEY = "viewer";

/** Key: VIEWER_KEY. The authenticated GitHub user (GhService.GetViewer, the daemon's snapshot). */
export const viewerResource = createResource((_key, signal) => getViewer(undefined, signal));

/** The viewer's GitHub login while mounted; "" until known (or when gh is not authenticated). */
export function useViewerLogin(): string {
  return useResource(viewerResource, VIEWER_KEY)?.data?.login ?? "";
}

/**
 * The one key of dashboardResource. Every reader (the Pull Requests page, the sidebar's
 * count and linked PR tags, the composer's `#`, the pages bridge) shares it, so the GUI
 * holds one watch and makes one read per dashboard change.
 */
export const DASHBOARD_KEY = "all";

/**
 * How often the Pull Requests page renews its daemon-side project-list watch lease
 * (the daemon keeps PollProjects active for 10 minutes after the last GetDashboard
 * with watch_projects: true). Only while the window is visible: see watchProjects.
 */
export const PROJECTS_WATCH_KEEPALIVE_MS = 5 * 60_000;

let projectsWatchers = 0;
let projectsTimer: ReturnType<typeof setInterval> | null = null;
let stopProjectsVisible: (() => void) | null = null;
/** A renewal fell while the window was hidden, so the lease may lapse: becoming visible renews it. */
let projectsRenewalMissed = false;

/** Whether any mounted view (Pull Requests page or page bridge) is keeping Snapshot.Projects live. */
export const isProjectsWatched = (): boolean => projectsWatchers > 0;

/**
 * Whether a dashboard read renews the daemon's project-list lease: a view holds it and
 * the window is visible. A read made while hidden (the daemon's poll changed the
 * dashboard) is a plain one, or PollProjects publishing its own changes would keep its
 * lease alive with nobody looking.
 */
const renewsProjectsLease = (): boolean => projectsWatchers > 0 && isPageVisible();

/** Key: DASHBOARD_KEY. The viewer's pull request lists in every repository (GhService.GetDashboard). */
export const dashboardResource = createResource((_key, signal) => getDashboard(undefined, signal, { watchProjects: renewsProjectsLease() }));

/** Renews the lease now (one dashboard read), or notes the renewal missed while the window is hidden. */
function renewProjectsLease(): void {
  if (!isPageVisible()) {
    projectsRenewalMissed = true;
    return;
  }
  if (dashboardResource.watched().includes(DASHBOARD_KEY)) {
    dashboardResource.invalidate(DASHBOARD_KEY);
  }
}

/** (Re)starts the keepalive: the next renewal is a full period from now. */
function startProjectsKeepalive(): void {
  if (projectsTimer !== null) clearInterval(projectsTimer);
  projectsTimer = setInterval(renewProjectsLease, PROJECTS_WATCH_KEEPALIVE_MS);
}

/**
 * Declares active Pull Requests page interest in Snapshot.Projects. While held and the
 * window is visible, dashboardResource sends watch_projects: true and renews the
 * daemon's 10-minute lease every 5 minutes. While hidden it renews nothing, so the lease
 * lapses on its own and the daemon stops PollProjects; on becoming visible again after a
 * missed renewal it renews at once (one read) and restarts the period. A hide with no
 * renewal due in it sends nothing, and any number of flips sends at most one read per
 * missed renewal.
 */
export function watchProjects(): () => void {
  projectsWatchers++;
  if (projectsWatchers === 1) {
    projectsRenewalMissed = false;
    renewProjectsLease();
    startProjectsKeepalive();
    stopProjectsVisible = onBecameVisible(() => {
      if (!projectsRenewalMissed) return;
      projectsRenewalMissed = false;
      renewProjectsLease();
      startProjectsKeepalive();
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    projectsWatchers = Math.max(0, projectsWatchers - 1);
    if (projectsWatchers === 0) {
      if (projectsTimer !== null) clearInterval(projectsTimer);
      projectsTimer = null;
      stopProjectsVisible?.();
      stopProjectsVisible = null;
      projectsRenewalMissed = false;
    }
  };
}

/**
 * Key: the repository's slug, lower case (the daemon's). Its default branch checks, read
 * from the daemon's snapshot (it polls every tracked repository's); re-read on
 * repo_activity_updated. Watched by the Default branch cells (the Projects index's rows,
 * a project page's title) while shown.
 */
export const repoActivityResource = createResource((slug, signal) => getRepoActivity(slug, undefined, signal));

const SEP = "\u0000";
export const branchKey = (slug: string, head: string): string => `${slug}${SEP}${head}`;

interface PendingBranchRead {
  key: string;
  slug: string;
  head: string;
  signal: AbortSignal;
  resolve: (v: BranchPullRequestsView) => void;
  reject: (err: unknown) => void;
  onAbort: () => void;
  aborted: boolean;
}

const pendingBranchReads: PendingBranchRead[] = [];
let branchFlushScheduled = false;

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function flushBranchReads(): void {
  branchFlushScheduled = false;
  const raw = pendingBranchReads.splice(0).filter((item) => !item.aborted && !item.signal.aborted);
  if (raw.length === 0) return;

  const groups = new Map<string, { slug: string; head: string; waiters: PendingBranchRead[] }>();
  for (const item of raw) {
    const g = groups.get(item.key);
    if (g) g.waiters.push(item);
    else groups.set(item.key, { slug: item.slug, head: item.head, waiters: [item] });
  }
  const unique = [...groups.values()];
  const batchCtl = new AbortController();

  const detachListeners = () => {
    for (const item of raw) item.signal.removeEventListener("abort", item.onAbort);
  };
  for (const item of raw) {
    item.signal.removeEventListener("abort", item.onAbort);
    item.onAbort = () => {
      if (item.aborted) return;
      item.aborted = true;
      item.reject(abortError());
      if (raw.every((w) => w.aborted || w.signal.aborted)) batchCtl.abort();
    };
    item.signal.addEventListener("abort", item.onAbort, { once: true });
  }

  const single = unique.length === 1 ? unique[0] : undefined;
  const req: Promise<BranchPullRequestsBatchEntry[]> = single
    ? getBranchPullRequests(single.slug, single.head, undefined, batchCtl.signal).then((v) => [{ ...v, repoSlug: single.slug, headRef: single.head }])
    : getBranchesPullRequests(
        unique.map((u) => ({ repoSlug: u.slug, headRef: u.head })),
        undefined,
        batchCtl.signal,
      );

  const settleGroup = (group: { slug: string; head: string; waiters: PendingBranchRead[] }, entry: BranchPullRequestsView | undefined) => {
    for (const w of group.waiters) {
      if (w.aborted || w.signal.aborted) continue;
      if (entry) w.resolve(entry);
      else w.reject(new Error(`missing branch pull requests entry for ${group.slug}@${group.head}`));
    }
  };

  void req
    .then((entries) => {
      const keyed = entries.every((e) => e.repoSlug !== undefined && e.headRef !== undefined);
      const byKey = keyed ? new Map(entries.map((e) => [branchKey((e.repoSlug ?? "").toLowerCase(), e.headRef ?? ""), e])) : null;
      for (let i = 0; i < unique.length; i++) {
        const group = unique[i];
        if (!group) continue;
        const entry = byKey ? byKey.get(branchKey(group.slug.toLowerCase(), group.head)) : entries[i];
        settleGroup(group, entry);
      }
    })
    .catch((err: unknown) => {
      // If one bad key caused InvalidArgument for the whole batch, isolate the bad key by
      // falling back to individual reads so sibling branches still load cleanly.
      if (!single && err instanceof ConnectError && err.code === Code.InvalidArgument && !batchCtl.signal.aborted) {
        return Promise.all(
          unique.map((group) =>
            getBranchPullRequests(group.slug, group.head, undefined, batchCtl.signal)
              .then((v) => {
                settleGroup(group, v);
              })
              .catch((singleErr: unknown) => {
                for (const w of group.waiters) {
                  if (!w.aborted && !w.signal.aborted) w.reject(singleErr);
                }
              }),
          ),
        );
      }
      for (const w of raw) {
        if (!w.aborted && !w.signal.aborted) w.reject(err);
      }
      return undefined;
    })
    .finally(detachListeners);
}

/**
 * Loads one branch's pull requests, coalescing concurrent reads queued in the same
 * microtask into one GetBranchesPullRequests RPC (single-branch loads keep using
 * GetBranchPullRequests).
 */
export function loadBranchPullRequests(key: string, signal: AbortSignal): Promise<BranchPullRequestsView> {
  if (signal.aborted) return Promise.reject(abortError());
  const [slug = "", head = ""] = key.split(SEP);
  return new Promise<BranchPullRequestsView>((resolve, reject) => {
    const item: PendingBranchRead = {
      key,
      slug,
      head,
      signal,
      resolve,
      reject,
      aborted: false,
      onAbort: () => {
        if (item.aborted) return;
        item.aborted = true;
        const idx = pendingBranchReads.indexOf(item);
        if (idx >= 0) pendingBranchReads.splice(idx, 1);
        reject(abortError());
      },
    };
    signal.addEventListener("abort", item.onAbort, { once: true });
    pendingBranchReads.push(item);
    if (!branchFlushScheduled) {
      branchFlushScheduled = true;
      queueMicrotask(flushBranchReads);
    }
  });
}

/**
 * Key: branchKey(slug, head). Re-read every 5 minutes while shown: the daemon keeps a
 * branch polled for 10 minutes after the last GetBranchPullRequests / GetBranchesPullRequests.
 */
export const branchPullRequestsResource = createResource(loadBranchPullRequests, { keepAliveMs: 5 * 60_000 });

/** Key of pullRequestDetailResource: "owner/name#number" (slug lower case, like the daemon's). */
export const pullRequestKey = (slug: string, number: number): string => `${slug.toLowerCase()}#${String(number)}`;

function parsePullRequestKey(key: string): [string, number] {
  const i = key.lastIndexOf("#");
  return [key.slice(0, i), Number(key.slice(i + 1))];
}

/**
 * How often an open detail is re-read: the daemon's default poll interval
 * (github.poll_interval_seconds). Every read answers from the daemon's copy; once that is
 * older than the poll interval the read also starts a fetch behind it. That keeps a PR the
 * poll does not cover (not on a dashboard or watched branch, so no
 * pull_request_detail_updated of its own) from going stale.
 */
export const PULL_REQUEST_DETAIL_KEEPALIVE_MS = 60_000;

/**
 * Key: pullRequestKey(slug, number). The daemon answers with any copy it has, marked
 * refreshing when it is not current, and announces (pull_request_detail_updated) when a poll
 * sees the PR move, a write lands, or that fetch ended; the re-read replaces the data in
 * place. A read waits for GitHub only with no copy, and right after a write made here. A
 * read the last watcher lets go of is aborted, and the daemon then drops it from its queue if
 * it has not started: the pull request someone flew past must not hold up the one they
 * stopped on. So a read with nobody showing it goes through readOnce, never `watch(key)()`.
 */
export const pullRequestDetailResource = createResource(
  (key, signal) => {
    const [slug, number] = parsePullRequestKey(key);
    return getPullRequestDetail(slug, number, false, undefined, signal);
  },
  { keepAliveMs: PULL_REQUEST_DETAIL_KEEPALIVE_MS, abortOnRelease: true },
);

/**
 * The fields of a summary row each change kind of pull_request_changed speaks for. The event's
 * row is the daemon's shown row (the user's own close, reopen, draft or review laid over the
 * poll's, as GetDashboard has it), but only these fields are news: the rest may be older than
 * the cached row (a re-read after a write) or absent from a closed or merged summary.
 */
const CHANGED_FIELDS: Readonly<Record<PrChangeKindView, readonly (keyof PullRequestView)[]>> = {
  appeared: [],
  merged: ["state", "mergedAtMs"],
  closed: ["state"],
  reopened: ["state"],
  headPushed: ["headSha"],
  checks: ["checks"],
  reviewDecision: ["review"],
  reviews: ["reviews", "latestReviews"],
  comments: ["comments"],
  reviewRequested: ["reviewRequests"],
  draft: ["draft", "mergeState"],
  title: ["title"],
};

/** Whether two plain view values are equal (rows are JSON-shaped data). */
function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
}

/** `cur` with `fields` taken from `next`; `cur` itself when none of them differs. */
function mergeChangedFields(cur: PullRequestView, next: PullRequestView, fields: readonly (keyof PullRequestView)[]): PullRequestView {
  const changed = fields.filter((f) => !sameValue(cur[f], next[f]));
  if (changed.length === 0) return cur;
  const out: Record<string, unknown> = { ...cur };
  for (const f of changed) out[f] = next[f];
  if (next.updatedAtMs !== null && (cur.updatedAtMs === null || next.updatedAtMs > cur.updatedAtMs)) out.updatedAtMs = next.updatedAtMs;
  return out as unknown as PullRequestView;
}

/** `list` with the row matching `targetKey` merged with `next`'s changed fields; `list` itself when nothing moved. */
function patchPrList(list: PullRequestView[], targetKey: string, next: PullRequestView, fields: readonly (keyof PullRequestView)[]): PullRequestView[] {
  let out: PullRequestView[] | null = null;
  for (const [i, p] of list.entries()) {
    if (pullRequestKey(p.repoSlug, p.number) !== targetKey) continue;
    const merged = mergeChangedFields(p, next, fields);
    if (merged === p) continue;
    out ??= list.slice();
    out[i] = merged;
  }
  return out ?? list;
}

function patchProjectList(list: ProjectPullRequestsView | undefined, targetKey: string, next: PullRequestView, fields: readonly (keyof PullRequestView)[]): ProjectPullRequestsView | undefined {
  if (!list) return list;
  const pullRequests = patchPrList(list.pullRequests, targetKey, next, fields);
  return pullRequests === list.pullRequests ? list : { ...list, pullRequests };
}

/**
 * Patches the PR's rows in the dashboard and branch caches when `pull_request_changed`
 * arrives, with the fields its changes name only (CHANGED_FIELDS), without an RPC. The
 * daemon published DashboardUpdated and BranchPullRequestsUpdated before it, so their
 * re-reads land one round trip later and write the same overlaid rows. The detail cache is
 * not patched: only the daemon knows whether its copy is older than the poll, and it says so
 * with pull_request_detail_updated (docs/notes/gh-pr-changed-overlay.md).
 */
function patchPullRequestInCaches(repoSlug: string, number: number, headRef: string, pr: PullRequestView, changes: readonly PrChangeKindView[]): void {
  if (pr.partial) return;
  const slug = pr.repoSlug || repoSlug;
  const num = pr.number || number;
  if (!slug || !num) return;
  const fields = [...new Set(changes.flatMap((c) => CHANGED_FIELDS[c]))];
  if (fields.length === 0) return;
  const patched: PullRequestView = pr.repoSlug && pr.number && (pr.headRef || !headRef) ? pr : { ...pr, repoSlug: slug, number: num, headRef: pr.headRef || headRef };
  const targetKey = pullRequestKey(slug, num);

  // 1. Dashboard lists (authored, reviewRequested, reviewed, recentlyMerged, projectOpen, projectMerged).
  const dashEntries = dashboardResource.store.getState().entries;
  let dashChanged = false;
  const nextDashEntries = { ...dashEntries };
  for (const [key, entry] of Object.entries(dashEntries)) {
    const d = entry.data;
    if (!d) continue;
    const authored = patchPrList(d.authored, targetKey, patched, fields);
    const reviewRequested = patchPrList(d.reviewRequested, targetKey, patched, fields);
    const reviewed = patchPrList(d.reviewed, targetKey, patched, fields);
    const recentlyMerged = patchPrList(d.recentlyMerged, targetKey, patched, fields);
    const projectOpen = patchProjectList(d.projectOpen, targetKey, patched, fields);
    const projectMerged = patchProjectList(d.projectMerged, targetKey, patched, fields);
    if (
      authored !== d.authored ||
      reviewRequested !== d.reviewRequested ||
      reviewed !== d.reviewed ||
      recentlyMerged !== d.recentlyMerged ||
      projectOpen !== d.projectOpen ||
      projectMerged !== d.projectMerged
    ) {
      nextDashEntries[key] = {
        ...entry,
        data: {
          ...d,
          authored,
          reviewRequested,
          reviewed,
          recentlyMerged,
          ...(projectOpen ? { projectOpen } : {}),
          ...(projectMerged ? { projectMerged } : {}),
        },
      };
      dashChanged = true;
    }
  }
  if (dashChanged) dashboardResource.store.setState({ entries: nextDashEntries });

  // 2. Branch pull request lists holding this PR.
  const branchEntries = branchPullRequestsResource.store.getState().entries;
  let branchChanged = false;
  const nextBranchEntries = { ...branchEntries };
  for (const [key, entry] of Object.entries(branchEntries)) {
    const b = entry.data;
    if (!b) continue;
    const pullRequests = patchPrList(b.pullRequests, targetKey, patched, fields);
    if (pullRequests !== b.pullRequests) {
      nextBranchEntries[key] = { ...entry, data: { ...b, pullRequests } };
      branchChanged = true;
    }
  }
  if (branchChanged) branchPullRequestsResource.store.setState({ entries: nextBranchEntries });
}

/**
 * Invalidates currently watched branch PR lists and PR details when EventService.Watch
 * reconnects with a full gh snapshot (could not resume via since_seq) or after a gh
 * source drop resync, so watched views refresh immediately instead of waiting 60s-5m.
 */
export function invalidateWatchedGhOnReconnect(): void {
  branchPullRequestsResource.invalidate(() => true);
  pullRequestDetailResource.invalidate(() => true);
}

/** Routes one gh notification to the views it affects. */
export function applyGhEvent(ev: GhEventView): void {
  switch (ev.kind) {
    case "polled":
      usePollStore.setState({ fetchedAtMs: ev.fetchedAtMs, lastError: ev.lastError, known: true, projectsFetchedAtMs: ev.projectsFetchedAtMs, projectsLastError: ev.projectsLastError });
      break;
    case "viewer":
    case "dashboard":
      if (ev.kind === "viewer") viewerResource.invalidate(VIEWER_KEY);
      dashboardResource.invalidate(() => true);
      break;
    case "repoActivity":
      repoActivityResource.invalidate(ev.repoSlug.toLowerCase());
      break;
    case "branchPullRequests":
      branchPullRequestsResource.invalidate(branchKey(ev.repoSlug, ev.headRef));
      break;
    case "pullRequestDetail":
      pullRequestDetailResource.invalidate(pullRequestKey(ev.repoSlug, ev.number));
      break;
    case "pullRequestChanged":
      patchPullRequestInCaches(ev.repoSlug, ev.number, ev.headRef, ev.pullRequest, ev.changes);
      break;
  }
}

/** Opens a link in the default browser through the registry (view.open.url). */
export async function openUrl(url: string): Promise<void> {
  if (!url) return;
  try {
    await invokeCommand("view.open.url", getUiContext(), { url });
  } catch (err) {
    notify({ level: "error", title: "Open in browser failed", description: errorMessage(err) });
  }
}
