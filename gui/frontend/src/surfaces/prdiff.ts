import { createElement } from "react";
import { FileDiff } from "lucide-react";
import { PrDiffView } from "@/components/diff/PrDiffView";
import { PrDiffReviewButton } from "@/components/pr/ReviewButton";
import { PR_DIFF_KIND, PR_DIFF_TITLE, prDiffOfTab } from "./prDiffTarget";
import type { SurfaceSpec } from "./types";

/**
 * Pull request diff: one pull request's diff from GitHub in a tab of its own
 * (components/diff/PrDiffView.tsx), beside the pull request's tab. Opened only for a pull request
 * (stores/prDiffPanel.ts openPullRequestDiff), so it is not listed and has no letter. Tabs: params
 * { slug, number, path? }, title "Diff #N" (surfaces/prDiffTarget.ts).
 */
export const prDiffSurface: SurfaceSpec = {
  kind: PR_DIFF_KIND,
  title: PR_DIFF_TITLE,
  icon: FileDiff,
  available: () => "hidden",
  render: (tab) => {
    const target = prDiffOfTab(tab);
    // The bar's Review: the pull request's own button, opening the same review dialog.
    return target ? createElement(PrDiffView, { tabId: tab.id, target, review: createElement(PrDiffReviewButton, { prRef: { slug: target.slug, number: target.number } }) }) : null;
  },
  openDefault: () => null,
};
