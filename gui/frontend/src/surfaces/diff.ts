import { createElement } from "react";
import { FileDiff } from "lucide-react";
import { DiffView } from "@/components/diff/DiffView";
import { lastTabOf } from "@/stores/filePanel";
import { tabChanges } from "@/shell/host";
import { DIFF_KIND, DIFF_TITLE, diffOfTab } from "./diffTarget";
import { NO_PROJECT_WATCHES, noProjectNow } from "./noProject";
import type { SurfaceSpec } from "./types";

/**
 * Diff: two sources of one checkout, compared file by file (components/diff/DiffView.tsx).
 * One tab per checkout (surfaces/diffTarget.ts), opened from the thread info card's Changes
 * row and its per-project rows, the Projects page's checkout menus, and view.panel.diff
 * (stores/filePanel.ts). D (and the list) bring back the panel's last Diff tab, so the entry
 * is live only while the panel has one; dimmed otherwise, hidden without a project.
 */
export const diffSurface: SurfaceSpec = {
  kind: DIFF_KIND,
  title: DIFF_TITLE,
  icon: FileDiff,
  hotkey: "d",
  available: (ctx) => (noProjectNow(ctx.selection) ? "hidden" : lastTabOf(DIFF_KIND, ctx.panelKey) ? "enabled" : "disabled"),
  watches: [...NO_PROJECT_WATCHES, tabChanges],
  render: (tab) => {
    const target = diffOfTab(tab);
    return target ? createElement(DiffView, { tabId: tab.id, tabTitle: tab.title, target }) : null;
  },
  openDefault: (ctx) => lastTabOf(DIFF_KIND, ctx.panelKey),
};
