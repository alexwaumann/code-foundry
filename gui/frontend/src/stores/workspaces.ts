/**
 * Workspaces (branch sets across projects), fed by the shared events stream's
 * `workspace` source (stores/events.ts). A daemon without that source leaves the slice
 * empty and `loaded` false; nothing else depends on it being there.
 */
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { WorkspaceEventView, WorkspaceView } from "@/api/workspace";

export interface WorkspacesData {
  byId: Readonly<Record<string, WorkspaceView>>;
  /** Workspace ids sorted by name. */
  order: readonly string[];
}

interface WorkspacesState extends WorkspacesData {
  /** A snapshot has arrived. */
  loaded: boolean;
}

export const emptyWorkspaces: WorkspacesData = { byId: {}, order: [] };

function sortedOrder(byId: Readonly<Record<string, WorkspaceView>>): string[] {
  return Object.values(byId)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((w) => w.id);
}

export function replaceWorkspaces(list: readonly WorkspaceView[]): WorkspacesData {
  const byId: Record<string, WorkspaceView> = {};
  for (const w of list) byId[w.id] = w;
  return { byId, order: sortedOrder(byId) };
}

export function applyWorkspaceEvent(prev: WorkspacesData, ev: WorkspaceEventView): WorkspacesData {
  switch (ev.kind) {
    case "snapshot":
      return replaceWorkspaces(ev.workspaces);
    case "updated": {
      const byId = { ...prev.byId, [ev.workspace.id]: ev.workspace };
      return { byId, order: sortedOrder(byId) };
    }
    case "removed": {
      if (!(ev.id in prev.byId)) return prev;
      const { [ev.id]: _removed, ...byId } = prev.byId;
      return { byId, order: prev.order.filter((id) => id !== ev.id) };
    }
  }
}

export const useWorkspacesStore = create<WorkspacesState>()(() => ({ ...emptyWorkspaces, loaded: false }));

/** Workspace ids sorted by name (shallow-stable). */
export function useWorkspaceOrder(): readonly string[] {
  return useWorkspacesStore(useShallow((s) => s.order));
}

/** One workspace (a new object only when that workspace changes), or undefined. */
export function useWorkspace(id: string): WorkspaceView | undefined {
  return useWorkspacesStore((s) => s.byId[id]);
}

