/**
 * GitHub pull request links that open in a Pull request tab instead of
 * the browser: in a thread's messages (components/thread/Code.tsx) and in a pull
 * request's description and comments (PrOverview, PrTimeline). Markdown's other users
 * (plugin nodes, file previews, help) keep opening every link in the browser.
 */
import { useMemo } from "react";
import { usePanelKey } from "@/shell/panelKeyContext";
import { parsePullRequestUrl } from "@/lib/prUrl";
import { findTab, tabPlace, type TabTarget } from "@/shell/host";
import { pullRequestTab } from "@/surfaces/pullrequestTarget";
import { openPullRequestInPanel } from "@/stores/prPanel";
import type { MarkdownExtras } from "./Markdown";

/**
 * MarkdownExtras.openLink for a panel: a pull request page opens as a tab of `target`'s
 * panel ("current": the selection's). False (the browser) for any other link, or when
 * there is no panel to open (nothing selected).
 */
export function openPullRequestLink(target: TabTarget): (url: string) => boolean {
  return (url) => {
    const parsed = parsePullRequestUrl(url);
    if (parsed === null) return false;
    const { slug, number, anchored } = parsed;
    // A link into the page of the pull request already showing (a comment, a diff line)
    // would land on the same tab and lose its anchor: the browser opens it there. The open
    // tab is found by identity, so a link in another letter case is that tab too.
    const open = anchored ? findTab(target, pullRequestTab({ slug, number }).id) : undefined;
    if (open && tabPlace(target).groups.some((g) => g.active?.id === open.id)) return false;
    return openPullRequestInPanel({ slug, number }, target);
  };
}

/** For a thread's messages: the selection's panel. */
export const openPullRequestLinkInCurrentPanel = openPullRequestLink("current");

/**
 * The extras for markdown inside a panel tab (a pull request's description and comments):
 * its pull request links open as tabs of that panel, in the group the click focused.
 * Stable per panel.
 */
export function usePanelMarkdownExtras(): MarkdownExtras {
  const panelKey = usePanelKey();
  return useMemo(() => ({ openLink: openPullRequestLink(panelKey || "current") }), [panelKey]);
}
