/**
 * The merge button's pure logic: whether it shows, why it is disabled, which methods it
 * offers, and pr.merge's args. Table-tested in merge.test.ts.
 */
import type { MergeMethodView, PullRequestDetailView } from "@/api/gh";
import type { PrRef } from "@/surfaces/pullrequestTarget";

/** GitHub's merge button labels, in its order. */
export const MERGE_METHOD_LABELS: Record<MergeMethodView, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

export const MERGE_METHOD_ORDER: readonly MergeMethodView[] = ["merge", "squash", "rebase"];

export interface MergeAvailability {
  /** Shown only for an open pull request. */
  visible: boolean;
  /** Why it is disabled (the tooltip); null when it can be used. */
  reason: string | null;
  /** The methods to offer, in GitHub's order. */
  methods: MergeMethodView[];
  /** Notes for the dropdown: merging anyway is allowed, but worth knowing. */
  notes: string[];
}

/**
 * Whether the merge button shows and works for d. The daemon and GitHub check again; this
 * only keeps the button from offering what GitHub refuses. Behind the base branch is
 * allowed (GitHub merges it as is), as is mergeability GitHub has not computed yet.
 */
export function mergeAvailability(d: PullRequestDetailView): MergeAvailability {
  const pr = d.pullRequest;
  const methods = MERGE_METHOD_ORDER.filter((m) => d.mergeMethods.includes(m));
  const notes: string[] = [];
  if (d.autoMergeEnabled) notes.push("Auto-merge is on: GitHub merges it once its requirements pass.");
  if (pr.mergeState === "behind") notes.push(`Behind ${pr.baseRef || "the base branch"}: it merges as is.`);
  if (pr.mergeState === "unstable") notes.push("Some checks that are not required are failing.");
  const out = (reason: string | null): MergeAvailability => ({ visible: pr.state === "open", reason, methods, notes });
  if (pr.state !== "open") return out(null);
  if (pr.draft || pr.mergeState === "draft") return out("Draft pull requests cannot be merged");
  if (!d.viewerCanUpdate) return out("Merging needs write access");
  if (pr.mergeable === "conflicting" || pr.mergeState === "dirty") return out("Resolve conflicts first");
  if (pr.mergeState === "blocked") return out("Blocked: required checks or reviews are missing");
  if (methods.length === 0) return out("This repository allows no merge method");
  return out(null);
}

/** The branch is deleted after the merge by default unless it lives in a fork (never deleted). */
export function canDeleteBranch(d: PullRequestDetailView): boolean {
  return !d.pullRequest.isCrossRepository && d.pullRequest.headRef !== "";
}

/** pr.merge's args. */
export function mergeArgs(ref: PrRef, method: MergeMethodView, deleteBranch: boolean): Record<string, string> {
  return { "repo-slug": ref.slug, number: String(ref.number), method, "delete-branch": String(deleteBranch) };
}

/** The line under a method in the dropdown, after GitHub's descriptions. */
export function mergeMethodHint(method: MergeMethodView, commitCount: number, baseRef: string): string {
  const commits = commitCount === 1 ? "its commit" : commitCount > 1 ? `its ${String(commitCount)} commits` : "its commits";
  const base = baseRef || "the base branch";
  switch (method) {
    case "merge":
      return `Adds ${commits} to ${base} with a merge commit.`;
    case "squash":
      return commitCount === 1 ? `Adds its commit to ${base} as one commit.` : `Combines ${commits} into one commit on ${base}.`;
    case "rebase":
      return `Replays ${commits} onto ${base}.`;
  }
}
