import { useState } from "react";
import { AlarmClock, BellRing } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { SnoozePresetItems } from "@/components/snooze/SnoozeMenu";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useNow } from "@/lib/clock";
import { isSnoozed, snoozeTimeShort } from "@/lib/snooze";
import { statusLine, statusText } from "@/lib/statusLine";
import { rowToneClasses } from "@/lib/statusRegistry";
import { clearSnoozeEnded, snoozeThread } from "@/stores/threadActions";
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
            void snoozeThread(threadId, null, { inView: true }).finally(() => {
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
 * A woken thread's strip: "Snooze ended · <ago>" in the warning tone, then Snooze again (the
 * preset menu; the snooze closes the thread's tab, so it toasts like the header menu's) and
 * Clear (thread.snooze.clear, held while it runs; no toast, the strip going says it).
 */
function Woken({ threadId, at }: { threadId: string; at: number | null }) {
  const now = useNow(30_000);
  const [pending, setPending] = useState(false);
  return (
    <div className={DOCK_STRIP} data-testid="woken-strip">
      <DockStripLine icon={BellRing} sentence={statusText({ kind: "snoozeEnded", detail: "", at }, now)} testId="woken-sentence" toneClass={rowToneClasses.warning}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="xs" data-testid="woken-snooze">
              Snooze again
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid="woken-snooze-menu">
            <SnoozePresetItems id={threadId} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} inView={false} />
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="outline"
          size="xs"
          disabled={pending}
          data-testid="woken-clear"
          onClick={() => {
            setPending(true);
            void clearSnoozeEnded(threadId, { inView: true }).finally(() => {
              setPending(false);
            });
          }}
        >
          Clear
        </Button>
      </DockStripLine>
    </div>
  );
}

/** What the strip shows for a thread: snoozed until a time, saved, woken (when it woke, 0 when unknown), or nothing. */
type StripState = { kind: "snoozed"; until: number | null } | { kind: "woken"; at: number } | { kind: "none" };

/**
 * The strip above the composer of a snoozed, saved or woken thread (docs/notes/open-row-snooze-strip.md,
 * docs/notes/clear-woken-thread.md): until when and Dismiss snooze, which ends it as the title
 * menu's Unsnooze does; or, once the daemon woke it, when and Snooze again and Clear. Keyed by
 * thread, so a press pending on one does not hold another's button.
 */
export function SnoozeStrip({ threadId }: { threadId: string }) {
  const state = useThreadsStore(
    useShallow((s): StripState => {
      const t = s.byId[threadId];
      if (!t) return { kind: "none" };
      if (t.savedAtMs !== null) return { kind: "snoozed", until: null };
      if (isSnoozed(t)) return { kind: "snoozed", until: t.snoozedUntilMs };
      const l = statusLine(t);
      return l.kind === "snoozeEnded" ? { kind: "woken", at: l.at ?? 0 } : { kind: "none" };
    }),
  );
  if (state.kind === "snoozed") return <Snoozed threadId={threadId} until={state.until} />;
  if (state.kind === "woken") return <Woken key="woken" threadId={threadId} at={state.at === 0 ? null : state.at} />;
  return null;
}
