import { useMemo } from "react";
import { workspaceThreads, workspaceThreadsCaption } from "@/lib/workspacePage";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { workspaceTerminalPlace } from "@/stores/workspaceActions";
import { useWorkspacesStore } from "@/stores/workspaces";
import { openThread as openWindowThread } from "@/stores/openThread";

/** Opens the thread (its own pane); a child or a snoozed one as the space's preview tab (stores/openThread.ts). */
export function openThread(id: string): void {
  openWindowThread(id, { focusPrompt: false });
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
