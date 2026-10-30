import { useThreadCheckouts } from "@/components/thread/useThreadCheckouts";
import { useThreadsStore } from "@/stores/threads";

/** The thread's set with its cwd's project first (the order every member list of the card uses). */
export function useMembers(threadId: string): {
  cwdProjectId: string;
  members: readonly string[];
  paths: Readonly<Record<string, string>>;
} {
  const { projectIds, paths } = useThreadCheckouts(threadId);
  const cwdProjectId = useThreadsStore((s) => s.byId[threadId]?.projectId ?? "");
  return { cwdProjectId, members: projectIds, paths };
}
