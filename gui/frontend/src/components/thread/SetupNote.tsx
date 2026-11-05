import { useState } from "react";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setupNoteLine } from "@/lib/threadSetup";
import { cn } from "@/lib/utils";
import { editSetup, retrySetup } from "@/stores/setupActions";
import { removeThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";

const QUIET = "font-normal text-cf-text-muted hover:text-cf-text";

/**
 * The composer's note at the top of the card on a setup that failed or was cancelled
 * (docs/notes/instant-threads-4-composer.md), in FailedPromptNote's slot, which stays silent
 * on such a thread: why, then Remove (its usual confirm), Edit (undoes the send:
 * stores/setupActions editSetup) and Try again (a message sent from this composer tries
 * again too). No close button: the thread stays stuck until one of them is used. Hidden while
 * the setup runs, so a retry takes it away at once.
 */
export function SetupNote({ threadId }: { threadId: string }) {
  const line = useThreadsStore((s) => setupNoteLine(s.byId[threadId]?.setup));
  const failed = useThreadsStore((s) => s.byId[threadId]?.setup?.phase === "failed");
  const [acting, setActing] = useState(false);
  if (!line) return null;
  const act = (run: () => Promise<boolean>) => {
    setActing(true);
    void run().finally(() => {
      setActing(false);
    });
  };
  return (
    <div className="col-span-2 flex min-w-0 items-center gap-2 border-b border-cf-border py-2 pr-2 pl-4 text-body-sm" role="status" data-testid="thread-setup-note" data-phase={failed ? "failed" : "cancelled"}>
      <CircleAlert className={cn("size-3.5 shrink-0", failed ? "text-cf-error-text" : "text-cf-text-muted")} aria-hidden />
      <span className="min-w-0 flex-1" data-testid="thread-setup-reason">
        {line}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="ghost" size="xs" className={QUIET} disabled={acting} data-testid="thread-setup-remove" onClick={() => { act(() => removeThread(threadId)); }}>
          Remove
        </Button>
        <Button type="button" variant="ghost" size="xs" className={QUIET} disabled={acting} data-testid="thread-setup-edit" onClick={() => { act(() => editSetup(threadId)); }}>
          Edit
        </Button>
        <Button type="button" variant="secondary" size="xs" className="bg-cf-control-hover font-normal text-cf-text hover:bg-cf-control-active" disabled={acting} data-testid="thread-setup-retry" onClick={() => { act(() => retrySetup(threadId)); }}>
          Try again
        </Button>
      </div>
    </div>
  );
}
