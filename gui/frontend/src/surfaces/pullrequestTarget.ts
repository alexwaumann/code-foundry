/**
 * Which pull request a selection resolves to, for the Pull request surface: the
 * selection's worktree (a session's, a terminal's, a worktree row, a repo row's main
 * worktree) → its branch → the branch's pull requests (branchPullRequestsResource).
 * Pure: the surface spec feeds it the stores' current state.
 */
import type { BranchPullRequestsView, PullRequestView } from "@/api/gh";
import { deriveContext } from "@/stores/context";
import { makeTab, type Tab } from "@/stores/panel";
import { findWorktree, type ReposData } from "@/stores/repos";
import type { ResourceEntry } from "@/stores/resource";
import type { SessionsData } from "@/stores/sessions";
import type { TerminalsData } from "@/stores/terminals";
import type { Selection } from "@/stores/ui";

export const PULL_REQUEST_KIND = "pullrequest";

/** A pull request a panel tab names. */
export interface PrRef {
  slug: string;
  number: number;
}

/** The tab for a pull request: params { slug, number }, title "#<number>". */
export function pullRequestTab(ref: PrRef): Tab {
  return makeTab(PULL_REQUEST_KIND, `#${String(ref.number)}`, { slug: ref.slug, number: String(ref.number) });
}

/** The pull request a tab names, or null when its params are not one. */
export function prRefOfTab(tab: Pick<Tab, "params">): PrRef | null {
  const slug = tab.params.slug ?? "";
  const number = Number(tab.params.number);
  return slug.includes("/") && Number.isInteger(number) && number > 0 ? { slug, number } : null;
}

export interface SelectionStores {
  repos: ReposData;
  sessions: SessionsData;
  terminals: TerminalsData;
}

/** GitHub slug (lower case, like branchKey's users) and branch the selection looks at; null without both. */
export function selectionBranch(sel: Selection, s: SelectionStores): { slug: string; branch: string } | null {
  if (sel.kind === "none" || sel.kind === "view") return null;
  const ctx = deriveContext(sel, s.terminals, s.repos, s.sessions);
  const repo = s.repos.byId[ctx.activeRepoId];
  const slug = repo?.githubSlug.toLowerCase() ?? "";
  const branch = findWorktree(s.repos, ctx.activeRepoId, ctx.activeWorktreePath)?.branch ?? "";
  return slug && branch ? { slug, branch } : null;
}

/** The branch's pull request to show: the first open one, else the first listed (most recent). */
export function pickPullRequest(prs: readonly PullRequestView[]): PullRequestView | null {
  return prs.find((p) => p.state === "open") ?? prs[0] ?? null;
}

/**
 * The pull request of the selection's branch, if its branch pull requests are loaded.
 * `entryOf` reads branchPullRequestsResource's entry for (slug, branch).
 */
export function selectionPullRequest(
  sel: Selection,
  s: SelectionStores,
  entryOf: (slug: string, branch: string) => ResourceEntry<BranchPullRequestsView> | undefined,
): PrRef | null {
  const at = selectionBranch(sel, s);
  if (!at) return null;
  const pr = pickPullRequest(entryOf(at.slug, at.branch)?.data?.pullRequests ?? []);
  return pr ? { slug: pr.repoSlug || at.slug, number: pr.number } : null;
}
