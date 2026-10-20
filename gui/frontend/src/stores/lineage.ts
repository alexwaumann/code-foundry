/**
 * Narrow selectors over thread lineage (lib/lineage, docs/notes/agents-3-lineage-gui.md),
 * all derived from the thread list: no RPC. Id lists are shallow-compared, so a related
 * thread's status change re-renders only its own row (the rows select their fields), and
 * a list re-renders only when a thread joins, leaves or changes creator.
 */
import { useShallow } from "zustand/react/shallow";
import { inSidebar } from "@/lib/inSidebar";
import { childIds, creatorOf, lineageStatus, noteCreator, projectCount, siblingIds, type Creator, type LineageCounts, type LineageStatus } from "@/lib/lineage";
import { useShowCreatedThreads } from "./settings";
import { useThreadsStore } from "./threads";

/**
 * The thread's creator (id, current name or the recorded one once removed, whether it
 * still exists); null when the user made it. Shallow over the three fields, so a rename
 * of the creator re-renders.
 */
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

/**
 * The creator a created-by note names by its id (lib/lineage noteCreator); `recorded` is
 * the note's name, for a removed creator. Shallow over id, name (s.byId[createdBy]?.name)
 * and exists, so a rename or a removal of the creator re-renders the note.
 */
export function useNoteCreator(createdBy: string, recorded: string): Creator {
  return useThreadsStore(useShallow((s) => noteCreator(s, createdBy, recorded)));
}

/**
 * Whether a thread another thread created is shown in the sidebar (lib/inSidebar.ts, with
 * threads.show_created_threads); null for the user's own thread (always shown, no override).
 * The Show / Hide in sidebar actions and the Threads tab's "hidden" mark.
 */
export function useSidebarShown(id: string): boolean | null {
  const showCreated = useShowCreatedThreads();
  return useThreadsStore((s) => {
    const t = s.byId[id];
    return t?.createdBy ? inSidebar(t, showCreated) : null;
  });
}
