/**
 * Hidden child threads (docs/notes/hidden-children-2-gui.md). A thread another thread
 * created (ThreadView.createdBy) is managed by its creator: by default it stays out of the
 * sidebar, its footers, keyboard order and attention counts, and is reached through its
 * creator's thread info card (its lineage group), the palette and links instead. In the sidebar means managed by
 * the user; hidden means managed by a thread.
 */
import type { ThreadView } from "@/api/threads";

/** The fields the rule reads. */
export type SidebarFields = Pick<ThreadView, "createdBy" | "inSidebar">;

/**
 * The one visibility rule, the daemon's (thread.Thread.InSidebar, the proto comment on
 * Thread.in_sidebar): a thread no thread created is shown; else its own override
 * (thread.sidebar, thread.new --sidebar) when set; else threads.show_created_threads.
 */
export function inSidebar(t: SidebarFields, showCreated: boolean): boolean {
  if (!t.createdBy) return true;
  // typeof: views built before the field (test fixtures, an older daemon) leave it out.
  if (typeof t.inSidebar === "boolean") return t.inSidebar;
  return showCreated;
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
export function threadFocus(t: (SidebarFields & Pick<ThreadView, "createdAtMs">) | undefined, showCreated: boolean, nowMs: number): "select" | "skip" | "wait" {
  if (t === undefined) return "wait";
  if (inSidebar(t, showCreated)) return "select";
  const fresh = t.createdAtMs === null || nowMs - t.createdAtMs < NEW_THREAD_FOCUS_MS;
  return fresh ? "skip" : "select";
}

/**
 * The sidebar row that stands for a thread: the thread itself when it is shown, else its
 * nearest shown ancestor (walking createdBy); null when there is none (an unknown thread,
 * a removed creator on the way, a creator cycle). A hidden thread opened from the Threads
 * tab, the palette or a link highlights that row.
 */
export function sidebarAnchor(byId: Readonly<Record<string, SidebarFields & Pick<ThreadView, "id">>>, id: string, showCreated: boolean): string | null {
  const seen = new Set<string>();
  for (let t = byId[id]; t !== undefined && !seen.has(t.id); t = byId[t.createdBy]) {
    if (inSidebar(t, showCreated)) return t.id;
    seen.add(t.id);
  }
  return null;
}
