/**
 * GitHub pull request links that open in the side panel (a Pull request tab) instead of
 * the browser: in a thread's messages (components/thread/Code.tsx) and in a pull
 * request's description and comments (PrSummary, PrTimeline). Markdown's other users
 * (plugin nodes, file previews, help) keep opening every link in the browser.
 */
import { useMemo } from "react";
import { usePanelKey } from "@/components/panel/panelKeyContext";
import { parsePullRequestUrl } from "@/lib/prUrl";
import type { PanelTarget } from "@/stores/panel";
import { openPullRequestInPanel } from "@/stores/prPanel";
import type { MarkdownExtras } from "./Markdown";

/**
 * MarkdownExtras.openLink for a panel: a pull request page opens as a tab of `target`'s
 * panel ("current": the selection's). False (the browser) for any other link, or when
 * there is no panel to open (nothing selected).
 */
export function openPullRequestLink(target: PanelTarget): (url: string) => boolean {
  return (url) => {
    const ref = parsePullRequestUrl(url);
    return ref !== null && openPullRequestInPanel(ref, target);
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
