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

/**
 * Whether a thread's name is not final yet: provisional (before the model's title lands) or being
 * regenerated (thread.regenerate-name). Every place that prints the name (the sidebar's rows, its
 * tab, the header and the linked row) draws it muted and italic while this holds, so they never
 * disagree. Selects the one boolean.
 */
export function useNameProvisional(threadId: string): boolean {
  return useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t !== undefined && (t.nameProvisional || t.naming);
  });
}
