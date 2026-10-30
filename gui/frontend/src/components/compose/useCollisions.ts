import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { collisions, type Checkout, type Collision, type HintProject, type HintThread } from "@/lib/collisionHints";
import { isRunningThread, isWorkingThread } from "@/lib/thread";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";

const SEP = "\u0001";
const LIST = "\u0002";
const PAIR = "\u0003";

/**
 * One string per running thread (lib/thread isRunningThread: not archived, not
 * snoozed, starting or connected): its checkouts (recorded, or what they resolve from) and whether it works
 * (shallow-stable). A thread that starts, stops, is snoozed or archived changes the list.
 */
function useThreadKeys(): string[] {
  return useThreadsStore(
    useShallow((s) => {
      const now = Date.now();
      return s.order.flatMap((id) => {
        const t = s.byId[id];
        if (!t || !isRunningThread(t, now)) return [];
        const recorded = t.checkoutPaths.map((c) => c.projectId + PAIR + c.path).join(LIST);
        return [[t.id, t.name, t.projectId, t.projectIds.join(","), t.worktreePath, t.createdWorktree ? "1" : "", t.branch, isWorkingThread(t) ? "1" : "", recorded].join(SEP)];
      });
    }),
  );
}

/** One string per project: its name, git, path and worktrees (path, branch, head, main). */
function useProjectKeys(): string[] {
  return useProjectsStore(
    useShallow((s) =>
      s.order.map((id) => {
        const p = s.byId[id];
        if (!p) return id;
        const wts = p.worktrees.map((w) => [w.path, w.branch, w.head, w.isMain ? "1" : ""].join(SEP)).join(LIST);
        return [id, p.name, p.git ? "1" : "", p.path].join(SEP) + LIST + wts;
      }),
    ),
  );
}

function decodeThreads(keys: readonly string[]): HintThread[] {
  return keys.map((k) => {
    const [id = "", name = "", projectId = "", ids = "", worktreePath = "", wt = "", branch = "", working = "", recorded = ""] = k.split(SEP);
    const checkoutPaths = recorded
      ? recorded.split(LIST).map((c) => {
          const [pid = "", path = ""] = c.split(PAIR);
          return { projectId: pid, path };
        })
      : [];
    return { id, name, projectId, projectIds: ids ? ids.split(",") : [], worktreePath, createdWorktree: wt === "1", branch, checkoutPaths, archived: false, working: working === "1" };
  });
}

function decodeProjects(keys: readonly string[]): Record<string, HintProject> {
  const out: Record<string, HintProject> = {};
  for (const k of keys) {
    const [head = "", ...wts] = k.split(LIST);
    const [id = "", name = "", git = "", path = ""] = head.split(SEP);
    out[id] = {
      name,
      git: git === "1",
      path,
      worktrees: wts.map((w) => {
        const [p = "", branch = "", h = "", main = ""] = w.split(SEP);
        return { path: p, branch, head: h, isMain: main === "1" };
      }),
    };
  }
  return out;
}

/**
 * The collisions of a draft (lib/collisionHints): its checkouts against every running
 * thread. `checkouts` comes from the projects map this hook passes to `mine` (so it sees
 * the same data). Recomputed only when a running thread's place or work, the set of
 * running threads, or a project's worktrees change.
 */
export function useCollisions(mine: (projects: Readonly<Record<string, HintProject>>) => { checkouts: readonly Checkout[]; worktreeMode: boolean }): Collision[] {
  const threadKeys = useThreadKeys();
  const projectKeys = useProjectKeys();
  const threads = useMemo(() => decodeThreads(threadKeys), [threadKeys]);
  const projects = useMemo(() => decodeProjects(projectKeys), [projectKeys]);
  const draft = useMemo(() => mine(projects), [mine, projects]);
  return useMemo(() => collisions(draft, threads, projects), [draft, threads, projects]);
}
