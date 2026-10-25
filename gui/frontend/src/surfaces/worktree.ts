import { createElement } from "react";
import { GitBranch } from "lucide-react";
import { WorktreePanelView } from "@/components/overview/WorktreeOverview";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { worktreeTabTitle } from "@/stores/worktreePanel";
import type { SurfaceSpec } from "./types";
import { selectionWorktree, WORKTREE_KIND, worktreeOfTab, worktreeTab, type WorktreeTarget } from "./worktreeTarget";

function worktree(sel: Selection): WorktreeTarget | null {
  return selectionWorktree(sel, { projects: useProjectsStore.getState(), threads: useThreadsStore.getState() });
}

/**
 * Worktree: what matters about one worktree (who else works in it, a git operation in
 * progress, origin/base/working-tree facts, the branch's pull request, changes, commits)
 * as a panel tab. For a thread in a registered worktree, T opens that worktree;
 * hidden for everything else, because its tabs are also opened from elsewhere: the
 * Projects page's project and worktree rows (Enter or double-click, into the page's own
 * panel) and the workspace surface's member rows (stores/worktreePanel.ts,
 * stores/workspacePanel.ts). Tab: params { project, path }, titled with the project (and
 * its branch off the main worktree).
 */
export const worktreeSurface: SurfaceSpec = {
  kind: WORKTREE_KIND,
  title: "Worktree",
  icon: GitBranch,
  hotkey: "t",
  available: (ctx) => (worktree(ctx.selection) ? "enabled" : "hidden"),
  // deriveContext places a thread in a worktree from the projects store.
  watches: [useThreadsStore, useProjectsStore],
  render: (tab) => {
    const m = worktreeOfTab(tab);
    return m ? createElement(WorktreePanelView, { projectId: m.projectId, path: m.path }) : null;
  },
  openDefault: (ctx) => {
    const w = worktree(ctx.selection);
    return w ? worktreeTab(w.projectId, w.path, worktreeTabTitle(useProjectsStore.getState(), w.projectId, w.path)) : null;
  },
};
