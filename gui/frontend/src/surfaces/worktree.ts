import { createElement } from "react";
import { GitBranch } from "lucide-react";
import { WorkspaceFolderPanelView, WorktreePanelView } from "@/components/overview/WorktreeOverview";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { selectionTab } from "@/stores/worktreePanel";
import type { SurfaceSpec } from "./types";
import { folderOfTab, selectionFolder, selectionWorktree, WORKTREE_KIND, worktreeOfTab } from "./worktreeTarget";

function placed(sel: Selection): boolean {
  if (selectionWorktree(sel, { projects: useProjectsStore.getState(), threads: useThreadsStore.getState() })) return true;
  return selectionFolder(sel, { threads: useThreadsStore.getState(), workspaces: useWorkspacesStore.getState() }) !== null;
}

/**
 * Worktree: what matters about one worktree (who else works in it, a git operation in
 * progress, origin/base/working-tree facts, the branch's pull request, changes, commits)
 * as a panel tab. For a thread in a registered worktree, T opens that worktree; for a
 * thread whose primary is its workspace's folder, the same tab with a folder head (the
 * workspace's name and folder, no git facts) and every member checkout under Also in;
 * hidden for everything else, because its tabs are also opened from elsewhere: the
 * Projects page's project, worktree and workspace member rows (Enter or double-click, into
 * the page's own panel) and Also in rows (stores/worktreePanel.ts,
 * stores/threadCheckouts.ts). Tab: params { project, path } (titled with the project, and
 * its branch off the main worktree) or { workspace, path } (titled with the workspace).
 */
export const worktreeSurface: SurfaceSpec = {
  kind: WORKTREE_KIND,
  title: "Worktree",
  icon: GitBranch,
  hotkey: "t",
  available: (ctx) => (placed(ctx.selection) ? "enabled" : "hidden"),
  // deriveContext places a thread in a worktree from the projects store; a workspace's folder comes from the workspaces store.
  watches: [useThreadsStore, useProjectsStore, useWorkspacesStore],
  render: (tab) => {
    const m = worktreeOfTab(tab);
    if (m) return createElement(WorktreePanelView, { projectId: m.projectId, path: m.path });
    const f = folderOfTab(tab);
    return f ? createElement(WorkspaceFolderPanelView, { workspaceId: f.workspaceId, path: f.path }) : null;
  },
  openDefault: (ctx) => selectionTab(ctx.selection),
};
