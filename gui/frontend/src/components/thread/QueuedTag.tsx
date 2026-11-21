import { Tip } from "@/components/ui/tooltip";
import type { DeliveryView } from "@/api/thread";
import { setupUnfinished } from "@/lib/threadSetup";
import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";
import { useThreadCtx } from "./context";

/** Why a "not sent" message was not: hidden behind the word. */
const UNSENT_TIP = "Claude stopped before it read this message";

/** The queued word's tooltip: when Claude reads it (one sent during a setup waits for Claude to start). */
function useQueuedTip(): string {
  const { threadId } = useThreadCtx();
  const unstarted = useThreadsStore((s) => setupUnfinished(s.byId[threadId]?.setup));
  return unstarted ? "Goes to Claude once it starts" : "Read by Claude at its next tool call";
}

/**
 * A message Claude has not read yet (docs/notes/orch-queued-placement.md), or never read
 * (`unsent`: its process ended first; docs/notes/steer-segments.md), as a small tag on a
 * wake note and a From row. A bubble says it in its caption instead (DeliveryWord). One
 * sent during a setup waits for Claude to start, through a failed setup and a restart too.
 */
export function QueuedTag({ unsent = false }: { unsent?: boolean }) {
  const tip = useQueuedTip();
  return (
    <Tip label={unsent ? UNSENT_TIP : tip}>
      <span className={cn("text-caption flex-none rounded-sm border px-1 select-none", unsent && "text-cf-warning-text")} data-testid={unsent ? "thread-unsent" : "thread-queued"}>
        {unsent ? "not sent" : "queued"}
      </span>
    </Tip>
  );
}

/**
 * A bubble's caption word for a message still queued ("queued") or never read ("not sent",
 * the warning tone): when Claude reads it, or why it did not, in its tooltip.
 */
export function DeliveryWord({ delivery }: { delivery: Extract<DeliveryView, "queued" | "unsent"> }) {
  const tip = useQueuedTip();
  const unsent = delivery === "unsent";
  return (
    <Tip label={unsent ? UNSENT_TIP : tip}>
      <span className={unsent ? "text-cf-warning-text" : undefined} data-testid={unsent ? "thread-unsent" : "thread-queued"}>
        {unsent ? "not sent" : "queued"}
      </span>
    </Tip>
  );
}
