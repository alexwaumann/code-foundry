/**
 * The Pull request surface's state and actions (components/pr). Inner view state lives
 * per panel tab, keyed by panel key + tab id, so switching panel tabs (or selections)
 * keeps it, and closing the tab drops it. Actions are registry commands (pr.refresh,
 * pr.review.request, pr.review, pr.revert, pr.merge) or existing store actions (openUrl, copyText); components
 * call these, never RPCs.
 */
import { toast } from "sonner";
import { create } from "zustand";
import { listReviewerCandidates, parseMergeResult, parseRefreshResult, parseRevertResult, type MergeMethodView } from "@/api/gh";
import { mergeArgs } from "@/components/pr/merge";
import type { Verdict } from "@/components/pr/review";
import { copyText } from "@/lib/clipboard";
import { pullRequestTab, type PrRef } from "@/surfaces/pullrequestTarget";
import { runCommand, runCommandForResult } from "./commands";
import { openUrl, pullRequestDetailResource, pullRequestKey } from "./gh";
import { allTabs, openSurface, usePanelStore, type PanelState, type PanelTarget } from "./panel";
import { createResource, type Resource } from "./resource";

export type PrInnerTab = "summary" | "timeline" | "code";
export type SortOrder = "newest" | "oldest";
/** Collapsible sections: the summary's, and the Code tab's file list. */
export type PrSection = "description" | "checks" | "comments" | "files";

export interface PrTabState {
  inner: PrInnerTab;
  commentOrder: SortOrder;
  timelineOrder: SortOrder;
  /** Sections the user folded (or unfolded, for those folded by default). */
  open: Readonly<Partial<Record<PrSection, boolean>>>;
}

export const defaultPrTabState: PrTabState = { inner: "summary", commentOrder: "newest", timelineOrder: "newest", open: {} };

/** Sections shown unfolded until the user folds them. */
export const sectionOpenByDefault: Record<PrSection, boolean> = { description: true, checks: true, comments: true, files: true };

interface PrPanelState {
  /** By prTabKey(panelKey, tabId). */
  byTab: Readonly<Record<string, PrTabState>>;
  /** pullRequestKey → a pr.refresh in flight. */
  refreshing: Readonly<Record<string, boolean>>;
  /** pullRequestKey + "\u0000" + login → a pr.review.request in flight. */
  requesting: Readonly<Record<string, boolean>>;
  /** pullRequestKey → a pr.merge in flight (from its confirmation on). */
  merging: Readonly<Record<string, boolean>>;
  /** pullRequestKey → a pr.review in flight (until the detail shows it). */
  reviewing: Readonly<Record<string, boolean>>;
}

export const usePrPanelStore = create<PrPanelState>()(() => ({ byTab: {}, refreshing: {}, requesting: {}, merging: {}, reviewing: {} }));

export const prTabKey = (panelKey: string, tabId: string): string => `${panelKey}\u0000${tabId}`;

/** Drops inner state of tabs no panel holds any more (a closed tab reopens fresh). */
function pruneClosedTabs(panels: PanelState): void {
  const byTab = usePrPanelStore.getState().byTab;
  const keys = Object.keys(byTab);
  if (keys.length === 0) return;
  const live = new Set<string>();
  for (const [panelKey, e] of Object.entries(panels.byKey)) for (const t of allTabs(e)) live.add(prTabKey(panelKey, t.id));
  if (keys.every((k) => live.has(k))) return;
  usePrPanelStore.setState({ byTab: Object.fromEntries(Object.entries(byTab).filter(([k]) => live.has(k))) });
}

usePanelStore.subscribe((s, prev) => {
  if (s.byKey !== prev.byKey) pruneClosedTabs(s);
});

export function updatePrTab(key: string, f: (s: PrTabState) => PrTabState): void {
  usePrPanelStore.setState((s) => ({ byTab: { ...s.byTab, [key]: f(s.byTab[key] ?? defaultPrTabState) } }));
}

export function setInnerTab(key: string, inner: PrInnerTab): void {
  updatePrTab(key, (s) => (s.inner === inner ? s : { ...s, inner }));
}

export function toggleSection(key: string, section: PrSection): void {
  updatePrTab(key, (s) => ({ ...s, open: { ...s.open, [section]: !(s.open[section] ?? sectionOpenByDefault[section]) } }));
}

export function toggleOrder(key: string, which: "commentOrder" | "timelineOrder"): void {
  updatePrTab(key, (s) => ({ ...s, [which]: s[which] === "newest" ? "oldest" : "newest" }));
}

/** reviewerCandidatesResource's key: the pull request, then the (trimmed) search; "" lists the requests only. */
export const reviewerCandidatesKey = (ref: PrRef, query: string): string => `${pullRequestKey(ref.slug, ref.number)}\u0000${query}`;

/**
 * Key: reviewerCandidatesKey. Read while the reviewer picker shows it (no keep-alive); a
 * search the user typed past is aborted.
 */
export const reviewerCandidatesResource = createResource(
  (key, signal) => {
    const sep = key.indexOf("\u0000");
    const pr = key.slice(0, sep);
    const i = pr.lastIndexOf("#");
    return listReviewerCandidates(pr.slice(0, i), Number(pr.slice(i + 1)), key.slice(sep + 1), undefined, signal);
  },
  { abortOnRelease: true },
);

/**
 * Opens a pull request in a side panel: the current selection's (a row on the Pull
 * Requests page or the worktree overview), or a thread's (view.panel.pr,
 * stores/threadPanelIntent.ts). Returns false with nothing selected.
 */
export function openPullRequestInPanel(ref: PrRef, target: PanelTarget = "current"): boolean {
  return openSurface(target, pullRequestTab(ref));
}

export const prArgs = (ref: PrRef): Record<string, string> => ({ "repo-slug": ref.slug, number: String(ref.number) });

/** pr.review's args. The body is trimmed (the daemon trims it too); an empty approval sends none. */
export function reviewArgs(ref: PrRef, verdict: Verdict, body: string): Record<string, string> {
  const b = body.trim();
  return { ...prArgs(ref), verdict, ...(b === "" ? {} : { body: b }) };
}

export function pullRequestUrl(ref: PrRef): string {
  return `https://github.com/${ref.slug}/pull/${String(ref.number)}`;
}

/**
 * Menu → Refresh: pr.refresh fetches from GitHub, quietly (the menu shows the progress and
 * the new time). Its result is the fresh detail, written straight into the resource: no
 * second read. A failure is toasted and recorded as the entry's error over the copy shown
 * ("Could not refresh"), which keeps its own lastError.
 */
export async function refreshPullRequest(ref: PrRef): Promise<boolean> {
  const key = pullRequestKey(ref.slug, ref.number);
  if (usePrPanelStore.getState().refreshing[key]) return false;
  usePrPanelStore.setState((s) => ({ refreshing: { ...s.refreshing, [key]: true } }));
  try {
    const res = await runCommandForResult("pr.refresh", prArgs(ref), {
      quiet: true,
      onError: (message) => {
        pullRequestDetailResource.set(key, { error: message });
      },
    });
    if (!res) return false;
    const fresh = parseRefreshResult(res.resultJson);
    // An older daemon's result carries no detail: read the (fresh) cache instead.
    if (fresh) pullRequestDetailResource.set(key, { data: fresh });
    else pullRequestDetailResource.invalidate(key);
    return true;
  } finally {
    usePrPanelStore.setState((s) => {
      const { [key]: _done, ...rest } = s.refreshing;
      return { refreshing: rest };
    });
  }
}

/**
 * Resolves once no entry of the keys matching pred is loading (at once when nothing reads
 * them), or after timeoutMs.
 */
function settled<V>(r: Resource<V>, pred: (key: string) => boolean, timeoutMs = 15_000): Promise<void> {
  const idle = (entries: Readonly<Record<string, { loading: boolean }>>) => !Object.entries(entries).some(([k, e]) => e.loading && pred(k));
  if (idle(r.store.getState().entries)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const unsub = r.store.subscribe((s) => {
      if (idle(s.entries)) done();
    });
  });
}

export const requestingKey = (ref: PrRef, login: string): string => `${pullRequestKey(ref.slug, ref.number)}\u0000${login}`;

/**
 * Reviewer picker: requests a review from login, or withdraws the pending request. The
 * row stays busy until the picker's candidates (every query it watches) are read again,
 * so it never shows the old state after the request, and a second click cannot repeat
 * the same request.
 */
export async function setReviewRequest(ref: PrRef, login: string, kind: "user" | "team", requested: boolean): Promise<boolean> {
  const busy = requestingKey(ref, login);
  if (usePrPanelStore.getState().requesting[busy]) return false;
  usePrPanelStore.setState((s) => ({ requesting: { ...s.requesting, [busy]: true } }));
  const key = pullRequestKey(ref.slug, ref.number);
  try {
    return await runCommand("pr.review.request", { ...prArgs(ref), login, kind, requested: String(requested) });
  } finally {
    pullRequestDetailResource.invalidate(key);
    const ofThisPr = (k: string) => k.startsWith(`${key}\u0000`);
    reviewerCandidatesResource.invalidate(ofThisPr);
    await settled(reviewerCandidatesResource, ofThisPr);
    usePrPanelStore.setState((s) => {
      const { [busy]: _done, ...rest } = s.requesting;
      return { requesting: rest };
    });
  }
}

/**
 * Menu → Revert changes: pr.revert (the daemon asks for confirmation; the confirm dialog
 * handles it). On success, toasts the new pull request and opens it as another tab of
 * the same panel. Returns the new pull request, or null.
 */
export async function revertPullRequest(ref: PrRef, panel: PanelTarget): Promise<PrRef | null> {
  const res = await runCommandForResult("pr.revert", prArgs(ref), { quiet: true });
  if (!res) return null;
  const made = parseRevertResult(res.resultJson);
  pullRequestDetailResource.invalidate(pullRequestKey(ref.slug, ref.number));
  if (!made) {
    if (res.message) toast.success(res.message);
    return null;
  }
  const url = made.url || pullRequestUrl({ slug: ref.slug, number: made.number });
  toast.success(`Opened #${String(made.number)} to revert #${String(ref.number)}`, {
    description: url,
    action: { label: "Open on GitHub", onClick: () => void openUrl(url) },
  });
  const next = { slug: ref.slug, number: made.number };
  openSurface(panel, pullRequestTab(next));
  return next;
}

/**
 * The merge button: pr.merge with the head commit the panel shows (the daemon refuses
 * if GitHub's head moved since; the daemon asks for confirmation and the confirm dialog
 * handles it). On success, toasts the daemon's message ("Merged #N (sha)", with the
 * branch deletion as the description). Either way the detail is read again: the daemon
 * also announces it, and after a refusal (the head moved) it shows GitHub's state.
 * Returns whether it merged; a second call while one runs sends nothing.
 */
export async function mergePullRequest(ref: PrRef, method: MergeMethodView, deleteBranch: boolean, headSha: string): Promise<boolean> {
  const key = pullRequestKey(ref.slug, ref.number);
  if (usePrPanelStore.getState().merging[key]) return false;
  usePrPanelStore.setState((s) => ({ merging: { ...s.merging, [key]: true } }));
  try {
    const res = await runCommandForResult("pr.merge", mergeArgs(ref, method, deleteBranch, headSha), { quiet: true });
    if (!res) return false;
    const message = parseMergeResult(res.resultJson)?.message || res.message || `Merged #${String(ref.number)}`;
    const [title = message, ...rest] = message.split("; ");
    toast.success(title, rest.length > 0 ? { description: rest.join("; ") } : undefined);
    return true;
  } finally {
    pullRequestDetailResource.invalidate(key);
    usePrPanelStore.setState((s) => {
      const { [key]: _done, ...others } = s.merging;
      return { merging: others };
    });
  }
}

/**
 * The Review composer: pr.review with the verdict and the (trimmed) body. The daemon's
 * message is toasted ("Approved #N"); a refusal is the generic "Review Pull Request
 * failed" toast with GitHub's message. Either way the detail is read again (the daemon
 * also announces it); on success this waits for that read, so the header's chip and the
 * new review in Comments are there when the composer closes, and a failure returns at
 * once. Returns whether it was
 * submitted; a second call while one runs sends nothing.
 */
export async function submitReview(ref: PrRef, verdict: Verdict, body: string): Promise<boolean> {
  const key = pullRequestKey(ref.slug, ref.number);
  if (usePrPanelStore.getState().reviewing[key]) return false;
  usePrPanelStore.setState((s) => ({ reviewing: { ...s.reviewing, [key]: true } }));
  let ok = false;
  try {
    ok = await runCommand("pr.review", reviewArgs(ref, verdict, body));
    return ok;
  } finally {
    pullRequestDetailResource.invalidate(key);
    // A failure frees the composer at once (its text stays for a retry); only a posted
    // review waits for the detail that shows it.
    if (ok) await settled(pullRequestDetailResource, (k) => k === key);
    usePrPanelStore.setState((s) => {
      const { [key]: _done, ...rest } = s.reviewing;
      return { reviewing: rest };
    });
  }
}

/** Menu → Copy link (and shift+cmd+c in the panel). */
export async function copyPullRequestLink(ref: PrRef, url = pullRequestUrl(ref)): Promise<void> {
  try {
    await copyText(url);
    toast.success("Link copied", { description: url });
  } catch {
    toast.error("Copy failed");
  }
}
