import { createElement } from "react";
import { GitPullRequest } from "lucide-react";
import { PullRequestSurface } from "@/components/pr/PullRequestSurface";
import { COPY_LINK_CHORD } from "@/components/pr/keys";
import { branchKey, branchPullRequestsResource } from "@/stores/gh";
import { copyPullRequestLink } from "@/stores/prPanel";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { PULL_REQUEST_KIND, prRefOfTab, pullRequestTab, selectionBranch, selectionPullRequest, type PrRef } from "./pullrequestTarget";
import { noProjectNow } from "./noProject";
import type { SurfaceSpec } from "./types";

const noop = (): void => undefined;

function stores() {
  return { projects: useProjectsStore.getState(), threads: useThreadsStore.getState() };
}

/** The pull request of the selection's worktree branch, from what is loaded now. */
function currentPullRequest(sel: Selection): PrRef | null {
  const entries = branchPullRequestsResource.store.getState().entries;
  return selectionPullRequest(sel, stores(), (slug, branch) => entries[branchKey(slug, branch)]);
}

/**
 * Pull request: the selection's pull request (a thread's or worktree's
 * branch; a project row's main worktree). Enabled when that branch has one; disabled
 * otherwise, including on the Pull Requests page, whose rows open a pull request
 * explicitly (openSurface with pullRequestTab). Hidden for a thread without a project,
 * which has no branch (a pull request it linked opens from Linked PRs). Tabs: params
 * { slug, number }, title #N.
 */
export const pullRequestSurface: SurfaceSpec = {
  kind: PULL_REQUEST_KIND,
  title: "Pull request",
  icon: GitPullRequest,
  hotkey: "p",
  available: (ctx) => (noProjectNow(ctx.selection) ? "hidden" : currentPullRequest(ctx.selection) ? "enabled" : "disabled"),
  watches: [useProjectsStore, useThreadsStore, branchPullRequestsResource.store],
  // Keeps the selection's branch pull requests loaded while its panel shows, so the
  // empty list and the P hotkey know whether there is one. Follows a branch switch.
  warm: (ctx) => {
    let key: string | null = null;
    let release = noop;
    const sync = () => {
      const at = selectionBranch(ctx.selection, stores());
      const next = at ? branchKey(at.slug, at.branch) : null;
      if (next === key) return;
      release();
      key = next;
      release = next === null ? noop : branchPullRequestsResource.watch(next);
    };
    sync();
    const stops = [useProjectsStore.subscribe(sync), useThreadsStore.subscribe(sync)];
    return () => {
      for (const stop of stops) stop();
      release();
    };
  },
  onKey: (chord, tab) => {
    const ref = prRefOfTab(tab);
    if (chord !== COPY_LINK_CHORD || !ref) return false;
    void copyPullRequestLink(ref);
    return true;
  },
  render: (tab) => {
    const ref = prRefOfTab(tab);
    return ref ? createElement(PullRequestSurface, { tabId: tab.id, slug: ref.slug, number: ref.number }) : null;
  },
  openDefault: (ctx) => {
    const ref = currentPullRequest(ctx.selection);
    return ref ? pullRequestTab(ref) : null;
  },
};
