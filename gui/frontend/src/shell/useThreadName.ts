import { leadOf } from "@/lib/inSidebar";
import { useThreadsStore } from "@/stores/threads";

/** A thread's name, looked up by id (a rename shows at once); the id while the threads have not arrived. */
export function useThreadName(threadId: string): string {
  return useThreadsStore((s) => s.byId[threadId]?.name || threadId);
}

/**
 * The thread a surface linked to `threadId` names: its lead (lib/inSidebar.ts leadOf). Selects
 * the resolved id, so a caller re-renders only when the lead changes. "" for "".
 */
export function useLeadThread(threadId: string): string {
  return useThreadsStore((s) => (threadId ? leadOf(s.byId, threadId) : ""));
}
