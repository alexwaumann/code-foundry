import { Hourglass } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isWaiting, waitingOnNames, waitingParts, waitingText } from "@/lib/waiting";
import { useThreadsStore } from "@/stores/threads";

/**
 * The thread tooltip's row for a thread waiting on its child threads (lib/waiting): a muted
 * hourglass, the daemon's reason as a sentence ("Waiting on 2 child threads and 1
 * subagent", "Waiting on a wake"), and the names of the children still working under it (at most five, then "+N more"). Nothing for any other status. Mounted only
 * while the tooltip is open.
 */
export function TipWaiting({ id }: { id: string }) {
  // The sentence is a string, so only a change of the reason's counts re-renders.
  const text = useThreadsStore((s) => {
    const t = s.byId[id];
    return t && isWaiting(t) ? waitingText(waitingParts(t.statusReason)) : null;
  });
  // Shallow over the names (strings), so only a change of who keeps it waiting re-renders.
  const names = useThreadsStore(useShallow((s) => (text === null ? NONE : waitingOnNames(s, id).names)));
  const more = useThreadsStore((s) => (text === null ? 0 : waitingOnNames(s, id).more));
  if (text === null) return null;
  return (
    <div className="mb-[3px] flex items-start gap-2 leading-5" data-testid="tip-waiting">
      <Hourglass className="mt-[3px] size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
      <div className="min-w-0">
        <div className="break-words">{text}</div>
        {names.map((name, i) => (
          <div key={i} className="truncate text-cf-text-muted" data-testid="tip-waiting-name">
            {name}
          </div>
        ))}
        {more > 0 && <div className="text-cf-text-muted" data-testid="tip-waiting-more">{`+${String(more)} more`}</div>}
      </div>
    </div>
  );
}

const NONE: string[] = [];
