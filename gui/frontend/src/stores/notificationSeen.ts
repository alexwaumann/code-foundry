/**
 * The bell's seen state (docs/notes/notification-seen.md): opening the list marks every shown
 * notification seen, and one that arrives while it is open is seen at once (it is on screen).
 * Acting on a notification marks that one seen in the daemon, so nothing here runs for it; an
 * arrival toast and a thread row's hover card mark nothing.
 */
import { useEffect } from "react";
import { runCommandForResult } from "./commands";
import { useUnseenWhileOpen } from "./notifications";

export const SEEN_COMMAND = "notification.seen";

/**
 * notification.seen with no id: every shown one. Quiet both ways: the badge going is the result,
 * and a failure (a daemon without the verb) leaves the badge for the next open, with nothing the
 * user pressed to report it against.
 */
export async function markNotificationsSeen(): Promise<boolean> {
  return (await runCommandForResult(SEEN_COMMAND, {}, { quiet: true, expected: () => true })) !== null;
}

/**
 * Marks the shown ones seen while the bell is open: once on opening, and again for each arrival
 * while it stays open. Keyed on the unseen ids, so a failed call does not loop and a new arrival
 * runs it again.
 */
export function useMarkSeenWhileOpen(): void {
  const unseen = useUnseenWhileOpen();
  useEffect(() => {
    if (unseen !== "") void markNotificationsSeen();
  }, [unseen]);
}
