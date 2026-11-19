/**
 * Closing and reopening a pull request (pr.close, pr.reopen), and copying its branch name:
 * the ⋯ menu's actions beside the draft change (prPanel.ts), in their own store so the
 * menu reads one narrow flag. Components call these, never RPCs.
 */
import { create } from "zustand";
import type { PullRequestDetailView } from "@/api/gh";
import { copyText } from "@/lib/clipboard";
import { notify } from "@/lib/notify";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { runCommand, type CommandSource } from "./commands";
import { pullRequestDetailResource, pullRequestKey } from "./gh";
import { prArgs, settled } from "./prPanel";

/** Which of the two is running on a pull request. */
export type PrClosing = "close" | "reopen";

interface PrCloseState {
  /** pullRequestKey → the pr.close or pr.reopen in flight (until the detail shows it). */
  closing: Readonly<Record<string, PrClosing>>;
}

export const usePrCloseStore = create<PrCloseState>()(() => ({ closing: {} }));

/**
 * Whether the menu offers Close pull request: it is open (a draft is open too) and GitHub
 * says the viewer may close it. The daemon checks both again before it acts.
 */
export function canClosePullRequest(d: PullRequestDetailView): boolean {
  return d.pullRequest.state === "open" && d.viewerCanClose;
}

/** Whether the menu offers Reopen pull request: it is closed, not merged, and the viewer may reopen it. */
export function canReopenPullRequest(d: PullRequestDetailView): boolean {
  return d.pullRequest.state === "closed" && d.viewerCanReopen;
}

/**
 * Runs pr.close or pr.reopen. The daemon asks before it closes (the confirm dialog
 * handles it; declining returns false quietly) and toasts its message ("Closed #12")
 * unless `source` is a control that shows the change. Busy (`closing`) until the detail
 * is read again, so the state chip has changed when the item comes back; a failure is
 * toasted and frees it at once. A second call while one runs sends nothing.
 */
async function closeOrReopen(ref: PrRef, what: PrClosing, source: CommandSource): Promise<boolean> {
  const key = pullRequestKey(ref.slug, ref.number);
  if (usePrCloseStore.getState().closing[key]) return false;
  usePrCloseStore.setState((s) => ({ closing: { ...s.closing, [key]: what } }));
  let ok = false;
  try {
    ok = await runCommand(what === "close" ? "pr.close" : "pr.reopen", prArgs(ref), undefined, source);
    return ok;
  } finally {
    pullRequestDetailResource.invalidate(key);
    if (ok) await settled(pullRequestDetailResource, (k) => k === key);
    usePrCloseStore.setState((s) => {
      const { [key]: _done, ...rest } = s.closing;
      return { closing: rest };
    });
  }
}

/** Menu → Close pull request: pr.close (confirmed by the daemon). */
export function closePullRequest(ref: PrRef, source: CommandSource = {}): Promise<boolean> {
  return closeOrReopen(ref, "close", source);
}

/** Menu → Reopen pull request: pr.reopen (no confirmation). */
export function reopenPullRequest(ref: PrRef, source: CommandSource = {}): Promise<boolean> {
  return closeOrReopen(ref, "reopen", source);
}

/** The close or reopen running on ref (null: none). */
export function usePullRequestClosing(ref: PrRef): PrClosing | null {
  return usePrCloseStore((s) => s.closing[pullRequestKey(ref.slug, ref.number)] ?? null);
}

/** Menu → Copy branch name: the head branch's name, as Copy link copies the URL. */
export async function copyPullRequestBranch(branch: string): Promise<void> {
  try {
    await copyText(branch);
    notify({ level: "success", title: "Branch name copied", description: branch });
  } catch {
    notify({ level: "error", title: "Copy failed" });
  }
}
