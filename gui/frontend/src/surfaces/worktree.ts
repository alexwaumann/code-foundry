import { createElement } from "react";
import { GitBranch } from "lucide-react";
import { WorktreePanelView } from "@/components/overview/WorktreeOverview";
import { useReposStore } from "@/stores/repos";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import type { Selection } from "@/stores/ui";
import { worktreeTabTitle } from "@/stores/worktreePanel";
import type { SurfaceSpec } from "./types";
import { selectionWorktree, WORKTREE_KIND, worktreeOfTab, worktreeTab, type WorktreeTarget } from "./workspaceTarget";

function worktree(sel: Selection): WorktreeTarget | null {
  return selectionWorktree(sel, { repos: useReposStore.getState(), sessions: useSessionsStore.getState(), terminals: useTerminalsStore.getState() });
}

/**
 * Worktree: one worktree's overview (sync state, GitHub activity, files, log) as a panel
 * tab. For a thread (or a terminal) in a registered worktree, T opens that worktree;
 * hidden for everything else, because its tabs are also opened from elsewhere: the
 * Projects page's project and worktree rows (Enter or double-click, into the page's own
 * panel) and the workspace surface's member rows (stores/worktreePanel.ts,
 * stores/workspacePanel.ts). Tab: params { repo, path }, titled with the project (and
 * its branch off the main worktree).
 */
export const worktreeSurface: SurfaceSpec = {
  kind: WORKTREE_KIND,
  title: "Worktree",
  icon: GitBranch,
  hotkey: "t",
  available: (ctx) => (worktree(ctx.selection) ? "enabled" : "hidden"),
  // deriveContext places a thread or terminal in a worktree from the repos store.
  watches: [useSessionsStore, useTerminalsStore, useReposStore],
  render: (tab) => {
    const m = worktreeOfTab(tab);
    return m ? createElement(WorktreePanelView, { repoId: m.repoId, path: m.path }) : null;
  },
  openDefault: (ctx) => {
    const w = worktree(ctx.selection);
    return w ? worktreeTab(w.repoId, w.path, worktreeTabTitle(useReposStore.getState(), w.repoId, w.path)) : null;
  },
};
