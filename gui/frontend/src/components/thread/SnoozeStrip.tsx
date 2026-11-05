import { useState } from "react";
import { AlarmClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/clock";
import { snoozeTimeShort } from "@/lib/snooze";
import { snoozeThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { DOCK_STRIP, DockStripLine } from "./DockStrip";

/** The strip's line; `until` is null for a thread saved for later. The button holds until the command is done, and a failure toasts (runCommand). */
function Snoozed({ threadId, until }: { threadId: string; until: number | null }) {
  const now = useNow(30_000);
  const [pending, setPending] = useState(false);
  return (
    <div className={DOCK_STRIP} data-testid="snooze-strip">
      <DockStripLine icon={AlarmClock} sentence={until === null ? "Saved for later" : `Snoozed until ${snoozeTimeShort(until, now)}`} testId="snooze-sentence">
        <Button
          variant="outline"
          size="xs"
          disabled={pending}
          data-testid="snooze-dismiss"
          onClick={() => {
            setPending(true);
            void snoozeThread(threadId, null).finally(() => {
              setPending(false);
            });
          }}
        >
          Dismiss snooze
        </Button>
      </DockStripLine>
    </div>
  );
}

/**
 * The strip above the composer of a snoozed or saved thread (docs/notes/open-row-snooze-strip.md):
 * until when, and Dismiss snooze, which ends it as the title menu's Unsnooze does. Keyed by
 * thread, so a press pending on one does not hold another's button. A thread the daemon woke
 * has the composer's SnoozeNote instead.
 */
export function SnoozeStrip({ threadId }: { threadId: string }) {
  const until = useThreadsStore((s) => s.byId[threadId]?.snoozedUntilMs ?? null);
  const saved = useThreadsStore((s) => (s.byId[threadId]?.savedAtMs ?? null) !== null);
  if (until === null && !saved) return null;
  return <Snoozed threadId={threadId} until={saved ? null : until} />;
}
