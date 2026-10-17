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
