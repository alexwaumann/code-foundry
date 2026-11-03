/**
 * GitHub pull request links that open in the side panel (a Pull request tab) instead of
 * the browser: in a thread's messages (components/thread/Code.tsx) and in a pull
 * request's description and comments (PrSummary, PrTimeline). Markdown's other users
 * (plugin nodes, file previews, help) keep opening every link in the browser.
 */
import { useMemo } from "react";
import { usePanelKey } from "@/components/panel/panelKeyContext";
import { parsePullRequestUrl } from "@/lib/prUrl";
import { getPanel, type PanelTarget } from "@/stores/panel";
import { PULL_REQUEST_KIND, prRefOfTab, type PrRef } from "@/surfaces/pullrequestTarget";
import { openPullRequestInPanel } from "@/stores/prPanel";
import type { MarkdownExtras } from "./Markdown";

/**
 * MarkdownExtras.openLink for a panel: a pull request page opens as a tab of `target`'s
 * panel ("current": the selection's). False (the browser) for any other link, or when
 * there is no panel to open (nothing selected).
 */
export function openPullRequestLink(target: PanelTarget): (url: string) => boolean {
  return (url) => {
    const parsed = parsePullRequestUrl(url);
    if (parsed === null) return false;
    const { ref, showing } = inPanel(target, parsed);
    // A link into the page of the pull request already showing (a comment, a diff line)
    // would land on the same tab and lose its anchor: the browser opens it there.
    if (showing && parsed.anchored) return false;
    return openPullRequestInPanel(ref, target);
  };
}

/**
 * The pull request as the target's panel already holds it, if it does: GitHub slugs are
 * case-insensitive but tab ids are not, so `Octo/Hello#1` reuses the `octo/hello#1` tab
 * instead of opening a second one. `showing`: that tab is a group's active tab.
 */
function inPanel(target: PanelTarget, link: { slug: string; number: number }): { ref: PrRef; showing: boolean } {
  const slug = link.slug.toLowerCase();
  for (const g of getPanel(target).groups) {
    for (const t of g.tabs) {
      const r = t.kind === PULL_REQUEST_KIND ? prRefOfTab(t) : null;
      if (r && r.number === link.number && r.slug.toLowerCase() === slug) return { ref: r, showing: g.activeTabId === t.id };
    }
  }
  return { ref: { slug: link.slug, number: link.number }, showing: false };
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
