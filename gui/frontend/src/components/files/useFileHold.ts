import { useEffect, useState } from "react";
import { readFile } from "@/api/files";
import { useThreadCheckouts } from "@/components/thread/useThreadCheckouts";
import { relativeTo, resolvePath } from "@/lib/filePath";
import { isUnplaced } from "@/lib/threadSetup";
import { replaceTab, setTabParams } from "@/shell/host";
import { useThreadsStore } from "@/stores/threads";
import { fileTab, HELD_PARAM, withoutParams, type FileTarget } from "@/surfaces/fileTarget";

/** Why a held tab cannot be edited now. */
const UNTIL_READY = "Read-only until this thread's worktree is ready";
const NOT_THERE = "Read-only: this is the project's own checkout, and the file is not in this thread's worktree";

/**
 * A File tab opened while its thread had no checkout (FileTarget.heldFor) shows the
 * project's own, and a save there would change what the thread is not working on. So it
 * cannot be edited until the thread has landed, and then it moves to the same file in the
 * thread's worktree; a file that is not there stays read-only for good. Returns what the
 * tab says about that; null for a tab that is not held.
 */
export function useFileHold(file: FileTarget, panelKey: string): string | null {
  const threadId = file.heldFor ?? "";
  const unplaced = useThreadsStore((s) => isUnplaced(s.byId[threadId]));
  const { paths } = useThreadCheckouts(threadId);
  const checkout = threadId && !unplaced ? (paths[file.project] ?? "") : "";
  const [notThere, setNotThere] = useState(false);
  const { project, base, path, line } = file;
  useEffect(() => {
    if (!threadId || !checkout) return;
    const tabId = fileTab({ project, base, path }).id;
    if (checkout === base) {
      setTabParams(panelKey, tabId, withoutParams([HELD_PARAM])); // the thread runs right here: it is its file
      return;
    }
    const rel = relativeTo(path, base);
    if (rel === null) return; // outside the checkout: it has no place in the worktree
    let live = true;
    const next = resolvePath(checkout, rel);
    void readFile(checkout, next).then(
      (view) => {
        if (!live) return;
        if (view.notFound) setNotThere(true);
        else replaceTab(panelKey, tabId, fileTab({ project, base: checkout, path: next, ...(line === undefined ? {} : { line }) }));
      },
      () => {
        if (live) setNotThere(true);
      },
    );
    return () => {
      live = false;
    };
  }, [threadId, checkout, project, base, path, line, panelKey]);
  if (!threadId) return null;
  return !unplaced && (notThere || relativeTo(path, base) === null) ? NOT_THERE : UNTIL_READY;
}
