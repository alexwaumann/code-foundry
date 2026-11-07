import { useEffect, useEffectEvent, useRef } from "react";
import { findWorktree, useProjectsStore } from "@/stores/projects";

/**
 * What git's status says of a checkout: staged, modified, untracked and HEAD. A staged change
 * can leave the detail the same (useWorktreeChanges sees nothing), and a comparison of the
 * index still has to follow it.
 */
export function useStatusChanges(projectId: string, worktree: string, onChange: () => void): void {
  const stamp = useProjectsStore((s) => {
    const wt = findWorktree(s, projectId, worktree);
    return wt ? `${wt.head}|${String(wt.status.staged)}|${String(wt.status.modified)}|${String(wt.status.untracked)}` : "";
  });
  const seen = useRef(stamp);
  const fire = useEffectEvent(onChange);
  useEffect(() => {
    if (seen.current === stamp) return;
    seen.current = stamp;
    fire();
  }, [stamp]);
}
