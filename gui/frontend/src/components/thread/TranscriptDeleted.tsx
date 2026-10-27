import { Archive, Trash2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { archiveThread, removeThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";

/**
 * A thread whose transcript Claude Code deleted (Thread.transcript_missing;
 * docs/notes/transcript-deleted.md) cannot continue: Claude Code removes transcripts after
 * its cleanupPeriodDays setting, and the daemon refuses a message, a fork and the queries
 * that would start Claude. The header says so with an amber chip, and the composer's card
 * says why with only Archive and Remove under it (ThreadComposer disables everything else).
 */
function useTranscriptMissing(threadId: string): boolean {
  return useThreadsStore((s) => s.byId[threadId]?.transcriptMissing === true);
}

/** The header's amber "Transcript deleted" chip; nothing for a thread that can continue. */
export function TranscriptDeletedChip({ id }: { id: string }) {
  if (!useTranscriptMissing(id)) return null;
  return (
    <Badge variant="outline" className="shrink-0 border-transparent bg-cf-warning-surface text-cf-warning-text" data-testid="thread-transcript-deleted">
      <Trash2 aria-hidden />
      Transcript deleted
    </Badge>
  );
}

/**
 * The composer card's note above the (disabled) editor, where the snooze, retry and cold
 * cache lines sit: why the thread cannot continue, and Archive and Remove (the archive and
 * remove thread actions, with the confirmations they already ask for). Archive is left out
 * for a thread already archived. No other way out: a new conversation would be a different
 * thread under this one's history.
 */
export function TranscriptDeletedNote({ threadId }: { threadId: string }) {
  const missing = useTranscriptMissing(threadId);
  const archived = useThreadsStore((s) => (s.byId[threadId]?.archivedAtMs ?? null) !== null);
  if (!missing) return null;
  return (
    <div className="col-span-2 flex min-w-0 gap-2 px-4 pt-3 text-body-sm" role="status" data-testid="thread-transcript-note">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-cf-warning-text" aria-hidden />
      <div className="flex min-w-0 flex-col gap-2">
        <p className="min-w-0">
          <span className="font-medium text-cf-text">This thread can&apos;t continue.</span>{" "}
          <span className="text-cf-text-muted">
            Claude Code deleted its transcript, so Claude no longer has this conversation. Claude Code removes transcripts after{" "}
            <code className="text-code">cleanupPeriodDays</code> (30 days by default), a Claude Code setting in <code className="text-code">~/.claude/settings.json</code>, not a
            Code Foundry one.
          </span>
        </p>
        <div className="flex items-center gap-1.5">
          {!archived && (
            <Button
              variant="outline"
              size="xs"
              data-testid="thread-transcript-archive"
              onClick={() => {
                void archiveThread(threadId, true);
              }}
            >
              <Archive aria-hidden />
              Archive
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            data-testid="thread-transcript-remove"
            onClick={() => {
              void removeThread(threadId);
            }}
          >
            <Trash2 aria-hidden />
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
}
