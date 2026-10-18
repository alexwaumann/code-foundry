import { createElement } from "react";
import { FileDiff } from "lucide-react";
import { DiffTab } from "@/components/files/DiffTab";
import { lastTabOf } from "@/stores/filePanel";
import { usePanelStore } from "@/stores/panel";
import { DIFF_KIND, diffOfTab } from "./fileTarget";
import { NO_PROJECT_WATCHES, noProjectNow } from "./noProject";
import type { SurfaceSpec } from "./types";

/**
 * Diff: one changed file of a worktree against its base (components/files/DiffTab.tsx),
 * working tree or branch. Tabs are opened from the worktree panel's Changes rows
 * (stores/filePanel.ts), one per file: params { project, worktree, path, oldPath?, scope }
 * (surfaces/fileTarget.ts). D (and the list) bring back the panel's last Diff tab, so the
 * entry is live only while the panel has one; dimmed otherwise, hidden without a project.
 */
export const diffSurface: SurfaceSpec = {
  kind: DIFF_KIND,
  title: "Diff",
  icon: FileDiff,
  hotkey: "d",
  available: (ctx) => (noProjectNow(ctx.selection) ? "hidden" : lastTabOf(DIFF_KIND, ctx.panelKey) ? "enabled" : "disabled"),
  watches: [...NO_PROJECT_WATCHES, usePanelStore],
  render: (tab) => {
    const target = diffOfTab(tab);
    return target ? createElement(DiffTab, { target }) : null;
  },
  openDefault: (ctx) => lastTabOf(DIFF_KIND, ctx.panelKey),
};
