import { useEffect, useEffectEvent, useRef, useState } from "react";
import { readFile } from "@/api/files";
import { fileWatcher } from "@/stores/fileStamps";
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

/** Where git keeps a checkout's index: under .git, or for a linked worktree the directory its .git file names. "" when it has neither. */
export async function indexPath(worktree: string): Promise<string> {
  const dot = await readFile(worktree, ".git");
  if (dot.isDir) return `${dot.path}/index`;
  const dir = /^gitdir: (.+)$/m.exec(dot.text ?? "")?.[1];
  if (!dir) return "";
  return dir.startsWith("/") ? `${dir}/index` : `${worktree}/${dir}/index`;
}

/**
 * Calls `onChange` when a checkout's index is written, for a comparison of it. The status only
 * counts files, so `git add` of a file already staged, or a second hunk of one, leaves it as it
 * was. Saving a file writes no index, so nothing else is read for those. "" watches nothing.
 */
export function useIndexChanges(worktree: string, onChange: () => void): void {
  const [found, setFound] = useState({ worktree: "", path: "" });
  useEffect(() => {
    if (!worktree) return;
    let live = true;
    void indexPath(worktree)
      .catch(() => "")
      .then((path) => {
        if (live) setFound({ worktree, path });
      });
    return () => {
      live = false;
    };
  }, [worktree]);
  const path = found.worktree === worktree ? found.path : "";
  const fire = useEffectEvent(onChange);
  useEffect(() => {
    if (!path) return;
    return fileWatcher.watch(path, () => {
      fire();
    });
  }, [path]);
}
