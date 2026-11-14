/**
 * The Pull request surface's state and actions (components/pr). Inner view state lives
 * per panel tab, keyed by panel key + tab id, so switching panel tabs (or selections)
 * keeps it, and closing the tab drops it. Actions are registry commands (pr.refresh,
 * pr.review.request, pr.review, pr.revert, pr.merge, pr.ready, pr.draft, pr.auto-merge, thread.pr.link)
 * or existing store actions (openUrl, copyText); components
 * call these, never RPCs.
 */
import { toast } from "sonner";
import { create } from "zustand";
import { listReviewerCandidates, parseMergeResult, parseRefreshResult, parseRevertResult, type MergeMethodView } from "@/api/gh";
import { mergeArgs } from "@/components/pr/merge";
import type { Verdict } from "@/components/pr/review";
import { copyText } from "@/lib/clipboard";
import type { TaskItem } from "@/lib/taskItems";
import { pullRequestTab, type PrRef } from "@/surfaces/pullrequestTarget";
import { runCommand, runCommandForResult } from "./commands";
import { openUrl, pullRequestDetailResource, pullRequestKey } from "./gh";
import { findTab, openTab, subscribeTabs, type Tab, type TabPlaces, type TabTarget } from "@/shell/host";
import { createResource, type Resource } from "./resource";

export type PrInnerTab = "overview" | "activity" | "code";
export type SortOrder = "newest" | "oldest";
/**
 * Collapsible sections: the Overview's, the readiness box's checks row (its full list),
 * the description shown whole (it fades out until Show all), and the Code tab's file list.
 */
export type PrSection = "description" | "fullDescription" | "checks" | "comments" | "files";

/** Which change of the pull request is running (`changing`): each button spins only for its own. */
export type PrChange = "ready" | "draft" | "auto-merge" | "cancel-auto-merge";

export interface PrTabState {
  inner: PrInnerTab;
  commentOrder: SortOrder;
  timelineOrder: SortOrder;
  /** Sections the user folded (or unfolded, for those folded by default). */
  open: Readonly<Partial<Record<PrSection, boolean>>>;
}

export const defaultPrTabState: PrTabState = { inner: "overview", commentOrder: "newest", timelineOrder: "newest", open: {} };

/** Sections shown unfolded until the user folds them. */
export const sectionOpenByDefault: Record<PrSection, boolean> = { description: true, fullDescription: false, checks: false, comments: true, files: true };

interface PrPanelState {
  /** By the pull request tab's layout id, linked or not (a tab is known by its id wherever it is). */
  byTab: Readonly<Record<string, PrTabState>>;
  /** pullRequestKey → a pr.refresh in flight. */
  refreshing: Readonly<Record<string, boolean>>;
  /** pullRequestKey + "\u0000" + login → a pr.review.request in flight. */
  requesting: Readonly<Record<string, boolean>>;
  /**
   * requestingKey → what the last successful pr.review.request from the picker left
   * (true: requested). The daemon has checked GitHub took it, so the row shows this over
   * the candidates until the picker closes (clearConfirmedRequests): a re-read that lags
   * GitHub, or is still running, never flips the check back.
   */
  confirmed: Readonly<Record<string, boolean>>;
  /** pullRequestKey → a pr.merge in flight (from its confirmation on). */
  merging: Readonly<Record<string, boolean>>;
  /** pullRequestKey → a pr.review in flight (until the detail shows it). */
  reviewing: Readonly<Record<string, boolean>>;
  /** pullRequestKey → the pr.ready, pr.draft or pr.auto-merge in flight (until the detail shows it). */
  changing: Readonly<Record<string, PrChange>>;
  /** pullRequestKey → a pr.revert in flight (from its confirmation on). */
  reverting: Readonly<Record<string, boolean>>;
  /** taskCheckKey → the state a pr.checkbox in flight asks for (until the detail shows it). */
  taskChecks: Readonly<Record<string, boolean>>;
  /** Lower-case repository slug → the merge method last chosen there (the split button's default). */
  mergeMethods: Readonly<Record<string, MergeMethodView>>;
}

export const usePrPanelStore = create<PrPanelState>()(() => ({ byTab: {}, refreshing: {}, requesting: {}, confirmed: {}, merging: {}, reviewing: {}, changing: {}, reverting: {}, taskChecks: {}, mergeMethods: {} }));

/**
 * Drops inner state of tabs no pane holds any more (a closed tab reopens fresh). Every open tab is
 * in its pane's place, so a tab moved, resized around or shown from another selection keeps its own.
 */
function pruneClosedTabs(places: TabPlaces): void {
  const byTab = usePrPanelStore.getState().byTab;
  const keys = Object.keys(byTab);
  if (keys.length === 0) return;
  const live = new Set<string>();
  for (const p of Object.values(places)) for (const t of p.tabs) live.add(t.id);
  if (keys.every((k) => live.has(k))) return;
  usePrPanelStore.setState({ byTab: Object.fromEntries(Object.entries(byTab).filter(([k]) => live.has(k))) });
}

subscribeTabs(pruneClosedTabs);

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
 * Opens a pull request's tab: the current selection's (a row on the Pull Requests page or the
 * worktree overview), or a thread's (the sidebar's linked pull request tag, with
 * `focus: false`). Returns false with nothing selected.
 */
export function openPullRequestInPanel(ref: PrRef, target: TabTarget = "current", opts: { focus?: boolean } = {}): boolean {
  return openTab(target, panelPullRequestTab(ref, target), opts);
}

/** The tab to open for a pull request: the one the panel holds, so it keeps the slug it shows, else a new one. */
export function panelPullRequestTab(ref: PrRef, target: TabTarget): Tab {
  const tab = pullRequestTab(ref);
  return findTab(target, tab.id) ?? tab;
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

/** Forgets the picker's confirmed requests for ref (it closed: the next open shows GitHub's state). */
export function clearConfirmedRequests(ref: PrRef): void {
  const prefix = `${pullRequestKey(ref.slug, ref.number)}\u0000`;
  const confirmed = usePrPanelStore.getState().confirmed;
  if (!Object.keys(confirmed).some((k) => k.startsWith(prefix))) return;
  usePrPanelStore.setState({ confirmed: Object.fromEntries(Object.entries(confirmed).filter(([k]) => !k.startsWith(prefix))) });
}

/**
 * Reviewer picker: requests a review from login, or withdraws the pending request. The
 * row stays busy until the picker's candidates (every query it watches) are read again,
 * so a second click cannot repeat the same request. Once the daemon confirms the
 * change, `confirmed` holds the new state, so the row shows it at once (during the
 * re-read too) and keeps it whatever the re-read says while the picker is open.
 */
export async function setReviewRequest(ref: PrRef, login: string, kind: "user" | "team", requested: boolean): Promise<boolean> {
  const busy = requestingKey(ref, login);
  if (usePrPanelStore.getState().requesting[busy]) return false;
  usePrPanelStore.setState((s) => {
    const { [busy]: _was, ...confirmed } = s.confirmed;
    return { requesting: { ...s.requesting, [busy]: true }, confirmed };
  });
  const key = pullRequestKey(ref.slug, ref.number);
  try {
    const ok = await runCommand("pr.review.request", { ...prArgs(ref), login, kind, requested: String(requested) });
    if (ok) usePrPanelStore.setState((s) => ({ confirmed: { ...s.confirmed, [busy]: requested } }));
    return ok;
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
 * the same panel. Returns the new pull request, or null; a second call while one runs
 * sends nothing, so it cannot open a second revert.
 */
export async function revertPullRequest(ref: PrRef, panel: TabTarget): Promise<PrRef | null> {
  const key = pullRequestKey(ref.slug, ref.number);
  if (usePrPanelStore.getState().reverting[key]) return null;
  usePrPanelStore.setState((s) => ({ reverting: { ...s.reverting, [key]: true } }));
  try {
    const res = await runCommandForResult("pr.revert", prArgs(ref), { quiet: true });
    if (!res) return null;
    const made = parseRevertResult(res.resultJson);
    pullRequestDetailResource.invalidate(key);
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
    openPullRequestInPanel(next, panel);
    return next;
  } finally {
    usePrPanelStore.setState((s) => {
      const { [key]: _done, ...rest } = s.reverting;
      return { reverting: rest };
    });
  }
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
    // Only a merge that ran sets the default: a declined confirmation or a refusal does not.
    rememberMergeMethod(ref.slug, method);
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

/** Remembers the merge method chosen in slug's repository: the split buttons' default there. */
export function rememberMergeMethod(slug: string, method: MergeMethodView): void {
  const k = slug.toLowerCase();
  if (usePrPanelStore.getState().mergeMethods[k] === method) return;
  usePrPanelStore.setState((s) => ({ mergeMethods: { ...s.mergeMethods, [k]: method } }));
}

/**
 * Runs one of the pull request's state changes (pr.ready, pr.draft, pr.auto-merge), the
 * daemon's message toasted. Busy (`changing`) until the detail is read again, so the box
 * shows the new state when its button comes back; a failure frees it at once. A second
 * call while one runs sends nothing.
 */
async function changePullRequest(ref: PrRef, change: PrChange, command: string, args: Record<string, string>): Promise<boolean> {
  const key = pullRequestKey(ref.slug, ref.number);
  if (usePrPanelStore.getState().changing[key]) return false;
  usePrPanelStore.setState((s) => ({ changing: { ...s.changing, [key]: change } }));
  let ok = false;
  try {
    ok = await runCommand(command, args);
    return ok;
  } finally {
    pullRequestDetailResource.invalidate(key);
    if (ok) await settled(pullRequestDetailResource, (k) => k === key);
    usePrPanelStore.setState((s) => {
      const { [key]: _done, ...rest } = s.changing;
      return { changing: rest };
    });
  }
}

/** The change running on ref (null: none). Any of them makes the others wait. */
export function usePullRequestChange(ref: PrRef): PrChange | null {
  return usePrPanelStore((s) => s.changing[pullRequestKey(ref.slug, ref.number)] ?? null);
}

/** The draft row's Ready for review (pr.ready) and the menu's Convert to draft (pr.draft). */
export function setPullRequestDraft(ref: PrRef, draft: boolean): Promise<boolean> {
  return changePullRequest(ref, draft ? "draft" : "ready", draft ? "pr.draft" : "pr.ready", prArgs(ref));
}

/** A task box of a pull request's description: its pullRequestKey and its index. */
export const taskCheckKey = (ref: PrRef, index: number): string => `${pullRequestKey(ref.slug, ref.number)}\u0000${String(index)}`;

/**
 * A click on a description's task box (components/pr/TaskBox): pr.checkbox. The box shows
 * `checked` at once and until the detail is read again, so it never flips back on the way;
 * a failure frees it at once and the toast says why. It says nothing on success: the box is
 * the answer. A second click while one runs sends nothing. Other boxes do not wait: the
 * daemon runs them one at a time, each on the last one's result.
 */
export async function setTaskChecked(ref: PrRef, item: TaskItem, checked: boolean): Promise<boolean> {
  const key = pullRequestKey(ref.slug, ref.number);
  const box = taskCheckKey(ref, item.index);
  if (usePrPanelStore.getState().taskChecks[box] !== undefined) return false;
  usePrPanelStore.setState((s) => ({ taskChecks: { ...s.taskChecks, [box]: checked } }));
  let ok = false;
  try {
    const args = { ...prArgs(ref), index: String(item.index), checked: String(checked), text: item.text };
    ok = (await runCommandForResult("pr.checkbox", args, { quiet: true })) !== null;
    return ok;
  } finally {
    pullRequestDetailResource.invalidate(key);
    if (ok) await settled(pullRequestDetailResource, (k) => k === key);
    usePrPanelStore.setState((s) => {
      const { [box]: _done, ...rest } = s.taskChecks;
      return { taskChecks: rest };
    });
  }
}

/** pr.auto-merge's args: on with a method and the head shown (refused if it moved), or --off. */
export function autoMergeArgs(ref: PrRef, method: MergeMethodView | null, headSha: string): Record<string, string> {
  if (method === null) return { ...prArgs(ref), off: "true" };
  return { ...prArgs(ref), method, ...(headSha ? { "head-sha": headSha } : {}) };
}

/**
 * The footer's Auto-merge (a method: GitHub merges it once its requirements pass; the
 * daemon confirms first) and Cancel auto-merge (null). The method becomes the
 * repository's default only once auto-merge is on (not when declined or refused).
 */
export async function setAutoMerge(ref: PrRef, method: MergeMethodView | null, headSha: string): Promise<boolean> {
  const ok = await changePullRequest(ref, method === null ? "cancel-auto-merge" : "auto-merge", "pr.auto-merge", autoMergeArgs(ref, method, headSha));
  if (ok && method !== null) rememberMergeMethod(ref.slug, method);
  return ok;
}

/** Menu → Link to this thread: thread.pr.link (a manual link; there is no unlink). */
export function linkPullRequestToThread(threadId: string, ref: PrRef): Promise<boolean> {
  return runCommand("thread.pr.link", { id: threadId, pr: `${ref.slug}#${String(ref.number)}` });
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
