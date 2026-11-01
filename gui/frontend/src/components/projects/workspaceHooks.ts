import { useMemo } from "react";
import { workspaceThreads, workspaceThreadsCaption } from "@/lib/workspacePage";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { workspaceTerminalPlace } from "@/stores/workspaceActions";
import { useWorkspacesStore } from "@/stores/workspaces";

/** Opens the thread (its own pane). */
export function openThread(id: string): void {
  useUiStore.getState().select({ kind: "thread", id });
}

/** The workspace's threads, in the page's order (lib/workspacePage.ts workspaceThreads): ids only, so a status change re-sorts but a name change does not rebuild the list. */
export function useWorkspaceThreads(workspaceId: string): { ids: string[]; caption: string } {
  const key = useThreadsStore((s) => {
    const w = workspaceThreads(s, workspaceId);
    return `${workspaceThreadsCaption(w)}\u0001${w.ids.join("\u0002")}`;
  });
  return useMemo(() => {
    const [caption = "", ids = ""] = key.split("\u0001");
    return { caption, ids: ids === "" ? [] : ids.split("\u0002") };
  }, [key]);
}

/** Whether the workspace's New terminal shows: a folder and a registered member to own the shell (workspaceTerminalPlace). */
export function useWorkspaceTerminal(workspaceId: string): boolean {
  const ws = useWorkspacesStore((s) => s.byId[workspaceId]);
  return useProjectsStore((s) => workspaceTerminalPlace(ws, s) !== null);
}
