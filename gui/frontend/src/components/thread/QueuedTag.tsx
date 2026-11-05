import { Tip } from "@/components/ui/tooltip";
import { setupUnfinished } from "@/lib/threadSetup";
import { useThreadsStore } from "@/stores/threads";
import { useThreadCtx } from "./context";

/**
 * A message Claude has not read yet (docs/notes/orch-queued-placement.md): sent while
 * Claude worked, it waits in Claude Code's queue until its next tool call (or the end of
 * the reply it is writing). The daemon clears the flag and moves the message where Claude
 * read it, and the tag goes. One sent during a setup waits for Claude to start, through a
 * failed setup and a restart too.
 */
export function QueuedTag() {
  const { threadId } = useThreadCtx();
  const unstarted = useThreadsStore((s) => setupUnfinished(s.byId[threadId]?.setup));
  return (
    <Tip label={unstarted ? "Goes to Claude once it starts" : "Read by Claude at its next tool call"}>
      <span className="text-caption flex-none rounded-sm border px-1 select-none" data-testid="thread-queued">
        queued
      </span>
    </Tip>
  );
}
