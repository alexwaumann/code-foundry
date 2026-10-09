/**
 * The Pull request surface's state and actions (components/pr). Inner view state lives
 * per panel tab, keyed by panel key + tab id, so switching panel tabs (or selections)
 * keeps it. Actions are registry commands (pr.refresh, pr.review.request, pr.revert) or
 * existing store actions (openUrl, copyText); components call these, never RPCs.
 */
import { toast } from "sonner";
import { create } from "zustand";
import { listReviewerCandidates } from "@/api/gh";
import { copyText } from "@/lib/clipboard";
import { pullRequestTab, type PrRef } from "@/surfaces/pullrequestTarget";
import { runCommand } from "./commands";
import { pullRequestDetailResource, pullRequestKey } from "./gh";
import { openSurface } from "./panel";
import { createResource } from "./resource";

export type PrInnerTab = "summary" | "timeline";
export type SortOrder = "newest" | "oldest";
/** Collapsible sections of the summary. */
export type PrSection = "description" | "checks" | "comments";

export interface PrTabState {
  inner: PrInnerTab;
  commentOrder: SortOrder;
  timelineOrder: SortOrder;
  /** Sections the user folded (or unfolded, for those folded by default). */
  open: Readonly<Partial<Record<PrSection, boolean>>>;
}

export const defaultPrTabState: PrTabState = { inner: "summary", commentOrder: "newest", timelineOrder: "newest", open: {} };

/** Sections shown unfolded until the user folds them. */
export const sectionOpenByDefault: Record<PrSection, boolean> = { description: true, checks: true, comments: true };

interface PrPanelState {
  /** By prTabKey(panelKey, tabId). */
  byTab: Readonly<Record<string, PrTabState>>;
  /** pullRequestKey → a pr.refresh in flight. */
  refreshing: Readonly<Record<string, boolean>>;
  /** pullRequestKey + "\u0000" + login → a pr.review.request in flight. */
  requesting: Readonly<Record<string, boolean>>;
}

export const usePrPanelStore = create<PrPanelState>()(() => ({ byTab: {}, refreshing: {}, requesting: {} }));

export const prTabKey = (panelKey: string, tabId: string): string => `${panelKey}\u0000${tabId}`;

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

/** Key: pullRequestKey(slug, number). Read when the reviewer picker opens (no keep-alive). */
export const reviewerCandidatesResource = createResource((key, signal) => {
  const i = key.lastIndexOf("#");
  return listReviewerCandidates(key.slice(0, i), Number(key.slice(i + 1)), undefined, signal);
});

/**
 * Opens a pull request in the current selection's side panel (a row on the Pull
 * Requests page or the worktree overview). Returns false with nothing selected.
 */
export function openPullRequestInPanel(ref: PrRef): boolean {
  return openSurface("current", pullRequestTab(ref));
}

const prArgs = (ref: PrRef): Record<string, string> => ({ "repo-slug": ref.slug, number: String(ref.number) });

export function pullRequestUrl(ref: PrRef): string {
  return `https://github.com/${ref.slug}/pull/${String(ref.number)}`;
}

/** Menu → Refresh: pr.refresh fetches from GitHub; the resource then re-reads the fresh cache. */
export async function refreshPullRequest(ref: PrRef): Promise<boolean> {
  const key = pullRequestKey(ref.slug, ref.number);
  if (usePrPanelStore.getState().refreshing[key]) return false;
  usePrPanelStore.setState((s) => ({ refreshing: { ...s.refreshing, [key]: true } }));
  try {
    return await runCommand("pr.refresh", prArgs(ref));
  } finally {
    pullRequestDetailResource.invalidate(key);
    usePrPanelStore.setState((s) => {
      const { [key]: _done, ...rest } = s.refreshing;
      return { refreshing: rest };
    });
  }
}

export const requestingKey = (ref: PrRef, login: string): string => `${pullRequestKey(ref.slug, ref.number)}\u0000${login}`;

/** Reviewer picker: requests a review from login, or withdraws the pending request. */
export async function setReviewRequest(ref: PrRef, login: string, kind: "user" | "team", requested: boolean): Promise<boolean> {
  const busy = requestingKey(ref, login);
  if (usePrPanelStore.getState().requesting[busy]) return false;
  usePrPanelStore.setState((s) => ({ requesting: { ...s.requesting, [busy]: true } }));
  try {
    return await runCommand("pr.review.request", { ...prArgs(ref), login, kind, requested: String(requested) });
  } finally {
    const key = pullRequestKey(ref.slug, ref.number);
    pullRequestDetailResource.invalidate(key);
    reviewerCandidatesResource.invalidate(key);
    usePrPanelStore.setState((s) => {
      const { [busy]: _done, ...rest } = s.requesting;
      return { requesting: rest };
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
