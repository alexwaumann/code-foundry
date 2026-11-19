import { SnoozePresetItems } from "@/components/snooze/SnoozeMenu";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { snoozeFull, type PillSnooze } from "@/lib/composerPill";
import { clearSnoozeEnded, snoozeThread } from "@/stores/threadActions";

/**
 * The snooze segment's menu (ComposerRow), opened upward: its first line says the whole state
 * ("Snoozed until Mon 9:00 AM"), then Dismiss snooze (a snoozed or saved thread: thread.snooze
 * --clear, the title menu's Unsnooze) or Clear (a woken one: thread.snooze.clear), then the
 * snooze menu every other surface has (components/snooze/SnoozeMenu.tsx). A snoozed thread
 * stays open when its time changes, so no toast; a woken one snoozed again closes its tab
 * (stores/archiveCleanup.ts), so that toasts as the title menu's does.
 */
export function PillSnoozeMenu({ threadId, snooze, now }: { threadId: string; snooze: PillSnooze; now: number }) {
  const woken = snooze.kind === "woken";
  return (
    <>
      <DropdownMenuLabel className="text-caption-sm" data-testid="snooze-menu-state">
        {snooze.kind === "saved" ? "Saved for later, no alarm" : snoozeFull(snooze, now)}
      </DropdownMenuLabel>
      {woken ? (
        <DropdownMenuItem
          data-testid="woken-clear"
          onSelect={() => {
            void clearSnoozeEnded(threadId, { inView: true });
          }}
        >
          Clear
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem
          data-testid="snooze-dismiss"
          onSelect={() => {
            void snoozeThread(threadId, null, { inView: true });
          }}
        >
          Dismiss snooze
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <SnoozePresetItems id={threadId} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} inView={!woken} />
    </>
  );
}
