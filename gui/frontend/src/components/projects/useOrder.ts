import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { projectActivity, sortByActivity, workspaceActivity } from "@/lib/projects";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";

/**
 * Project ids in the index's order (lib/projects.ts sortByActivity): last activity of
 * their threads, most recent first, then by name. Rebuilds on membership, names and
 * activity times only.
 */
export function useProjectOrder(): string[] {
  const ids = useProjectsStore(useShallow((s) => s.order.filter((id) => s.byId[id] !== undefined)));
  const names = useProjectsStore(useShallow((s) => ids.map((id) => s.byId[id]?.name ?? "")));
  const lasts = useThreadsStore(useShallow((s) => ids.map((id) => projectActivity(s, id).lastMs)));
  return useMemo(() => {
    const at = new Map(ids.map((id, i) => [id, { name: names[i] ?? "", last: lasts[i] ?? null }]));
    return sortByActivity(ids, (id) => at.get(id)?.last ?? null, (id) => at.get(id)?.name ?? id);
  }, [ids, names, lasts]);
}

/** Workspace ids in the index's order, like useProjectOrder. */
export function useWorkspaceOrder(): string[] {
  const ids = useWorkspacesStore(useShallow((s) => s.order.filter((id) => s.byId[id] !== undefined)));
  const names = useWorkspacesStore(useShallow((s) => ids.map((id) => s.byId[id]?.name ?? "")));
  const lasts = useThreadsStore(useShallow((s) => ids.map((id) => workspaceActivity(s, id).lastMs)));
  return useMemo(() => {
    const at = new Map(ids.map((id, i) => [id, { name: names[i] ?? "", last: lasts[i] ?? null }]));
    return sortByActivity(ids, (id) => at.get(id)?.last ?? null, (id) => at.get(id)?.name ?? id);
  }, [ids, names, lasts]);
}

/** A project's last activity (one number). */
export function useProjectLastMs(projectId: string): number | null {
  return useThreadsStore((s) => projectActivity(s, projectId).lastMs);
}

/** A workspace's last activity (one number). */
export function useWorkspaceLastMs(workspaceId: string): number | null {
  return useThreadsStore((s) => workspaceActivity(s, workspaceId).lastMs);
}
