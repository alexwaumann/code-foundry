/**
 * Whether "Mark as unread" (thread.unread, docs/notes/thread-mark-unread.md) is offered for a
 * thread: idle at its prompt (not working, starting, asking, in error, waiting or already
 * Done), not archived, snoozed or saved, and not setting up. The daemon refuses anything else
 * by the same rule (internal/store/thread/unread.go); its command is listed wherever a thread
 * is (a list fetched before the thread changed would mislead), so the row, header and tab
 * menus and the palette offer it by this rule.
 */
import type { ThreadView } from "@/api/threads";
import { isSnoozed } from "./snooze";
import { setupUnfinished } from "./threadSetup";

export type MarkUnreadFacts = Pick<ThreadView, "status" | "statusReason" | "state" | "archivedAtMs" | "snoozedUntilMs" | "savedAtMs" | "setup">;

export function canMarkUnread(t: MarkUnreadFacts | undefined): boolean {
  if (t === undefined) return false;
  return t.status === "idle" && t.statusReason === "at prompt" && t.state !== "starting" && t.archivedAtMs === null && !isSnoozed(t) && !setupUnfinished(t.setup);
}
