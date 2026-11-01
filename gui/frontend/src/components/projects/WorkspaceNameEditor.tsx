import { useShallow } from "zustand/react/shallow";
import { workspaceNameError } from "@/lib/workspaceCard";
import { renameWorkspace } from "@/stores/workspaceActions";
import { useWorkspacesStore } from "@/stores/workspaces";
import { NameEditor } from "./NameEditor";

/** A workspace's name on its page's header, edited in place (the header's Rename…; workspace.rename). Names are unique whatever their case. */
export function WorkspaceNameEditor({ workspaceId, name, onDone }: { workspaceId: string; name: string; onDone: () => void }) {
  const others = useWorkspacesStore(useShallow((s) => s.order.filter((x) => x !== workspaceId).map((x) => s.byId[x]?.name ?? "")));
  return (
    <NameEditor
      name={name}
      validate={(v) => workspaceNameError(v, others)}
      onRename={(v) => void renameWorkspace(workspaceId, v)}
      onDone={onDone}
      label="Workspace name"
      testId="workspace-name"
    />
  );
}
