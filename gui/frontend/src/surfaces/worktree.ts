import { createElement } from "react";
import { GitBranch } from "lucide-react";
import { WorktreePanelView } from "@/components/overview/WorktreeOverview";
import type { SurfaceSpec } from "./types";
import { memberOfTab, WORKTREE_KIND } from "./workspaceTarget";

/**
 * Worktree: one worktree's overview (sync state, GitHub activity, files, log) as a panel
 * tab. Opened from the workspace surface's member rows (stores/workspacePanel.ts
 * openMemberTab); never listed in the empty panel and has no hotkey. Tab: params
 * { repo, path }, titled with the project's name.
 */
export const worktreeSurface: SurfaceSpec = {
  kind: WORKTREE_KIND,
  title: "Worktree",
  icon: GitBranch,
  available: () => "hidden",
  render: (tab) => {
    const m = memberOfTab(tab);
    return m ? createElement(WorktreePanelView, { repoId: m.repoId, path: m.path }) : null;
  },
  openDefault: () => null,
};
