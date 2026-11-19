/**
 * Opening a pull request's diff tab (surfaces/prDiffTarget.ts, docs/notes/pr-diff-tab.md),
 * as openPullRequestInPanel (stores/prPanel.ts) opens its pull request: straight through the
 * host seam, like every other surface's tab, no command of its own.
 */
import { findTab, groupOfTab, openTab, pullRequestTabId, tabPlace, type TabTarget } from "@/shell/host";
import { prDiffTab } from "@/surfaces/prDiffTarget";
import type { PrRef } from "@/surfaces/pullrequestTarget";

/**
 * Opens a pull request's diff, with the focus: beside the pull request's own tab when the
 * target holds one (in its pane, after the tab the pane shows), else where the layout places
 * it. A diff tab already open for that pull request is shown where it is, as it is (its file
 * and its slug's spelling kept): never a second one. False before the layout has loaded.
 */
export function openPullRequestDiff(ref: PrRef, target: TabTarget = "current", opts: { focus?: boolean } = {}): boolean {
  const fresh = prDiffTab(ref);
  const open = findTab(target, fresh.id);
  if (open) return openTab(target, open, opts);
  const pr = findTab(target, pullRequestTabId(ref.slug, String(ref.number)));
  const group = pr ? groupOfTab(tabPlace(target), pr.id) : null;
  return openTab(target, fresh, { ...opts, ...(group === null ? {} : { group }) });
}
