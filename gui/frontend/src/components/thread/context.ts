import { createContext, useContext } from "react";

/** The thread a timeline row belongs to, and its worktree (paths inside it are shown relative). */
export interface ThreadCtx {
  sessionId: string;
  cwd: string;
}

export const ThreadContext = createContext<ThreadCtx>({ sessionId: "", cwd: "" });

export function useThreadCtx(): ThreadCtx {
  return useContext(ThreadContext);
}
