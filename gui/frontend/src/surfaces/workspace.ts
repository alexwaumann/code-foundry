import { createElement } from "react";
import { Layers } from "lucide-react";
import { WorkspaceSurface } from "@/components/workspace/WorkspaceSurface";
import { useReposStore } from "@/stores/repos";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import type { Selection } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import type { SurfaceSpec } from "./types";
import { selectionWorkspaceThread, WORKSPACE_KIND, workspaceOfTab, workspaceTab, type WorkspaceThread } from "./workspaceTarget";

function thread(sel: Selection): WorkspaceThread | null {
  return selectionWorkspaceThread(sel, { repos: useReposStore.getState(), sessions: useSessionsStore.getState(), terminals: useTerminalsStore.getState() });
}

/**
 * Workspace: the members of the workspace that owns the selected thread (a session, or a
 * thread's terminal), with their git and pull request state, the thread's current member
 * marked, add/remove member and Run in. Hidden for anything else (a project thread, a
 * worktree, a page). Tab: params { workspace }, titled with the workspace's name.
 * Opened by W in the panel, view.panel.workspace, the sidebar's workspace badge, and
 * the Projects page's workspace rows (stores/workspacePanel.ts).
 */
export const workspaceSurface: SurfaceSpec = {
  kind: WORKSPACE_KIND,
  title: "Workspace",
  icon: Layers,
  hotkey: "w",
  available: (ctx) => (thread(ctx.selection) ? "enabled" : "hidden"),
  // deriveContext reads the repos store too (placement); the name comes from workspaces.
  watches: [useSessionsStore, useTerminalsStore, useReposStore],
  render: (tab) => {
    const id = workspaceOfTab(tab);
    return id ? createElement(WorkspaceSurface, { workspaceId: id }) : null;
  },
  openDefault: (ctx) => {
    const t = thread(ctx.selection);
    if (!t) return null;
    return workspaceTab(t.workspaceId, useWorkspacesStore.getState().byId[t.workspaceId]?.name ?? "");
  },
};
