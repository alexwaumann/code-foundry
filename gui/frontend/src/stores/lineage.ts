/**
 * Narrow selectors over thread lineage (lib/lineage, docs/notes/agents-3-lineage-gui.md),
 * all derived from the thread list: no RPC. Id lists are shallow-compared, so a related
 * thread's status change re-renders only its own row (the rows select their fields), and
 * a list re-renders only when a thread joins, leaves or changes creator.
 */
import { useShallow } from "zustand/react/shallow";
import { inSidebar } from "@/lib/inSidebar";
import { creatorOf, noteCreator, type Creator } from "@/lib/lineage";
import { liveCount } from "@/lib/liveCount";
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

/**
 * The thread's live count (lib/liveCount): background subagents running plus live child
 * threads. A number, so a row re-renders only when it changes. The sidebar row's Bot
 * badge and the thread info card's "Lineage · N running" both read it.
 */
export function useLiveCount(id: string): number {
  return useThreadsStore((s) => liveCount(s, id));
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
 * The thread menu's Show / Hide in sidebar item.
 */
export function useSidebarShown(id: string): boolean | null {
  const showCreated = useShowCreatedThreads();
  return useThreadsStore((s) => {
    const t = s.byId[id];
    return t?.createdBy ? inSidebar(t, showCreated) : null;
  });
}
