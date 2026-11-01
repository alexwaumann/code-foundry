/**
 * Child threads stay with their creator (docs/notes/no-sidebar-override-1-gui.md). A thread
 * another thread created (ThreadView.createdBy) is its creator's: it is in no sidebar list,
 * footer, keyboard order or attention count, and is reached through its creator's thread
 * info card (its lineage group), the palette and links instead. There is no setting and no
 * per-thread override; to take over a child's work the user forks it or starts a new thread.
 */
import type { ThreadView } from "@/api/threads";

/** The fields the rule reads. */
export type SidebarFields = Pick<ThreadView, "createdBy">;

/**
 * The thread list the rule looks creators up in: ThreadsData.byId, every thread the daemon
 * lists (archived and owned ones included). Only membership matters.
 */
export type ThreadsById = Readonly<Record<string, unknown>>;

/**
 * The one visibility rule: a thread is in the sidebar iff no thread created it, or its
 * creator no longer exists (removed: not in the thread list at all; an archived creator
 * still exists and keeps its children). Nothing is stored for the orphan case: it follows
 * the list.
 */
export function inSidebar(t: SidebarFields, byId: ThreadsById): boolean {
  return !t.createdBy || byId[t.createdBy] === undefined;
}

/**
 * How recently a thread was created for a focusThread intent about it to count as its
 * creation's (thread.new, thread.fork and the pr.* threads focus every thread they
 * create; thread.focus focuses on request).
 */
export const NEW_THREAD_FOCUS_MS = 10_000;

/**
 * What a focusThread intent does: "select" the thread (switch the view to it), "skip" it
 * (the view stays: a hidden thread just created, so an agent creating children, perhaps
 * woken while the user works elsewhere, never yanks the view), or "wait" for it (not in
 * the thread list yet: the intent and the list event travel separately; decide once it
 * arrives). A thread created longer ago than NEW_THREAD_FOCUS_MS is an explicit
 * thread.focus and is selected, hidden or not.
 */
export function threadFocus(t: (SidebarFields & Pick<ThreadView, "createdAtMs">) | undefined, byId: ThreadsById, nowMs: number): "select" | "skip" | "wait" {
  if (t === undefined) return "wait";
  if (inSidebar(t, byId)) return "select";
  const fresh = t.createdAtMs === null || nowMs - t.createdAtMs < NEW_THREAD_FOCUS_MS;
  return fresh ? "skip" : "select";
}

/**
 * The sidebar row that stands for a thread: the thread itself when it is shown, else its
 * nearest shown ancestor (walking createdBy); null when there is none (an unknown thread,
 * a creator cycle). A hidden thread opened from the thread info card, the palette or a
 * link highlights that row.
 */
export function sidebarAnchor(byId: Readonly<Record<string, SidebarFields & Pick<ThreadView, "id">>>, id: string): string | null {
  const seen = new Set<string>();
  for (let t = byId[id]; t !== undefined && !seen.has(t.id); t = byId[t.createdBy]) {
    if (inSidebar(t, byId)) return t.id;
    seen.add(t.id);
  }
  return null;
}
