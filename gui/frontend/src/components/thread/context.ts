import { createContext, useContext } from "react";

/** The thread a timeline row belongs to, and its worktree (paths inside it are shown relative). */
export interface ThreadCtx {
  threadId: string;
  cwd: string;
}

export const ThreadContext = createContext<ThreadCtx>({ threadId: "", cwd: "" });

export function useThreadCtx(): ThreadCtx {
  return useContext(ThreadContext);
}

/**
 * Keeps a timeline row where it is on screen across the next change of rows (Timeline):
 * a header calls it with its row key before it folds or unfolds its turn. A no-op outside
 * a Timeline.
 */
export const KeepRowContext = createContext<(rowKey: string) => void>(() => undefined);
