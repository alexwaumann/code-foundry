import { useShallow } from "zustand/react/shallow";
import { movingTo } from "@/lib/move";
import { useMovePickerStore } from "@/stores/movePicker";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";

/**
 * Where the thread is moving to, by name (lib/move movingTo): its pending_move, else a move this
 * window sent and the daemon has not answered; null when it is not moving. The thread's header
 * (ThreadHeader's place chip) and a subagent run's crumb (ThreadParts) say it.
 */
export function useMovingTo(id: string): string | null {
  const pending = useThreadsStore(
    useShallow((s) => {
      const m = s.byId[id]?.pendingMove;
      return m ? { projectId: m.projectId, workspaceId: m.workspaceId } : null;
    }),
  );
  const sending = useMovePickerStore((s) => s.sending[id]);
  const project = useProjectsStore((s) => (pending?.projectId ? s.byId[pending.projectId]?.name : undefined));
  const workspace = useWorkspacesStore((s) => (pending?.workspaceId ? s.byId[pending.workspaceId]?.name : undefined));
  return movingTo(pending, sending, { project: () => project, workspace: () => workspace });
}
