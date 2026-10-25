import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { collisionHints, type Checkout, type HintProject, type HintThread } from "@/lib/collisionHints";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";

const SEP = "\u0001";
const LIST = "\u0002";

/** One string per thread that is not archived: what its checkouts derive from (shallow-stable). */
function useThreadKeys(): string[] {
  return useThreadsStore(
    useShallow((s) =>
      s.order.flatMap((id) => {
        const t = s.byId[id];
        if (!t || t.archivedAtMs !== null) return [];
        return [[t.id, t.name, t.projectId, t.projectIds.join(","), t.worktreePath, t.createdWorktree ? "1" : "", t.branch].join(SEP)];
      }),
    ),
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
    const [id = "", name = "", projectId = "", ids = "", worktreePath = "", wt = "", branch = ""] = k.split(SEP);
    return { id, name, projectId, projectIds: ids ? ids.split(",") : [], worktreePath, createdWorktree: wt === "1", branch, archived: false };
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
 * The collision hints of a draft (lib/collisionHints): its checkouts against every
 * thread that is not archived. `checkouts` comes from the projects map this hook passes
 * to `mine` (so it sees the same data). Recomputed only when a thread's place or a
 * project's worktrees change.
 */
export function useCollisionHints(mine: (projects: Readonly<Record<string, HintProject>>) => { checkouts: readonly Checkout[]; worktreeMode: boolean }): string[] {
  const threadKeys = useThreadKeys();
  const projectKeys = useProjectKeys();
  const threads = useMemo(() => decodeThreads(threadKeys), [threadKeys]);
  const projects = useMemo(() => decodeProjects(projectKeys), [projectKeys]);
  const draft = useMemo(() => mine(projects), [mine, projects]);
  return useMemo(() => collisionHints(draft, threads, projects), [draft, threads, projects]);
}
