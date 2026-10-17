/**
 * Narrow selectors over thread lineage (lib/lineage, docs/notes/agents-3-lineage-gui.md),
 * all derived from the thread list: no RPC. Id lists are shallow-compared, so a related
 * thread's status change re-renders only its own row (the rows select their fields), and
 * a list re-renders only when a thread joins, leaves or changes creator.
 */
import { useShallow } from "zustand/react/shallow";
import { childIds, creatorOf, lineageStatus, noteCreatorId, projectCount, siblingIds, type Creator, type LineageCounts, type LineageStatus } from "@/lib/lineage";
import { useThreadsStore } from "./threads";

/** The thread's creator (id, recorded name, whether it still exists); null when the user made it. */
export function useCreator(threadId: string): Creator | null {
  return useThreadsStore(useShallow((s) => creatorOf(s, threadId)));
}

/** The creator's other threads, in spawn order. */
export function useSiblingIds(threadId: string): readonly string[] {
  return useThreadsStore(useShallow((s) => siblingIds(s, threadId)));
}

/** Threads created from this one, in spawn order. */
export function useChildIds(threadId: string): readonly string[] {
  return useThreadsStore(useShallow((s) => childIds(s, threadId)));
}

/** The Threads panel header's figures. */
export function useLineageCounts(threadId: string): LineageCounts {
  return useThreadsStore(
    useShallow((s) => {
      const c = creatorOf(s, threadId);
      const children = childIds(s, threadId);
      return {
        creator: c === null ? "" : c.exists ? "created" : "removed",
        creatorName: c?.name ?? "",
        siblings: siblingIds(s, threadId).length,
        children: children.length,
        childProjects: projectCount(s, children),
      } satisfies LineageCounts;
    }),
  );
}

/** A thread's status word in the panel (lib/lineage lineageStatus). */
export function useLineageStatus(id: string): LineageStatus {
  return useThreadsStore((s) => lineageStatus(s.byId[id]));
}

/** Whether a thread made by an agent: the sidebar's ↳ glyph. */
export function useMadeByThread(id: string): boolean {
  return useThreadsStore((s) => Boolean(s.byId[id]?.createdBy));
}

/** The thread a created-by note links to ("" for plain text): lib/lineage noteCreatorId. */
export function useNoteCreatorId(threadId: string, noteId: string, name: string): string {
  return useThreadsStore((s) => noteCreatorId(s, threadId, noteId, name));
}
