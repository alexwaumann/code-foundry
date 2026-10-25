import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { threadCheckouts, type HintProjects } from "@/lib/collisionHints";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";

const SEP = "\u0001";

/** The thread's fields its checkouts derive from, as one string (shallow-stable across unrelated updates). */
function placeKey(threadId: string): (s: ReturnType<typeof useThreadsStore.getState>) => string {
  return (s) => {
    const t = s.byId[threadId];
    if (!t) return "";
    return [t.projectId, t.worktreePath, t.createdWorktree ? "1" : "", t.branch, t.projectIds.join(",")].join(SEP);
  };
}

/**
 * A thread's projects (its primary first) and the checkout of each the GUI can derive
 * (lib/collisionHints threadCheckouts): what its "/" and "@" read, and what "New thread on
 * this branch" shows. Narrow: the thread's place fields and the projects' worktree paths
 * and branches only.
 */
export function useThreadCheckouts(threadId: string): { projectIds: string[]; paths: Readonly<Record<string, string>> } {
  const key = useThreadsStore(placeKey(threadId));
  const [projectId = "", worktreePath = "", worktreeMode = "", branch = "", ids = ""] = key.split(SEP);
  const projectIds = useMemo(() => {
    const set = ids ? ids.split(",") : projectId ? [projectId] : [];
    return projectId && set.includes(projectId) ? [projectId, ...set.filter((id) => id !== projectId)] : set;
  }, [ids, projectId]);
  const pathKeys = useProjectsStore(
    useShallow((s) => {
      const projects: HintProjects = s.byId;
      const t = { id: threadId, name: "", projectId, projectIds, worktreePath, createdWorktree: worktreeMode === "1", branch, archived: false };
      return threadCheckouts(t, projects).map((c) => c.projectId + SEP + c.path);
    }),
  );
  return useMemo(() => {
    const paths: Record<string, string> = {};
    for (const k of pathKeys) {
      const [id = "", path = ""] = k.split(SEP);
      paths[id] = path;
    }
    return { projectIds, paths };
  }, [projectIds, pathKeys]);
}
