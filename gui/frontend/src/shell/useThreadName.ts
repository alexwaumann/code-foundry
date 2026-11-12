import { useThreadsStore } from "@/stores/threads";

/** A thread's name, looked up by id (a rename shows at once); the id while the threads have not arrived. */
export function useThreadName(threadId: string): string {
  return useThreadsStore((s) => s.byId[threadId]?.name || threadId);
}
