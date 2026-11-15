import { useElementCopied } from "@/stores/pluginCopied";
import { useViewCtx } from "./context";

/** Whether this view's element `key` just ran its copy action (stores/pluginCopied.ts; CopiedMark in copied.tsx draws it). */
export function useCopiedHere(key: string): boolean {
  const { watchKey } = useViewCtx();
  return useElementCopied(watchKey, key);
}
