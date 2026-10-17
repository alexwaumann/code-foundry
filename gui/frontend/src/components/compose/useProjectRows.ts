import { useShallow } from "zustand/react/shallow";
import { useProjectsStore } from "@/stores/projects";
import { useWorkspaceOrder } from "@/stores/workspaces";

/**
 * The project pickers' rows in order (ProjectRowGroups): workspace ids by name above
 * project ids in registry order, and whether projects have loaded. A row's cmdk value
 * is its target's draftKey (lib/compose): the project id, or "ws:<workspace id>".
 */
export function useProjectRows(): { workspaces: readonly string[]; projects: readonly string[]; loaded: boolean } {
  const projects = useProjectsStore(useShallow((s) => s.order));
  const loaded = useProjectsStore((s) => s.loaded);
  const workspaces = useWorkspaceOrder();
  return { workspaces, projects, loaded };
}
